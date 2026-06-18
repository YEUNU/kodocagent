/**
 * propose_form_fill 툴 — 문서 양식 필드 채우기 제안
 * docs/SPEC.md §6, §7
 *
 * kordoc `fillHwpx(hwpxBuffer, {라벨: 값})` 로 HWPX 원본을 직접 수정해 서식 필드를
 * 채운다(스타일 100% 보존). 과거에는 fillForm 미export로 마크다운 정규식 치환 +
 * patchHwpx 우회를 썼으나, kordoc 3.1.x 가 전용 API 를 제공하므로 이를 채택한다.
 * (직접 XML 수정이라 patchHwpx 의 전-마크다운 LCS 재조정 경로를 타지 않는다.)
 *
 * diff: 라벨: 이전 값 → 새 값 표. 미매칭 라벨은 fillHwpx 의 unmatched 로 경고하고,
 * kordoc `extractFormSchema`(type/required/empty 추론)로 채울 수 있는 필드 목록을
 * 함께 안내해 에이전트가 라벨을 자가교정하도록 돕는다.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { kordocErrorMessage } from "@kodocagent/shared";
import { extractFormSchema, fillHwpx } from "kordoc";
import { z } from "zod";
import { parse } from "../kordoc-parse.js";
import { assertFileSizeWithinLimit, hwpStructuralGuard, resolveSafePath } from "../security.js";
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

    // 현재 양식 필드 스키마 추출 — kordoc extractFormSchema(type/required/empty 추론).
    // diff 의 '이전 값' 표시 + 미매칭 시 채울 수 있는 필드 안내에 사용.
    const formSchema = extractFormSchema(parseResult.blocks);
    const existingFields = new Map(formSchema.fields.map((f) => [f.label, f.value]));
    const warnings: string[] = [];

    // 채울 수 있는 필드 안내 문자열 — 라벨 불일치 시 에이전트 자가교정용
    const fieldTypeKo: Record<string, string> = {
      text: "텍스트",
      date: "날짜",
      phone: "전화",
      email: "이메일",
      amount: "금액",
      checkbox: "체크박스",
      idnum: "주민번호",
    };
    const availableHint =
      formSchema.fields.length > 0
        ? ` 채울 수 있는 필드: ${formSchema.fields
            .map((f) => `${f.label}(${fieldTypeKo[f.type] ?? f.type}${f.required ? ", 필수" : ""})`)
            .join(", ")}.`
        : "";

    // diff 구성: 라벨 | 이전 값 | 새 값
    const diffLines: string[] = ["| 라벨 | 이전 값 | 새 값 |", "| --- | --- | --- |"];
    for (const [label, newValue] of Object.entries(input.fields)) {
      const oldValue = existingFields.get(label) ?? "(없음)";
      diffLines.push(`| ${label} | ${oldValue} | ${newValue} |`);
    }
    const diff = diffLines.join("\n");

    // kordoc fillHwpx — HWPX 원본을 직접 수정해 서식 필드를 채움(스타일 100% 보존)
    const origAB = originalBuffer.buffer.slice(
      originalBuffer.byteOffset,
      originalBuffer.byteOffset + originalBuffer.byteLength,
    ) as ArrayBuffer;
    let stagedData: Uint8Array;
    try {
      const fillResult = await fillHwpx(origAB, input.fields);
      if (fillResult.unmatched.length > 0) {
        warnings.push(
          `다음 라벨을 찾을 수 없습니다: ${fillResult.unmatched.join(", ")}.${
            availableHint || " read_document로 현재 필드 목록을 확인하세요."
          }`,
        );
      }
      if (fillResult.filled.length === 0) {
        return `오류: 채워진 양식 필드가 없습니다. 라벨이 문서와 일치하는지 확인하세요${
          fillResult.unmatched.length > 0 ? ` (미매칭: ${fillResult.unmatched.join(", ")})` : ""
        }.${availableHint || " read_document로 현재 필드 목록을 확인하세요."}`;
      }
      stagedData = new Uint8Array(fillResult.buffer);
    } catch (err) {
      return `오류: 양식 채우기를 적용하지 못했습니다: ${err instanceof Error ? err.message : String(err)}.`;
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
