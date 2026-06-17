/**
 * scan_pii 툴 — 문서에서 한국 개인정보(PII) 탐지 (읽기 전용)
 * docs/SPEC.md §6
 *
 * .md/.txt 등 평문 파일은 UTF-8로 직접 읽고,
 * HWP/HWPX/DOCX/XLSX/PDF는 kordoc parse()로 마크다운 텍스트를 추출해 탐지한다.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { detectPii } from "@kodocagent/shared";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { resolveSafePath } from "../security.js";
import type { ToolContext, ToolDefinition } from "../types.js";

/** 평문 텍스트 확장자 집합 (소문자) — kordoc 없이 직접 읽는다 */
const PLAIN_TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text"]);

export const scanPiiSchema = z.object({
  path: z.string().describe("개인정보를 점검할 문서 경로"),
});

export type ScanPiiInput = z.infer<typeof scanPiiSchema>;

export const scanPiiTool: ToolDefinition<ScanPiiInput> = {
  name: "scan_pii",
  description:
    "문서에서 한국 개인정보(주민등록번호·신용카드번호·전화번호·이메일)를 탐지합니다. " +
    "원문 값은 반환하지 않고 마스킹된 예시만 표시합니다. 외부 공유 전 검토에 활용하세요.",
  inputSchema: scanPiiSchema,
  requiresApproval: false,
  execute: async ({
    input,
    ctx,
  }: {
    input: ScanPiiInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => {
    let safePath: string;
    try {
      safePath = await resolveSafePath(ctx.cwd, input.path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: 경로를 확인할 수 없습니다: ${msg}`;
    }

    const ext = extname(safePath).toLowerCase();

    let text: string;
    if (PLAIN_TEXT_EXTS.has(ext)) {
      try {
        text = await readFile(safePath, "utf-8");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `오류: 파일을 읽을 수 없습니다: ${msg}`;
      }
    } else {
      let parseResult: Awaited<ReturnType<typeof parse>>;
      try {
        parseResult = await parse(safePath);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `오류: 문서를 파싱할 수 없습니다: ${msg}`;
      }
      if (!parseResult.success) {
        return `오류: 문서를 읽을 수 없습니다: ${parseResult.error ?? "알 수 없는 오류"}`;
      }
      text = parseResult.markdown;
    }

    const findings = detectPii(text);

    if (findings.length === 0) {
      return `개인정보가 발견되지 않았습니다: ${input.path}`;
    }

    const lines: string[] = [`발견된 개인정보 (${input.path}):`];
    for (const f of findings) {
      lines.push(`- ${f.type}: ${f.count}건 (예: ${f.masked.join(", ")})`);
    }
    lines.push("※ 마스킹된 예시이며 원문 값은 표시하지 않습니다. 외부 공유 전 확인하세요.");

    return lines.join("\n");
  },
};
