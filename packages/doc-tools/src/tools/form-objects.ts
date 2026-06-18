/**
 * HWPX 양식 개체(form object) 읽기/쓰기 툴
 *
 * list_form_objects  — 읽기 전용: 문서의 양식 개체 목록 열거
 * propose_form_object — 쓰기: 양식 개체 값 패치 (승인 필요)
 *
 * kordoc IR에 양식 개체 타입이 없으므로 propose_cell_edit과 동일하게
 * .hwpx ZIP 안의 section XML을 직접 읽고 패치한다.
 *
 * 지원 타입 (확인된 XML 구조):
 *   hp:btn       — caption 속성 (PushButton)
 *   hp:checkBtn  — value 속성 CHECKED|UNCHECKED (CheckBox)
 *   hp:radioBtn  — value 속성 CHECKED|UNCHECKED (RadioButton)
 *   hp:comboBox  — selectedValue 속성, hp:listItem 자식 (ComboBox)
 *   hp:edit      — <hp:text> 자식 내용 (Edit)
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import {
  assertFileSizeWithinLimit,
  hwpStructuralGuard,
  isZipBinary,
  resolveSafePath,
} from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────

export type FormObjectType = "button" | "checkBox" | "radioButton" | "comboBox" | "edit";

export interface FormObjectInfo {
  /** 문서 전체 0-based 인덱스 (섹션 경계 무관) */
  index: number;
  /** name 속성 */
  name: string;
  type: FormObjectType;
  /** 현재 값: button=caption, checkBox/radioButton=boolean, comboBox=selectedValue, edit=텍스트 */
  currentValue: string | boolean;
  /** comboBox 전용: 선택 가능한 항목 value 목록 */
  comboItems?: string[];
  /** 이 객체가 속한 섹션 파일명 (e.g. "Contents/section0.xml") */
  sectionFile: string;
  /** 섹션 XML 내 태그 시작 위치 */
  posInSection: number;
}

// ─────────────────────────────────────────────────────────
// 순수 XML 파싱 함수
// ─────────────────────────────────────────────────────────

/**
 * XML 특수문자를 이스케이프한다.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * XML 엔티티를 디코딩한다.
 */
function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * 여는 태그에서 특정 속성 값을 추출한다.
 * openTag: <hp:btn ... name="PushButton" ...> 같은 문자열
 */
function getAttr(openTag: string, attr: string): string {
  const re = new RegExp(`\\b${attr}="([^"]*)"`, "");
  const m = re.exec(openTag);
  return m ? decodeXml(m[1] ?? "") : "";
}

/**
 * 섹션 XML에서 모든 양식 개체를 순서대로 파싱한다.
 * index는 이 함수 호출 시 시작 인덱스(startIndex)부터 부여된다.
 *
 * @param xml         섹션 XML 문자열
 * @param sectionFile 섹션 파일명 (메타용)
 * @param startIndex  이 섹션의 첫 객체에 부여할 전역 인덱스
 */
export function parseFormObjects(
  xml: string,
  sectionFile: string,
  startIndex = 0,
): FormObjectInfo[] {
  const results: FormObjectInfo[] = [];
  let idx = startIndex;

  // 양식 개체 태그별 정규식: 여는 태그 위치를 찾고, 해당 요소 전체를 추출한다.
  // 단순 선형 스캔: 양식 개체는 리프 요소로 동일 종류 중첩 없음.
  const tagSpecs: Array<{ xmlTag: string; type: FormObjectType }> = [
    { xmlTag: "hp:btn", type: "button" },
    { xmlTag: "hp:checkBtn", type: "checkBox" },
    { xmlTag: "hp:radioBtn", type: "radioButton" },
    { xmlTag: "hp:comboBox", type: "comboBox" },
    { xmlTag: "hp:edit", type: "edit" },
  ];

  // 전체 XML에서 양식 개체 여는 태그 위치를 수집하여 소스 순서로 정렬
  interface FormHit {
    pos: number;
    xmlTag: string;
    type: FormObjectType;
  }
  const hits: FormHit[] = [];

  for (const spec of tagSpecs) {
    const re = new RegExp(`<${spec.xmlTag}\\b`, "g");
    for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
      hits.push({ pos: m.index, xmlTag: spec.xmlTag, type: spec.type });
    }
  }

  // 소스 순서로 정렬
  hits.sort((a, b) => a.pos - b.pos);

  for (const hit of hits) {
    const { pos, xmlTag, type } = hit;

    // 여는 태그 끝 위치 찾기 (> 까지)
    const openTagEnd = xml.indexOf(">", pos);
    if (openTagEnd < 0) continue;
    const openTag = xml.slice(pos, openTagEnd + 1);

    // 닫는 태그 찾기
    const closeTag = `</${xmlTag}>`;
    const closeIdx = xml.indexOf(closeTag, openTagEnd);
    if (closeIdx < 0) continue;

    const elementEnd = closeIdx + closeTag.length;
    const elementXml = xml.slice(pos, elementEnd);

    const name = getAttr(openTag, "name");

    let currentValue: string | boolean;
    let comboItems: string[] | undefined;

    switch (type) {
      case "button":
        currentValue = getAttr(openTag, "caption");
        break;
      case "checkBox":
      case "radioButton":
        currentValue = getAttr(openTag, "value") === "CHECKED";
        break;
      case "comboBox": {
        currentValue = getAttr(openTag, "selectedValue");
        // hp:listItem 자식에서 value 속성 수집
        const listItemRe = /<hp:listItem\b[^>]*/g;
        const items: string[] = [];
        for (let lm = listItemRe.exec(elementXml); lm !== null; lm = listItemRe.exec(elementXml)) {
          const itemValue = getAttr(lm[0] ?? "", "value");
          items.push(itemValue);
        }
        comboItems = items;
        break;
      }
      case "edit": {
        // <hp:text>VALUE</hp:text> 또는 <hp:text/> (빈 경우)
        const textSelfClose = /<hp:text\s*\/>/;
        const textOpen = /<hp:text>/;
        const textClose = "</hp:text>";
        if (textSelfClose.test(elementXml)) {
          currentValue = "";
        } else {
          const tOpenIdx = elementXml.search(textOpen);
          if (tOpenIdx >= 0) {
            const afterOpen = elementXml.indexOf(">", tOpenIdx) + 1;
            const closePos = elementXml.indexOf(textClose, afterOpen);
            currentValue = closePos >= 0 ? decodeXml(elementXml.slice(afterOpen, closePos)) : "";
          } else {
            currentValue = "";
          }
        }
        break;
      }
    }

    results.push({
      index: idx++,
      name,
      type,
      currentValue,
      comboItems,
      sectionFile,
      posInSection: pos,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────
// 순수 XML 패치 함수
// ─────────────────────────────────────────────────────────

export interface FormObjectEditRequest {
  /** 대상 FormObjectInfo */
  target: FormObjectInfo;
  set: FormEditSet;
  expected?: FormEditExpected;
}

export interface FormEditSet {
  caption?: string;
  checked?: boolean;
  selected?: string;
  text?: string;
}

export interface FormEditExpected {
  caption?: string;
  checked?: boolean;
  selected?: string;
  text?: string;
}

export interface FormObjectEditResult {
  success: boolean;
  oldValue?: string | boolean;
  error?: string;
}

/**
 * 단일 섹션 XML에 양식 개체 편집 목록을 적용한다. 순수 함수.
 *
 * - 모든 편집이 성공해야 newXml이 변경됨. 실패 시 newXml === xml.
 * - 속성 교체는 해당 요소의 여는 태그 범위로만 한정.
 * - hp:edit의 텍스트 교체는 해당 요소 내 <hp:text> 범위로만 한정.
 */
export function applyFormObjectEdits(
  xml: string,
  edits: FormObjectEditRequest[],
): { newXml: string; results: FormObjectEditResult[] } {
  const results: FormObjectEditResult[] = edits.map(() => ({ success: false }));

  interface Patch {
    from: number;
    to: number;
    text: string;
  }
  const patches: Patch[] = [];

  for (let ei = 0; ei < edits.length; ei++) {
    const edit = edits[ei] as FormObjectEditRequest;
    const { target, set, expected } = edit;

    // 섹션 내 위치로 요소 범위 확정
    const pos = target.posInSection;
    const xmlTag = typeToXmlTag(target.type);
    const openTagEnd = xml.indexOf(">", pos);
    if (openTagEnd < 0) {
      results[ei] = {
        success: false,
        error: `양식 개체 "${target.name}" 여는 태그 끝을 찾을 수 없습니다.`,
      };
      continue;
    }
    const _openTag = xml.slice(pos, openTagEnd + 1);

    const closeTag = `</${xmlTag}>`;
    const closeIdx = xml.indexOf(closeTag, openTagEnd);
    if (closeIdx < 0) {
      results[ei] = {
        success: false,
        error: `양식 개체 "${target.name}" 닫는 태그를 찾을 수 없습니다.`,
      };
      continue;
    }
    const elementEnd = closeIdx + closeTag.length;

    // 타입 검증: set의 키가 타입에 맞는지 확인
    const typeError = validateSetForType(target.type, set);
    if (typeError) {
      results[ei] = { success: false, error: typeError };
      continue;
    }

    // 현재 값 읽기 (expected 검증 및 oldValue 기록용)
    const currentRaw = readCurrentValue(
      xml,
      pos,
      openTagEnd,
      openTagEnd + 1,
      elementEnd,
      target.type,
    );

    // expected 검증
    if (expected !== undefined) {
      const mismatch = checkExpected(expected, currentRaw, target);
      if (mismatch) {
        results[ei] = { success: false, error: mismatch };
        continue;
      }
    }

    // comboBox: selected 값 유효성 검증
    if (target.type === "comboBox" && set.selected !== undefined) {
      const items = target.comboItems ?? [];
      if (!items.includes(set.selected)) {
        const validList = items.map((v) => `"${v}"`).join(", ");
        results[ei] = {
          success: false,
          error:
            `comboBox "${target.name}"의 selected 값 "${set.selected}"이 유효한 항목이 아닙니다. ` +
            `유효한 항목: ${validList || "(없음)"}`,
        };
        continue;
      }
    }

    // 패치 생성
    let patchCreated = false;
    if (set.caption !== undefined) {
      // caption 속성 교체 — 여는 태그 범위만
      const patch = replaceAttrInOpenTag(xml, pos, openTagEnd, "caption", escapeXml(set.caption));
      if (!patch) {
        results[ei] = {
          success: false,
          error: `양식 개체 "${target.name}"의 caption 속성을 찾을 수 없습니다.`,
        };
        continue;
      }
      patches.push(patch);
      patchCreated = true;
    } else if (set.checked !== undefined) {
      // value 속성 교체 (CHECKED|UNCHECKED) — 여는 태그 범위만
      const newValue = set.checked ? "CHECKED" : "UNCHECKED";
      const patch = replaceAttrInOpenTag(xml, pos, openTagEnd, "value", newValue);
      if (!patch) {
        results[ei] = {
          success: false,
          error: `양식 개체 "${target.name}"의 value 속성을 찾을 수 없습니다.`,
        };
        continue;
      }
      patches.push(patch);
      patchCreated = true;
    } else if (set.selected !== undefined) {
      // selectedValue 속성 교체 — 여는 태그 범위만
      const patch = replaceAttrInOpenTag(
        xml,
        pos,
        openTagEnd,
        "selectedValue",
        escapeXml(set.selected),
      );
      if (!patch) {
        results[ei] = {
          success: false,
          error: `양식 개체 "${target.name}"의 selectedValue 속성을 찾을 수 없습니다.`,
        };
        continue;
      }
      patches.push(patch);
      patchCreated = true;
    } else if (set.text !== undefined) {
      // <hp:text> 자식 교체 — 요소 내부 범위만
      const elementContent = xml.slice(pos, elementEnd);
      const textPatch = replaceEditText(xml, pos, elementContent, set.text);
      if (!textPatch) {
        results[ei] = {
          success: false,
          error: `양식 개체 "${target.name}"의 <hp:text> 요소를 찾을 수 없습니다.`,
        };
        continue;
      }
      patches.push(textPatch);
      patchCreated = true;
    }

    if (!patchCreated) {
      results[ei] = { success: false, error: `편집 #${ei + 1}: set 필드가 없습니다.` };
      continue;
    }

    results[ei] = { success: true, oldValue: currentRaw };
  }

  // 실패한 편집이 있으면 XML 무변경
  if (results.some((r) => !r.success)) {
    return { newXml: xml, results };
  }

  // 모든 패치를 뒤에서 앞으로 적용
  const sortedPatches = [...patches].sort((a, b) => b.from - a.from);
  let result = xml;
  for (const patch of sortedPatches) {
    result = result.slice(0, patch.from) + patch.text + result.slice(patch.to);
  }

  return { newXml: result, results };
}

/**
 * FormObjectType → XML 태그명
 */
function typeToXmlTag(type: FormObjectType): string {
  switch (type) {
    case "button":
      return "hp:btn";
    case "checkBox":
      return "hp:checkBtn";
    case "radioButton":
      return "hp:radioBtn";
    case "comboBox":
      return "hp:comboBox";
    case "edit":
      return "hp:edit";
  }
}

/**
 * set 필드와 타입 일치 여부 검증. 오류 메시지 반환, 통과 시 null.
 */
function validateSetForType(type: FormObjectType, set: FormEditSet): string | null {
  const key = Object.keys(set).find((k) => set[k as keyof FormEditSet] !== undefined);
  if (!key) return "set 필드가 비어있습니다. caption/checked/selected/text 중 하나를 지정하세요.";

  const allowed: Record<FormObjectType, string> = {
    button: "caption",
    checkBox: "checked",
    radioButton: "checked",
    comboBox: "selected",
    edit: "text",
  };

  if (key !== allowed[type]) {
    const typeKo: Record<FormObjectType, string> = {
      button: "PushButton",
      checkBox: "CheckBox",
      radioButton: "RadioButton",
      comboBox: "ComboBox",
      edit: "Edit",
    };
    return (
      `타입 불일치: ${typeKo[type]} 양식 개체에는 "${allowed[type]}" 필드만 사용 가능하지만 ` +
      `"${key}"이(가) 지정되었습니다.`
    );
  }
  return null;
}

/**
 * 현재 값을 읽어 string | boolean으로 반환한다.
 * oldValue 기록 및 expected 검증에 사용.
 */
function readCurrentValue(
  xml: string,
  pos: number,
  openTagEnd: number,
  _afterOpen: number,
  elementEnd: number,
  type: FormObjectType,
): string | boolean {
  const openTag = xml.slice(pos, openTagEnd + 1);
  switch (type) {
    case "button":
      return decodeXml(getAttr(openTag, "caption"));
    case "checkBox":
    case "radioButton":
      return getAttr(openTag, "value") === "CHECKED";
    case "comboBox":
      return decodeXml(getAttr(openTag, "selectedValue"));
    case "edit": {
      const elementContent = xml.slice(pos, elementEnd);
      if (/<hp:text\s*\/>/.test(elementContent)) return "";
      const tOpenIdx = elementContent.search(/<hp:text>/);
      if (tOpenIdx >= 0) {
        const afterOpen = elementContent.indexOf(">", tOpenIdx) + 1;
        const closePos = elementContent.indexOf("</hp:text>", afterOpen);
        return closePos >= 0 ? decodeXml(elementContent.slice(afterOpen, closePos)) : "";
      }
      return "";
    }
  }
}

/**
 * expected 값과 현재 값을 비교하여 불일치 시 오류 메시지 반환.
 */
function checkExpected(
  expected: FormEditExpected,
  currentRaw: string | boolean,
  target: FormObjectInfo,
): string | null {
  let expectedVal: string | boolean | undefined;
  if (expected.caption !== undefined) expectedVal = expected.caption;
  else if (expected.checked !== undefined) expectedVal = expected.checked;
  else if (expected.selected !== undefined) expectedVal = expected.selected;
  else if (expected.text !== undefined) expectedVal = expected.text;

  if (expectedVal === undefined) return null;

  const matches =
    typeof expectedVal === "boolean"
      ? currentRaw === expectedVal
      : String(currentRaw) === String(expectedVal);

  if (!matches) {
    return (
      `양식 개체 "${target.name}" 현재 값이 예상값과 다릅니다. ` +
      `예상: ${JSON.stringify(expectedVal)}, 실제: ${JSON.stringify(currentRaw)}. 수정하지 않습니다.`
    );
  }
  return null;
}

/**
 * 여는 태그 내의 특정 속성 값을 교체하는 패치를 생성한다.
 * 교체 범위는 반드시 tagStart~tagEnd(여는 태그) 안으로 한정된다.
 */
function replaceAttrInOpenTag(
  xml: string,
  tagStart: number,
  tagEnd: number,
  attr: string,
  newValue: string,
): { from: number; to: number; text: string } | null {
  // 여는 태그 내에서만 속성 검색
  const tagStr = xml.slice(tagStart, tagEnd + 1);
  const re = new RegExp(`\\b(${attr}=")([^"]*)(")`, "");
  const m = re.exec(tagStr);
  if (!m) return null;

  const relFrom = m.index + (m[1]?.length ?? 0);
  const relTo = relFrom + (m[2]?.length ?? 0);

  return {
    from: tagStart + relFrom,
    to: tagStart + relTo,
    text: newValue,
  };
}

/**
 * hp:edit 요소 내의 <hp:text> 자식을 교체하는 패치를 생성한다.
 * elementContent는 xml.slice(pos, elementEnd).
 */
function replaceEditText(
  _xml: string,
  pos: number,
  elementContent: string,
  newText: string,
): { from: number; to: number; text: string } | null {
  const escaped = escapeXml(newText);

  // <hp:text/> (self-closing) → <hp:text>VALUE</hp:text>
  const selfCloseRe = /<hp:text\s*\/>/;
  const scm = selfCloseRe.exec(elementContent);
  if (scm) {
    return {
      from: pos + scm.index,
      to: pos + scm.index + scm[0].length,
      text: `<hp:text>${escaped}</hp:text>`,
    };
  }

  // <hp:text>OLD</hp:text> → <hp:text>NEW</hp:text>
  const openRe = /<hp:text>/;
  const om = openRe.exec(elementContent);
  if (om) {
    const afterOpen = om.index + om[0].length;
    const closePos = elementContent.indexOf("</hp:text>", afterOpen);
    if (closePos < 0) return null;
    return {
      from: pos + afterOpen,
      to: pos + closePos,
      text: escaped,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// ZIP 처리 공통 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * .hwpx ZIP에서 모든 섹션 XML을 읽어 FormObjectInfo 목록을 반환한다.
 */
async function listFormObjectsFromZip(
  zip: JSZip,
): Promise<{ objects: FormObjectInfo[]; sectionFiles: string[]; sectionXmls: string[] }> {
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort();

  const sectionXmls: string[] = [];
  const objects: FormObjectInfo[] = [];
  let globalIndex = 0;

  for (const sf of sectionFiles) {
    const entry = zip.file(sf);
    const xml = entry ? await entry.async("string") : "";
    sectionXmls.push(xml);

    const parsed = parseFormObjects(xml, sf, globalIndex);
    objects.push(...parsed);
    globalIndex += parsed.length;
  }

  return { objects, sectionFiles, sectionXmls };
}

/**
 * .hwpx 버퍼의 ZIP 헤더와 확장자를 검증하고 오류 메시지를 반환한다.
 * OLE2/HWP 바이너리는 hwpStructuralGuard로 구체적인 안내를 반환한다.
 * 통과 시 null 반환.
 */
function validateHwpxBuffer(ext: string, buffer: Uint8Array): string | null {
  if (ext !== ".hwpx" && ext !== ".hwp") {
    return `오류: 이 툴은 .hwpx 파일만 지원합니다. 현재 파일 확장자: ${ext}`;
  }
  // OLE2/HWP 바이너리 가드 — 콘텐츠 기반 감지 (확장자 오인식 포함)
  const structuralGuard = hwpStructuralGuard(ext, buffer);
  if (structuralGuard !== null) {
    return structuralGuard;
  }
  // ZIP 매직 바이트 검증 (PK = 0x504B) — kordoc isZipFile 위임
  if (!isZipBinary(buffer)) {
    return (
      "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
      "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷입니다."
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

export const listFormObjectsSchema = z.object({
  path: z.string().describe("읽을 .hwpx 파일 경로"),
});
export type ListFormObjectsInput = z.infer<typeof listFormObjectsSchema>;

const formEditSetSchema = z
  .object({
    caption: z.string().optional().describe("PushButton 캡션 텍스트"),
    checked: z.boolean().optional().describe("CheckBox/RadioButton 체크 상태 (true=CHECKED)"),
    selected: z.string().optional().describe("ComboBox 선택 값 (listItem 중 하나여야 함)"),
    text: z.string().optional().describe("Edit 텍스트 내용"),
  })
  .refine(
    (v) => {
      const keys = (["caption", "checked", "selected", "text"] as const).filter(
        (k) => v[k] !== undefined,
      );
      return keys.length === 1;
    },
    { message: "set 필드는 caption/checked/selected/text 중 정확히 하나만 지정해야 합니다." },
  );

const formEditExpectedSchema = z
  .object({
    caption: z.string().optional(),
    checked: z.boolean().optional(),
    selected: z.string().optional(),
    text: z.string().optional(),
  })
  .optional();

const formEditItemSchema = z.object({
  name: z.string().describe("양식 개체의 name 속성 값"),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("동일 name이 여럿인 경우 문서 전체 0-based 인덱스로 구분"),
  set: formEditSetSchema.describe("변경할 값 (caption/checked/selected/text 중 하나)"),
  expected: formEditExpectedSchema.describe(
    "현재 값 사전 검증 (안전 옵션). 실제 값이 다르면 이 편집을 취소하고 오류 반환.",
  ),
});

export const proposeFormObjectSchema = z.object({
  path: z.string().describe("수정할 .hwpx 파일 경로"),
  edits: z.array(formEditItemSchema).min(1).describe("양식 개체 편집 목록"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});
export type ProposeFormObjectInput = z.infer<typeof proposeFormObjectSchema>;

// ─────────────────────────────────────────────────────────
// list_form_objects 툴
// ─────────────────────────────────────────────────────────

export const listFormObjectsTool: ToolDefinition<ListFormObjectsInput> = {
  name: "list_form_objects",
  description:
    "HWPX 문서의 양식 개체(form object) 목록을 열거합니다. " +
    "PushButton, CheckBox, RadioButton, ComboBox, Edit 다섯 가지 타입을 지원합니다. " +
    "각 양식 개체의 이름(name), 타입, 현재 값, ComboBox의 경우 선택 가능한 항목 목록을 반환합니다. " +
    "propose_form_object로 값을 수정하기 전에 이 툴로 먼저 현재 상태를 확인하세요. " +
    ".hwpx 파일 전용입니다.",
  inputSchema: listFormObjectsSchema,
  requiresApproval: false,

  execute: async ({
    input,
    ctx,
  }: {
    input: ListFormObjectsInput;
    ctx: ToolContext;
  }): Promise<string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    let buffer: Buffer;
    try {
      buffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}`;
    }

    const validationError = validateHwpxBuffer(ext, new Uint8Array(buffer.buffer as ArrayBuffer));
    if (validationError) return validationError;

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(new Uint8Array(buffer.buffer as ArrayBuffer));
    } catch {
      return "오류: .hwpx(ZIP) 파일을 열 수 없습니다. 파일이 손상되었을 수 있습니다.";
    }

    const { objects } = await listFormObjectsFromZip(zip);

    if (objects.length === 0) {
      return "이 문서에는 양식 개체(form object)가 없습니다.";
    }

    const lines: string[] = [`총 ${objects.length}개의 양식 개체가 발견되었습니다.\n`];

    const typeKo: Record<FormObjectType, string> = {
      button: "PushButton",
      checkBox: "CheckBox",
      radioButton: "RadioButton",
      comboBox: "ComboBox",
      edit: "Edit",
    };

    for (const obj of objects) {
      let valueStr: string;
      if (typeof obj.currentValue === "boolean") {
        valueStr = obj.currentValue ? "체크됨 (CHECKED)" : "체크 해제됨 (UNCHECKED)";
      } else {
        valueStr = `"${obj.currentValue}"`;
      }

      let line = `[${obj.index}] name="${obj.name}" | 타입: ${typeKo[obj.type]} | 현재 값: ${valueStr}`;

      if (obj.type === "comboBox" && obj.comboItems) {
        const itemList = obj.comboItems.map((v) => `"${v}"`).join(", ");
        line += ` | 항목: [${itemList}]`;
      }

      lines.push(line);
    }

    return lines.join("\n");
  },
};

// ─────────────────────────────────────────────────────────
// propose_form_object 툴
// ─────────────────────────────────────────────────────────

export const proposeFormObjectTool: ToolDefinition<ProposeFormObjectInput> = {
  name: "propose_form_object",
  description:
    "HWPX 문서의 양식 개체(form object) 값을 XML 직접 패치 방식으로 수정합니다. " +
    "PushButton(caption), CheckBox/RadioButton(checked), ComboBox(selected), Edit(text)를 수정할 수 있습니다. " +
    "kordoc IR에 양식 개체 타입이 없으므로 section XML을 직접 패치합니다. " +
    "수정 전에 list_form_objects로 현재 상태를 확인하세요. " +
    "name이 중복된 경우 index로 대상을 지정하세요. " +
    "변경 사항은 사용자 승인 후에만 저장됩니다. .hwpx 파일 전용입니다.",
  inputSchema: proposeFormObjectSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeFormObjectInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // 파일 크기 가드 — 원본 readFile 직전
    try {
      await assertFileSizeWithinLimit(safePath);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }

    let originalBuffer: Buffer;
    try {
      originalBuffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}`;
    }

    const bufArray = new Uint8Array(originalBuffer.buffer as ArrayBuffer);
    const validationError = validateHwpxBuffer(ext, bufArray);
    if (validationError) return validationError;

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bufArray);
    } catch {
      return "오류: .hwpx(ZIP) 파일을 열 수 없습니다. 파일이 손상되었을 수 있습니다.";
    }

    const { objects, sectionFiles, sectionXmls } = await listFormObjectsFromZip(zip);

    // 각 편집 항목의 대상 FormObjectInfo를 찾는다
    interface ResolvedEdit {
      target: FormObjectInfo;
      set: FormEditSet;
      expected?: FormEditExpected;
      editIdx: number;
    }
    const resolvedEdits: ResolvedEdit[] = [];
    const resolveErrors: string[] = [];

    for (let ei = 0; ei < input.edits.length; ei++) {
      const edit = input.edits[ei];
      if (!edit) continue;

      // name으로 후보 찾기
      const candidates = objects.filter((o) => o.name === edit.name);

      if (candidates.length === 0) {
        resolveErrors.push(
          `편집 #${ei + 1}: name="${edit.name}"인 양식 개체를 찾을 수 없습니다. ` +
            `list_form_objects로 문서의 양식 개체 목록을 확인하세요.`,
        );
        continue;
      }

      let target: FormObjectInfo;
      if (candidates.length > 1) {
        // 동일 name이 여럿 — index 필수
        if (edit.index === undefined) {
          const indices = candidates.map((c) => c.index).join(", ");
          resolveErrors.push(
            `편집 #${ei + 1}: name="${edit.name}"인 양식 개체가 ${candidates.length}개 발견되었습니다 ` +
              `(문서 인덱스: ${indices}). index 필드로 대상을 지정하세요.`,
          );
          continue;
        }
        const byIndex = candidates.find((c) => c.index === edit.index);
        if (!byIndex) {
          resolveErrors.push(
            `편집 #${ei + 1}: name="${edit.name}", index=${edit.index}인 양식 개체를 찾을 수 없습니다.`,
          );
          continue;
        }
        target = byIndex;
      } else {
        // 후보 1개
        target = candidates[0] as FormObjectInfo;
        // index가 지정된 경우 일치 검증
        if (edit.index !== undefined && edit.index !== target.index) {
          resolveErrors.push(
            `편집 #${ei + 1}: name="${edit.name}"의 문서 인덱스는 ${target.index}이지만 ` +
              `index=${edit.index}가 지정되었습니다.`,
          );
          continue;
        }
      }

      resolvedEdits.push({
        target,
        set: edit.set as FormEditSet,
        expected: edit.expected as FormEditExpected | undefined,
        editIdx: ei,
      });
    }

    if (resolveErrors.length > 0) {
      return `오류: 다음 편집 대상을 찾을 수 없어 파일을 수정하지 않았습니다.\n${resolveErrors.join("\n")}`;
    }

    // 섹션별로 편집 분배
    const sectionEditMap = new Map<number, FormObjectEditRequest[]>();
    for (const re of resolvedEdits) {
      const si = sectionFiles.indexOf(re.target.sectionFile);
      if (si < 0) continue;
      if (!sectionEditMap.has(si)) sectionEditMap.set(si, []);
      sectionEditMap.get(si)!.push({
        target: re.target,
        set: re.set,
        expected: re.expected,
      });
    }

    // 각 섹션에 편집 적용
    interface SectionResult {
      si: number;
      results: FormObjectEditResult[];
      edits: FormObjectEditRequest[];
    }
    const sectionResults: SectionResult[] = [];
    const newSectionXmls = [...sectionXmls];

    for (const [si, edits] of sectionEditMap) {
      const xml = sectionXmls[si] ?? "";
      const { newXml, results } = applyFormObjectEdits(xml, edits);
      newSectionXmls[si] = newXml;
      sectionResults.push({ si, results, edits });
    }

    // 실패 여부 확인 (resolvedEdits 순서로)
    const failMessages: string[] = [];
    const successMap = new Map<number, FormObjectEditResult>();

    for (const sr of sectionResults) {
      for (let i = 0; i < sr.edits.length; i++) {
        const editReq = sr.edits[i] as FormObjectEditRequest;
        const result = sr.results[i] as FormObjectEditResult;
        // resolvedEdits에서 같은 target의 editIdx를 찾는다
        const resolved = resolvedEdits.find((r) => r.target === editReq.target);
        if (resolved) {
          successMap.set(resolved.editIdx, result);
          if (!result.success) {
            failMessages.push(
              `편집 #${resolved.editIdx + 1} (name="${editReq.target.name}"): ${result.error}`,
            );
          }
        }
      }
    }

    if (failMessages.length > 0) {
      return `오류: 다음 편집을 적용할 수 없어 파일을 수정하지 않았습니다.\n${failMessages.join("\n")}`;
    }

    // 새 ZIP 생성 (mimetype은 STORE로 첫 번째)
    const out = new JSZip();
    const mimetypeEntry = zip.file("mimetype");
    if (mimetypeEntry) {
      out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
    }

    for (const [name, entry] of Object.entries(zip.files)) {
      if (name === "mimetype" || entry.dir) continue;
      const si = sectionFiles.indexOf(name);
      if (si >= 0) {
        out.file(name, newSectionXmls[si] ?? "");
      } else {
        out.file(name, await entry.async("uint8array"));
      }
    }

    const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const newBuffer = new Uint8Array(buf as unknown as ArrayBuffer);

    // diff 생성
    const typeKo: Record<FormObjectType, string> = {
      button: "PushButton",
      checkBox: "CheckBox",
      radioButton: "RadioButton",
      comboBox: "ComboBox",
      edit: "Edit",
    };

    const diffLines = ["| 양식 개체 | 이전 | 이후 |", "| --- | --- | --- |"];
    for (const re of resolvedEdits) {
      const result = successMap.get(re.editIdx);
      const oldVal = result?.oldValue ?? "";
      const oldStr =
        typeof oldVal === "boolean" ? (oldVal ? "CHECKED" : "UNCHECKED") : String(oldVal);

      let newStr: string;
      if (re.set.caption !== undefined) newStr = re.set.caption;
      else if (re.set.checked !== undefined) newStr = re.set.checked ? "CHECKED" : "UNCHECKED";
      else if (re.set.selected !== undefined) newStr = re.set.selected;
      else newStr = re.set.text ?? "";

      diffLines.push(`| ${re.target.name}(${typeKo[re.target.type]}) | ${oldStr} | ${newStr} |`);
    }
    const diff = diffLines.join("\n");

    // 스테이징
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);
    const stagedPath = await stageFile(ctx.sessionId, safePath, newBuffer);
    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "form-object",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings: [],
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
