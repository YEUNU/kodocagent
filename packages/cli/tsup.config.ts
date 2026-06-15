import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Bundle all @kodocagent/* workspace packages into the CLI so the published
  // artifact is self-contained.  All third-party deps remain external.
  noExternal: [/^@kodocagent\//],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
