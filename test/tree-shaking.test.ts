import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, type Rollup } from "vite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nativeFilePlugin from "../src/index.js";

describe("tree-shaken native modules", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-tree-shaking-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createPackage(): string {
    const packageDirectory = path.join(tempDir, "node_modules", "fake-native-pkg");
    const nativeModulePath = path.join(packageDirectory, "build", "Release", "fake.node");

    fs.mkdirSync(path.dirname(nativeModulePath), { recursive: true });
    fs.writeFileSync(nativeModulePath, "not a real binary");
    fs.writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "fake-native-pkg",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        sideEffects: false,
      }),
    );
    fs.writeFileSync(
      path.join(packageDirectory, "index.js"),
      `export const plainHelper = () => "no native code needed";
export { nativeFeature } from "./native.js";
`,
    );
    fs.writeFileSync(
      path.join(packageDirectory, "native.js"),
      `import { createRequire } from "node:module";

const addon = createRequire(import.meta.url)("./build/Release/fake.node");

export const nativeFeature = () => addon.doSomething();
`,
    );

    return packageDirectory;
  }

  async function buildEntry(
    source: string,
  ): Promise<Array<Rollup.OutputAsset | Rollup.OutputChunk>> {
    const entryPath = path.join(tempDir, "src", "index.js");
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, source);

    const result = await build({
      root: tempDir,
      logLevel: "silent",
      ssr: { noExternal: true },
      build: {
        minify: false,
        ssr: entryPath,
        write: false,
      },
      plugins: [nativeFilePlugin()],
    });
    const buildOutput = result as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = Array.isArray(buildOutput) ? buildOutput : [buildOutput];

    return outputs.flatMap((output) => output.output);
  }

  function nativeAssets(
    output: Array<Rollup.OutputAsset | Rollup.OutputChunk>,
  ): Rollup.OutputAsset[] {
    return output.filter(
      (item): item is Rollup.OutputAsset =>
        item.type === "asset" && item.fileName.endsWith(".node"),
    );
  }

  it("does not emit an addon whose re-export was tree-shaken", async () => {
    createPackage();

    const output = await buildEntry(`import { plainHelper } from "fake-native-pkg";

export const handler = () => plainHelper();
`);

    const chunks = output.filter((item): item is Rollup.OutputChunk => item.type === "chunk");

    expect(chunks.some((chunk) => chunk.code.includes("plainHelper"))).toBe(true);
    expect(chunks.some((chunk) => chunk.code.includes("fake.node"))).toBe(false);
    expect(nativeAssets(output)).toEqual([]);
  });

  it("still emits an addon when its native-backed export is used", async () => {
    createPackage();

    const output = await buildEntry(`import { nativeFeature } from "fake-native-pkg";

export const handler = () => nativeFeature();
`);

    const assets = nativeAssets(output);
    const chunks = output.filter((item): item is Rollup.OutputChunk => item.type === "chunk");

    expect(assets).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.code.includes(assets[0].fileName))).toBe(true);
  });
});
