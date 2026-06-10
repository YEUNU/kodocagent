/**
 * write_new_spreadsheet 툴 — 신규 XLSX 스프레드시트 작성 제안
 * docs/SPEC.md §6, §7
 *
 * exceljs로 신규 워크북 생성
 * 타겟 파일이 이미 존재하면 오류
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import { commitStaged, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

export const writeNewSpreadsheetSchema = z.object({
  path: z.string().describe("생성할 XLSX 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  sheets: z
    .array(
      z.object({
        name: z.string().describe("시트 이름"),
        rows: z.array(z.array(z.string())).describe("행 데이터 배열 (각 행은 셀 값 배열)"),
      }),
    )
    .min(1)
    .describe("생성할 시트 목록"),
});

export type WriteNewSpreadsheetInput = z.infer<typeof writeNewSpreadsheetSchema>;

export const writeNewSpreadsheetTool: ToolDefinition<WriteNewSpreadsheetInput> = {
  name: "write_new_spreadsheet",
  description:
    "새 XLSX 스프레드시트를 생성합니다. " +
    "이미 존재하는 파일은 생성할 수 없습니다(존재하는 파일 수정은 propose_sheet_edit 사용). " +
    "내용 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: writeNewSpreadsheetSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: WriteNewSpreadsheetInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    if (ext !== ".xlsx") {
      return `오류: write_new_spreadsheet은 .xlsx 파일만 지원합니다. 현재 확장자: ${ext}.`;
    }

    // 타겟 파일이 이미 존재하는지 확인
    try {
      await stat(safePath);
      return (
        `오류: 파일이 이미 존재합니다: ${input.path}. ` +
        `기존 파일 셀 수정은 propose_sheet_edit을 사용하세요.`
      );
    } catch {
      // ENOENT = 파일 없음 → 정상 진행
    }

    // exceljs 신규 워크북 생성
    const workbook = new ExcelJS.Workbook();

    const diffRows: string[] = [`| 시트 | 행 수 | 열 수 |`, `| --- | --- | --- |`];

    for (const sheetDef of input.sheets) {
      const worksheet = workbook.addWorksheet(sheetDef.name);

      for (let r = 0; r < sheetDef.rows.length; r++) {
        const row = sheetDef.rows[r];
        if (row) {
          worksheet.addRow(row);
        }
      }

      const rowCount = sheetDef.rows.length;
      const colCount = sheetDef.rows[0]?.length ?? 0;
      diffRows.push(`| ${sheetDef.name} | ${rowCount} | ${colCount} |`);
    }

    const diff = `[새 스프레드시트 미리보기]\n\n${diffRows.join("\n")}`;

    let stagedData: Uint8Array;
    try {
      const buf = await workbook.xlsx.writeBuffer();
      stagedData = new Uint8Array(buf as unknown as ArrayBuffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `오류: 스프레드시트 생성 중 오류가 발생했습니다: ${msg}`;
    }
    const stagedPath = await stageFile(ctx.sessionId, safePath, stagedData);

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "new-spreadsheet",
        targetPath: safePath,
        stagedPath,
        summary: `새 스프레드시트 생성: ${input.path}`,
        diff,
        warnings: [],
      },
      commit: async (): Promise<string> => {
        // 신규 파일이므로 백업 불필요
        await commitStaged(stagedPath, safePath);
        return `저장 완료: ${safePath}`;
      },
    };
  },
};
