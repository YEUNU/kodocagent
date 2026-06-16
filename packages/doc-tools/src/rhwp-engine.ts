/**
 * rhwp-engine — @rhwp/core WASM 지연 초기화 래퍼
 *
 * Phase 1: find/replace 및 HWP/HWPX 내보내기 전용.
 * 렌더 메서드(Canvas 필요)는 사용하지 않는다.
 *
 * 설계 원칙:
 *   - WASM(5.6MB)은 첫 번째 rhwp 툴 호출 시에만 로드 (지연 초기화).
 *   - 모듈 임포트 시점에는 WASM을 로드하지 않는다.
 *   - 이중 초기화를 module-level promise로 방지한다.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { HwpDocument } from "@rhwp/core";

// @rhwp/core 타입만 임포트 (런타임 바인딩은 동적 import)
export type { HwpDocument };

/** 초기화 promise — null이면 아직 시작 안 됨 */
let _initPromise: Promise<void> | null = null;

/**
 * @rhwp/core WASM을 지연 초기화한다.
 * 첫 호출 시에만 WASM 파일을 읽고 initSync를 실행한다.
 * 이후 호출은 캐시된 promise를 반환한다.
 */
async function ensureRhwpInit(): Promise<void> {
  if (_initPromise !== null) return _initPromise;

  _initPromise = (async () => {
    let initSync: (opts: { module: Uint8Array }) => void;
    try {
      const mod = await import("@rhwp/core");
      initSync = mod.initSync as (opts: { module: Uint8Array }) => void;
    } catch (e) {
      throw new Error(
        `@rhwp/core 로드 실패. 패키지가 설치되어 있는지 확인하세요. 원인: ${String(e)}`,
      );
    }

    // createRequire로 wasm 파일 경로를 해석한다.
    const _require = createRequire(import.meta.url);
    let wasmPath: string;
    try {
      wasmPath = _require.resolve("@rhwp/core/rhwp_bg.wasm");
    } catch (e) {
      throw new Error(
        `@rhwp/core/rhwp_bg.wasm 경로를 찾을 수 없습니다. ` +
          `패키지가 올바르게 설치되어 있는지 확인하세요. 원인: ${String(e)}`,
      );
    }

    let wasmBytes: Buffer;
    try {
      wasmBytes = await readFile(wasmPath);
    } catch (e) {
      throw new Error(`WASM 파일을 읽을 수 없습니다: ${wasmPath}. 원인: ${String(e)}`);
    }

    initSync({
      module: new Uint8Array(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength),
    });
  })();

  return _initPromise;
}

/**
 * WASM을 초기화하고 HWP/HWPX 파일 바이트에서 HwpDocument를 생성한다.
 *
 * @param bytes   HWP 또는 HWPX 파일의 바이트 (Uint8Array)
 * @returns       HwpDocument 인스턴스
 * @throws        WASM 초기화 실패, 파일 포맷 오류 등
 */
export async function loadRhwpDocument(bytes: Uint8Array): Promise<HwpDocument> {
  await ensureRhwpInit();

  const mod = await import("@rhwp/core");
  const HwpDocument = mod.HwpDocument as typeof import("@rhwp/core").HwpDocument;

  try {
    return new HwpDocument(bytes);
  } catch (e) {
    throw new Error(
      `HWP/HWPX 문서를 불러오지 못했습니다. 파일이 손상되었거나 지원하지 않는 포맷일 수 있습니다. ` +
        `원인: ${String(e)}`,
    );
  }
}

/**
 * 파일 확장자에 따라 HwpDocument를 적절한 포맷으로 내보낸다.
 *
 * @param doc   HwpDocument 인스턴스
 * @param ext   파일 확장자 (소문자, 점 포함) — ".hwp" 또는 ".hwpx"
 * @returns     내보낸 파일의 바이트
 * @throws      지원하지 않는 확장자
 *
 * 주의: doc.exportHwp() 는 편집 내용을 실제로 저장하지 않는다 (rhwp 이슈 #197).
 * 원본 파일을 그대로 반환하므로 편집된 결과 저장에는 사용하지 않는다.
 * propose_find_replace 는 항상 doc.exportHwpx() 를 직접 호출한다.
 */
export function exportByExt(doc: HwpDocument, ext: string): Uint8Array {
  if (ext === ".hwp") {
    // NOTE: exportHwp()는 편집 내용을 저장하지 않는다 (rhwp #197).
    // 이 분기는 레거시 호환 목적으로만 존재하며 실제로 사용하지 않는다.
    return doc.exportHwp();
  }
  if (ext === ".hwpx") {
    return doc.exportHwpx();
  }
  throw new Error(`지원하지 않는 확장자입니다: ${ext}. rhwp 엔진은 .hwp 및 .hwpx만 지원합니다.`);
}

/**
 * replaceAll 결과 JSON의 파싱된 형태.
 * 성공: { ok: true; count: number }
 * 실패 (파싱 오류): null
 */
export interface ReplaceAllResult {
  ok: true;
  count: number;
}

/**
 * doc.replaceAll() 결과 JSON을 파싱한다.
 * @throws  JSON 파싱 실패 시 오류
 */
export function parseReplaceAllResult(json: string): ReplaceAllResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`replaceAll 결과를 파싱할 수 없습니다: ${json}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    (parsed as Record<string, unknown>).ok !== true ||
    typeof (parsed as Record<string, unknown>).count !== "number"
  ) {
    throw new Error(`replaceAll 예상하지 못한 결과: ${json}`);
  }

  return { ok: true, count: (parsed as Record<string, unknown>).count as number };
}
