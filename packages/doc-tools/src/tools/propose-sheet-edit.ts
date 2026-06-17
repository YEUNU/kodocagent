/**
 * propose_sheet_edit 툴 — XLSX 셀 단위 수정 제안
 * docs/SPEC.md §6, §7
 *
 * exceljs로 원본 워크북 로드 → 셀 단위 수정 → 서식 보존 저장
 * diff: 셀 변경 표 (시트!셀: '이전' → '이후')
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

export const proposeSheetEditSchema = z.object({
  path: z.string().describe("수정할 XLSX 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  updates: z
    .array(
      z.object({
        sheet: z.string().describe("시트 이름"),
        cell: z.string().describe("셀 주소 (예: A1, B3)"),
        value: z.union([z.string(), z.number()]).describe("새 값"),
      }),
    )
    .min(1)
    .describe("수정할 셀 목록. read_document로 원본 시트 구조를 먼저 확인하세요"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeSheetEditInput = z.infer<typeof proposeSheetEditSchema>;

export const proposeSheetEditTool: ToolDefinition<ProposeSheetEditInput> = {
  name: "propose_sheet_edit",
  description:
    "XLSX 파일의 셀 값을 수정합니다. " +
    "반드시 read_document로 시트 구조를 먼저 확인한 후 사용하세요. " +
    "변경 사항은 셀 변경 표와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: proposeSheetEditSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeSheetEditInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    if (ext !== ".xlsx" && ext !== ".xls") {
      return `오류: propose_sheet_edit은 .xlsx/.xls 파일만 지원합니다. 현재 파일: ${ext}.`;
    }

    // 원본 파일 읽기
    let originalBuffer: Buffer;
    try {
      originalBuffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }

    // exceljs로 워크북 로드
    const workbook = new ExcelJS.Workbook();
    try {
      // exceljs의 load()는 exceljs 고유 Buffer 타입 — ArrayBuffer로 변환
      // exceljs Buffer type — use unknown cast since ESM default import has no named types
      await workbook.xlsx.load(
        originalBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `오류: XLSX 파일을 파싱할 수 없습니다: ${msg}. 파일이 손상되었거나 지원되지 않는 형식입니다.`;
    }

    // 시트 이름 목록 (오류 메시지용)
    const availableSheets: string[] = [];
    workbook.eachSheet((sheet) => {
      availableSheets.push(sheet.name);
    });

    // 각 업데이트 적용
    const diffRows: string[] = ["| 시트!셀 | 이전 값 | 새 값 |", "| --- | --- | --- |"];

    for (const update of input.updates) {
      const worksheet = workbook.getWorksheet(update.sheet);
      if (!worksheet) {
        return (
          `오류: 시트 '${update.sheet}'를 찾을 수 없습니다. ` +
          `사용 가능한 시트: ${availableSheets.length > 0 ? availableSheets.join(", ") : "(없음)"}. ` +
          `read_document로 시트 목록을 확인하세요.`
        );
      }

      const cell = worksheet.getCell(update.cell);
      const oldValue =
        cell.value !== null && cell.value !== undefined ? String(cell.value) : "(빈 셀)";

      // 셀 값 설정 (서식 보존을 위해 value만 변경)
      cell.value = update.value;

      const newValueStr = String(update.value);
      diffRows.push(`| ${update.sheet}!${update.cell} | ${oldValue} | ${newValueStr} |`);
    }

    const diff = diffRows.join("\n");

    // 수정된 워크북을 버퍼로 저장
    let modifiedBuffer: Uint8Array;
    try {
      const buf = await workbook.xlsx.writeBuffer();
      modifiedBuffer = new Uint8Array(buf as unknown as ArrayBuffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `오류: 워크북 저장 중 오류가 발생했습니다: ${msg}`;
    }

    const stagedData = modifiedBuffer;
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);
    const stagedPath = await stageFile(ctx.sessionId, outputPath, stagedData);

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "sheet-edit",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings: [],
        willConvertFormat,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(outputPath);
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
