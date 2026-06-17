/**
 * form-objects.test.ts — list_form_objects + propose_form_object 테스트
 *
 * 1. parseFormObjects 단위 테스트 — 인라인 XML, 5가지 타입
 * 2. applyFormObjectEdits 단위 테스트 — 각 set 필드 패치, 에러 케이스
 * 3. 통합 테스트 — 실제 HWPX(markdownToHwpx + 양식 개체 주입) + 툴 실행
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { markdownToHwpx } from "kordoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyFormObjectEdits,
  escapeXml,
  listFormObjectsTool,
  parseFormObjects,
  proposeFormObjectSchema,
  proposeFormObjectTool,
} from "./form-objects.js";

// ─────────────────────────────────────────────────────────
// 픽스처 헬퍼
// ─────────────────────────────────────────────────────────

/**
 * 실제 한콤 섹션 XML에서 관찰된 구조를 재현한 인라인 XML 픽스처.
 * 5가지 양식 개체 타입 전부 포함.
 */
const FIXTURE_SECTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="urn:schemas-microsoft-com:office:spreadsheet" xmlns:hp="urn:hancom:partype">
<hp:p>
  <hp:run>
    <hp:btn caption="명령 단추" value="UNCHECKED" radioGroupName="" triState="0" backStyle="TRANSPARENT" name="PushButton" foreColor="#000000" backColor="#F0F0F0" groupName="" tabStop="1" editable="1" tabOrder="1" enabled="1" borderTypeIDRef="4" drawFrame="1" printable="1" command="">
      <hp:formCharPr charPrIDRef="0" followContext="0" autoSz="0" wordWrap="0"/>
    </hp:btn>
    <hp:checkBtn caption="선택 상자" value="CHECKED" radioGroupName="" triState="0" backStyle="OPAQUE" name="CheckBox" foreColor="#000000" backColor="#FFFFFF" groupName="" tabStop="1" editable="1" tabOrder="2" enabled="1" borderTypeIDRef="0" drawFrame="1" printable="1" command="">
      <hp:formCharPr charPrIDRef="0" followContext="0" autoSz="0" wordWrap="0"/>
    </hp:checkBtn>
    <hp:radioBtn caption="라디오 단추" value="UNCHECKED" radioGroupName="" triState="0" backStyle="OPAQUE" name="RadioButton" foreColor="#000000" backColor="#FFFFFF" groupName="" tabStop="1" editable="1" tabOrder="4" enabled="1" borderTypeIDRef="0" drawFrame="1" printable="1" command="">
      <hp:formCharPr charPrIDRef="0" followContext="0" autoSz="0" wordWrap="0"/>
    </hp:radioBtn>
    <hp:comboBox listBoxRows="4" listBoxWidth="0" editEnable="1" selectedValue="" name="ComboBox" foreColor="#000000" backColor="#F0F0F0" groupName="" tabStop="1" editable="1" tabOrder="3" enabled="1" borderTypeIDRef="5" drawFrame="1" printable="1" command="">
      <hp:formCharPr charPrIDRef="0" followContext="0" autoSz="1" wordWrap="0"/>
      <hp:listItem displayText="" value="계절 선택"/>
      <hp:listItem displayText="" value="봄"/>
      <hp:listItem displayText="" value="여름"/>
    </hp:comboBox>
    <hp:edit multiLine="0" passwordChar="" maxLength="2147483647" scrollBars="NONE" tabKeyBehavior="NEXT_OBJECT" numOnly="0" readOnly="0" alignText="LEFT" name="Edit" foreColor="#000000" backColor="#F0F0F0" groupName="" tabStop="1" editable="1" tabOrder="5" enabled="1" borderTypeIDRef="5" drawFrame="1" printable="1" command="">
      <hp:formCharPr charPrIDRef="0" followContext="0" autoSz="0" wordWrap="0"/>
      <hp:text/>
    </hp:edit>
  </hp:run>
</hp:p>
</hs:sec>`;

/**
 * Edit 안에 텍스트가 있는 경우 (빈 <hp:text/> 대신 <hp:text>VALUE</hp:text>)
 */
const FIXTURE_EDIT_WITH_TEXT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="urn:schemas-microsoft-com:office:spreadsheet" xmlns:hp="urn:hancom:partype">
<hp:p>
  <hp:run>
    <hp:edit multiLine="0" name="Edit" tabOrder="1" editable="1">
      <hp:formCharPr charPrIDRef="0"/>
      <hp:text>기존 텍스트</hp:text>
    </hp:edit>
  </hp:run>
</hp:p>
</hs:sec>`;

/**
 * 같은 name을 가진 두 개의 CheckBox
 */
const FIXTURE_DUPLICATE_NAME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="urn:schemas-microsoft-com:office:spreadsheet" xmlns:hp="urn:hancom:partype">
<hp:p>
  <hp:run>
    <hp:checkBtn caption="체크1" value="UNCHECKED" name="MyCheck" tabOrder="1" editable="1" command="">
      <hp:formCharPr charPrIDRef="0"/>
    </hp:checkBtn>
    <hp:checkBtn caption="체크2" value="CHECKED" name="MyCheck" tabOrder="2" editable="1" command="">
      <hp:formCharPr charPrIDRef="0"/>
    </hp:checkBtn>
  </hp:run>
</hp:p>
</hs:sec>`;

// ─────────────────────────────────────────────────────────
// 세션 컨텍스트
// ─────────────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `kodocagent-form-objects-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(() => {
  // OS가 자동 정리
});

function makeCtx(subDir?: string): { cwd: string; sessionId: string } {
  return {
    cwd: subDir ?? testDir,
    sessionId: `test-fo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ─────────────────────────────────────────────────────────
// 1. parseFormObjects 단위 테스트
// ─────────────────────────────────────────────────────────

describe("parseFormObjects — 5가지 타입 파싱", () => {
  it("5가지 양식 개체를 소스 순서대로 파싱한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    expect(objs).toHaveLength(5);

    // 인덱스 순서 확인
    expect(objs[0]?.index).toBe(0);
    expect(objs[1]?.index).toBe(1);
    expect(objs[4]?.index).toBe(4);
  });

  it("PushButton: name과 caption(currentValue)을 파싱한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const btn = objs.find((o) => o.type === "button");
    expect(btn).toBeDefined();
    expect(btn?.name).toBe("PushButton");
    expect(btn?.currentValue).toBe("명령 단추");
  });

  it("CheckBox: value=CHECKED → currentValue=true", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "checkBox");
    expect(cb).toBeDefined();
    expect(cb?.name).toBe("CheckBox");
    expect(cb?.currentValue).toBe(true);
  });

  it("RadioButton: value=UNCHECKED → currentValue=false", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const rb = objs.find((o) => o.type === "radioButton");
    expect(rb).toBeDefined();
    expect(rb?.name).toBe("RadioButton");
    expect(rb?.currentValue).toBe(false);
  });

  it("ComboBox: selectedValue + comboItems 목록 파싱", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "comboBox");
    expect(cb).toBeDefined();
    expect(cb?.name).toBe("ComboBox");
    expect(cb?.currentValue).toBe(""); // selectedValue=""
    expect(cb?.comboItems).toEqual(["계절 선택", "봄", "여름"]);
  });

  it('Edit: <hp:text/> (self-closing) → currentValue=""', () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const ed = objs.find((o) => o.type === "edit");
    expect(ed).toBeDefined();
    expect(ed?.name).toBe("Edit");
    expect(ed?.currentValue).toBe("");
  });

  it("Edit: <hp:text>기존 텍스트</hp:text> → 텍스트 파싱", () => {
    const objs = parseFormObjects(FIXTURE_EDIT_WITH_TEXT_XML, "Contents/section0.xml", 0);
    expect(objs).toHaveLength(1);
    expect(objs[0]?.type).toBe("edit");
    expect(objs[0]?.currentValue).toBe("기존 텍스트");
  });

  it("startIndex 파라미터로 전역 인덱스 오프셋을 지정할 수 있다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 10);
    expect(objs[0]?.index).toBe(10);
    expect(objs[4]?.index).toBe(14);
  });
});

// ─────────────────────────────────────────────────────────
// 2. applyFormObjectEdits 단위 테스트
// ─────────────────────────────────────────────────────────

describe("applyFormObjectEdits — caption 패치 (PushButton)", () => {
  it("caption 속성을 교체하고 다른 속성(name, tabOrder)은 그대로 유지한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const btn = objs.find((o) => o.type === "button")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: btn, set: { caption: "확인" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldValue).toBe("명령 단추");
    expect(newXml).toContain('caption="확인"');
    // 다른 속성 보존
    expect(newXml).toContain('name="PushButton"');
    expect(newXml).toContain('tabOrder="1"');
    // CheckBox, RadioButton 등 다른 개체 변경 없음
    expect(newXml).toContain('name="CheckBox"');
  });
});

describe("applyFormObjectEdits — checked 패치 (CheckBox)", () => {
  it("checked=false → value=UNCHECKED로 교체한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "checkBox")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: cb, set: { checked: false } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldValue).toBe(true); // 원래 CHECKED
    // checkBtn의 value 속성이 UNCHECKED로 변경됨
    expect(newXml).toContain('name="CheckBox"');
    // 변경된 checkBtn 태그에서 value="UNCHECKED" 확인
    const cbPos = newXml.indexOf('name="CheckBox"');
    const tagStart = newXml.lastIndexOf("<hp:checkBtn", cbPos);
    const tagEnd = newXml.indexOf(">", tagStart);
    expect(newXml.slice(tagStart, tagEnd)).toContain('value="UNCHECKED"');
  });

  it("checked=true → value=CHECKED로 교체한다 (RadioButton도 동일)", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const rb = objs.find((o) => o.type === "radioButton")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: rb, set: { checked: true } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldValue).toBe(false); // 원래 UNCHECKED
    const rbPos = newXml.indexOf('name="RadioButton"');
    const tagStart = newXml.lastIndexOf("<hp:radioBtn", rbPos);
    const tagEnd = newXml.indexOf(">", tagStart);
    expect(newXml.slice(tagStart, tagEnd)).toContain('value="CHECKED"');
  });
});

describe("applyFormObjectEdits — selected 패치 (ComboBox)", () => {
  it("유효한 selected 값으로 selectedValue 속성을 교체한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "comboBox")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: cb, set: { selected: "봄" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldValue).toBe(""); // 원래 selectedValue=""
    const cbPos = newXml.indexOf('name="ComboBox"');
    const tagStart = newXml.lastIndexOf("<hp:comboBox", cbPos);
    const tagEnd = newXml.indexOf(">", tagStart);
    expect(newXml.slice(tagStart, tagEnd)).toContain('selectedValue="봄"');
    // listItem 보존
    expect(newXml).toContain('<hp:listItem displayText="" value="계절 선택"/>');
  });

  it("유효하지 않은 selected 값 → 오류, XML 무변경", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "comboBox")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: cb, set: { selected: "겨울" } },
    ]);

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("유효한 항목이 아닙니다");
    expect(results[0]?.error).toContain('"봄"');
    expect(newXml).toBe(FIXTURE_SECTION_XML); // 무변경
  });
});

describe("applyFormObjectEdits — text 패치 (Edit)", () => {
  it("<hp:text/> (self-closing) → <hp:text>VALUE</hp:text>로 교체한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const ed = objs.find((o) => o.type === "edit")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: ed, set: { text: "홍길동" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldValue).toBe("");
    expect(newXml).toContain("<hp:text>홍길동</hp:text>");
    // self-closing은 사라져야 함
    expect(newXml).not.toContain("<hp:text/>");
    // 다른 속성 보존
    expect(newXml).toContain('name="Edit"');
    expect(newXml).toContain('tabOrder="5"');
  });

  it("<hp:text>기존</hp:text> → <hp:text>신규</hp:text>로 교체한다", () => {
    const objs = parseFormObjects(FIXTURE_EDIT_WITH_TEXT_XML, "Contents/section0.xml", 0);
    const ed = objs[0]!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_EDIT_WITH_TEXT_XML, [
      { target: ed, set: { text: "신규 텍스트" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(results[0]?.oldValue).toBe("기존 텍스트");
    expect(newXml).toContain("<hp:text>신규 텍스트</hp:text>");
    expect(newXml).not.toContain("기존 텍스트");
  });
});

describe("applyFormObjectEdits — 타입 불일치 오류", () => {
  it("Edit에 checked 지정 → 타입 불일치 오류, XML 무변경", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const ed = objs.find((o) => o.type === "edit")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: ed, set: { checked: true } },
    ]);

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("타입 불일치");
    expect(newXml).toBe(FIXTURE_SECTION_XML);
  });

  it("CheckBox에 caption 지정 → 타입 불일치 오류", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "checkBox")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: cb, set: { caption: "잘못된" } },
    ]);

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("타입 불일치");
    expect(newXml).toBe(FIXTURE_SECTION_XML);
  });
});

describe("applyFormObjectEdits — expected 불일치 오류", () => {
  it("expected.checked=false이지만 실제 CHECKED → 오류, XML 무변경", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const cb = objs.find((o) => o.type === "checkBox")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: cb, set: { checked: false }, expected: { checked: false } },
    ]);

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain("예상값과 다릅니다");
    expect(newXml).toBe(FIXTURE_SECTION_XML);
  });

  it('expected.text="" 일치 → 성공', () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const ed = objs.find((o) => o.type === "edit")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: ed, set: { text: "홍길동" }, expected: { text: "" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain("<hp:text>홍길동</hp:text>");
  });
});

describe("applyFormObjectEdits — 동일 name 중복 처리", () => {
  it("parseFormObjects는 중복 name을 서로 다른 인덱스로 반환한다", () => {
    const objs = parseFormObjects(FIXTURE_DUPLICATE_NAME_XML, "Contents/section0.xml", 0);
    expect(objs).toHaveLength(2);
    expect(objs[0]?.name).toBe("MyCheck");
    expect(objs[1]?.name).toBe("MyCheck");
    expect(objs[0]?.index).toBe(0);
    expect(objs[1]?.index).toBe(1);
  });

  it("index로 특정 개체를 지정하여 패치할 수 있다", () => {
    const objs = parseFormObjects(FIXTURE_DUPLICATE_NAME_XML, "Contents/section0.xml", 0);
    // index=1 (두 번째, 현재 CHECKED)
    const second = objs[1]!;
    expect(second.currentValue).toBe(true);

    const { newXml, results } = applyFormObjectEdits(FIXTURE_DUPLICATE_NAME_XML, [
      { target: second, set: { checked: false } },
    ]);

    expect(results[0]?.success).toBe(true);
    // 첫 번째(tabOrder="1")는 변경 없음
    const _first = objs[0]!;
    const firstTagStart = newXml.indexOf("<hp:checkBtn");
    const firstTagEnd = newXml.indexOf(">", firstTagStart);
    expect(newXml.slice(firstTagStart, firstTagEnd)).toContain('value="UNCHECKED"');
    // 두 번째(tabOrder="2")는 UNCHECKED로 변경됨
    const secondTagStart = newXml.indexOf("<hp:checkBtn", firstTagEnd);
    const secondTagEnd = newXml.indexOf(">", secondTagStart);
    expect(newXml.slice(secondTagStart, secondTagEnd)).toContain('value="UNCHECKED"');
  });
});

describe("applyFormObjectEdits — XML 이스케이프", () => {
  it("caption에 XML 특수문자(<, >, &)가 있으면 이스케이프한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const btn = objs.find((o) => o.type === "button")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: btn, set: { caption: "A & B <테스트>" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain('caption="A &amp; B &lt;테스트&gt;"');
  });

  it("edit text에 XML 특수문자가 있으면 이스케이프한다", () => {
    const objs = parseFormObjects(FIXTURE_SECTION_XML, "Contents/section0.xml", 0);
    const ed = objs.find((o) => o.type === "edit")!;

    const { newXml, results } = applyFormObjectEdits(FIXTURE_SECTION_XML, [
      { target: ed, set: { text: "<홍길동 & 이순신>" } },
    ]);

    expect(results[0]?.success).toBe(true);
    expect(newXml).toContain("<hp:text>&lt;홍길동 &amp; 이순신&gt;</hp:text>");
  });
});

describe("zod 스키마 — set 필드 검증", () => {
  it("set이 비어있으면 zod 유효성 오류", () => {
    const result = proposeFormObjectSchema.safeParse({
      path: "test.hwpx",
      edits: [{ name: "Edit", set: {} }],
      summary: "테스트",
    });
    expect(result.success).toBe(false);
  });

  it("set에 두 필드 이상 지정하면 zod 유효성 오류", () => {
    const result = proposeFormObjectSchema.safeParse({
      path: "test.hwpx",
      edits: [{ name: "Edit", set: { caption: "A", checked: true } }],
      summary: "테스트",
    });
    expect(result.success).toBe(false);
  });

  it("유효한 set 필드는 통과", () => {
    const result = proposeFormObjectSchema.safeParse({
      path: "test.hwpx",
      edits: [{ name: "Edit", set: { text: "홍길동" } }],
      summary: "테스트",
    });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 3. 통합 테스트 — 실제 HWPX 생성 후 툴 실행
// ─────────────────────────────────────────────────────────

/**
 * markdownToHwpx로 최소 HWPX 생성 후 section0.xml에 양식 개체 주입
 */
async function buildTestHwpx(dir: string, filename: string): Promise<string> {
  const hwpxBuf = await markdownToHwpx("# 테스트 문서");
  const zip = await JSZip.loadAsync(hwpxBuf);

  // section0.xml 읽기
  const sectionEntry = zip.file("Contents/section0.xml");
  if (!sectionEntry) throw new Error("section0.xml not found in skeleton hwpx");
  const sectionXml = await sectionEntry.async("string");

  // </hs:sec> 앞에 양식 개체 삽입
  const insertPoint = sectionXml.lastIndexOf("</");
  const formObjects = `
<hp:p xmlns:hp="urn:hancom:partype">
  <hp:run>
    <hp:btn caption="명령 단추" value="UNCHECKED" name="PushButton" tabOrder="1" editable="1" command=""><hp:formCharPr charPrIDRef="0"/><hp:sz width="7087" widthRelTo="ABSOLUTE" height="1984" heightRelTo="ABSOLUTE" protect="0"/></hp:btn>
    <hp:checkBtn caption="선택 상자" value="CHECKED" name="CheckBox" tabOrder="2" editable="1" command=""><hp:formCharPr charPrIDRef="0"/><hp:sz width="9921" widthRelTo="ABSOLUTE" height="1984" heightRelTo="ABSOLUTE" protect="0"/></hp:checkBtn>
    <hp:comboBox listBoxRows="4" selectedValue="" name="ComboBox" tabOrder="3" editable="1" command=""><hp:formCharPr charPrIDRef="0"/><hp:listItem displayText="" value="계절 선택"/><hp:listItem displayText="" value="봄"/><hp:sz width="6058" widthRelTo="ABSOLUTE" height="1450" heightRelTo="ABSOLUTE" protect="0"/></hp:comboBox>
    <hp:edit multiLine="0" name="Edit" tabOrder="4" editable="1" command=""><hp:formCharPr charPrIDRef="0"/><hp:text/><hp:sz width="7087" widthRelTo="ABSOLUTE" height="1984" heightRelTo="ABSOLUTE" protect="0"/></hp:edit>
  </hp:run>
</hp:p>`;

  const patchedXml = sectionXml.slice(0, insertPoint) + formObjects + sectionXml.slice(insertPoint);

  // 새 ZIP 빌드
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

  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const filePath = join(dir, filename);
  await writeFile(filePath, buf as Buffer);
  return filePath;
}

describe("통합 테스트 — list_form_objects + propose_form_object", () => {
  let hwpxPath: string;

  beforeAll(async () => {
    hwpxPath = await buildTestHwpx(testDir, "form-test.hwpx");
  });

  it("list_form_objects: 주입된 4개 양식 개체를 열거한다", async () => {
    const ctx = makeCtx();
    const result = await listFormObjectsTool.execute!({
      input: { path: hwpxPath },
      ctx,
    });

    expect(result).toContain("4개의 양식 개체");
    expect(result).toContain("PushButton");
    expect(result).toContain("CheckBox");
    expect(result).toContain("ComboBox");
    expect(result).toContain("Edit");
    // CheckBox는 CHECKED이므로 체크됨
    expect(result).toContain("체크됨");
    // ComboBox 항목 목록
    expect(result).toContain("계절 선택");
    expect(result).toContain("봄");
  });

  it("propose_form_object + commit: Edit 텍스트와 CheckBox 값을 변경하고 ZIP에 반영한다", async () => {
    // 임시 복사본 생성
    const copyPath = join(testDir, "form-test-copy.hwpx");
    await writeFile(copyPath, await readFile(hwpxPath));

    const ctx = makeCtx();
    const outcome = await proposeFormObjectTool.propose!({
      input: {
        path: copyPath,
        edits: [
          { name: "Edit", set: { text: "홍길동" } },
          { name: "CheckBox", set: { checked: false } },
        ],
        summary: "Edit 텍스트 설정 + CheckBox 해제",
      },
      ctx,
    });

    expect(typeof outcome).toBe("object");
    if (typeof outcome === "string") throw new Error(outcome);

    // proposal 확인
    expect(outcome.proposal.kind).toBe("form-object");
    expect(outcome.proposal.diff).toContain("홍길동");
    expect(outcome.proposal.diff).toContain("UNCHECKED");

    // commit
    const msg = await outcome.commit();
    expect(msg).toContain("저장 완료");

    // 저장된 ZIP 재검증
    const savedBuf = await readFile(copyPath);
    const savedZip = await JSZip.loadAsync(new Uint8Array(savedBuf.buffer as ArrayBuffer));
    const savedEntry = savedZip.file("Contents/section0.xml");
    if (!savedEntry) throw new Error("section0.xml not found in saved zip");
    const savedXml = await savedEntry.async("string");

    expect(savedXml).toContain("<hp:text>홍길동</hp:text>");
    // CheckBox value=UNCHECKED
    const cbPos = savedXml.indexOf('name="CheckBox"');
    const cbTagStart = savedXml.lastIndexOf("<hp:checkBtn", cbPos);
    const cbTagEnd = savedXml.indexOf(">", cbTagStart);
    expect(savedXml.slice(cbTagStart, cbTagEnd)).toContain('value="UNCHECKED"');
  });

  it("propose_form_object: 존재하지 않는 name → 오류 문자열 반환", async () => {
    const ctx = makeCtx();
    const result = await proposeFormObjectTool.propose!({
      input: {
        path: hwpxPath,
        edits: [{ name: "없는개체", set: { text: "값" } }],
        summary: "테스트",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("찾을 수 없습니다");
  });

  it("propose_form_object: ComboBox 선택 + commit 후 selectedValue 반영", async () => {
    const copyPath2 = join(testDir, "form-test-copy2.hwpx");
    await writeFile(copyPath2, await readFile(hwpxPath));

    const ctx = makeCtx();
    const outcome = await proposeFormObjectTool.propose!({
      input: {
        path: copyPath2,
        edits: [{ name: "ComboBox", set: { selected: "봄" } }],
        summary: "ComboBox 봄 선택",
      },
      ctx,
    });

    if (typeof outcome === "string") throw new Error(outcome);
    await outcome.commit();

    const savedBuf = await readFile(copyPath2);
    const savedZip = await JSZip.loadAsync(new Uint8Array(savedBuf.buffer as ArrayBuffer));
    const savedXml = await savedZip.file("Contents/section0.xml")!.async("string");
    const cbPos = savedXml.indexOf('name="ComboBox"');
    const cbTagStart = savedXml.lastIndexOf("<hp:comboBox", cbPos);
    const cbTagEnd = savedXml.indexOf(">", cbTagStart);
    expect(savedXml.slice(cbTagStart, cbTagEnd)).toContain('selectedValue="봄"');
  });

  it("propose_form_object: .hwp 파일 → 오류 반환", async () => {
    const hwpPath = join(testDir, "fake.hwp");
    // 실제 OLE 바이너리 아님, 단순 바이트로 .hwp 확장자 테스트
    await writeFile(hwpPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));

    const ctx = makeCtx();
    const result = await proposeFormObjectTool.propose!({
      input: {
        path: hwpPath,
        edits: [{ name: "Edit", set: { text: "값" } }],
        summary: "테스트",
      },
      ctx,
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain(".hwpx");
  });
});

describe("escapeXml 단위 테스트", () => {
  it('& < > " 문자를 올바르게 이스케이프한다', () => {
    expect(escapeXml("A & B")).toBe("A &amp; B");
    expect(escapeXml("<태그>")).toBe("&lt;태그&gt;");
    expect(escapeXml('"따옴표"')).toBe("&quot;따옴표&quot;");
  });
});
