/**
 * propose_form_fill 툴 — 문서 양식 필드 채우기 제안
 * docs/SPEC.md §6, §7
 *
 * SPEC 일탈: kordoc에는 fillForm이 export되지 않음.
 * 대신 extractFormFields(blocks)로 현재 필드 목록을 읽고,
 * 마크다운에서 필드 값을 직접 치환한 뒤 patchHwpx로 무손실 패치한다.
 *
 * diff: 라벨: 이전 값 → 새 값 표
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { kordocErrorMessage } from "@kodocagent/shared";
import { extractFormFields, patchHwpx } from "kordoc";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { hwpStructuralGuard, resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

export const proposeFormFillSchema = z.object({
  path: z.string().describe("양식 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  fields: z
    .record(z.string(), z.string())
    .describe("채울 필드 매핑: { 라벨: 값 }. read_document로 먼저 필드 목록을 확인하세요"),
  summary: z.string().describe("변경 요약 (한국어 1-2문장)"),
});

export type ProposeFormFillInput = z.infer<typeof proposeFormFillSchema>;

export const proposeFormFillTool: ToolDefinition<ProposeFormFillInput> = {
  name: "propose_form_fill",
  description:
    "HWPX/HWP 양식 문서의 필드를 채웁니다. " +
    "반드시 read_document로 현재 필드 목록을 먼저 확인한 후 사용하세요. " +
    "변경 사항은 diff 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: proposeFormFillSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeFormFillInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    if (ext !== ".hwpx" && ext !== ".hwp") {
      return `오류: propose_form_fill은 .hwp/.hwpx 파일만 지원합니다. 현재 파일: ${ext}. .docx 파일은 propose_edit을 사용하세요.`;
    }

    // 원본 파일 읽기
    let originalBuffer: Buffer;
    try {
      originalBuffer = await readFile(safePath);
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}. 경로를 확인하세요.`;
    }

    // OLE2/HWP 바이너리 가드 — 콘텐츠 기반 감지 (확장자 오인식 포함)
    // patchHwpx는 실제 .hwp OLE 바이너리를 처리할 수 없으므로 조기 차단
    const structuralGuard = hwpStructuralGuard(
      ext,
      new Uint8Array(originalBuffer.buffer, originalBuffer.byteOffset, originalBuffer.byteLength),
    );
    if (structuralGuard !== null) {
      return structuralGuard;
    }

    // 원본 파싱
    const parseResult = await parse(originalBuffer.buffer as ArrayBuffer);
    if (!parseResult.success) {
      const msg = kordocErrorMessage(
        parseResult.code,
        `문서를 읽을 수 없습니다: ${parseResult.error}`,
      );
      return `오류: ${msg}`;
    }

    // 현재 양식 필드 추출
    const formResult = extractFormFields(parseResult.blocks);
    const existingFields = new Map(formResult.fields.map((f) => [f.label, f.value]));

    // 매핑되지 않은 필드 경고
    const unknownLabels = Object.keys(input.fields).filter((label) => !existingFields.has(label));
    const warnings: string[] = [];
    if (unknownLabels.length > 0) {
      warnings.push(
        `다음 라벨을 찾을 수 없습니다: ${unknownLabels.join(", ")}. read_document로 현재 필드 목록을 확인하세요.`,
      );
    }

    // 마크다운에서 필드 값 치환하여 새 마크다운 생성
    let newMarkdown = parseResult.markdown;
    const diffLines: string[] = ["| 라벨 | 이전 값 | 새 값 |", "| --- | --- | --- |"];

    for (const [label, newValue] of Object.entries(input.fields)) {
      const oldValue = existingFields.get(label) ?? "(없음)";
      diffLines.push(`| ${label} | ${oldValue} | ${newValue} |`);

      // 마크다운에서 "라벨: 이전값" 또는 "라벨 이전값" 패턴 치환
      // 표 형식: | 라벨 | 이전값 | → | 라벨 | 새값 |
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedOld = oldValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (oldValue !== "(없음)") {
        newMarkdown = newMarkdown.replace(
          new RegExp(`(\\|\\s*${escapedLabel}\\s*\\|\\s*)${escapedOld}(\\s*\\|)`, "g"),
          `$1${newValue}$2`,
        );
      }
    }

    const diff = diffLines.join("\n");

    // patchHwpx로 무손실 서식 보존 채우기
    const origU8 = new Uint8Array(
      originalBuffer.buffer,
      originalBuffer.byteOffset,
      originalBuffer.byteLength,
    );
    const patchResult = await patchHwpx(origU8, newMarkdown);
    if (!patchResult.success || !patchResult.data) {
      return `오류: 양식 채우기를 적용하지 못했습니다: ${patchResult.error ?? "알 수 없는 오류"}.`;
    }
    const stagedData = patchResult.data;
    for (const s of patchResult.skipped) {
      warnings.push(`일부 항목이 적용되지 않았습니다(${s.reason ?? "사유 미상"}).`);
    }
    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);
    const stagedPath = await stageFile(ctx.sessionId, safePath, stagedData);

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "form-fill",
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
