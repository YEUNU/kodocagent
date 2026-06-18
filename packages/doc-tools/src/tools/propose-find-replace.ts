/**
 * propose_find_replace 툴 — HWPX ZIP XML 직접 패치 방식 텍스트 찾기·바꾸기
 *
 * rhwp 엔진을 사용하지 않습니다. .hwpx ZIP 안의 Contents/section*.xml 파일에서
 * <hp:t>...</hp:t> 텍스트 노드 내용만 정확히 패치합니다.
 *
 * 장점:
 *   - 이미지·표·레이아웃 등 모든 구조를 완전히 보존 (재직렬화 없음)
 *   - 복잡한 문서(중첩 표·이미지 포함)도 안전하게 처리
 *   - rhwp WASM 로드 불필요 (속도 향상)
 *
 * 제약:
 *   - 텍스트가 여러 <hp:t> 런에 나뉘어 있으면 그 경계를 가로지르는 패턴은
 *     매칭되지 않습니다(서식 분리 텍스트). 이 경우 경고만 추가하고 진행합니다.
 *   - .hwpx 전용입니다. .hwp(구형 OLE 바이너리)는 지원하지 않습니다.
 *
 * 내보내기 정책:
 *   - 입력이 .hwpx이면 .hwpx 그대로 저장 (포맷 변환 없음).
 *   - .hwp는 오류 반환 (Hancom에서 .hwpx로 저장 후 재시도 안내).
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import type { SpliceEdit } from "kordoc";
import { applySplices, buildRangeSplices, scanSectionXml } from "kordoc";
import { z } from "zod";
import { collectParasInDocOrder } from "../hwpx-splice.js";
import { parse } from "../kordoc-parse.js";
import {
  assertFileSizeWithinLimit,
  hwpStructuralGuard,
  isZipBinary,
  resolveSafePath,
} from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

export const proposeFindReplaceSchema = z.object({
  path: z.string().describe("수정할 .hwpx 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  find: z.string().min(1).describe("찾을 텍스트"),
  replace: z.string().describe("바꿀 텍스트"),
  caseSensitive: z.boolean().optional().default(false).describe("대소문자 구분 (기본값: false)"),
  all: z
    .boolean()
    .optional()
    .default(true)
    .describe("모든 항목을 교체할지 여부 (기본값: true). false이면 첫 번째 매치만 교체"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeFindReplaceInput = z.infer<typeof proposeFindReplaceSchema>;

// ─────────────────────────────────────────────────────────
// 순수 XML 치환 함수 (단위 테스트 가능)
// ─────────────────────────────────────────────────────────

/** diff 미리보기에 표시할 최대 샘플 수 */
const MAX_DIFF_SAMPLES = 20;

/**
 * XML 특수문자를 이스케이프한다 (& < > 만 처리 — 속성 인용 제외).
 */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** XML 이스케이프를 평문으로 되돌린다 (표시용). 순서 중요: &amp; 마지막. */
export function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** 두 문자열의 공통 접두/접미 길이를 빼서 변경 구간 주변만 잘라낸 스니펫을 만든다. */
export function makeChangeSnippet(
  before: string,
  after: string,
  ctx = 24,
): { before: string; after: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  const maxSuffix = Math.min(before.length - p, after.length - p);
  let s = 0;
  while (s < maxSuffix && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const slice = (str: string) => {
    const start = Math.max(0, p - ctx);
    const end = Math.min(str.length, str.length - s + ctx);
    return (start > 0 ? "…" : "") + str.slice(start, end) + (end < str.length ? "…" : "");
  };
  return { before: slice(before), after: slice(after) };
}

/** 치환 전/후 섹션 XML에서 내용이 바뀐 <hp:t> 노드를 찾아 표시용 스니펫 목록을 만든다. */
export function collectChangedSnippets(
  beforeXml: string,
  afterXml: string,
  maxSamples: number,
): Array<{ before: string; after: string }> {
  const re = /<hp:t>([\s\S]*?)<\/hp:t>/g;
  const beforeNodes = [...beforeXml.matchAll(re)].map((m) => m[1] ?? "");
  const afterNodes = [...afterXml.matchAll(re)].map((m) => m[1] ?? "");
  const out: Array<{ before: string; after: string }> = [];
  const n = Math.min(beforeNodes.length, afterNodes.length);
  for (let i = 0; i < n && out.length < maxSamples; i++) {
    if (beforeNodes[i] !== afterNodes[i]) {
      const snip = makeChangeSnippet(unescapeXml(beforeNodes[i]!), unescapeXml(afterNodes[i]!));
      out.push(snip);
    }
  }
  return out;
}

/**
 * 섹션 XML에서 <hp:t>...</hp:t> 텍스트 노드 안에서만 텍스트를 치환한다.
 *
 * - self-closing <hp:t/> 는 건드리지 않는다 (콘텐츠 없음).
 * - find/replace 는 XML-이스케이프한 형태로 매칭/삽입한다.
 * - caseSensitive=false 일 때: 소문자 비교로 매칭 위치를 찾되,
 *   실제 원본 텍스트(XML 내 이스케이프 그대로)를 교체한다.
 * - all=false + alreadyReplaced>0 이면 이 섹션에서 치환을 수행하지 않는다.
 *
 * @param xml              원본 섹션 XML
 * @param find             찾을 텍스트 (평문)
 * @param replace          바꿀 텍스트 (평문)
 * @param caseSensitive    대소문자 구분 여부
 * @param replaceAll       true = 전체 치환, false = 최초 1회만
 * @param alreadyReplaced  이전 섹션에서 치환된 누계
 * @returns                { xml: 수정된 XML, count: 이 섹션에서 치환된 횟수 }
 */
export function replaceInSectionXml(
  xml: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
  replaceAll: boolean,
  alreadyReplaced: number,
): { xml: string; count: number } {
  // all=false이고 이미 치환이 됐으면 이 섹션은 스킵
  if (!replaceAll && alreadyReplaced > 0) {
    return { xml, count: 0 };
  }

  // find/replace를 XML-이스케이프하여 XML 내 텍스트와 비교/삽입
  const escapedFind = escapeXml(find);
  const escapedReplace = escapeXml(replace);

  if (escapedFind.length === 0) {
    return { xml, count: 0 };
  }

  // 비교용 정규화 문자열
  const normFind = caseSensitive ? escapedFind : escapedFind.toLowerCase();
  const normReplace = escapedReplace; // replace는 그대로 삽입

  let totalCount = 0;
  let result = xml;

  // <hp:t>...</hp:t> 매칭 — self-closing <hp:t/> 는 제외
  // 패턴: <hp:t> 여는 태그로 시작하되 '/' 뒤에 오는 self-closing 형태는 제외
  const tNodeRe = /<hp:t>([\s\S]*?)<\/hp:t>/g;
  let offset = 0; // 원본 → result 오프셋 누적 (패치 후 인덱스 보정)

  // 원본 xml에서 매칭하고 result에 패치 적용
  let m = tNodeRe.exec(xml);
  while (m !== null) {
    const content = m[1] as string; // <hp:t>와 </hp:t> 사이의 원본 내용

    // 이 노드 내에서 치환 수행
    const nodeResult = replaceInContent(
      content,
      normFind,
      normReplace,
      caseSensitive,
      replaceAll,
      alreadyReplaced + totalCount,
    );

    if (nodeResult.count > 0) {
      // 원본 content의 result 내 실제 위치 = m.index + offset + '<hp:t>'.length
      const openTagLen = "<hp:t>".length;
      const contentStart = m.index + offset + openTagLen;
      const contentEnd = contentStart + content.length;

      result = result.substring(0, contentStart) + nodeResult.text + result.substring(contentEnd);
      offset += nodeResult.text.length - content.length;
      totalCount += nodeResult.count;

      // all=false이고 이제 1회 치환됨 → 루프 종료
      if (!replaceAll && alreadyReplaced + totalCount >= 1) {
        break;
      }
    }

    m = tNodeRe.exec(xml);
  }

  return { xml: result, count: totalCount };
}

/**
 * <hp:t> 내용 문자열에서 find를 치환한다.
 * find는 이미 XML-이스케이프된 형태(normFind).
 * caseSensitive=false 시 content를 소문자로 변환해 매칭하되 실제 교체는 원본 기준.
 */
function replaceInContent(
  content: string,
  normFind: string, // escapedFind (caseSensitive=false이면 소문자)
  escapedReplace: string,
  caseSensitive: boolean,
  replaceAll: boolean,
  alreadyReplaced: number,
): { text: string; count: number } {
  const searchIn = caseSensitive ? content : content.toLowerCase();
  const findLen = normFind.length;

  if (findLen === 0) return { text: content, count: 0 };

  let result = "";
  let pos = 0;
  let count = 0;

  while (pos <= content.length) {
    // all=false이고 (이미 이전 섹션 + 이 노드에서) 1회 교체됐으면 중단
    if (!replaceAll && alreadyReplaced + count >= 1) {
      result += content.substring(pos);
      break;
    }

    const idx = searchIn.indexOf(normFind, pos);
    if (idx === -1) {
      result += content.substring(pos);
      break;
    }

    // idx 이전 내용은 그대로 + 교체 텍스트 삽입
    result += content.substring(pos, idx) + escapedReplace;
    pos = idx + findLen;
    count++;
  }

  return { text: result, count };
}

/**
 * str 안에서 sub의 발생 횟수를 리터럴 카운트한다 (겹치지 않는 발생만).
 * 정규식을 사용하지 않는다.
 */
function countOccurrences(str: string, sub: string): number {
  if (sub.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = str.indexOf(sub, pos);
    if (idx === -1) break;
    count++;
    pos = idx + sub.length;
  }
  return count;
}

// ─────────────────────────────────────────────────────────
// kordoc splice 프리미티브 기반 치환 (1순위 경로)
//
// scanSectionXml 로 섹션 소스맵(본문·표·머리말/꼬리말 문단 + t-도메인 좌표)을 얻고,
// buildRangeSplices 로 매칭 범위만 run/charPr·tab/br 보존하며 치환한다.
// 정규식 직접 패치(replaceInSectionXml)와 달리 여러 서식 런에 나뉜 텍스트도 t-도메인
// 좌표로 매칭되며, 엔티티/내부 태그로 오프셋 정합이 깨지는 문단은 buildRangeSplices 가
// null 을 반환하므로 그때만 구 정규식 경로로 폴백한다.
// ─────────────────────────────────────────────────────────

/**
 * 한 섹션 XML에 splice 기반 치환을 시도한다.
 *
 * - 매칭은 문단 t-도메인 텍스트(`para.text`, 엔티티 디코딩)에서 평문으로 수행한다.
 *   replace 는 buildRangeSplices 가 내부에서 XML-이스케이프하므로 평문 그대로 넘긴다.
 * - 어느 매칭이든 buildRangeSplices 가 null 을 반환하면(오프셋 정합 불가) 즉시 null 을
 *   반환해 호출자가 구 정규식 경로로 폴백하게 한다(섹션 단위 all-or-nothing).
 *
 * @returns { xml, count } 또는 null(폴백 필요)
 */
function replaceSectionViaSplices(
  xml: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
  replaceAll: boolean,
  alreadyReplaced: number,
): { xml: string; count: number } | null {
  if (find.length === 0) return { xml, count: 0 };
  if (!replaceAll && alreadyReplaced > 0) return { xml, count: 0 };

  const scan = scanSectionXml(xml, 0);
  const paras = collectParasInDocOrder(scan);
  const needle = caseSensitive ? find : find.toLowerCase();
  const splices: SpliceEdit[] = [];
  let count = 0;

  for (const p of paras) {
    if (!replaceAll && alreadyReplaced + count >= 1) break;
    const hay = caseSensitive ? p.text : p.text.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      if (!replaceAll && alreadyReplaced + count >= 1) break;
      const s = buildRangeSplices(p, xml, idx, idx + find.length, replace);
      if (s === null) return null; // 오프셋 정합 불가 — 섹션 전체를 구 경로로 폴백
      splices.push(...s);
      count++;
      if (!replaceAll) break;
      idx = hay.indexOf(needle, idx + needle.length);
    }
  }

  if (count === 0) return { xml, count: 0 };
  return { xml: applySplices(xml, splices), count };
}

// ─────────────────────────────────────────────────────────
// ZIP 처리
// ─────────────────────────────────────────────────────────

/**
 * .hwpx ZIP 버퍼에서 모든 section*.xml에 find/replace를 적용하고
 * 수정된 ZIP 버퍼를 반환한다.
 *
 * @returns { buffer, count, samples } — count는 전체 치환 횟수, samples는 diff 미리보기용 스니펫
 */
async function applyFindReplaceToHwpx(
  hwpxBuffer: Uint8Array,
  find: string,
  replace: string,
  caseSensitive: boolean,
  replaceAll: boolean,
): Promise<{
  buffer: Uint8Array;
  count: number;
  samples: Array<{ before: string; after: string }>;
}> {
  const zip = await JSZip.loadAsync(hwpxBuffer);

  // 섹션 파일 목록 수집 (Contents/section0.xml, section1.xml, …)
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort();

  // 각 섹션 XML 읽기
  const sectionXmls: string[] = [];
  for (const sf of sectionFiles) {
    const entry = zip.file(sf);
    const xml = entry ? await entry.async("string") : "";
    sectionXmls.push(xml);
  }

  // 섹션별 치환 적용
  let totalCount = 0;
  const newSectionXmls: string[] = [];

  for (let si = 0; si < sectionFiles.length; si++) {
    const srcXml = sectionXmls[si] ?? "";

    // 1순위: kordoc splice 프리미티브. 폴백 신호(null) 시 구 정규식 경로.
    let newXml: string;
    let count: number;
    const spliced = replaceSectionViaSplices(
      srcXml,
      find,
      replace,
      caseSensitive,
      replaceAll,
      totalCount,
    );
    if (spliced !== null) {
      newXml = spliced.xml;
      count = spliced.count;
    } else {
      const fallback = replaceInSectionXml(
        srcXml,
        find,
        replace,
        caseSensitive,
        replaceAll,
        totalCount,
      );
      newXml = fallback.xml;
      count = fallback.count;
    }
    newSectionXmls.push(newXml);
    totalCount += count;

    // all=false이고 이미 1회 치환됐으면 남은 섹션은 원본 그대로
    if (!replaceAll && totalCount >= 1) {
      for (let j = si + 1; j < sectionFiles.length; j++) {
        newSectionXmls.push(sectionXmls[j] ?? "");
      }
      break;
    }
  }

  // 치환이 없으면 ZIP 재생성 불필요
  if (totalCount === 0) {
    return { buffer: hwpxBuffer, count: 0, samples: [] };
  }

  // 변경된 노드 스니펫 수집 (diff 미리보기용)
  const samples: Array<{ before: string; after: string }> = [];
  for (let si = 0; si < sectionFiles.length && samples.length < MAX_DIFF_SAMPLES; si++) {
    const remaining = MAX_DIFF_SAMPLES - samples.length;
    const snippets = collectChangedSnippets(
      sectionXmls[si] ?? "",
      newSectionXmls[si] ?? "",
      remaining,
    );
    for (const snip of snippets) {
      samples.push(snip);
    }
  }

  // 새 ZIP 생성 (mimetype은 STORE로 첫 번째 — ZIP 스펙 요구사항)
  const out = new JSZip();
  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "mimetype" || entry.dir) continue;
    const sectionIdx = sectionFiles.indexOf(name);
    if (sectionIdx >= 0) {
      out.file(name, newSectionXmls[sectionIdx] ?? "");
    } else {
      out.file(name, await entry.async("uint8array"));
    }
  }

  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    buffer: new Uint8Array(buf as unknown as ArrayBuffer),
    count: totalCount,
    samples,
  };
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeFindReplaceTool: ToolDefinition<ProposeFindReplaceInput> = {
  name: "propose_find_replace",
  description:
    "HWPX 문서 전체에서 텍스트를 찾아 바꿉니다. " +
    "본문·표·머리말·꼬리말 등 모든 섹션을 대상으로 문서 XML을 직접 패치합니다(rhwp 엔진 미사용). " +
    "이미지·표·레이아웃 등 문서 구조를 완전히 보존합니다. " +
    ".hwpx 전용입니다. .hwp(구형 OLE 바이너리)는 지원하지 않으며, " +
    "한글 프로그램에서 '다른 이름으로 저장 → .hwpx'로 저장한 후 사용하세요. " +
    "all:true(기본값)이면 모든 항목을 교체하고, all:false이면 첫 번째 매치만 교체합니다. " +
    "텍스트가 여러 서식 런에 나뉘어 있으면 경계를 가로지르는 패턴은 교체되지 않을 수 있습니다(서식이 나뉜 텍스트). " +
    "찾을 텍스트가 없으면 파일을 수정하지 않고 오류를 반환합니다. " +
    "변경 사항은 diff 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: proposeFindReplaceSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeFindReplaceInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // .hwpx 전용 — .hwp 및 기타 거부 (확장자 기반 조기 검사)
    if (ext !== ".hwpx" && ext !== ".hwp") {
      return (
        `오류: propose_find_replace는 .hwpx 파일만 지원합니다. 현재 파일 확장자: ${ext}. ` +
        ".hwpx 파일을 지정하세요."
      );
    }

    // 파일 크기 가드 — 원본 readFile 직전
    try {
      await assertFileSizeWithinLimit(safePath);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }

    // 파일 읽기
    let originalBuf: Buffer;
    try {
      originalBuf = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }

    const originalBytes = new Uint8Array(
      originalBuf.buffer,
      originalBuf.byteOffset,
      originalBuf.byteLength,
    );

    // OLE2/HWP 바이너리 가드 — 콘텐츠 기반 감지 (확장자 오인식 포함)
    const structuralGuard = hwpStructuralGuard(ext, originalBytes);
    if (structuralGuard !== null) {
      return structuralGuard;
    }

    // ZIP 매직 바이트 검증 (PK = 0x504B) — kordoc isZipFile 위임. 비-ZIP .hwpx 거부
    if (!isZipBinary(originalBytes)) {
      return (
        "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
        "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷일 수 있습니다. " +
        "한글 프로그램에서 .hwpx로 저장 후 다시 시도하세요."
      );
    }

    // XML 직접 패치 치환 수행
    let newBytes: Uint8Array;
    let replacedCount: number;
    let diffSamples: Array<{ before: string; after: string }>;
    try {
      const result = await applyFindReplaceToHwpx(
        originalBytes,
        input.find,
        input.replace,
        input.caseSensitive ?? false,
        input.all ?? true,
      );
      newBytes = result.buffer;
      replacedCount = result.count;
      diffSamples = result.samples;
    } catch (e) {
      return `오류: 치환 중 오류가 발생했습니다. ${String(e)}`;
    }

    // 찾을 텍스트가 없으면 오류 반환 (파일 무수정)
    if (replacedCount === 0) {
      const caseNote = input.caseSensitive ? " (대소문자 구분)" : "";
      return (
        `오류: 찾을 텍스트를 문서에서 발견하지 못했습니다: "${input.find}"${caseNote}. ` +
        `read_document로 문서 내용을 확인하고 정확한 텍스트를 지정하세요.`
      );
    }

    // ── 경량 검증 (경고만; 중단하지 않음) ───────────────────
    // kordoc parse()로 치환 후 남은 find 발생 횟수를 확인.
    // 서식 분리 텍스트로 인해 일부 누락됐으면 경고 추가.
    const warnings: string[] = [];

    try {
      const exportedResult = await parse(newBytes.buffer as ArrayBuffer);
      if (exportedResult.success) {
        const exportedMd = exportedResult.markdown;
        const normAfter = (input.caseSensitive ?? false) ? exportedMd : exportedMd.toLowerCase();
        const normFind = (input.caseSensitive ?? false) ? input.find : input.find.toLowerCase();
        const normReplace =
          (input.caseSensitive ?? false) ? input.replace : input.replace.toLowerCase();

        // replace가 find를 포함하지 않을 때만 잔존 여부 확인
        if (!normReplace.includes(normFind)) {
          const remaining = countOccurrences(normAfter, normFind);
          if (remaining > 0) {
            warnings.push(
              `일부 "${input.find}"(${remaining}곳)이 교체되지 않았습니다. ` +
                `텍스트가 여러 서식 런에 나뉘어 있어 경계를 가로지르는 패턴은 교체할 수 없습니다(서식이 나뉜 텍스트). ` +
                `이미 교체된 ${replacedCount}곳은 정상 반영되었습니다. ` +
                `남은 ${remaining}곳은 표 안의 셀이면 propose_cell_edit으로 한 곳씩 수정하거나, 한글 프로그램에서 직접 찾기·바꾸기로 처리하세요.`,
            );
          }
        }
      }
    } catch {
      // parse 실패 시 검증 생략 (경고 없음)
    }
    // ── 경량 검증 종료 ────────────────────────────────────────

    // 출력 경로 결정 (.hwpx → .hwpx, 포맷 변환 없음)
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);

    // diff 텍스트 생성 (per-match before→after 스니펫 미리보기)
    const allLabel = (input.all ?? true) ? `${replacedCount}곳` : "첫 번째 1곳";
    let diff: string;
    if (diffSamples.length === 0) {
      // 샘플 없음 — 폴백 (replace===find 등 극히 드문 케이스)
      diff = `찾기: "${input.find}" → 바꾸기: "${input.replace}" (${allLabel} 교체됨)`;
    } else {
      const lines: string[] = [`${replacedCount}곳 교체: "${input.find}" → "${input.replace}"`];
      for (let i = 0; i < diffSamples.length; i++) {
        const sample = diffSamples[i]!;
        lines.push(`  ${i + 1}. - ${sample.before}`);
        lines.push(`     + ${sample.after}`);
      }
      if (replacedCount > diffSamples.length) {
        lines.push(
          `  … 외 ${replacedCount - diffSamples.length}곳 (미리보기는 최대 ${MAX_DIFF_SAMPLES}곳)`,
        );
      }
      diff = lines.join("\n");
    }

    // 스테이징
    const stagedPath = await stageFile(ctx.sessionId, outputPath, newBytes);
    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "find-replace",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings,
        willConvertFormat,
        sourcePath: safePath,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(safePath, undefined, { summary: input.summary });
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
