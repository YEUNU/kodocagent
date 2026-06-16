/**
 * propose_table_structure 툴 — rhwp 엔진을 사용한 HWP/HWPX 표 구조 편집
 *
 * Phase 2 기능:
 *   - 행/열 삽입·삭제 (insertTableRow, insertTableColumn, deleteTableRow, deleteTableColumn)
 *   - 셀 병합 (mergeTableCells)
 *
 * 표 식별 방법: anchor 텍스트 (content-anchor 기반)
 *   - kordoc tableIndex ≠ rhwp 표 열거 인덱스임이 실측으로 확인되었으므로
 *     숫자 인덱스가 아닌 앵커 텍스트로 표를 식별한다.
 *   - enumerateTables → findTableByAnchor (rhwp-engine.ts)
 *
 * 내보내기 정책:
 *   - 항상 doc.exportHwpx()로 내보낸다 (exportHwp()는 편집 내용 미저장 — rhwp #197).
 *   - .hwp 입력 → .hwpx 출력 (resolveOutputPath + 경고).
 *
 * 자기검증 게이트:
 *   1. 내보낸 바이트를 kordoc parse()로 재파싱 — 파싱 성공 확인.
 *   2. 재파싱 마크다운에 anchor 텍스트가 남아 있는지 확인 (표가 살아있음).
 *   3. 순수 행/열 삽입·삭제 연산(병합 없음): rhwp로 재로드하여
 *      getTableDimensions로 예상 행·열 수와 실제를 비교한다.
 *
 * 연산 순서:
 *   연산은 지정된 순서대로 적용된다. 나중 연산의 row/col 인덱스는
 *   앞 연산이 적용된 후의 표 상태를 기준으로 한다.
 *   (에이전트가 의도한 순서로 연산을 제공해야 함 — 자동 조정 없음)
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "@clazic/kordoc";
import { z } from "zod";
import { detectStructuralLoss, findTableByAnchor, loadRhwpDocument } from "../rhwp-engine.js";
import { resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

const insertRowOpSchema = z.object({
  type: z.literal("insertRow"),
  row: z.number().int().nonnegative().describe("기준 행 인덱스 (0-based)"),
  position: z.enum(["above", "below"]).describe("삽입 위치: above=row 위에, below=row 아래에"),
});

const deleteRowOpSchema = z.object({
  type: z.literal("deleteRow"),
  row: z.number().int().nonnegative().describe("삭제할 행 인덱스 (0-based)"),
});

const insertColumnOpSchema = z.object({
  type: z.literal("insertColumn"),
  col: z.number().int().nonnegative().describe("기준 열 인덱스 (0-based)"),
  position: z.enum(["left", "right"]).describe("삽입 위치: left=col 왼쪽에, right=col 오른쪽에"),
});

const deleteColumnOpSchema = z.object({
  type: z.literal("deleteColumn"),
  col: z.number().int().nonnegative().describe("삭제할 열 인덱스 (0-based)"),
});

const mergeCellsOpSchema = z.object({
  type: z.literal("mergeCells"),
  startRow: z.number().int().nonnegative().describe("병합 시작 행 (0-based)"),
  startCol: z.number().int().nonnegative().describe("병합 시작 열 (0-based)"),
  endRow: z.number().int().nonnegative().describe("병합 끝 행 (0-based, 포함)"),
  endCol: z.number().int().nonnegative().describe("병합 끝 열 (0-based, 포함)"),
});

const operationSchema = z
  .discriminatedUnion("type", [
    insertRowOpSchema,
    deleteRowOpSchema,
    insertColumnOpSchema,
    deleteColumnOpSchema,
    mergeCellsOpSchema,
  ])
  .describe("표 구조 연산. 나중 연산의 row/col 인덱스는 앞 연산 적용 후 상태를 기준으로 한다.");

export type TableStructureOperation = z.infer<typeof operationSchema>;

export const proposeTableStructureSchema = z.object({
  path: z.string().describe("수정할 .hwp 또는 .hwpx 파일 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  anchor: z
    .string()
    .min(1)
    .describe(
      "대상 표를 식별하는 앵커 텍스트. 표 안에만 있는 독특한 셀 텍스트를 지정하세요. " +
        "(부분 일치, 공백 트림) — read_document로 확인 후 사용 권장.",
    ),
  operations: z
    .array(operationSchema)
    .min(1)
    .describe(
      "적용할 표 구조 연산 목록 (순서대로 실행). " +
        "각 연산은 이전 연산이 적용된 후의 표 상태 기준으로 row/col을 지정해야 합니다.",
    ),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeTableStructureInput = z.infer<typeof proposeTableStructureSchema>;

// ─────────────────────────────────────────────────────────
// rhwp 연산 결과 파싱
// ─────────────────────────────────────────────────────────

/**
 * rhwp 표 구조 연산 결과 JSON을 파싱한다.
 * 성공: { ok: true, ... }
 * 실패: null
 */
function parseOpResult(json: string): { ok: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as { ok: boolean };
}

// ─────────────────────────────────────────────────────────
// 자기검증 게이트 (export for testing)
// ─────────────────────────────────────────────────────────

/**
 * 순수 행/열 삽입·삭제 연산으로부터 예상 행·열 수의 순증감을 계산한다.
 * mergeCells 연산이 포함되면 null 반환 (행·열 수 변화 없음, 검증 불가).
 */
export function computeExpectedDelta(
  ops: TableStructureOperation[],
): { rowDelta: number; colDelta: number } | null {
  let rowDelta = 0;
  let colDelta = 0;
  for (const op of ops) {
    if (op.type === "mergeCells") return null;
    if (op.type === "insertRow") rowDelta++;
    else if (op.type === "deleteRow") rowDelta--;
    else if (op.type === "insertColumn") colDelta++;
    else if (op.type === "deleteColumn") colDelta--;
  }
  return { rowDelta, colDelta };
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeTableStructureTool: ToolDefinition<ProposeTableStructureInput> = {
  name: "propose_table_structure",
  description:
    "HWP/HWPX 문서에서 anchor 텍스트로 식별된 표의 구조(행/열/셀 병합)를 수정합니다. " +
    "rhwp 엔진을 사용하여 행·열 삽입·삭제 및 셀 병합을 수행합니다. " +
    "anchor는 대상 표 안에만 있는 독특한 셀 텍스트를 지정하세요 — " +
    "먼저 read_document로 문서를 읽어 표 내용을 확인하세요. " +
    "연산은 지정된 순서대로 적용되며, 나중 연산의 row/col 인덱스는 " +
    "앞 연산 적용 후의 표 상태를 기준으로 합니다. " +
    ".hwpx와 .hwp를 모두 지원하며, .hwp 파일은 .hwpx로 저장됩니다 " +
    "(exportHwp()는 편집 내용을 저장하지 않으므로 항상 .hwpx로 내보냅니다). " +
    "변경 사항은 자기검증 게이트를 통과한 후 사용자 승인을 받아야만 저장됩니다.",
  inputSchema: proposeTableStructureSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeTableStructureInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // 지원 확장자 검사
    if (ext !== ".hwp" && ext !== ".hwpx") {
      return (
        `오류: propose_table_structure는 .hwp 및 .hwpx 파일만 지원합니다. ` +
        `현재 파일 확장자: ${ext}. .hwp 또는 .hwpx 파일을 지정하세요.`
      );
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

    // rhwp 문서 로드
    let doc: Awaited<ReturnType<typeof loadRhwpDocument>>;
    try {
      doc = await loadRhwpDocument(originalBytes);
    } catch (e) {
      return `오류: 문서를 불러오지 못했습니다. ${String(e)}`;
    }

    // anchor로 표 찾기
    const tableResult = findTableByAnchor(doc, input.anchor);
    if ("error" in tableResult) {
      return `오류: ${tableResult.error}`;
    }
    const { sec, para, ctrl } = tableResult;

    // before 치수 읽기
    let beforeRowCount = 0;
    let beforeColCount = 0;
    try {
      const raw = doc.getTableDimensions(sec, para, ctrl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).rowCount === "number"
      ) {
        beforeRowCount = (parsed as Record<string, unknown>).rowCount as number;
        beforeColCount = (parsed as Record<string, unknown>).colCount as number;
      }
    } catch {
      return `오류: getTableDimensions 호출 실패 (sec=${sec}, para=${para}, ctrl=${ctrl}).`;
    }

    // 연산 적용
    for (let i = 0; i < input.operations.length; i++) {
      const op = input.operations[i];
      if (!op) continue;

      let rawResult: string;
      try {
        if (op.type === "insertRow") {
          // below=true → row 아래에 삽입, false → row 위에 삽입
          const below = op.position === "below";
          rawResult = doc.insertTableRow(sec, para, ctrl, op.row, below);
        } else if (op.type === "deleteRow") {
          rawResult = doc.deleteTableRow(sec, para, ctrl, op.row);
        } else if (op.type === "insertColumn") {
          // right=true → col 오른쪽에 삽입, false → col 왼쪽에 삽입
          const right = op.position === "right";
          rawResult = doc.insertTableColumn(sec, para, ctrl, op.col, right);
        } else if (op.type === "deleteColumn") {
          rawResult = doc.deleteTableColumn(sec, para, ctrl, op.col);
        } else {
          // mergeCells
          rawResult = doc.mergeTableCells(
            sec,
            para,
            ctrl,
            op.startRow,
            op.startCol,
            op.endRow,
            op.endCol,
          );
        }
      } catch (e) {
        return (
          `오류: 연산 #${i + 1} (${op.type}) 실행 중 예외가 발생했습니다. ` +
          `파일을 변경하지 않았습니다. 원인: ${String(e)}`
        );
      }

      const opResult = parseOpResult(rawResult);
      if (opResult?.ok !== true) {
        return (
          `오류: 연산 #${i + 1} (${op.type})이 실패했습니다 (ok !== true). ` +
          `rhwp 결과: ${rawResult}. 파일을 변경하지 않았습니다.`
        );
      }
    }

    // 항상 .hwpx로 내보내기
    let newBytes: Uint8Array;
    try {
      newBytes = doc.exportHwpx();
    } catch (e) {
      return `오류: 문서 내보내기 실패. ${String(e)}`;
    }

    // ── 자기검증 게이트 ──────────────────────────────────
    const warnings: string[] = [];

    // .hwp 입력 시 경고
    if (ext === ".hwp") {
      warnings.push("rhwp는 .hwp 직접 저장을 지원하지 않아 .hwpx로 저장됩니다.");
    }

    // 원본 kordoc parse (구조 손실 게이트용)
    let originalBlocks: import("@clazic/kordoc").IRBlock[] | null = null;
    try {
      const origResult = await parse(originalBuf.buffer as ArrayBuffer);
      if (origResult.success) {
        originalBlocks = origResult.blocks;
      }
    } catch {
      // parse 실패 → originalBlocks는 null 유지 (게이트 스킵)
    }

    // (1) kordoc parse로 재파싱 — 성공 + anchor 텍스트 존재 확인
    let exportedMd = "";
    let kordocOk = false;
    let exportedBlocks: import("@clazic/kordoc").IRBlock[] | null = null;
    try {
      const exportedResult = await parse(newBytes.buffer as ArrayBuffer);
      if (exportedResult.success) {
        exportedMd = exportedResult.markdown;
        exportedBlocks = exportedResult.blocks;
        kordocOk = true;
      }
    } catch {
      // 파싱 실패 → 아래서 처리
    }

    if (!kordocOk) {
      return (
        `오류: 내보낸 문서를 kordoc으로 재파싱하지 못했습니다. ` +
        `문서가 손상되었을 수 있으므로 파일을 저장하지 않았습니다.`
      );
    }

    // ── 구조 손실 게이트 (블록 히스토그램 비교) ───────────
    if (originalBlocks !== null && exportedBlocks !== null) {
      const lossResult = detectStructuralLoss(originalBlocks, exportedBlocks);
      if (lossResult.lost) {
        return (
          `오류: rhwp 엔진이 이 문서를 안전하게 변환하지 못했습니다(구조 손실: ${lossResult.detail}). ` +
          `중첩표·이미지 등이 포함된 복잡한 문서는 현재 rhwp 엔진으로 편집할 수 없습니다. ` +
          `파일을 변경하지 않았습니다.`
        );
      }
    }
    // ── 구조 손실 게이트 종료 ─────────────────────────────

    // anchor 텍스트가 결과 문서에 없는 경우:
    //   - 삭제 연산(deleteRow/deleteColumn)이 포함된 경우 anchor 자체가 삭제될 수 있으므로 경고만 추가.
    //   - 삽입/병합만인 경우(anchor가 살아있어야 함)에는 오류로 처리.
    const hasDeleteOp = input.operations.some(
      (op) => op.type === "deleteRow" || op.type === "deleteColumn",
    );
    const anchorInExported = exportedMd.includes(input.anchor.trim());
    if (!anchorInExported) {
      if (!hasDeleteOp) {
        return (
          `오류: 자기검증 실패 — 내보낸 문서에서 anchor "${input.anchor}"를 찾을 수 없습니다. ` +
          `표 구조가 손상되었을 수 있으므로 파일을 저장하지 않았습니다.`
        );
      }
      // 삭제 연산 포함 → anchor가 삭제된 행/열에 있었을 수 있음: 경고만 추가
      warnings.push(
        `자기검증: 내보낸 문서에서 anchor "${input.anchor}"가 보이지 않습니다. ` +
          `삭제 연산으로 anchor가 포함된 행/열이 제거되었을 수 있습니다. 결과를 직접 확인하세요.`,
      );
    }

    // (2) 순수 행/열 삽입·삭제 연산: rhwp로 재로드 후 치수 검증
    let afterRowCount = beforeRowCount;
    let afterColCount = beforeColCount;

    const delta = computeExpectedDelta(input.operations);
    if (delta !== null) {
      // 병합 없음 → 행·열 수 검증 가능
      const expectedRowCount = beforeRowCount + delta.rowDelta;
      const expectedColCount = beforeColCount + delta.colDelta;

      // 재로드하여 실제 치수 확인
      // anchor가 삭제된 경우 원본 sec/para/ctrl 주소를 직접 사용해 치수를 읽는다.
      let verifyRowCount = -1;
      let verifyColCount = -1;
      try {
        const verifyDoc = await loadRhwpDocument(newBytes);
        // 먼저 anchor로 재탐색 시도 (anchor가 살아있는 경우)
        let verifyAddr: { sec: number; para: number; ctrl: number } | null = null;
        const verifyResult = findTableByAnchor(verifyDoc, input.anchor);
        if (!("error" in verifyResult)) {
          verifyAddr = { sec: verifyResult.sec, para: verifyResult.para, ctrl: verifyResult.ctrl };
        } else if (hasDeleteOp) {
          // anchor가 삭제된 경우: 원본 주소를 직접 사용
          verifyAddr = { sec, para, ctrl };
        }

        if (verifyAddr !== null) {
          const dimRaw = verifyDoc.getTableDimensions(
            verifyAddr.sec,
            verifyAddr.para,
            verifyAddr.ctrl,
          );
          const dimParsed = JSON.parse(dimRaw) as Record<string, unknown>;
          if (typeof dimParsed.rowCount === "number") {
            verifyRowCount = dimParsed.rowCount;
            verifyColCount = (dimParsed.colCount as number) ?? -1;
          }
        }
      } catch {
        // 재로드 실패 → 경고만 추가
        warnings.push("자기검증(치수 재확인)을 수행하지 못했습니다. 결과를 직접 확인하세요.");
      }

      if (verifyRowCount >= 0) {
        if (verifyRowCount !== expectedRowCount || verifyColCount !== expectedColCount) {
          return (
            `오류: 자기검증 실패 — 예상 치수 (${expectedRowCount}행 × ${expectedColCount}열)와 ` +
            `실제 치수 (${verifyRowCount}행 × ${verifyColCount}열)가 다릅니다. ` +
            `파일을 저장하지 않았습니다.`
          );
        }
        afterRowCount = verifyRowCount;
        afterColCount = verifyColCount;
      } else {
        afterRowCount = expectedRowCount;
        afterColCount = expectedColCount;
      }
    }
    // ── 게이트 종료 ───────────────────────────────────────

    // 출력 경로 결정
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);

    // diff 텍스트 생성
    const opDescriptions = input.operations.map((op, i) => {
      if (op.type === "insertRow")
        return `  ${i + 1}. 행 ${op.row} ${op.position === "below" ? "아래" : "위"}에 행 삽입`;
      if (op.type === "deleteRow") return `  ${i + 1}. 행 ${op.row} 삭제`;
      if (op.type === "insertColumn")
        return `  ${i + 1}. 열 ${op.col} ${op.position === "right" ? "오른쪽" : "왼쪽"}에 열 삽입`;
      if (op.type === "deleteColumn") return `  ${i + 1}. 열 ${op.col} 삭제`;
      // mergeCells
      return `  ${i + 1}. (${op.startRow},${op.startCol})~(${op.endRow},${op.endCol}) 셀 병합`;
    });

    const diff =
      `anchor: "${input.anchor}" → (sec=${sec}, para=${para}, ctrl=${ctrl})\n` +
      `이전: ${beforeRowCount}행 × ${beforeColCount}열\n` +
      `이후: ${afterRowCount}행 × ${afterColCount}열\n` +
      `연산 (${input.operations.length}개):\n${opDescriptions.join("\n")}`;

    // 스테이징
    const stagedPath = await stageFile(ctx.sessionId, outputPath, newBytes);
    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "table-structure",
        targetPath: outputPath,
        stagedPath,
        summary: input.summary,
        diff,
        warnings,
        willConvertFormat,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(safePath);
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `저장 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
