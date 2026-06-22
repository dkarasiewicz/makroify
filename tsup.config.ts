import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/core/index.ts", "src/cli/index.ts", "src/eve/tools.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Playwright is an optional, lazily-imported dependency — never bundle it.
  external: ["playwright", "playwright-core"],
});
