import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", ".agents/**", ".claude/**"],
  },
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    format: ["esm", "cjs"],
    fixedExtension: false,
    sourcemap: true,
    target: "node18",
    platform: "node",
    treeshake: true,
    deps: {
      neverBundle: ["vite"],
    },
  },
  lint: {
    ignorePatterns: ["dist", ".agents/**", ".claude/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
