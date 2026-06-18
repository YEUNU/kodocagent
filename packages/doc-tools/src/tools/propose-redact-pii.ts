/**
 * propose_redact_pii 툴 — 문서 내 개인정보 비식별(마스킹) 처리
 *
 * .hwpx는 ZIP XML 직접 패치로 구조(표·이미지·서식) 보존.
 * .md/.txt는 UTF-8 텍스트 직접 치환.
 *
 * 원문 PII 값은 diff나 응답에 절대 노출하지 않는다.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { PiiFinding } from "@kodocagent/shared";
import { detectPii, redactRanges, redactText } from "@kodocagent/shared";
import JSZip from "jszip";
import { scanSectionXml } from "kordoc";
import { z } from "zod";
import { applyRangeSplicesToSection, collectParasInDocOrder } from "../hwpx-splice.js";
import { hwpStructuralGuard, isZipBinary, resolveSafePath } from "../security.js";
import { backupFile, commitStaged, resolveOutputPath, stageFile } from "../staging.js";
import type { ProposeOutcome, ToolContext, ToolDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────

export const proposeRedactPiiSchema = z.object({
  path: z.string().describe("개인정보를 비식별 처리할 문서 경로"),
  summary: z.string().optional().describe("변경 요약"),
});

export type ProposeRedactPiiInput = z.infer<typeof proposeRedactPiiSchema>;

// ─────────────────────────────────────────────────────────
// 탐지 결과 합산 헬퍼
// ─────────────────────────────────────────────────────────

/** 여러 노드에서 수집된 PiiFinding[]을 타입 기준으로 합산한다. */
function mergeFindings(allFindings: PiiFinding[][]): PiiFinding[] {
  const map = new Map<string, PiiFinding>();
  for (const findings of allFindings) {
    for (const f of findings) {
      const existing = map.get(f.type);
      if (existing) {
        existing.count += f.count;
        // masked 예시를 최대 5개까지 유니크하게 병합
        for (const m of f.masked) {
          if (!existing.masked.includes(m) && existing.masked.length < 5) {
            existing.masked.push(m);
          }
        }
      } else {
        map.set(f.type, { type: f.type, count: f.count, masked: [...f.masked] });
      }
    }
  }
  return [...map.values()];
}

// ─────────────────────────────────────────────────────────
// HWPX ZIP XML 패치
// ─────────────────────────────────────────────────────────

/**
 * 폴백: 한 섹션 XML의 <hp:t> 노드 단위로 PII를 마스킹한다.
 * (splice 경로에서 오프셋 정합이 깨지는 문단이 있을 때만 사용 — 구 동작 보존.)
 */
function redactSectionViaNodes(srcXml: string): { xml: string; changed: boolean } {
  const tNodeRe = /<hp:t>([\s\S]*?)<\/hp:t>/g;
  let offset = 0;
  let result = srcXml;
  let changed = false;

  let m = tNodeRe.exec(srcXml);
  while (m !== null) {
    const content = m[1] as string;
    if (content.length > 0) {
      const { text: redacted } = redactText(content);
      if (redacted !== content) {
        // PII chars are not XML-special so operate on raw node content directly
        const openTagLen = "<hp:t>".length;
        const contentStart = m.index + offset + openTagLen;
        const contentEnd = contentStart + content.length;
        result = result.substring(0, contentStart) + redacted + result.substring(contentEnd);
        offset += redacted.length - content.length;
        changed = true;
      }
    }
    m = tNodeRe.exec(srcXml);
  }
  return { xml: result, changed };
}

/**
 * .hwpx ZIP 버퍼에서 모든 section*.xml에 PII 마스킹을 적용하고
 * 수정된 ZIP 버퍼와 탐지 결과를 반환한다.
 */
async function applyRedactToHwpx(hwpxBuffer: Uint8Array): Promise<{
  buffer: Uint8Array;
  findings: PiiFinding[];
  changed: boolean;
}> {
  const zip = await JSZip.loadAsync(hwpxBuffer);

  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort();

  // 각 섹션 XML 읽기
  const sectionXmls: string[] = [];
  for (const sf of sectionFiles) {
    const entry = zip.file(sf);
    const xml = entry ? await entry.async("string") : "";
    sectionXmls.push(xml);
  }

  // 섹션별 마스킹 — kordoc splice 우선, 폴백은 <hp:t> 노드 단위
  const newSectionXmls: string[] = [];
  const allFindings: PiiFinding[][] = [];
  let anyChanged = false;

  for (const srcXml of sectionXmls) {
    // 탐지 결과는 문단 t-도메인 텍스트 기준으로 수집한다(여러 서식 런에 나뉜 PII도 포착).
    const scan = scanSectionXml(srcXml, 0);
    for (const p of collectParasInDocOrder(scan)) {
      const findings = detectPii(p.text);
      if (findings.length > 0) allFindings.push(findings);
    }

    // 1순위: splice 범위 치환(런/charPr·tab/br 보존, 서식 분리 PII도 마스킹).
    const spliced = applyRangeSplicesToSection(srcXml, (text) =>
      redactRanges(text).map((r) => ({ start: r.start, end: r.end, replacement: r.replacement })),
    );
    if (spliced !== null) {
      newSectionXmls.push(spliced.xml);
      if (spliced.count > 0) anyChanged = true;
    } else {
      // 폴백: 오프셋 정합 불가 문단이 있는 섹션은 구 <hp:t> 노드 경로로 처리.
      const fb = redactSectionViaNodes(srcXml);
      newSectionXmls.push(fb.xml);
      if (fb.changed) anyChanged = true;
    }
  }

  if (!anyChanged) {
    return { buffer: hwpxBuffer, findings: mergeFindings(allFindings), changed: false };
  }

  // 새 ZIP 생성 (mimetype STORE 첫 번째)
  const out = new JSZip();
  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    out.file("mimetype", await mimetypeEntry.async("uint8array"), { compression: "STORE" });
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "mimetype" || entry.dir) continue;
    const sectionIdx = sectionFiles.indexOf(name);
    if (sectionIdx >= 0) {
      out.file(name, newSectionXmls[sectionIdx] ?? "");
    } else {
      out.file(name, await entry.async("uint8array"));
    }
  }

  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    buffer: new Uint8Array(buf as unknown as ArrayBuffer),
    findings: mergeFindings(allFindings),
    changed: true,
  };
}

// ─────────────────────────────────────────────────────────
// diff 텍스트 생성 (원문 PII 값 미포함)
// ─────────────────────────────────────────────────────────

function buildDiff(findings: PiiFinding[]): string {
  const total = findings.reduce((s, f) => s + f.count, 0);
  const lines: string[] = [`개인정보 ${total}건 비식별 처리`];
  for (const f of findings) {
    const examples = f.masked.slice(0, 3).join(", ");
    lines.push(`- ${f.type}: ${f.count}건 → ${examples}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// 툴 정의
// ─────────────────────────────────────────────────────────

export const proposeRedactPiiTool: ToolDefinition<ProposeRedactPiiInput> = {
  name: "propose_redact_pii",
  description:
    "문서의 개인정보(주민등록번호·전화번호·이메일·신용카드번호)를 가리기/마스킹/비식별 처리합니다. " +
    "사용자가 '개인정보 가려줘/지워줘/비식별 처리해줘/마스킹해줘'라고 하면 이 도구로 수정안을 제안하세요(scan_pii는 확인용일 뿐 수정하지 않습니다). " +
    ".hwpx는 XML 직접 패치로 구조(표·이미지·서식)를 보존하며, .md/.txt도 지원합니다. " +
    "변경은 승인 후에만 저장됩니다. 원문 값은 표시하지 않습니다.",
  inputSchema: proposeRedactPiiSchema,
  requiresApproval: true,

  propose: async ({
    input,
    ctx,
  }: {
    input: ProposeRedactPiiInput;
    ctx: ToolContext;
  }): Promise<ProposeOutcome | string> => {
    const safePath = await resolveSafePath(ctx.cwd, input.path);
    const ext = extname(safePath).toLowerCase();

    // 미지원 포맷 거부
    if (ext !== ".hwpx" && ext !== ".hwp" && ext !== ".md" && ext !== ".txt") {
      const hint =
        ext === ".docx" || ext === ".xlsx"
          ? " .hwpx/.md/.txt만 지원합니다."
          : " .hwpx/.md/.txt만 지원합니다.";
      return `오류: propose_redact_pii는 .hwpx/.md/.txt 파일만 지원합니다. 현재 파일 확장자: ${ext}.${hint}`;
    }

    const { outputPath, willConvertFormat } = resolveOutputPath(safePath);

    // ── .hwpx / .hwp 처리 ─────────────────────────────────
    if (ext === ".hwpx" || ext === ".hwp") {
      let originalBuf: Buffer;
      try {
        originalBuf = await readFile(safePath);
      } catch {
        return `오류: 파일을 읽을 수 없습니다: ${input.path}`;
      }

      const originalBytes = new Uint8Array(
        originalBuf.buffer,
        originalBuf.byteOffset,
        originalBuf.byteLength,
      );

      // OLE2/HWP 바이너리 가드 — 콘텐츠 기반 감지 (확장자 오인식 포함)
      const structuralGuard = hwpStructuralGuard(ext, originalBytes);
      if (structuralGuard !== null) {
        return structuralGuard;
      }

      // ZIP 매직 바이트 검증 (PK = 0x504B) — kordoc isZipFile 위임. 비-ZIP .hwpx 거부
      if (!isZipBinary(originalBytes)) {
        return (
          "오류: 파일이 유효한 .hwpx(ZIP) 포맷이 아닙니다. " +
          "파일이 손상되었거나 구형 .hwp(OLE 바이너리) 포맷일 수 있습니다."
        );
      }

      let patchResult: Awaited<ReturnType<typeof applyRedactToHwpx>>;
      try {
        patchResult = await applyRedactToHwpx(originalBytes);
      } catch (e) {
        return `오류: 비식별 처리 중 오류가 발생했습니다. ${String(e)}`;
      }

      const { buffer: newBytes, findings, changed } = patchResult;

      const totalCount = findings.reduce((s, f) => s + f.count, 0);
      if (!changed || totalCount === 0) {
        return `개인정보가 발견되지 않아 변경할 내용이 없습니다: ${input.path}`;
      }

      const stagedPath = await stageFile(ctx.sessionId, outputPath, newBytes);
      const proposalId = crypto.randomUUID();
      const diff = buildDiff(findings);
      const summaryText = input.summary ?? `개인정보 비식별 처리(마스킹): ${basename(safePath)}`;

      return {
        proposal: {
          id: proposalId,
          kind: "redact-pii",
          targetPath: outputPath,
          stagedPath,
          summary: summaryText,
          diff,
          warnings: [],
          willConvertFormat,
        },
        commit: async (): Promise<string> => {
          const backupPath = await backupFile(outputPath);
          await commitStaged(stagedPath, outputPath);
          const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
          return `개인정보 비식별 완료: ${outputPath}${backupInfo}`;
        },
      };
    }

    // ── .md / .txt 처리 ───────────────────────────────────
    let originalText: string;
    try {
      originalText = await readFile(safePath, "utf-8");
    } catch {
      return `오류: 파일을 읽을 수 없습니다: ${input.path}`;
    }

    const { text: redacted, findings } = redactText(originalText);
    const totalCount = findings.reduce((s, f) => s + f.count, 0);

    if (totalCount === 0) {
      return `개인정보가 발견되지 않아 변경할 내용이 없습니다: ${input.path}`;
    }

    const stagedPath = await stageFile(ctx.sessionId, outputPath, redacted);
    const proposalId = crypto.randomUUID();
    const diff = buildDiff(findings);
    const summaryText = input.summary ?? `개인정보 비식별 처리(마스킹): ${basename(safePath)}`;

    return {
      proposal: {
        id: proposalId,
        kind: "redact-pii",
        targetPath: outputPath,
        stagedPath,
        summary: summaryText,
        diff,
        warnings: [],
        willConvertFormat,
      },
      commit: async (): Promise<string> => {
        const backupPath = await backupFile(outputPath);
        await commitStaged(stagedPath, outputPath);
        const backupInfo = backupPath ? ` (백업: ${backupPath})` : "";
        return `개인정보 비식별 완료: ${outputPath}${backupInfo}`;
      },
    };
  },
};
