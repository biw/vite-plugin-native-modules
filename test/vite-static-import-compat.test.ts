import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  },
);
