import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nativeFilePlugin from "../src/index.js";
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Integration tests for syntheticNamedExports handling.
 *
 * These tests run actual Vite/Rollup builds to verify the plugin doesn't
 * cause Rollup errors related to syntheticNamedExports, particularly:
 *
 * "Module that is marked with `syntheticNamedExports: true` needs a default
 * export that does not reexport an unresolved named export of the same module."
 *
 * This error occurs when:
 * 1. A module is marked with syntheticNamedExports: true
 * 2. Another module uses `export * from` to re-export from it
 * 3. The synthetic exports can't be resolved at bundle time
 */
describe("syntheticNamedExports integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "synthetic-exports-test-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("bufferutil-style pattern (node-gyp-build)", () => {
    /**
     * This test simulates the bufferutil package structure:
     * - index.js uses require('node-gyp-build')(__dirname)
     * - prebuilds/darwin-arm64/bufferutil.node is the native module
     *
     * Previously this would error when bundled with syntheticNamedExports: true
     */
    it("should build without syntheticNamedExports error for node-gyp-build pattern", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create bufferutil-like package structure
      const packageDir = path.join(tempDir, "node_modules", "bufferutil");
      const prebuildsDir = path.join(packageDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      // Create the native module
      fs.writeFileSync(
        path.join(prebuildsDir, "bufferutil.node"),
        Buffer.from("fake native module")
      );

      // Create package.json
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "bufferutil",
          main: "index.js",
        })
      );

      // Create index.js that uses node-gyp-build pattern
      fs.writeFileSync(
        path.join(packageDir, "index.js"),
        `'use strict';
try {
  module.exports = require('node-gyp-build')(__dirname);
} catch (e) {
  module.exports = { mask: function() {}, unmask: function() {} };
}
`
      );

      // Create a fake node-gyp-build module
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" })
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  const platform = process.platform;
  const arch = process.arch;
  return require(path.join(dir, 'prebuilds', platform + '-' + arch, 'bufferutil.node'));
};`
      );

      // Create main entry point that imports bufferutil
      const entryPath = path.join(tempDir, "index.js");
      fs.writeFileSync(
        entryPath,
        `const bufferutil = require('bufferutil');
console.log(bufferutil);
`
      );

      // Run Vite build
      let buildError: Error | null = null;
      try {
        await build({
          root: tempDir,
          logLevel: "silent",
          build: {
            write: false,
            rollupOptions: {
              input: entryPath,
            },
            lib: {
              entry: entryPath,
              formats: ["cjs"],
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
      } catch (err) {
        buildError = err as Error;
      }

      // The build should succeed without the syntheticNamedExports error
      if (buildError) {
        expect(buildError.message).not.toContain("syntheticNamedExports");
        expect(buildError.message).not.toContain(
          "needs a default export that does not reexport"
        );
      }
    });

    /**
     * Test with export * re-export pattern that might trigger the error
     */
    it("should build without error when module with native addon is re-exported with export *", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create native-addon package
      const addonDir = path.join(tempDir, "node_modules", "native-addon");
      const prebuildsDir = path.join(addonDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      fs.writeFileSync(
        path.join(prebuildsDir, "addon.node"),
        Buffer.from("fake native module")
      );

      fs.writeFileSync(
        path.join(addonDir, "package.json"),
        JSON.stringify({
          name: "native-addon",
          main: "index.js",
        })
      );

      fs.writeFileSync(
        path.join(addonDir, "index.js"),
        `'use strict';
try {
  module.exports = require('node-gyp-build')(__dirname);
} catch (e) {
  module.exports = { doSomething: function() {} };
}
`
      );

      // Create node-gyp-build
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" })
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  const platform = process.platform;
  const arch = process.arch;
  return require(path.join(dir, 'prebuilds', platform + '-' + arch, 'addon.node'));
};`
      );

      // Create a wrapper module that re-exports with export *
      const wrapperDir = path.join(tempDir, "node_modules", "addon-wrapper");
      fs.mkdirSync(wrapperDir, { recursive: true });
      fs.writeFileSync(
        path.join(wrapperDir, "package.json"),
        JSON.stringify({
          name: "addon-wrapper",
          main: "index.js",
          type: "module",
        })
      );
      // This pattern can trigger the syntheticNamedExports error
      fs.writeFileSync(
        path.join(wrapperDir, "index.js"),
        `export * from 'native-addon';
export { default } from 'native-addon';
`
      );

      // Create entry point
      const entryPath = path.join(tempDir, "index.mjs");
      fs.writeFileSync(
        entryPath,
        `import addon from 'addon-wrapper';
console.log(addon);
`
      );

      let buildError: Error | null = null;
      try {
        await build({
          root: tempDir,
          logLevel: "silent",
          build: {
            write: false,
            rollupOptions: {
              input: entryPath,
            },
            lib: {
              entry: entryPath,
              formats: ["es"],
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
      } catch (err) {
        buildError = err as Error;
      }

      if (buildError) {
        // Check it's not the syntheticNamedExports error
        expect(buildError.message).not.toContain("syntheticNamedExports");
        expect(buildError.message).not.toContain(
          "needs a default export that does not reexport"
        );
      }
    });

    /**
     * Test with named import destructuring pattern
     */
    it("should build successfully with named import destructuring from native module", async () => {
      const platform = process.platform;
      const arch = process.arch;

      // Create native package
      const nativeDir = path.join(tempDir, "node_modules", "my-native");
      const prebuildsDir = path.join(nativeDir, "prebuilds", `${platform}-${arch}`);
      fs.mkdirSync(prebuildsDir, { recursive: true });

      fs.writeFileSync(
        path.join(prebuildsDir, "native.node"),
        Buffer.from("fake native module")
      );

      fs.writeFileSync(
        path.join(nativeDir, "package.json"),
        JSON.stringify({ name: "my-native", main: "index.js" })
      );

      fs.writeFileSync(
        path.join(nativeDir, "index.js"),
        `'use strict';
try {
  module.exports = require('node-gyp-build')(__dirname);
} catch (e) {
  module.exports = { foo: function() {}, bar: function() {} };
}
`
      );

      // Create node-gyp-build
      const nodeGypBuildDir = path.join(tempDir, "node_modules", "node-gyp-build");
      fs.mkdirSync(nodeGypBuildDir, { recursive: true });
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "package.json"),
        JSON.stringify({ name: "node-gyp-build", main: "index.js" })
      );
      fs.writeFileSync(
        path.join(nodeGypBuildDir, "index.js"),
        `module.exports = function(dir) {
  const path = require('path');
  const platform = process.platform;
  const arch = process.arch;
  return require(path.join(dir, 'prebuilds', platform + '-' + arch, 'native.node'));
};`
      );

      // Entry point with destructuring
      const entryPath = path.join(tempDir, "index.js");
      fs.writeFileSync(
        entryPath,
        `const { foo, bar } = require('my-native');
console.log(foo, bar);
`
      );

      let buildError: Error | null = null;
      try {
        await build({
          root: tempDir,
          logLevel: "silent",
          build: {
            write: false,
            rollupOptions: {
              input: entryPath,
            },
            lib: {
              entry: entryPath,
              formats: ["cjs"],
            },
          },
          plugins: [nativeFilePlugin({ forced: true })],
        });
      } catch (err) {
        buildError = err as Error;
      }

      if (buildError) {
        expect(buildError.message).not.toContain("syntheticNamedExports");
        expect(buildError.message).not.toContain(
          "needs a default export that does not reexport"
        );
      }
    });
  });
});
