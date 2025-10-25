import { defineConfig } from "tsup";

export default defineConfig(() => ({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  minify: false,
  sourcemap: true,
  target: "node18",
  platform: "node",
  splitting: false,
  treeshake: true,
  external: ["vite"],
}));
