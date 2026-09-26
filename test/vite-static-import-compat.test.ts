import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build as buildVite7 } from "vite7";
import vite7Package from "vite7/package.json";
import { build as buildVite8 } from "vite8";
import vite8Package from "vite8/package.json";
import type { Rollup } from "vite";
import nativeFilePlugin from "../src/index.js";

type ViteBuild = (config: unknown) => Promise<unknown>;

function outputs(
  result: Rollup.RollupOutput | Rollup.RollupOutput[],
): Array<Rollup.OutputAsset | Rollup.OutputChunk> {
  return (Array.isArray(result) ? result : [result]).flatMap((output) => output.output);
}

function expectNativeAddonOutput(result: Rollup.RollupOutput | Rollup.RollupOutput[]): void {
  const generated = outputs(result);
  const bundledCode = generated
    .filter((output): output is Rollup.OutputChunk => output.type === "chunk")
    .map((output) => output.code)
    .join("\n");

  expect(
    generated.some(
      (output) => output.type === "asset" && /addon-[A-F0-9]{8}\.node/.test(output.fileName),
    ),
  ).toBe(true);
  expect(bundledCode).toMatch(/addon-[A-F0-9]{8}\.node/);
  expect(bundledCode).not.toContain('"./addon.node"');
}

const viteVersions = [
  { build: buildVite7 as ViteBuild, major: 7, version: vite7Package.version },
  { build: buildVite8 as ViteBuild, major: 8, version: vite8Package.version },
];

describe.each(viteVersions)(
  "direct native ESM imports on Vite $major",
  ({ build, major, version }) => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-static-import-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { force: true, recursive: true });
    });

    it("builds a direct native ESM import", async () => {
      expect(version).toMatch(new RegExp(`^${major}\\.`));

      const entryPath = path.join(tempDir, "index.js");
      fs.writeFileSync(path.join(tempDir, "addon.node"), Buffer.from("fake native module"));
      fs.writeFileSync(entryPath, 'import addon from "./addon.node";\nconsole.log(addon);\n');

      await build({
        build: {
          rollupOptions: { input: entryPath },
          ssr: true,
          write: false,
        },
        configFile: false,
        logLevel: "silent",
        plugins: [nativeFilePlugin()],
        root: tempDir,
      });
    });

    it("bundles a TypeScript module that loads a native addon with require", async () => {
      const entryPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(path.join(tempDir, "addon.node"), Buffer.from("fake native module"));
      fs.writeFileSync(
        entryPath,
        `
          export interface NativeAddon {
            ping(): string;
          }

          const addon: NativeAddon = require("./addon.node");
          export const ping = () => addon.ping();
        `,
      );

      const result = (await build({
        build: {
          rollupOptions: { input: entryPath, output: { format: "es" } },
          ssr: true,
          write: false,
        },
        configFile: false,
        logLevel: "silent",
        plugins: [nativeFilePlugin()],
        root: tempDir,
      })) as Rollup.RollupOutput | Rollup.RollupOutput[];

      expectNativeAddonOutput(result);
    });

    it("bundles an ESM TypeScript module that loads a native addon with createRequire", async () => {
      const entryPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(path.join(tempDir, "addon.node"), Buffer.from("fake native module"));
      fs.writeFileSync(
        entryPath,
        `
          import { createRequire } from "node:module";

          type NativeAddon = {
            ping(): string;
          };

          const require = createRequire(import.meta.url);
          const addon: NativeAddon = require("./addon.node");
          export const ping = () => addon.ping();
        `,
      );

      const result = (await build({
        build: {
          rollupOptions: { input: entryPath, output: { format: "es" } },
          ssr: true,
          write: false,
        },
        configFile: false,
        logLevel: "silent",
        plugins: [nativeFilePlugin()],
        root: tempDir,
      })) as Rollup.RollupOutput | Rollup.RollupOutput[];

      expectNativeAddonOutput(result);
    });

    it.each([
      { name: "relative path", source: "./build/Release/addon.node", comment: "" },
      // NAPI-RS loaders mention their .node filename, which the transform filter requires.
      { name: "package", source: "native-pkg", comment: "// Loads native-pkg/addon.node" },
    ])(
      "returns the native exports from a CommonJS $name require in ESM output",
      async ({ comment, source }) => {
        const entryPath = path.join(tempDir, "index.mjs");
        const releaseDir = path.join(tempDir, "build", "Release");
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.writeFileSync(path.join(releaseDir, "addon.node"), Buffer.from("fake native module"));
        const packageDir = path.join(tempDir, "node_modules", "native-pkg");
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(path.join(packageDir, "addon.node"), Buffer.from("fake package module"));
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({ main: "addon.node", name: "native-pkg" }),
        );
        fs.writeFileSync(
          path.join(tempDir, "lib.cjs"),
          `
          ${comment}
          const addon = require("${source}");
          class Wrapped extends addon.Base {}
          module.exports = { hasDefault: "default" in addon, wrapped: new Wrapped().marker };
        `,
        );
        fs.writeFileSync(entryPath, "import lib from './lib.cjs'; export default lib;\n");

        // Replace createRequire so the bundle can run without a real native binary.
        const fakeNodeModule = {
          enforce: "pre" as const,
          load(id: string) {
            if (id === "\0fake-node-module") {
              return `class Base { marker = "native"; }
export function createRequire() {
  return () => ({ Base });
}`;
            }
          },
          name: "fake-node-module",
          resolveId(id: string) {
            if (id === "node:module" || id === "module") return "\0fake-node-module";
          },
        };

        const outDir = path.join(tempDir, "dist");
        await build({
          build: {
            outDir,
            rollupOptions: {
              input: entryPath,
              output: { entryFileNames: "index.mjs", format: "es" },
            },
            ssr: true,
          },
          configFile: false,
          logLevel: "silent",
          plugins: [fakeNodeModule, nativeFilePlugin()],
          root: tempDir,
          ssr: { noExternal: true },
        });

        const bundledModule = await import(
          /* @vite-ignore */ pathToFileURL(path.join(outDir, "index.mjs")).href
        );

        expect(bundledModule.default).toEqual({ hasDefault: false, wrapped: "native" });
      },
    );
  },
);
