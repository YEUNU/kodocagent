/**
 * OTA 업데이트 체크 및 `kodocagent update` 서브커맨드
 * docs/SPEC.md §9
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { KODOC_PATHS } from "@kodocagent/shared";

// ─────────────────────────────────────────────
// 최소 semver 비교 (외부 의존성 없음)
// ─────────────────────────────────────────────

/**
 * a < b → -1, a === b → 0, a > b → 1
 * 프리릴리스 접미사(-alpha 등)는 무시한다 (숫자 파싱 불가 시 0 처리).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): [number, number, number] => {
    // strip optional leading "v" and prerelease suffix
    const clean = v.replace(/^v/, "").split("-")[0] ?? "";
    const parts = clean.split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

// ─────────────────────────────────────────────
// 업데이트 캐시
// ─────────────────────────────────────────────

interface UpdateCache {
  checkedAt: string; // ISO 8601
  latest: string; // semver
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

async function readCache(cachePath: string): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "checkedAt" in parsed &&
      "latest" in parsed &&
      typeof (parsed as UpdateCache).checkedAt === "string" &&
      typeof (parsed as UpdateCache).latest === "string"
    ) {
      return parsed as UpdateCache;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // 캐시 쓰기 실패는 무시
  }
}

// ─────────────────────────────────────────────
// 업데이트 체크 (DI 지원)
// ─────────────────────────────────────────────

export interface CheckForUpdateOptions {
  /** 캐시 파일 경로 (테스트 주입용). 기본값: KODOC_PATHS.updateCheck */
  cachePath?: string;
  /** fetch 구현체 (테스트 주입용). 기본값: globalThis.fetch */
  fetchFn?: typeof fetch;
}

/**
 * 현재 버전보다 새 버전이 있으면 해당 버전 문자열을 반환한다.
 * - 24시간 내에 성공한 캐시가 있으면 네트워크 요청 없이 캐시 사용
 * - 네트워크 오류 / 404 → null 반환, 캐시 불변
 */
export async function checkForUpdate(
  currentVersion: string,
  opts: CheckForUpdateOptions = {},
): Promise<string | null> {
  const cachePath = opts.cachePath ?? KODOC_PATHS.updateCheck;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  // 캐시 확인
  const cache = await readCache(cachePath);
  if (cache) {
    const age = Date.now() - new Date(cache.checkedAt).getTime();
    if (age < CACHE_TTL_MS) {
      // 캐시 유효 — 네트워크 요청 없이 반환
      return compareSemver(currentVersion, cache.latest) < 0 ? cache.latest : null;
    }
  }

  // 네트워크 요청
  try {
    const res = await fetchFn("https://registry.npmjs.org/@kodocagent/cli/latest", {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      // 404(미게시) 등 — 캐시 오염 안 함
      return null;
    }

    const body = (await res.json()) as { version?: string };
    const latest = body.version;
    if (!latest || typeof latest !== "string") {
      return null;
    }

    // 성공 시 캐시 갱신
    await writeCache(cachePath, {
      checkedAt: new Date().toISOString(),
      latest,
    });

    return compareSemver(currentVersion, latest) < 0 ? latest : null;
  } catch {
    // 네트워크 오류, 타임아웃 — 캐시 불변, null 반환
    return null;
  }
}

// ─────────────────────────────────────────────
// 설치 방법 감지
// ─────────────────────────────────────────────

type InstallMethod = "pnpm" | "npm" | "npx";

function detectInstallMethod(): InstallMethod {
  try {
    // 실제 실행 파일 경로 (symlink 해소 후)
    const argv1 = process.argv[1] ?? "";

    if (argv1.includes("_npx") || argv1.includes("/.cache/npx") || argv1.includes("\\npx\\")) {
      return "npx";
    }
    if (argv1.toLowerCase().includes("pnpm")) {
      return "pnpm";
    }
    // npm 글로벌 경로 휴리스틱
    // ~/.npm-global/ or /usr/local/lib/node_modules 등
    // 기본값: npm
    return "npm";
  } catch {
    return "npm";
  }
}

// ─────────────────────────────────────────────
// `kodocagent update` 실행
// ─────────────────────────────────────────────

/**
 * 설치 방법을 감지하고 최신 버전으로 업데이트한다.
 */
export async function runUpdate(): Promise<void> {
  const method = detectInstallMethod();

  if (method === "npx") {
    process.stdout.write(
      "npx로 실행 중입니다. npx @kodocagent/cli@latest 는 항상 최신 버전을 사용합니다.\n",
    );
    return;
  }

  const cmd = method === "pnpm" ? "pnpm" : "npm";
  const args = ["install", "-g", "@kodocagent/cli@latest"];

  process.stdout.write(`${cmd} ${args.join(" ")} 실행 중...\n`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        process.stdout.write("kodocagent 최신 버전으로 업데이트되었습니다.\n");
        resolve();
      } else {
        reject(
          new Error(
            `'${cmd} install -g @kodocagent/cli@latest' 실행이 실패했습니다 (종료 코드 ${code}). ` +
              "네트워크 연결과 패키지 매니저 권한을 확인하세요.",
          ),
        );
      }
    });
  });
}
