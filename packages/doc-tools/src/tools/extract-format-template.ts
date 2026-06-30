/**
 * extract_format_template 툴 — 문서의 "양식 골격"을 추출(읽기 전용)
 *
 * 사용자가 연 문서와 같은 양식의 새 문서를 만들 때 가이드로 쓴다. kordoc IRBlock 에서
 * 뽑을 수 있는 구조(블록 구성·제목 계층·표 격자·항목부호 추정)만 캡처한다.
 * ⚠️ 한계: 글꼴·여백·색상 등 세부 서식은 IRBlock 에 없어 캡처 못 함(구조 골격만).
 */

import { readFile } from "node:fs/promises";
import type { IRBlock } from "kordoc";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { assertFileSizeWithinLimit, resolveSafePath } from "../security.js";
import { computeStructuralFingerprint } from "../structural-fingerprint.js";
import type { ToolContext, ToolDefinition } from "../types.js";

export const extractFormatTemplateSchema = z.object({
  path: z.string().describe("양식 골격을 추출할 문서 경로(.hwp/.hwpx/.docx 등, cwd 기준)"),
});

export type ExtractFormatTemplateInput = z.infer<typeof extractFormatTemplateSchema>;

export const extractFormatTemplateTool: ToolDefinition<ExtractFormatTemplateInput> = {
  name: "extract_format_template",
  description:
    "문서의 양식 '골격'(블록 구성·제목 계층·표 격자·항목부호 체계)을 추출합니다(읽기 전용). " +
    "사용자가 연 문서와 같은 양식으로 새 문서를 만들 때 참고용으로 쓰세요. " +
    "글꼴·여백·색상 등 세부 서식은 캡처하지 못합니다(구조 골격만). " +
    "추출 후 write_new_document로 같은 구성을 따라 작성하고, 공문서면 gongmunPreset을 함께 쓰세요.",
  inputSchema: extractFormatTemplateSchema,
  requiresApproval: false,

  execute: async ({
    input,
    ctx,
  }: {
    input: ExtractFormatTemplateInput;
    ctx: ToolContext;
  }): Promise<string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    try {
      await assertFileSizeWithinLimit(safePath);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }
    let buf: Buffer;
    try {
      buf = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }
    const result = await parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const blocks = (result as { blocks?: IRBlock[] }).blocks;
    if (!result.success || !Array.isArray(blocks)) {
      return `오류: 문서를 파싱할 수 없습니다: ${input.path} (지원하지 않는 형식이거나 손상됨).`;
    }

    const fp = computeStructuralFingerprint(blocks);
    const out: string[] = [`# 양식 골격: ${input.path}`, ""];
    out.push(
      `- 블록 구성: ${Object.entries(fp.blockHistogram)
        .map(([t, c]) => `${t} ${c}`)
        .join(", ")}`,
    );
    out.push(`- 항목부호 체계(추정): ${fp.numberingStyle}`);
    if (fp.headingOutline.length > 0) {
      out.push(`- 제목 계층(${fp.headingOutline.length}):`);
      for (const h of fp.headingOutline) {
        out.push(`  ${"  ".repeat(Math.max(0, h.level - 1))}H${h.level} ${h.text}`);
      }
    }
    if (fp.tables.length > 0) {
      out.push(
        `- 표(${fp.tables.length}): ${fp.tables
          .map((t, i) => `#${i + 1} ${t.rows}×${t.cols}${t.hasHeader ? "(머리행)" : ""}`)
          .join(", ")}`,
      );
    }
    if (fp.imageCount > 0) out.push(`- 이미지: ${fp.imageCount}`);
    if (fp.footnoteCount > 0) out.push(`- 각주: ${fp.footnoteCount}`);
    out.push("", "```json", JSON.stringify(fp, null, 2), "```", "");
    out.push(
      "※ 이 골격은 블록 구조만 담습니다(글꼴·여백·색상 제외). 같은 양식의 새 문서는 이 구성을 " +
        "참고해 마크다운을 작성하고, 공문서면 write_new_document의 gongmunPreset을 함께 쓰세요.",
    );
    return out.join("\n");
  },
};
