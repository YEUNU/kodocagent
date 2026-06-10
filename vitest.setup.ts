/**
 * 테스트 격리 — 모든 테스트는 실제 ~/.kodocagent 대신 임시 홈을 사용한다.
 * (DEVELOPMENT.md §2 불변 원칙)
 *
 * setupFiles는 각 테스트 파일의 import 이전에 실행되므로,
 * @kodocagent/shared의 KODOC_HOME이 이 값으로 평가된다.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODOCAGENT_HOME = mkdtempSync(join(tmpdir(), "kodocagent-test-home-"));
