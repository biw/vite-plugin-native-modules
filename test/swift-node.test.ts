import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as acornParse } from "acorn";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, type Plugin, type Rollup } from "vite";
import nativeFilePlugin from "../src/index.js";

const parse = (code: string) => acornParse(code, { ecmaVersion: "latest", sourceType: "module" });

function outputs(
  result: Rollup.RollupOutput | Rollup.RollupOutput[],
): Array<Rollup.OutputAsset | Rollup.OutputChunk> {
  return (Array.isArray(result) ? result : [result]).flatMap((output) => output.output);
}

describe("swift-node support", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swift-node-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("rewrites a target-qualified native path passed to createRequire", async () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({ command: "build", mode: "production" });

    const target = `${process.platform}-${process.arch}`;
    const nativeFileName = `macos_native_clone_file.${target}.node`;
    fs.writeFileSync(path.join(tempDir, nativeFileName), Buffer.from("fake native module"));

    // This is the loader shape emitted by macos-native-clone-file, a swift-node package.
    const code = `
      import { createRequire } from "node:module";
      import { fileURLToPath } from "node:url";
      import { dirname, join } from "node:path";

      const require = createRequire(import.meta.url);
      const packageDirectory = dirname(fileURLToPath(import.meta.url));
      const target = \`${"${process.platform}"}-${"${process.arch}"}\`;
      const addonPath = join(packageDirectory, \`macos_native_clone_file.${"${target}"}.node\`);
      const native = require(addonPath);
      export const cloneFile = native.cloneFile;
    `;
    const id = path.join(tempDir, "index.mjs");

    const result = (plugin.transform as any).call({ parse }, code, id);

    expect(result).toBeDefined();
    expect(result.code).toMatch(
      /createRequire\(import\.meta\.url\)\(["']\.\/macos_native_clone_file\.[^"']+-[A-F0-9]{8}\.node["']\)/,
    );
    expect(result.code).not.toContain("require(addonPath)");

    const hashedFilename = result.code.match(
      /\.\/(macos_native_clone_file\.[^"']+-[A-F0-9]{8}\.node)/,
    )?.[1];
    expect(hashedFilename).toBeDefined();

    const resolved = await (plugin.resolveId as any).call({} as any, `./${hashedFilename}`, id, {});
    const virtualId = typeof resolved === "string" ? resolved : resolved.id;
    expect(virtualId).toContain("\0native:");

    const loaded = await (plugin.load as any).call({} as any, virtualId);
    expect(loaded).toContain(`./${hashedFilename}`);
  });

  it("bundles a swift-node package with its target-qualified addon", async () => {
    const packageDir = path.join(tempDir, "node_modules", "macos-native-clone-file");
    const target = `${process.platform}-${process.arch}`;
    const nativeFileName = `macos_native_clone_file.${target}.node`;

    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "macos-native-clone-file", main: "index.mjs", type: "module" }),
    );
    fs.writeFileSync(path.join(packageDir, nativeFileName), Buffer.from("fake native module"));
    fs.writeFileSync(
      path.join(packageDir, "index.mjs"),
      `
        import { existsSync } from "node:fs";
        import { createRequire } from "node:module";
        import { fileURLToPath } from "node:url";
        import { dirname, join } from "node:path";

        const require = createRequire(import.meta.url);
        const packageDirectory = dirname(fileURLToPath(import.meta.url));
        const target = \`${"${process.platform}"}-${"${process.arch}"}\`;
        const addonPath = join(packageDirectory, \`macos_native_clone_file.${"${target}"}.node\`);
        if (!existsSync(addonPath)) throw new Error("Missing native addon");
        const native = require(addonPath);
        export const cloneFile = native.cloneFile;
      `,
    );
    const entryPath = path.join(tempDir, "index.mjs");
    fs.writeFileSync(
      entryPath,
      'import { cloneFile } from "macos-native-clone-file";\nconsole.log(cloneFile);\n',
    );

    const result = (await build({
      root: tempDir,
      logLevel: "silent",
      ssr: { noExternal: ["macos-native-clone-file"] },
      build: {
        ssr: true,
        write: false,
        rollupOptions: { input: entryPath, output: { format: "es" } },
      },
      plugins: [nativeFilePlugin()],
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];

    const generated = outputs(result);
    expect(
      generated.some(
        (output) =>
          output.type === "asset" &&
          /macos_native_clone_file\.[a-z0-9-]+-[A-F0-9]{8}\.node/.test(output.fileName),
      ),
    ).toBe(true);
    expect(
      generated.some(
        (output) =>
          output.type === "chunk" &&
          /macos_native_clone_file\.[a-z0-9-]+-[A-F0-9]{8}\.node/.test(output.code),
      ),
    ).toBe(true);
  });
});
