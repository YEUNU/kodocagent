/**
 * compare_documents 툴 — kordoc compare()로 두 문서를 비교하여 블록 단위 diff 반환
 *
 * 읽기 전용 툴 (requiresApproval: false).
 * 크로스 포맷 비교 가능 (예: HWP vs HWPX).
 *
 * docs/SPEC.md §6
 */
import { readFile } from "node:fs/promises";
import { blocksToMarkdown, compare } from "kordoc";
import { z } from "zod";
import { assertFileSizeWithinLimit, resolveSafePath } from "../security.js";
import type { ToolContext, ToolDefinition } from "../types.js";

/** 반환 마크다운 최대 길이 — read_document와 동일 */
const MAX_MARKDOWN_LENGTH = 80_000;

/** 텍스트가 너무 길 경우 한 줄로 트렁케이트 */
const MAX_BLOCK_TEXT_LENGTH = 200;

export const compareDocumentsSchema = z.object({
  pathA: z.string().describe("비교할 첫 번째 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
  pathB: z.string().describe("비교할 두 번째 문서 경로 (cwd 기준 상대 경로 또는 절대 경로)"),
});

export type CompareDocumentsInput = z.infer<typeof compareDocumentsSchema>;

/**
 * Node.js Buffer에서 안전한 ArrayBuffer를 얻는다.
 * Buffer는 내부 풀을 공유하므로 byteOffset/byteLength 기반 슬라이스가 필요하다.
 * `buf.buffer.slice()`는 `ArrayBuffer | SharedArrayBuffer`를 반환하므로 명시적 캐스팅한다.
 */
function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * IRBlock을 한 줄 텍스트로 변환한다.
 * blocksToMarkdown([block])으로 마크다운을 구하고 길면 트렁케이트한다.
 */
function blockToText(block: Parameters<typeof blocksToMarkdown>[0][number]): string {
  const md = blocksToMarkdown([block]).trim();
  if (md.length > MAX_BLOCK_TEXT_LENGTH) {
    return `${md.slice(0, MAX_BLOCK_TEXT_LENGTH)}…`;
  }
  return md;
}

export const compareDocumentsTool: ToolDefinition<CompareDocumentsInput> = {
  name: "compare_documents",
  description:
    "두 문서를 비교하여 추가·삭제·수정된 블록과 통계를 한국어 마크다운으로 반환합니다. " +
    "HWP/HWPX/DOCX/XLSX/PDF 등 크로스 포맷 비교가 가능합니다.",
  inputSchema: compareDocumentsSchema,
  requiresApproval: false,
  execute: async ({
    input,
    ctx,
  }: {
    input: CompareDocumentsInput;
    signal?: AbortSignal;
    ctx: ToolContext;
  }) => {
    // 경로 보안 검증
    let safePathA: string;
    let safePathB: string;
    try {
      safePathA = await resolveSafePath(ctx.cwd, input.pathA);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: pathA 경로를 확인할 수 없습니다: ${msg}`;
    }
    try {
      safePathB = await resolveSafePath(ctx.cwd, input.pathB);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: pathB 경로를 확인할 수 없습니다: ${msg}`;
    }

    // 파일 읽기
    let bufA: Buffer;
    let bufB: Buffer;
    try {
      await assertFileSizeWithinLimit(safePathA);
      bufA = await readFile(safePathA);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: 첫 번째 파일을 읽을 수 없습니다 (${input.pathA}): ${msg}`;
    }
    try {
      await assertFileSizeWithinLimit(safePathB);
      bufB = await readFile(safePathB);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: 두 번째 파일을 읽을 수 없습니다 (${input.pathB}): ${msg}`;
    }

    // Buffer 풀 공유 문제를 피하기 위해 slicing으로 독립적인 ArrayBuffer 확보
    const abA = bufferToArrayBuffer(bufA);
    const abB = bufferToArrayBuffer(bufB);

    // kordoc 비교 수행
    let diffResult: Awaited<ReturnType<typeof compare>>;
    try {
      diffResult = await compare(abA, abB);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `오류: 문서 비교 중 오류가 발생했습니다: ${msg}`;
    }

    const { stats, diffs } = diffResult;

    // ─── 마크다운 결과 조합 ────────────────────────────────
    const lines: string[] = [];

    lines.push("## 문서 비교 결과");
    lines.push("");
    lines.push(`- **문서 A**: \`${input.pathA}\``);
    lines.push(`- **문서 B**: \`${input.pathB}\``);
    lines.push("");

    // 통계 표
    lines.push("### 변경 통계");
    lines.push("");
    lines.push("| 구분 | 건수 |");
    lines.push("|------|------|");
    lines.push(`| 추가 | ${stats.added} |`);
    lines.push(`| 삭제 | ${stats.removed} |`);
    lines.push(`| 수정 | ${stats.modified} |`);
    lines.push(`| 변경 없음 | ${stats.unchanged} |`);
    lines.push("");

    // unchanged 제외한 변경 블록 목록
    const changedDiffs = diffs.filter((d) => d.type !== "unchanged");

    if (changedDiffs.length === 0) {
      lines.push("### 변경 내용");
      lines.push("");
      lines.push("두 문서가 동일합니다. 변경된 블록이 없습니다.");
    } else {
      lines.push("### 변경 내용");
      lines.push("");

      for (const diff of changedDiffs) {
        if (diff.type === "added") {
          // 추가된 블록 — after만 존재
          const afterText = diff.after ? blockToText(diff.after) : "";
          lines.push(`**[추가]** ${afterText}`);
        } else if (diff.type === "removed") {
          // 삭제된 블록 — before만 존재
          const beforeText = diff.before ? blockToText(diff.before) : "";
          lines.push(`**[삭제]** ${beforeText}`);
        } else if (diff.type === "modified") {
          // 수정된 블록 — before, after 모두 존재
          const beforeText = diff.before ? blockToText(diff.before) : "";
          const afterText = diff.after ? blockToText(diff.after) : "";
          lines.push(`**[수정]**`);
          lines.push(`- 이전: ${beforeText}`);
          lines.push(`- 이후: ${afterText}`);

          // 셀 단위 변경 (테이블 블록의 경우)
          if (diff.cellDiffs && diff.cellDiffs.length > 0) {
            const changedCells = diff.cellDiffs.flat().filter((cell) => cell.type !== "unchanged");
            if (changedCells.length > 0) {
              lines.push(`  - 셀 변경 (${changedCells.length}건):`);
              for (const cell of changedCells.slice(0, 10)) {
                // 최대 10개 셀만 표시
                if (cell.type === "added") {
                  const val = cell.after ?? "";
                  lines.push(`    - 추가: \`${val.length > 80 ? `${val.slice(0, 80)}…` : val}\``);
                } else if (cell.type === "removed") {
                  const val = cell.before ?? "";
                  lines.push(`    - 삭제: \`${val.length > 80 ? `${val.slice(0, 80)}…` : val}\``);
                } else if (cell.type === "modified") {
                  const bval = cell.before ?? "";
                  const aval = cell.after ?? "";
                  const bShort = bval.length > 60 ? `${bval.slice(0, 60)}…` : bval;
                  const aShort = aval.length > 60 ? `${aval.slice(0, 60)}…` : aval;
                  lines.push(`    - 수정: \`${bShort}\` → \`${aShort}\``);
                }
              }
              if (changedCells.length > 10) {
                lines.push(`    - … 외 ${changedCells.length - 10}건`);
              }
            }
          }
        }
        lines.push(""); // 블록 사이 빈 줄
      }
    }

    // 전체 출력 조합
    const output = lines.join("\n");

    // MAX_MARKDOWN_LENGTH 캡 처리
    if (output.length > MAX_MARKDOWN_LENGTH) {
      const truncated = output.slice(0, MAX_MARKDOWN_LENGTH);
      return `${truncated}\n\n---\n\n⚠️ 내용이 너무 길어 약 80,000자에서 잘렸습니다.`;
    }

    return output;
  },
};
