/**
 * 실문서 RAW parse 골든 차등 게이트 (로컬 코퍼스 있을 때만 — 비키워드·비합성 손상 클래스)
 *
 * 합성(markdownToHwpx) 픽스처는 머리말/꼬리말·각주·도형/이미지·중첩표·leader탭·별표·
 * CP949 같은 기능을 **생성하지 못한다**. 이 클래스의 kordoc 무성 손상은 **실 바이너리
 * 차등비교로만** 잡힌다(메모리 교훈; 3.5.4 회귀도 실문서 budget 차등으로 포착).
 *
 * 동작: eval-docs/f6 의 실문서를 RAW kordoc 으로 파싱 → 마크다운을 골든(.golden/<name>.md)과
 * **정확 diff**. 골든이 없으면 현재 출력을 골든으로 기록하고 통과(베이스라인 수립).
 * kordoc 업그레이드/재패치 후 이 테스트가 빨개지면 raw 파싱이 바뀐 것(손상 회귀 후보).
 *
 * 게이팅: 코퍼스(eval-docs/f6, gitignore)가 없으면(CI 등) skip. 골든도 eval-docs 하위라 gitignore.
 * 골든 재생성: KODOC_GOLDEN_REGEN=1.
 *
 * ⚠️ RAW kordoc(직접 import)로 검증한다 — 우리 parse() 래퍼 가드는 읽기 손상을 복원해
 * 미패치를 가리므로(편집 경로는 가드 미적용·patch 의존), 게이트는 raw 여야 한다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "kordoc";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORPUS_DIR = join(REPO_ROOT, "eval-docs", "f6");
const GOLDEN_DIR = join(CORPUS_DIR, ".golden");
const REGEN = process.env.KODOC_GOLDEN_REGEN === "1";

const corpus = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => /\.(hwp|hwpx)$/i.test(f))
  : [];

async function rawParseMarkdown(file: string): Promise<string> {
  const buf = readFileSync(join(CORPUS_DIR, file));
  const u8 = new Uint8Array(buf);
  const r = await parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  if (!r.success || typeof r.markdown !== "string") {
    throw new Error(`parse 실패(${file}): ${(r as { error?: string }).error ?? "unknown"}`);
  }
  return r.markdown;
}

const suite = corpus.length === 0 ? describe.skip : describe;

suite("실문서 RAW parse 골든 차등 (eval-docs/f6)", () => {
  for (const file of corpus) {
    it(`${file} — RAW parse 가 골든과 일치`, async () => {
      const md = await rawParseMarkdown(file);
      const goldenPath = join(GOLDEN_DIR, `${file}.md`);
      if (REGEN || !existsSync(goldenPath)) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(goldenPath, md, "utf-8");
        // 베이스라인 수립(또는 재생성) — 이번 실행은 통과 처리.
        expect(md.length).toBeGreaterThan(0);
        return;
      }
      const golden = readFileSync(goldenPath, "utf-8");
      // 정확 일치 — 어떤 무성 변형이든(꼬리 절단·캡션 삭제·leader탭·별표) 실패시킨다.
      expect(md).toBe(golden);
    });
  }
});
