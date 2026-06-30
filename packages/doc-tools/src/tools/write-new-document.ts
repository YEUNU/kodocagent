/**
 * write_new_document 툴 — 신규 문서 작성 제안
 * docs/SPEC.md §6, §7
 *
 * 확장자별 처리:
 * - .hwpx : markdownToHwpx (템플릿 없음)
 * - .docx : md→docx 재생성
 * - .md/.txt : raw 저장
 *
 * 타겟 파일이 이미 존재하면 오류 (propose_edit을 사용하도록 안내)
 * diff 없이 전체 내용 미리보기 (최대 10k 문자)
 */

import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { KodocError } from "@kodocagent/shared";
import { markdownToHwpx } from "kordoc";
import { z } from "zod";
import { markdownToDocx } from "../md-to-docx.js";
import { resolveSafePath } from "../security.js";
import { commitStaged, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

const MAX_PREVIEW_CHARS = 10_000;

// ⑬ Windows 예약 파일명·경로 길이 검증 (Windows에서만 실행, 다른 플랫폼은 no-op)
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^.]*)?$/i;
const WINDOWS_MAX_PATH = 259;

/**
 * Windows에서만 예약 파일명·경로 길이를 검증한다.
 * macOS/Linux는 no-op.
 * @throws KodocError — 예약명이거나 260자 초과 시
 */
function assertWindowsSafePath(absPath: string): void {
  if (process.platform !== "win32") return;
  const name = basename(absPath);
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    throw new KodocError("Windows에서 사용할 수 없는 파일 이름입니다.", "다른 이름을 사용하세요.");
  }
  if (absPath.length > WINDOWS_MAX_PATH) {
    throw new KodocError(
      `경로가 너무 깁니다(Windows 260자 제한). 현재: ${absPath.length}자.`,
      "더 짧은 경로나 파일 이름을 사용하세요.",
    );
  }
}

/** 공문서 서식 프리셋(.hwpx 전용) — kordoc GongmunPresetInput(영문 키 + 한글 별칭)과 동기화. */
const GONGMUN_PRESETS = [
  "official",
  "report",
  "plan",
  "notice",
  "minutes",
  "기안문",
  "시행문",
  "공문",
  "공문서",
  "보고서",
  "계획서",
  "계획",
  "통지",
  "알림",
  "안내",
  "회의록",
] as const;

export const writeNewDocumentSchema = z.object({
  path: z.string().describe("생성할 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  markdown: z
    .string()
    .refine((s) => !s.includes("\u0000"), "내용에 NULL 문자를 포함할 수 없습니다")
    .describe("새 문서 내용 (마크다운 형식)"),
  gongmunPreset: z
    .enum(GONGMUN_PRESETS)
    .optional()
    .describe(
      "공문서 서식 프리셋(.hwpx 전용). 지정 시 한국 행정 공문서 표준 서식(공식 여백·명조 15pt·" +
        "항목부호 8단계)으로 생성. 'report'/'보고서'=□○- 보고서체, 'official'/'기안문'=법정 8단계, " +
        "'minutes'/'회의록'=좁은 줄간격. 일반 문서는 비워 두세요.",
    ),
  gongmunFont: z
    .enum(["myeongjo", "gothic"])
    .optional()
    .describe("본문 글꼴(공문 프리셋 시). myeongjo=명조(보고서 관행), gothic=고딕(전자결재 기본)."),
  gongmunNumbering: z
    .enum(["standard", "report"])
    .optional()
    .describe(
      "항목부호 체계(공문 프리셋 시). standard=법정 8단계(1. 가. 1)…), report=보고서 불릿(□ ○ -).",
    ),
});

export type WriteNewDocumentInput = z.infer<typeof writeNewDocumentSchema>;

export const writeNewDocumentTool: ToolDefinition<WriteNewDocumentInput> = {
  name: "write_new_document",
  description:
    "새 문서 파일(.hwpx/.docx/.md/.txt)을 생성합니다. " +
    "이미 존재하는 파일은 생성할 수 없습니다(존재하는 파일 수정은 propose_edit 사용). " +
    "내용 미리보기와 함께 사용자 승인을 받은 후에만 저장됩니다.",
  inputSchema: writeNewDocumentSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: WriteNewDocumentInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // ⑬ Windows 예약 파일명·경로 길이 검증
    try {
      assertWindowsSafePath(safePath);
    } catch (err) {
      if (err instanceof KodocError) return `오류: ${err.message} ${err.hint ?? ""}`.trim();
      throw err;
    }

    // 타겟 파일이 이미 존재하는지 확인
    try {
      await stat(safePath);
      return (
        `오류: 파일이 이미 존재합니다: ${input.path}. ` +
        `기존 파일을 수정하려면 propose_edit을 사용하세요.`
      );
    } catch {
      // ENOENT = 파일 없음 → 정상 진행
    }

    const warnings: string[] = [];
    let stagedData: Uint8Array;

    const wantsGongmun = !!(input.gongmunPreset || input.gongmunFont || input.gongmunNumbering);
    if (wantsGongmun && ext !== ".hwpx") {
      warnings.push("공문서 서식 프리셋은 .hwpx에만 적용됩니다 — 이 형식에서는 무시됩니다.");
    }

    if (ext === ".hwpx") {
      // 공문 프리셋이 지정되면 한국 행정 공문서 표준 서식으로 렌더(미지정 시 기존 범용 변환).
      const hwpxBuffer = wantsGongmun
        ? await markdownToHwpx(input.markdown, {
            gongmun: {
              preset: input.gongmunPreset,
              bodyFont: input.gongmunFont,
              numbering: input.gongmunNumbering,
            },
          })
        : await markdownToHwpx(input.markdown);
      stagedData = new Uint8Array(hwpxBuffer);
      if (wantsGongmun) {
        warnings.push(
          `공문서 서식 프리셋 적용: ${input.gongmunPreset ?? "official"}` +
            `${input.gongmunFont ? ` · ${input.gongmunFont}` : ""}` +
            `${input.gongmunNumbering ? ` · ${input.gongmunNumbering} 번호체계` : ""}.`,
        );
      }
    } else if (ext === ".docx") {
      warnings.push("DOCX 생성: 복잡한 서식(머리글/각주/스타일)은 지원되지 않습니다.");
      const docxBuffer = await markdownToDocx(input.markdown);
      stagedData = new Uint8Array(docxBuffer);
    } else if (ext === ".md" || ext === ".txt") {
      stagedData = new TextEncoder().encode(input.markdown);
    } else {
      return (
        `오류: 지원하지 않는 파일 형식입니다: ${ext}. ` +
        `.hwpx, .docx, .md, .txt 중 하나를 사용하세요.`
      );
    }

    // 스테이징
    const stagedPath = await stageFile(ctx.sessionId, safePath, stagedData);

    // 전체 내용 미리보기 (diff 대신)
    const preview =
      input.markdown.length > MAX_PREVIEW_CHARS
        ? `${input.markdown.slice(0, MAX_PREVIEW_CHARS)}\n\n...이하 생략 (${input.markdown.length - MAX_PREVIEW_CHARS}자 더 있음)`
        : input.markdown;

    const proposalId = crypto.randomUUID();

    return {
      proposal: {
        id: proposalId,
        kind: "new-document",
        targetPath: safePath,
        stagedPath,
        summary: `새 문서 생성: ${input.path}`,
        diff: `[새 파일 미리보기]\n\n${preview}`,
        warnings,
      },
      commit: async (): Promise<string> => {
        // 신규 파일이므로 백업 불필요
        await commitStaged(stagedPath, safePath);
        return `저장 완료: ${safePath}`;
      },
    };
  },
};
