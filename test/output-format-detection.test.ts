import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nativeFilePlugin from "../src/index.js";
import { build, type Plugin, type Rollup } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for output format detection.
 *
 * These tests verify that the plugin generates the correct module format
 * based on the Vite OUTPUT format, not the importer's format.
 *
 * The bug: When a CJS file (like bufferutil/index.js using require('node-gyp-build'))
 * imports a native module, but the Vite output format is ESM, the plugin was
 * generating CommonJS code which got inlined into the ESM output, causing:
 * "Cannot determine intended module format because both require() and top-level await are present"
 */
describe("Output Format Detection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "output-format-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("CJS importer with ESM output", () => {
    /**
     * This is the actual bug scenario:
     * - bufferutil/index.js is CommonJS (uses require('node-gyp-build'))
     * - But the Vite build output format is ESM
     * - The plugin should generate ESM code (createRequire) not CJS (require)
     */
    it("should generate ESM code when output format is ES, even if importer is CJS", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create a native module package with CJS index.js (like bufferutil)
      const packageDir = path.join(tempDir, "node_modules", "native-addon");
      const prebuildsDir = path.join(packageDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      // Create the native .node file
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), Buffer.from("fake native module"));

      // Create package.json
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "native-addon",
          main: "index.js",
        }),
      );

      // Create CJS index.js that uses node-gyp-build pattern
      fs.writeFileSync(
        path.join(packageDir, "index.js"),
        `'use strict';
try {
  module.exports = require('node-gyp-build')(__dirname);
} catch (e) {
  module.exports = { doSomething: function() {} };
}
`,
      );

      // Create a fake node-gyp-build module
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" }),
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  const platform = process.platform;
  const arch = process.arch;
  return require(path.join(dir, 'prebuilds', platform + '-' + arch, 'addon.node'));
};`,
      );

      // Create ESM entry point that imports the CJS native-addon
      // This simulates a modern ESM app importing bufferutil
      const entryPath = path.join(tempDir, "index.mjs");
      fs.writeFileSync(
        entryPath,
        `import addon from 'native-addon';
console.log(addon);
export { addon };
`,
      );

      // Build with ESM output format for Node.js target
      let buildOutput: Rollup.RollupOutput | undefined;
      let buildError: Error | null = null;

      try {
        const result = await build({
          root: tempDir,
          logLevel: "silent",
          ssr: {
            noExternal: true,
          },
          build: {
            write: false,
            ssr: true, // Target Node.js, not browser
            rollupOptions: {
              input: entryPath,
              output: {
                format: "es", // ESM output
              },
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
        // When write: false, result is RollupOutput | RollupOutput[], not a watcher
        const output = result as Rollup.RollupOutput | Rollup.RollupOutput[];
        buildOutput = Array.isArray(output) ? output[0] : output;
      } catch (err) {
        buildError = err as Error;
      }

      // The build should succeed
      expect(buildError).toBeNull();
      expect(buildOutput).toBeDefined();

      // Find the main output chunk
      const mainChunk = buildOutput!.output.find(
        (o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry,
      );
      expect(mainChunk).toBeDefined();

      // The output should NOT contain raw `require(` calls (should use createRequire or be converted)
      // We check for the specific pattern that causes issues: module.exports = require
      expect(mainChunk!.code).not.toMatch(/module\.exports\s*=\s*require\(/);

      // The output should contain ESM syntax
      expect(mainChunk!.code).toContain("export");
    });

    it("should not cause 'Cannot determine intended module format' error", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create native module package
      const packageDir = path.join(tempDir, "node_modules", "native-addon");
      const prebuildsDir = path.join(packageDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), Buffer.from("fake native module"));

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon", main: "index.js" }),
      );

      fs.writeFileSync(
        path.join(packageDir, "index.js"),
        `'use strict';
module.exports = require('node-gyp-build')(__dirname);
`,
      );

      // Create node-gyp-build
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" }),
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  return require(path.join(dir, 'prebuilds', process.platform + '-' + process.arch, 'addon.node'));
};`,
      );

      // Entry with top-level await (ESM feature that triggers the error)
      const entryPath = path.join(tempDir, "index.mjs");
      fs.writeFileSync(
        entryPath,
        `import addon from 'native-addon';

// Top-level await - ESM only feature
const result = await Promise.resolve(addon);
console.log(result);

export { addon };
`,
      );

      // Build with ESM output for Node.js target
      let buildError: Error | null = null;

      try {
        await build({
          root: tempDir,
          logLevel: "silent",
          ssr: {
            noExternal: true,
          },
          build: {
            write: false,
            ssr: true, // Target Node.js, not browser
            target: "esnext",
            rollupOptions: {
              input: entryPath,
              output: {
                format: "es",
              },
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
      } catch (err) {
        buildError = err as Error;
      }

      expect(buildError).toBeNull();
    });

    const nativeObjectExpression = 'Object.freeze({ marker: "native-value" })';
    const defaultOnlyNativeExpression = "function nativeValue() {}";

    it.each([
      {
        description: "default namespace interop",
        requireReturnsDefault: undefined,
        nativeValueExpression: nativeObjectExpression,
        expectedMarker: "native-value",
        loader: "node-gyp-build",
      },
      {
        description: "default-returning interop",
        requireReturnsDefault: true,
        nativeValueExpression: nativeObjectExpression,
        expectedMarker: "native-value",
        loader: "node-gyp-build",
      },
      {
        description: "auto interop",
        requireReturnsDefault: "auto",
        nativeValueExpression: nativeObjectExpression,
        expectedMarker: "native-value",
        loader: "node-gyp-build",
      },
      {
        description: "auto interop with a default-only module",
        requireReturnsDefault: "auto",
        nativeValueExpression: defaultOnlyNativeExpression,
        expectedMarker: undefined,
        loader: "node-gyp-build",
      },
      {
        description: "preferred interop",
        requireReturnsDefault: "preferred",
        nativeValueExpression: nativeObjectExpression,
        expectedMarker: "native-value",
        loader: "node-gyp-build",
      },
      {
        description: "namespace interop",
        requireReturnsDefault: "namespace",
        nativeValueExpression: nativeObjectExpression,
        expectedMarker: "native-value",
        loader: "node-gyp-build",
      },
      {
        description: "per-module preferred interop",
        requireReturnsDefault: (id: string) =>
          id.startsWith("\0native:") ? ("preferred" as const) : false,
        nativeValueExpression: nativeObjectExpression,
        expectedMarker: "native-value",
        loader: "node-gyp-build",
      },
      {
        description: "auto interop with a direct native require",
        requireReturnsDefault: "auto",
        nativeValueExpression: defaultOnlyNativeExpression,
        expectedMarker: undefined,
        loader: "direct",
      },
    ] as const)(
      "should give bundled CommonJS code the native value with $description",
      async ({ requireReturnsDefault, nativeValueExpression, expectedMarker, loader }) => {
        const packageDir = path.join(tempDir, "node_modules", "native-addon");
        const prebuildsDir = path.join(
          packageDir,
          "prebuilds",
          `${process.platform}-${process.arch}`,
        );
        fs.mkdirSync(prebuildsDir, { recursive: true });
        fs.writeFileSync(path.join(prebuildsDir, "addon.node"), Buffer.from("fake native module"));
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "native-addon", main: "index.js" }),
        );
        fs.writeFileSync(
          path.join(packageDir, "index.js"),
          `const addon = ${
            loader === "direct"
              ? `require('./prebuilds/${process.platform}-${process.arch}/addon.node')`
              : `require('node-gyp-build')(__dirname)`
          };
module.exports = {
  marker: addon.marker,
  receivedNamespace: Object.prototype.hasOwnProperty.call(addon, 'default')
};
`,
        );

        const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
        fs.mkdirSync(nodeGypBuildDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeGypBuildDir, "package.json"),
          JSON.stringify({ name: "node-gyp-build", main: "index.js" }),
        );
        fs.writeFileSync(
          path.join(nodeGypBuildDir, "index.js"),
          "module.exports = function () { throw new Error('not transformed'); };\n",
        );

        const entryPath = path.join(tempDir, "index.mjs");
        fs.writeFileSync(entryPath, "import addon from 'native-addon'; export default addon;\n");

        // Replace createRequire so the plugin's real virtual ESM wrapper remains
        // in the bundle while the test avoids loading a platform native binary.
        const fakeNodeModule: Plugin = {
          name: "fake-node-module",
          enforce: "pre",
          resolveId(id) {
            if (id === "node:module") return "\0fake-node-module";
          },
          load(id) {
            if (id === "\0fake-node-module") {
              return `const nativeValue = ${nativeValueExpression};
export function createRequire() {
  return () => nativeValue;
}`;
            }
          },
        };

        const result = await build({
          root: tempDir,
          logLevel: "silent",
          ssr: {
            noExternal: true,
          },
          build: {
            write: false,
            ssr: true,
            commonjsOptions: {
              requireReturnsDefault,
            },
            rollupOptions: {
              input: entryPath,
              output: {
                format: "es",
              },
            },
          },
          plugins: [fakeNodeModule, nativeFilePlugin({ forced: true })],
        });

        const buildOutput = result as Rollup.RollupOutput | Rollup.RollupOutput[];
        const output = Array.isArray(buildOutput) ? buildOutput[0] : buildOutput;
        const mainChunk = output.output.find(
          (item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry,
        );
        expect(mainChunk).toBeDefined();

        const bundleUrl = `data:text/javascript;base64,${Buffer.from(mainChunk!.code).toString(
          "base64",
        )}`;
        const bundledModule = await import(/* @vite-ignore */ bundleUrl);

        expect(bundledModule.default).toEqual({
          marker: expectedMarker,
          receivedNamespace: false,
        });
      },
    );
  });

  describe("ESM importer with CJS output", () => {
    /**
     * The reverse scenario:
     * - An ESM file imports a native module
     * - But the Vite build output format is CJS
     * - The plugin should generate CJS code (require) not ESM (import.meta.url)
     */
    it("should generate CJS code when output format is CJS, even if importer is ESM", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create native module package
      const packageDir = path.join(tempDir, "node_modules", "native-addon");
      const prebuildsDir = path.join(packageDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), Buffer.from("fake native module"));

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon", main: "index.js" }),
      );

      fs.writeFileSync(
        path.join(packageDir, "index.js"),
        `'use strict';
module.exports = require('node-gyp-build')(__dirname);
`,
      );

      // Create node-gyp-build
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" }),
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  return require(path.join(dir, 'prebuilds', process.platform + '-' + process.arch, 'addon.node'));
};`,
      );

      // Create ESM entry (using import syntax)
      const entryPath = path.join(tempDir, "index.mjs");
      fs.writeFileSync(
        entryPath,
        `import addon from 'native-addon';
console.log(addon);
export { addon };
`,
      );

      // Build with CJS output format for Node.js target
      let buildOutput: Rollup.RollupOutput | undefined;
      let buildError: Error | null = null;

      try {
        const result = await build({
          root: tempDir,
          logLevel: "silent",
          ssr: {
            noExternal: true,
          },
          build: {
            write: false,
            ssr: true, // Target Node.js, not browser
            rollupOptions: {
              input: entryPath,
              output: {
                format: "cjs", // CJS output
              },
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
        // When write: false, result is RollupOutput | RollupOutput[], not a watcher
        const output = result as Rollup.RollupOutput | Rollup.RollupOutput[];
        buildOutput = Array.isArray(output) ? output[0] : output;
      } catch (err) {
        buildError = err as Error;
      }

      // The build should succeed
      expect(buildError).toBeNull();
      expect(buildOutput).toBeDefined();

      // Find the main output chunk
      const mainChunk = buildOutput!.output.find(
        (o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry,
      );
      expect(mainChunk).toBeDefined();

      // The output should NOT contain import.meta.url (doesn't work in CJS)
      expect(mainChunk!.code).not.toContain("import.meta.url");

      // The output should use CJS syntax
      expect(mainChunk!.code).toMatch(/require\(/);
      expect(mainChunk!.code).toMatch(/[A-F0-9]{8}\.node/);
    });
  });

  describe("lib mode format detection", () => {
    it("should detect format from lib.formats when rollupOptions.output.format is not set", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create native module package
      const packageDir = path.join(tempDir, "node_modules", "native-addon");
      const prebuildsDir = path.join(packageDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), Buffer.from("fake native module"));

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon", main: "index.js" }),
      );

      fs.writeFileSync(
        path.join(packageDir, "index.js"),
        `'use strict';
module.exports = require('node-gyp-build')(__dirname);
`,
      );

      // Create node-gyp-build
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" }),
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  return require(path.join(dir, 'prebuilds', process.platform + '-' + process.arch, 'addon.node'));
};`,
      );

      // Create entry
      const entryPath = path.join(tempDir, "index.mjs");
      fs.writeFileSync(
        entryPath,
        `import addon from 'native-addon';
export default addon;
`,
      );

      // Build using lib mode with cjs format for Node.js target
      let buildOutput: Rollup.RollupOutput | Rollup.RollupOutput[] | undefined;
      let buildError: Error | null = null;

      try {
        const result = await build({
          root: tempDir,
          logLevel: "silent",
          ssr: {
            noExternal: true,
          },
          build: {
            write: false,
            ssr: true, // Target Node.js, not browser
            lib: {
              entry: entryPath,
              formats: ["cjs"], // CJS format via lib mode
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
        // When write: false, result is RollupOutput | RollupOutput[], not a watcher
        buildOutput = result as Rollup.RollupOutput | Rollup.RollupOutput[];
      } catch (err) {
        buildError = err as Error;
      }

      // The build should succeed
      expect(buildError).toBeNull();
      expect(buildOutput).toBeDefined();

      // Get the output (lib mode may return array)
      const output = Array.isArray(buildOutput) ? buildOutput[0] : buildOutput;
      const mainChunk = output!.output.find(
        (o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry,
      );
      expect(mainChunk).toBeDefined();

      // The output should NOT contain import.meta.url (doesn't work in CJS)
      expect(mainChunk!.code).not.toContain("import.meta.url");
      expect(mainChunk!.code).toMatch(/[A-F0-9]{8}\.node/);
    });

    it("should use an output-agnostic wrapper for CJS-first mixed formats", async () => {
      const nativePath = path.join(tempDir, "addon.node");
      const entryPath = path.join(tempDir, "index.mjs");
      fs.writeFileSync(nativePath, Buffer.from("fake native module"));
      fs.writeFileSync(
        entryPath,
        `import addon from "./addon.node";
export default addon;
`,
      );

      const plugin = nativeFilePlugin({ forced: true });
      plugin.enforce = "pre";

      const result = await build({
        root: tempDir,
        logLevel: "silent",
        build: {
          write: false,
          ssr: true,
          lib: {
            entry: entryPath,
            formats: ["cjs", "es"],
            fileName: (format) => `index.${format}`,
          },
        },
        plugins: [plugin],
      });
      const buildOutputs = result as Rollup.RollupOutput | Rollup.RollupOutput[];
      const outputs = Array.isArray(buildOutputs) ? buildOutputs : [buildOutputs];
      const chunks = outputs.flatMap((output) =>
        output.output.filter((item): item is Rollup.OutputChunk => item.type === "chunk"),
      );
      const cjsChunk = chunks.find((chunk) => chunk.code.startsWith('"use strict"'));
      const esmChunk = chunks.find((chunk) => chunk.code.includes("export {"));

      expect(cjsChunk).toBeDefined();
      expect(cjsChunk!.code).toMatch(/[A-F0-9]{8}\.node/);
      expect(esmChunk).toBeDefined();
      expect(esmChunk!.code).toContain("createRequire");
      expect(esmChunk!.code).toContain("import.meta.url");
      expect(esmChunk!.code).toMatch(/[A-F0-9]{8}\.node/);
    });
  });
});
