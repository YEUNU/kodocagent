/**
 * 아티팩트 검사 — .hwpx ZIP+XML 파일을 직접 열어 ground truth를 추출한다.
 *
 * kordoc parse().markdown은 양식 개체 값, 각주, 머리말 텍스트, 특정 서식을 드롭한다.
 * 이 모듈은 JSZip으로 ZIP을 직접 열어 Raw XML에서 사실을 추출한다.
 *
 * 검사 대상 파일:
 *  - Contents/section*.xml
 *  - Contents/masterpage*.xml
 *  - Contents/header.xml
 */

import JSZip from "jszip";

// ─────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────

/** HWPX ZIP에서 검사 대상 XML 파일 목록을 결정한다. */
function inspectEntryNames(zip: JSZip): string[] {
  const names: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (
      /^Contents\/section\d*\.xml$/i.test(name) ||
      /^Contents\/masterpage\d*\.xml$/i.test(name) ||
      /^Contents\/header\.xml$/i.test(name)
    ) {
      names.push(name);
    }
  }
  return names;
}

/**
 * XML 엔티티 디코딩 — `&amp;` `&lt;` `&gt;` `&apos;` `&quot;` 와 `&#xNNNN;` / `&#NNNN;` 처리.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
}

/**
 * `<hp:t>...</hp:t>` 또는 `<hp:t .../>` (self-closing) 내부의 텍스트를 모두 추출한다.
 * 네임스페이스 접두사가 다를 수 있으므로 `:t>` 패턴을 허용한다.
 */
function extractHpTTexts(xml: string): string[] {
  const texts: string[] = [];
  const re = /<[a-zA-Z_][\w]*:t(?:\s[^>]*)?>([^<]*)<\/[a-zA-Z_][\w]*:t>/g;
  for (const m of xml.matchAll(re)) {
    const raw = m[1] ?? "";
    const text = decodeXmlEntities(raw);
    if (text) texts.push(text);
  }
  return texts;
}

/**
 * ブロック探索ヘルパー — 正規表現でマッチした開始位置から閉じタグまでを切り出す。
 * 各マッチ位置と閉じタグ名を受け取りブロック文字列の配列を返す。
 */
function extractBlocks(
  xml: string,
  openRe: RegExp,
  closeTagFn: (prefix: string) => string,
): string[] {
  const blocks: string[] = [];
  for (const m of xml.matchAll(openRe)) {
    const prefix = m[1] ?? "hp";
    const closeTag = closeTagFn(prefix);
    const blockStart = m.index ?? 0;
    const blockEnd = xml.indexOf(closeTag, blockStart);
    if (blockEnd === -1) continue;
    blocks.push(xml.slice(blockStart, blockEnd + closeTag.length));
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────
// 공개 API
// ─────────────────────────────────────────────────────────

/**
 * .hwpx ZIP을 열고 검사 대상 XML 파일들을 연결한 전체 raw 문자열을 반환한다.
 * (section*.xml + masterpage*.xml + header.xml)
 */
export async function hwpxRawXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = inspectEntryNames(zip);
  const parts: string[] = [];
  for (const name of names.sort()) {
    const entry = zip.file(name);
    if (entry) {
      parts.push(await entry.async("string"));
    }
  }
  return parts.join("\n");
}

/**
 * `<hp:t>` 요소 내부 텍스트에 `needle`이 존재하는지 확인한다.
 * XML 엔티티를 디코딩한 후 비교한다.
 */
export async function hwpxContainsText(bytes: Uint8Array, needle: string): Promise<boolean> {
  const xml = await hwpxRawXml(bytes);
  const texts = extractHpTTexts(xml);
  return texts.some((t) => t.includes(needle));
}

/**
 * 이름이 `name`인 양식 개체(편집상자 hp:edit)의 현재 텍스트를 반환한다.
 *
 * 탐색 전략:
 *  1. `name="<name>"` 속성을 가진 `<hp:edit ...>` 요소를 찾는다.
 *  2. 해당 요소 내부의 `<hp:text>` 혹은 `<hp:t>` 텍스트를 반환한다.
 *  3. 값이 없으면 `""` 반환. 요소 자체가 없으면 `null` 반환.
 */
export async function hwpxFormObjectValue(bytes: Uint8Array, name: string): Promise<string | null> {
  const xml = await hwpxRawXml(bytes);

  // name 속성 매칭 (큰따옴표 또는 작은따옴표 허용)
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameAttrRe = new RegExp(`name=["']${escapedName}["']`);

  // hp:edit 블록 찾기 — 여러 줄에 걸칠 수 있으므로 전체 XML 스캔
  const editOpenRe = /<([a-zA-Z_][\w]*):edit\s/g;
  const blocks = extractBlocks(xml, editOpenRe, (prefix) => `</${prefix}:edit>`);

  for (const block of blocks) {
    if (!nameAttrRe.test(block)) continue;
    // 편집상자 값은 <hp:text> 자식에 저장된다(propose_form_object 기준 — form-objects.ts).
    // 먼저 <hp:text> 내부를 읽고(내부 태그 제거 + 엔티티 디코딩), 없으면 <hp:t> fallback.
    const textEl = block.match(
      /<[a-zA-Z_][\w]*:text(?:\s[^>]*)?>([\s\S]*?)<\/[a-zA-Z_][\w]*:text>/,
    );
    if (textEl) {
      const inner = (textEl[1] ?? "").replace(/<[^>]+>/g, "");
      const decoded = decodeXmlEntities(inner).trim();
      if (decoded) return decoded;
    }
    const innerTexts = extractHpTTexts(block);
    return innerTexts.join("");
  }

  return null;
}

/**
 * 문서 전체의 표 행(`<hp:tr>`) 수를 반환한다. markdown은 빈 행을 드롭하므로,
 * 행 추가/삭제 검증은 이 XML 카운트로 한다(중첩표 행 포함).
 */
export async function hwpxRowCount(bytes: Uint8Array): Promise<number> {
  const xml = await hwpxRawXml(bytes);
  return (xml.match(/<[a-zA-Z_][\w]*:tr[\s>]/g) ?? []).length;
}

/**
 * 문서의 각주(`<hp:footNote ...>...</hp:footNote>`) 내부 텍스트 목록을 반환한다.
 *
 * 각 각주 블록의 `<hp:t>` 텍스트를 연결한 문자열이 배열 항목이 된다.
 */
export async function hwpxFootnoteTexts(bytes: Uint8Array): Promise<string[]> {
  const xml = await hwpxRawXml(bytes);

  // hp:footNote 블록 탐색 — <hp:footNote ...> ... </hp:footNote>
  const footNoteOpenRe = /<([a-zA-Z_][\w]*):footNote[\s>]/g;
  const blocks = extractBlocks(xml, footNoteOpenRe, (prefix) => `</${prefix}:footNote>`);

  const results: string[] = [];
  for (const block of blocks) {
    const texts = extractHpTTexts(block);
    const combined = texts.join("").trim();
    if (combined) results.push(combined);
  }
  return results;
}

/**
 * 최상위 `<hp:tbl>` 요소 수를 반환한다 — 중첩된 tbl은 제외한다.
 *
 * 깊이 카운터: `<hp:tbl` 을 만나면 depth++, `</hp:tbl>` 을 만나면 depth--.
 * depth === 0 에서 `<hp:tbl` 를 만나는 경우만 집계한다.
 */
export async function hwpxTopLevelTableCount(bytes: Uint8Array): Promise<number> {
  const xml = await hwpxRawXml(bytes);

  let count = 0;
  let depth = 0;

  // 간단한 선형 스캔 — <hp:tbl 과 </hp:tbl> 위치 찾기
  // 네임스페이스 접두사 변동 허용
  const tokenRe = /<(\/?)([a-zA-Z_][\w]*:tbl)[\s>/]/g;
  for (const m of xml.matchAll(tokenRe)) {
    const isClose = m[1] === "/";
    if (!isClose) {
      if (depth === 0) count++;
      depth++;
    } else {
      if (depth > 0) depth--;
    }
  }
  return count;
}
