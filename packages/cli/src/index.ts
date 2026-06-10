import { Command } from "commander";
import { cliVersion } from "./version.js";

const program = new Command();

program
  .name("kodocagent")
  .description("한국어 특화 문서 AI 에이전트 — HWP/HWPX/DOCX/XLSX 읽기·수정, 한국 법령 기반 검토")
  .version(cliVersion(), "-v, --version", "버전 출력");

program.action(() => {
  console.log(`kodocagent v${cliVersion()}`);
  console.log("채팅 기능은 M1에서 제공됩니다. 진행 상황: https://github.com/YEUNU/kodocagent");
});

program.parse();
