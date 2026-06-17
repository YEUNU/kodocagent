/**
 * 문서 편집 검증 하네스 — Stage 1: 합성 픽스처 생성기
 *
 * 결정론적(Date.now/Math.random 미사용). kordoc markdownToHwpx로 .hwpx 생성.
 * docs/EVAL-SET.md §0 참조.
 */

import JSZip from "jszip";
import { markdownToHwpx } from "kordoc";

export interface Fixture {
  name: string;
  ext: ".hwpx" | ".md";
  bytes: Uint8Array;
}

// ─────────────────────────────────────────────────────────
// F1 — 사업계획 보고서 마크다운
// ─────────────────────────────────────────────────────────
//
// 삽입된 검증 요소:
//  - 'AI' 여러 번 등장
//  - 기관명 '한국문화정보원' 여러 번, 약칭 후보 '문정원'
//  - 혼재 날짜: '2026년 1월 1일' / '26.1.1' / '2026-01-01'
//  - 금액 '1500000원'
//  - 오탈자 '재고'(→ 올바른 표현: 제고)
//  - 띄어쓰기 오류 '확대 합니다'
//  - 부서명 '문화기획팀' (→ 치환 대상: 문화사업팀)
//  - 법령명 '구 정보통신망법' (→ 치환 대상: 정보통신망 이용촉진 및 정보보호 등에 관한 법률)
//  - 참고자료 번호: 1, 2, 4, 5 (3 누락)

const F1_MARKDOWN = `\
# 2026년 AI 기반 디지털 문화 사업계획 보고서

## 1. 개요

한국문화정보원은 AI 기술을 활용한 디지털 문화 서비스를 확대 합니다.
본 보고서는 2026년 1월 1일을 기준으로 작성되었으며, 문화기획팀이 주관합니다.

국민 문화 접근성을 재고하고, AI 도입 효과를 극대화하는 것이 목표입니다.

구 정보통신망법 제22조에 따라 개인정보 처리 방침을 수립하였습니다.

## 2. 추진 배경

한국문화정보원(이하 문정원)은 26.1.1 이후 디지털 전환 정책을 추진하고 있습니다.
AI 기술은 서비스 품질 향상의 핵심 수단으로 자리잡고 있습니다.

## 3. 예산

총 사업 예산은 1500000원으로 편성되었습니다.

## 4. 일정

사업 시작일: 2026-01-01

## 5. 참고자료

1. 한국문화정보원 중장기 발전 계획(2025–2030)
2. AI 기반 문화서비스 현황 보고서
4. 디지털 뉴딜 2.0 추진 계획
5. 국가 AI 전략 로드맵
`;

// ─────────────────────────────────────────────────────────
// F2 — 예산·실적 표 보고서 마크다운
// ─────────────────────────────────────────────────────────
//
// 삽입된 검증 요소:
//  - 마크다운 표(항목/금액): 1500000, 230000
//  - 본문에 총액 1730000 언급 (정합 확인용)

const F2_MARKDOWN = `\
# 2026년 예산·실적 보고서

## 1. 개요

문화기획팀이 담당하는 사업별 예산 현황입니다.

## 2. 예산 현황표

| 항목 | 금액 |
|---|---|
| 콘텐츠 제작비 | 1500000 |
| 운영비 | 230000 |

총액은 1730000원입니다.
`;

// ─────────────────────────────────────────────────────────
// F5 — 개인정보 안내문 마크다운
// ─────────────────────────────────────────────────────────
//
// 삽입된 PII:
//  - 주민등록번호: 900101-1234567
//  - 전화번호: 010-1234-5678
//  - 이메일: hong@example.com
//  - 신용카드번호: 1234-5678-9012-3456

const F5_MARKDOWN = `\
# 개인정보 처리 안내문

## 1. 수집 항목 예시

아래는 수집하는 개인정보의 예시입니다.

- 성명: 홍길동
- 주민등록번호: 900101-1234567
- 전화번호: 010-1234-5678
- 이메일: hong@example.com
- 결제카드번호: 1234-5678-9012-3456

## 2. 이용 목적

수집된 개인정보는 서비스 제공 및 본인 확인 목적으로만 사용됩니다.
`;

// ─────────────────────────────────────────────────────────
// 픽스처 생성 함수
// ─────────────────────────────────────────────────────────

/** F1 — 사업계획 보고서(.hwpx) */
export async function makeF1(): Promise<Fixture> {
  const buf = await markdownToHwpx(F1_MARKDOWN);
  return {
    name: "F1_보고서",
    ext: ".hwpx",
    bytes: new Uint8Array(buf),
  };
}

/** F2 — 예산·실적 표 보고서(.hwpx) */
export async function makeF2(): Promise<Fixture> {
  const buf = await markdownToHwpx(F2_MARKDOWN);
  return {
    name: "F2_표_보고서",
    ext: ".hwpx",
    bytes: new Uint8Array(buf),
  };
}

/**
 * F5 — 개인정보 안내문
 *  - .hwpx 변형: markdownToHwpx 경유
 *  - .md 변형:   원문 마크다운 UTF-8 바이트
 */
export async function makeF5Hwpx(): Promise<Fixture> {
  const buf = await markdownToHwpx(F5_MARKDOWN);
  return {
    name: "F5_개인정보_안내문",
    ext: ".hwpx",
    bytes: new Uint8Array(buf),
  };
}

export function makeF5Md(): Fixture {
  return {
    name: "F5_개인정보_안내문",
    ext: ".md",
    bytes: new TextEncoder().encode(F5_MARKDOWN),
  };
}

// ─────────────────────────────────────────────────────────
// 내부 HWPX ZIP 패치 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * HWPX ZIP 바이트의 section0.xml을 패처 함수로 변환한다.
 * form-objects.test.ts / propose-cell-edit.test.ts 의 buildTestHwpx 패턴을 재사용.
 */
async function patchSectionXml(
  hwpxBuf: ArrayBuffer | Uint8Array,
  patcher: (xml: string) => string,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(hwpxBuf instanceof Uint8Array ? hwpxBuf : hwpxBuf);
  const sectionEntry = zip.file("Contents/section0.xml");
  if (!sectionEntry) throw new Error("section0.xml not found");
  const originalXml = await sectionEntry.async("string");
  const patchedXml = patcher(originalXml);

  const out = new JSZip();
  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
  }
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "mimetype" || entry.dir) continue;
    if (name === "Contents/section0.xml") {
      out.file(name, patchedXml);
    } else {
      out.file(name, await entry.async("uint8array"));
    }
  }
  const nodeBuf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return new Uint8Array(nodeBuf.buffer as ArrayBuffer, nodeBuf.byteOffset, nodeBuf.byteLength);
}

// ─────────────────────────────────────────────────────────
// F3 — 신청서 양식 (라벨/값 2열, 병합 헤더, 빈 값칸)
// ─────────────────────────────────────────────────────────
//
// 구조:
//  행0: "신청서 양식" (colspan=2 병합 헤더)
//  행1: "성명"   | (빈칸)
//  행2: "생년월일" | (빈칸)
//  행3: "주소"   | "서울시 종로구 종로 1가"  ← 미리 채워진 행
//
// 마크다운 → markdownToHwpx로 기본 구조 생성 후
// 첫 번째 셀의 cellSpan을 colSpan="2"로 패치해 병합 헤더를 만든다.

const F3_MARKDOWN = `\
| 신청서 양식 |  |
|---|---|
| 성명 |  |
| 생년월일 |  |
| 주소 | 서울시 종로구 종로 1가 |
`;

/** F3 — 신청서 양식 표 (.hwpx): 병합 헤더 + 빈 값칸 */
export async function makeF3(): Promise<Fixture> {
  const baseBuf = await markdownToHwpx(F3_MARKDOWN);

  // 첫 번째 셀(row=0, col=0)의 colSpan을 2로 패치 → 병합 헤더
  const patched = await patchSectionXml(new Uint8Array(baseBuf), (xml) => {
    // markdownToHwpx는 각 셀에 colSpan="1" rowSpan="1"을 쓴다.
    // 첫 번째 cellSpan 태그만 교체한다.
    return xml.replace('colSpan="1" rowSpan="1"', 'colSpan="2" rowSpan="1"');
  });

  return {
    name: "F3_신청서_양식",
    ext: ".hwpx",
    bytes: patched,
  };
}

// ─────────────────────────────────────────────────────────
// F4 — 양식 개체 문서 (편집상자 + 콤보 + 체크박스)
// ─────────────────────────────────────────────────────────
//
// form-objects.test.ts의 buildTestHwpx 패턴을 재사용해
// markdownToHwpx로 기본 문서를 생성하고 section0.xml에 양식 개체를 주입한다.
//
// 주입 개체:
//  - hp:edit    name="성명입력" (편집상자, 빈값)
//  - hp:comboBox name="부서선택" items=[총무팀, 기획팀, 개발팀] (콤보)
//  - hp:checkBtn name="동의여부" value=UNCHECKED (체크박스)

const F4_MARKDOWN = `\
# 양식 개체 테스트 문서

아래 양식을 작성해 주세요.
`;

const F4_FORM_OBJECTS_XML = `
<hp:p xmlns:hp="urn:hancom:partype">
  <hp:run>
    <hp:edit multiLine="0" passwordChar="" maxLength="2147483647" scrollBars="NONE" tabKeyBehavior="NEXT_OBJECT" numOnly="0" readOnly="0" alignText="LEFT" name="성명입력" foreColor="#000000" backColor="#F0F0F0" groupName="" tabStop="1" editable="1" tabOrder="1" enabled="1" borderTypeIDRef="5" drawFrame="1" printable="1" command=""><hp:formCharPr charPrIDRef="0" followContext="0" autoSz="0" wordWrap="0"/><hp:text/></hp:edit>
    <hp:comboBox listBoxRows="4" listBoxWidth="0" editEnable="1" selectedValue="" name="부서선택" foreColor="#000000" backColor="#F0F0F0" groupName="" tabStop="1" editable="1" tabOrder="2" enabled="1" borderTypeIDRef="5" drawFrame="1" printable="1" command=""><hp:formCharPr charPrIDRef="0" followContext="0" autoSz="1" wordWrap="0"/><hp:listItem displayText="" value="총무팀"/><hp:listItem displayText="" value="기획팀"/><hp:listItem displayText="" value="개발팀"/></hp:comboBox>
    <hp:checkBtn caption="개인정보 수집 동의" value="UNCHECKED" radioGroupName="" triState="0" backStyle="OPAQUE" name="동의여부" foreColor="#000000" backColor="#FFFFFF" groupName="" tabStop="1" editable="1" tabOrder="3" enabled="1" borderTypeIDRef="0" drawFrame="1" printable="1" command=""><hp:formCharPr charPrIDRef="0" followContext="0" autoSz="0" wordWrap="0"/></hp:checkBtn>
  </hp:run>
</hp:p>`;

/** F4 — 양식 개체 문서 (.hwpx): 편집상자 + 콤보박스 + 체크박스 */
export async function makeF4(): Promise<Fixture> {
  const baseBuf = await markdownToHwpx(F4_MARKDOWN);

  const patched = await patchSectionXml(new Uint8Array(baseBuf), (xml) => {
    // </hs:sec> 직전에 양식 개체 단락을 삽입
    const insertPoint = xml.lastIndexOf("</");
    return xml.slice(0, insertPoint) + F4_FORM_OBJECTS_XML + xml.slice(insertPoint);
  });

  return {
    name: "F4_양식개체_문서",
    ext: ".hwpx",
    bytes: patched,
  };
}

/** 테스트·디버그용: 각 픽스처의 원본 마크다운을 반환한다. */
export const FIXTURE_MARKDOWN = {
  F1: F1_MARKDOWN,
  F2: F2_MARKDOWN,
  F3: F3_MARKDOWN,
  F4: F4_MARKDOWN,
  F5: F5_MARKDOWN,
} as const;

// ─────────────────────────────────────────────────────────
// F6 — 실 공공문서 픽스처 (gitignored eval-docs/f6/)
// ─────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

function resolveF6Dir(): string {
  const CORPUS_SUBDIR = "eval-docs/f6";
  const fromCwd = pathJoin(process.cwd(), CORPUS_SUBDIR);
  if (existsSync(fromCwd)) return fromCwd;
  // import.meta.url 기준 — packages/doc-tools/src/eval/fixtures.ts → 4단계 위가 repo root
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = pathResolve(dirname(thisFile), "../../../..");
  const fromMeta = pathJoin(repoRoot, CORPUS_SUBDIR);
  if (existsSync(fromMeta)) return fromMeta;
  return fromCwd;
}

/**
 * F6/D3 — 실 공공문서: d3_exam_social.hwpx (각주+머리말+표 46개)
 *
 * 파일이 없으면 null을 반환한다 — 의존 스펙은 파일 부재 시 SKIP해야 한다.
 */
export async function makeF6D3(): Promise<Fixture | null> {
  const f6Dir = resolveF6Dir();
  const d3Path = pathJoin(f6Dir, "d3_exam_social.hwpx");
  if (!existsSync(d3Path)) return null;
  const buf = await fsReadFile(d3Path);
  return {
    name: "F6_D3_exam_social",
    ext: ".hwpx",
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  };
}

/**
 * F6/D1 — 실 공공문서: d1_unikorea_press.hwp (통일부 보도자료)
 *
 * 파일이 없으면 null을 반환한다.
 */
export async function makeF6D1(): Promise<Fixture | null> {
  const f6Dir = resolveF6Dir();
  const d1Path = pathJoin(f6Dir, "d1_unikorea_press.hwp");
  if (!existsSync(d1Path)) return null;
  const buf = await fsReadFile(d1Path);
  return {
    name: "F6_D1_unikorea_press",
    // .hwp은 Fixture.ext 타입에 없으므로 .hwpx 로 캐스팅 (실 확장자는 .hwp이나 bytes는 그대로)
    ext: ".hwpx",
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  };
}
