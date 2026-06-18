/**
 * kordoc parse() 래퍼 — 발행 번들에 포함되는 런타임 가드.
 *
 * 배경: kordoc 3.1.1 의 parse() 는 도형/이미지 **대체텍스트**("사각형입니다." 등)를
 *   제거하는 정규식을 앵커 없이 전역(/g)으로 본문 전체에 적용한다. 그 결과 도형
 *   키워드(표·그림·원·별·선…)로 끝나는 **합성어**("목표입니다"의 표, "공원입니다"의 원,
 *   "발표입니다"의 표)의 꼬리를 본문 한가운데서 잘라낸다. → read_document 텍스트 무성
 *   손실 + patchHwpx 재조정 시 숨은 꼬리 중복(문서 손상).
 *
 * 레포 자체는 `patches/kordoc@3.1.1.patch`(룩비하인드)로 근본 수정돼 있으나, npm 에
 *   발행된 CLI 사용자는 unscoped kordoc 를 그대로 받으므로 패치가 닿지 않는다. 이 래퍼는
 *   parse() 산출 마크다운을 **원본 HWPX 의 raw `<hp:t>` 텍스트와 대조해 과제거된 꼬리를
 *   복원**하여, 패치 여부와 무관하게 사용자를 보호한다.
 *
 * 안전성: 원본 XML 에 실제로 존재하는 텍스트만 복원한다(없는 텍스트 날조 불가). 마크다운
 *   라인의 (장식 제거) 내용이 "버그가 만들어낼 출력"과 **정확히 일치**할 때만 그 라인을
 *   원래 텍스트로 되돌린다. 일치하지 않으면 건드리지 않는다(거짓 양성 없음, 미복원은 안전).
 *   복원 로직이 던지면 원본 parse 결과를 그대로 반환한다(가드가 parse 를 깨지 않는다).
 *
 * 상세: docs/EVAL-SET.md §10, 메모리 kordoc-parse-drops-pyoimnida.
 */

import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { IRBlock, ParseOptions, ParseResult } from "kordoc";
import { isZipFile, parse as kordocParse } from "kordoc";

// kordoc 도형/이미지 대체텍스트 제거 정규식의 키워드 집합 — kordoc dist 의 실제 정규식
// 전 변형에서 추출한 **완전한 44종**(kordoc 순서 유지). 누락 키워드가 있으면 가드가
// 해당 합성어 드롭(예 '번호입니다'→'번')을 복원하지 못하므로 kordoc 와 동기화가 중요.
const SHAPE_ALT_KEYWORDS = [
  "사각형",
  "직사각형",
  "정사각형",
  "원",
  "타원",
  "삼각형",
  "이등변 삼각형",
  "직각 삼각형",
  "선",
  "직선",
  "곡선",
  "화살표",
  "굵은 화살표",
  "이중 화살표",
  "오각형",
  "육각형",
  "팔각형",
  "별",
  "[4-8]점별",
  "십자",
  "십자형",
  "구름",
  "구름형",
  "마름모",
  "도넛",
  "평행사변형",
  "사다리꼴",
  "부채꼴",
  "호",
  "반원",
  "물결",
  "번개",
  "하트",
  "빗금",
  "블록 화살표",
  "수식",
  "표",
  "그림",
  "개체",
  "그리기\\s?개체",
  "묶음\\s?개체",
  "글상자",
  "수식\\s?개체",
  "OLE\\s?개체",
].join("|");

/** kordoc 의 (버그) 전역 대체텍스트 제거 — 앵커 없음. */
export const BUGGY_SHAPE_STRIP = new RegExp(
  `(?:모서리가 둥근 |둥근 )?(?:${SHAPE_ALT_KEYWORDS})\\s?입니다\\.?`,
  "g",
);

/** 올바른 동작 — 선행 한글 음절이 있으면(=합성어 내부) 제거하지 않음. */
export const FIXED_SHAPE_STRIP = new RegExp(
  `(?<![가-힣])(?:모서리가 둥근 |둥근 )?(?:${SHAPE_ALT_KEYWORDS})\\s?입니다\\.?`,
  "g",
);

/** kordoc 의 본문 텍스트 정규화(공백 압축 + trim) 후 지정 정규식으로 제거. */
function applyStrip(raw: string, re: RegExp): string {
  const normalized = raw.replace(/[ \t]+/g, " ").trim();
  return normalized.replace(re, "").trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/**
 * HWPX 바이트에서 단락별 raw 텍스트를 추출한다.
 * section*.xml 을 `<hp:p` 시작 기준으로 분할하고, 각 조각의 `<hp:t>` 텍스트를 이어 붙인다.
 * (중첩 표 등으로 인한 과결합은 라인 정확 일치 단계에서 자연히 걸러지므로 안전하다.)
 */
export async function extractHwpxParagraphTexts(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const out: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!/^Contents\/section\d*\.xml$/i.test(name)) continue;
    const entry = zip.files[name];
    if (!entry) continue;
    const xml = await entry.async("string");
    for (const seg of xml.split(/(?=<hp:p\b)/)) {
      let para = "";
      for (const m of seg.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g)) {
        para += decodeXmlEntities((m[1] ?? "").replace(/<[^>]+>/g, ""));
      }
      if (para.trim()) out.push(para);
    }
  }
  return out;
}

/** 마크다운 라인에서 선두 장식(제목·목록·인용·들여쓰기)을 분리한다. */
function splitDecoration(line: string): { prefix: string; content: string } {
  const m = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)?)([\s\S]*)$/);
  if (!m) return { prefix: "", content: line };
  return { prefix: m[1] ?? "", content: m[2] ?? "" };
}

/**
 * 과제거된 도형 키워드 꼬리를 원본 텍스트로 복원한다.
 *
 * 각 원본 단락 텍스트에 대해:
 *  - buggy = 버그 정규식 적용 결과(=kordoc 이 마크다운에 내놓는 형태)
 *  - fixed = 올바른 정규식 적용 결과(=복원 목표)
 * buggy !== fixed (과제거 발생) 이고, 장식 제거한 마크다운 라인 내용이 buggy 와 정확히
 * 일치하는 미사용 라인이 있으면 그 라인을 fixed 로 되돌린다.
 */
export function restoreOverStrippedShapeText(markdown: string, paragraphTexts: string[]): string {
  const lines = markdown.split("\n");
  const used = new Set<number>();
  let changed = false;

  for (const raw of paragraphTexts) {
    const buggy = applyStrip(raw, BUGGY_SHAPE_STRIP);
    const fixed = applyStrip(raw, FIXED_SHAPE_STRIP);
    if (buggy === fixed) continue; // 과제거 없음
    if (!fixed) continue; // 독립 대체텍스트 — 복원하지 않음
    if (!buggy) continue; // 빈 매치는 정확 일치 불가

    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const { prefix, content } = splitDecoration(lines[i] ?? "");
      if (content.trim() === buggy && content.trim() !== fixed) {
        lines[i] = prefix + fixed;
        used.add(i);
        changed = true;
        break;
      }
    }
  }

  return changed ? lines.join("\n") : markdown;
}

/** 블록 트리의 편집 가능한 텍스트 슬롯(문단/헤딩 text, 표 셀 text, 중첩 셀 blocks, children)을 문서 순서로 수집. */
function collectBlockTextSlots(
  blocks: IRBlock[],
): Array<{ get: () => string; set: (v: string) => void }> {
  const slots: Array<{ get: () => string; set: (v: string) => void }> = [];
  const walk = (bs: IRBlock[]): void => {
    for (const b of bs) {
      if (typeof b.text === "string") {
        slots.push({
          get: () => b.text ?? "",
          set: (v) => {
            b.text = v;
          },
        });
      }
      if (b.table) {
        for (const row of b.table.cells) {
          for (const cell of row) {
            slots.push({
              get: () => cell.text,
              set: (v) => {
                cell.text = v;
              },
            });
            if (cell.blocks) walk(cell.blocks);
          }
        }
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return slots;
}

/**
 * parse().blocks 의 과제거된 도형 키워드 꼬리를 원본 텍스트로 복원한다(제자리 변이).
 * 마크다운 복원과 동일한 안전 규칙: 원본 XML 에 실재하는 텍스트만, 슬롯 텍스트가 buggy 와
 * 정확히 일치할 때만 fixed 로 되돌린다(거짓 양성 억제 — used 집합으로 1:1 매칭).
 *
 * @returns 하나라도 복원했으면 true
 */
export function restoreOverStrippedBlocks(blocks: IRBlock[], paragraphTexts: string[]): boolean {
  const slots = collectBlockTextSlots(blocks);
  const used = new Set<number>();
  let changed = false;

  for (const raw of paragraphTexts) {
    const buggy = applyStrip(raw, BUGGY_SHAPE_STRIP);
    const fixed = applyStrip(raw, FIXED_SHAPE_STRIP);
    if (buggy === fixed) continue;
    if (!fixed || !buggy) continue;

    for (let i = 0; i < slots.length; i++) {
      if (used.has(i)) continue;
      const cur = slots[i]?.get().trim() ?? "";
      if (cur === buggy && cur !== fixed) {
        slots[i]?.set(fixed);
        used.add(i);
        changed = true;
        break;
      }
    }
  }

  return changed;
}

function isZip(bytes: Uint8Array): boolean {
  // kordoc isZipFile 위임 (ArrayBuffer 입력 — subarray 풀 공유 회피용 복사)
  if (bytes.length < 4) return false;
  return isZipFile(new Uint8Array(bytes.subarray(0, 4)).buffer);
}

async function resolveHwpxBytes(input: string | ArrayBuffer | Buffer): Promise<Uint8Array | null> {
  try {
    if (typeof input === "string") {
      if (!/\.hwpx$/i.test(input)) return null;
      return new Uint8Array(await readFile(input));
    }
    const u8 =
      input instanceof Uint8Array
        ? input
        : new Uint8Array(input instanceof ArrayBuffer ? input : (input as ArrayBufferLike));
    return isZip(u8) ? u8 : null;
  } catch {
    return null;
  }
}

/**
 * kordoc parse() 래퍼. HWPX 인 경우 과제거된 도형 키워드 꼬리를 원본 XML 로 복원한다.
 * 그 외 형식·실패 결과는 그대로 통과시킨다. 복원 실패는 절대 parse 를 깨지 않는다.
 */
export async function parse(
  input: string | ArrayBuffer | Buffer,
  options?: ParseOptions,
): Promise<ParseResult> {
  const result = await kordocParse(input, options);
  if (!result.success || typeof result.markdown !== "string" || !result.markdown) {
    return result;
  }
  const bytes = await resolveHwpxBytes(input);
  if (!bytes) return result;

  try {
    const paragraphTexts = await extractHwpxParagraphTexts(bytes);
    if (paragraphTexts.length === 0) return result; // hwpx 아님(docx 등) → 통과
    const repaired = restoreOverStrippedShapeText(result.markdown, paragraphTexts);
    // blocks 도 동일 규칙으로 제자리 복원(form 필드·blocksToMarkdown 등이 blocks 를 읽음).
    if (Array.isArray(result.blocks)) {
      restoreOverStrippedBlocks(result.blocks, paragraphTexts);
    }
    if (repaired !== result.markdown) {
      return { ...result, markdown: repaired };
    }
  } catch {
    // 복원은 best-effort — 어떤 오류도 원본 parse 결과를 가리지 않는다.
  }
  return result;
}
