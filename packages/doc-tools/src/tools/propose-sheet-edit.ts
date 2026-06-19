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
import { assertFileSizeWithinLimit, assertZipNotBomb, resolveSafePath } from "../security.js";
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

    // 파일 크기 가드 — 원본 readFile 직전
    try {
      await assertFileSizeWithinLimit(safePath);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
    }

    // 원본 파일 읽기
    let originalBuffer: Buffer;
    try {
      originalBuffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }

    // 압축 폭탄 가드 — exceljs xlsx.load 직전 (.xlsx는 ZIP 포맷)
    try {
      assertZipNotBomb(originalBuffer);
    } catch (err) {
      if (err instanceof Error) return `오류: ${err.message}`;
      throw err;
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
    const warnings: string[] = [];

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

      // ⑩ 병합 셀의 슬레이브(대표가 아닌) 주소를 지정하면 ExcelJS가 대표(좌상단) 셀의 값을
      // 바꾼다. 표시 주소와 실제 편집 셀이 달라 혼란스러우므로 경고하고 diff에도 명시한다.
      const isMergedSlave =
        cell.isMerged && cell.master !== undefined && cell.master.address !== cell.address;
      if (isMergedSlave) {
        warnings.push(
          `${update.sheet}!${update.cell}은(는) 병합된 셀의 일부입니다. ` +
            `실제로는 병합 영역의 대표 셀 ${update.sheet}!${cell.master.address}의 값이 변경됩니다.`,
        );
      }

      // ④ 수식 셀을 편집하면 수식이 정적 값으로 대체되어 영구 소실된다. 이전 값을
      // '[object Object]'가 아니라 실제 수식으로 표시하고, 수식 소실을 경고한다.
      let oldValue: string;
      if (cell.value === null || cell.value === undefined) {
        oldValue = "(빈 셀)";
      } else if (cell.type === ExcelJS.ValueType.Formula) {
        const fv = cell.value as ExcelJS.CellFormulaValue;
        const resultPart =
          fv.result !== undefined && fv.result !== null ? ` (결과: ${String(fv.result)})` : "";
        oldValue = `=${fv.formula}${resultPart}`;
        warnings.push(
          `${update.sheet}!${update.cell}에는 수식(=${fv.formula})이 있습니다. ` +
            `값을 입력하면 수식이 사라지고 고정 값으로 대체됩니다.`,
        );
      } else if (cell.type === ExcelJS.ValueType.Date) {
        const d = cell.value as Date;
        // ExcelJS는 엑셀 직렬값을 UTC instant로 디코드한다(순수 날짜 = UTC 자정).
        // 서버 로컬 TZ로 포맷하면 날짜가 하루 밀리거나 가짜 시간이 붙으므로 UTC 기준으로 표시.
        const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
        oldValue = new Intl.DateTimeFormat("ko-KR", {
          timeZone: "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          ...(hasTime ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : {}),
        }).format(d);
      } else if (cell.type === ExcelJS.ValueType.RichText) {
        const rtv = cell.value as ExcelJS.CellRichTextValue;
        oldValue = rtv.richText.map((r) => r.text).join("");
      } else if (cell.type === ExcelJS.ValueType.Hyperlink) {
        const hv = cell.value as ExcelJS.CellHyperlinkValue;
        oldValue = `${hv.text} (${hv.hyperlink})`;
      } else {
        oldValue = String(cell.value);
      }

      // 셀 값 설정 (서식 보존을 위해 value만 변경)
      cell.value = update.value;

      const targetAddr = isMergedSlave
        ? `${update.sheet}!${update.cell} → ${cell.master.address}`
        : `${update.sheet}!${update.cell}`;
      const newValueStr = String(update.value);
      diffRows.push(`| ${targetAddr} | ${oldValue} | ${newValueStr} |`);
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
    const opSummary = input.summary;

    return {
      proposal: {
        id: proposalId,
        kind: "sheet-edit",
        targetPath: outputPath,
        stagedPath,
        summary: opSummary,
        diff,
        warnings,
        willConvertFormat,
        sourcePath: safePath,
      },
      commit: async (): Promise<string> => {
        // 소스 백업 (원본 .xls/.xlsx 파일)
        const backupPath = await backupFile(safePath, undefined, { summary: opSummary });
        // ① 포맷 변환 시 출력 경로 기존 파일도 별도 백업 (data-loss 방지)
        if (outputPath !== safePath) {
          await backupFile(outputPath, undefined, { summary: opSummary });
        }
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
