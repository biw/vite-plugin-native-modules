import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nativeFilePlugin from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as acornParse } from "acorn";

// Wrapper to provide the same parse signature as Rollup
const parse = (code: string) => acornParse(code, { ecmaVersion: "latest" });

/**
 * Tests for bindings package support
 *
 * The bindings package uses patterns like: require('bindings')('addon')
 * which searches for native modules in common build directories.
 *
 * This plugin detects these patterns and rewrites them to direct require()
 * calls with the appropriate .node file for the current build platform.
 */
describe("bindings Package Support", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindings-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Basic Patterns", () => {
    it("should detect and replace require('bindings')('addon') pattern", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create build/Release directory with .node file
      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const bindings = require('bindings');
const addon = bindings('addon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
      expect(result.code).toContain(`require("./addon-`);
    });

    it("should detect and replace direct require('bindings')('addon') pattern", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create build/Release directory with .node file
      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "native.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('native');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("native-");
      expect(result.code).toContain(".node");
    });

    it("should handle .node extension in module name", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "binding.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const binding = require('bindings')('binding.node');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
    });
  });

  describe("Object Argument Pattern", () => {
    it("should handle bindings({ bindings: 'addon' }) pattern", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')({ bindings: 'addon' });`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should handle variable with object argument", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "binding.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const bindings = require('bindings');
const binding = bindings({ bindings: 'binding' });`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
    });
  });

  describe("Build Directory Search", () => {
    it("should find .node files in build/Release", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('addon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
    });

    it("should find .node files in build/Debug", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Debug");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('addon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
    });

    it("should find .node files in out/Release", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const outDir = path.join(tempDir, "out", "Release");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('addon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
    });

    it("should prefer build/Release over build/Debug", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create both directories
      const releaseDir = path.join(tempDir, "build", "Release");
      const debugDir = path.join(tempDir, "build", "Debug");
      fs.mkdirSync(releaseDir, { recursive: true });
      fs.mkdirSync(debugDir, { recursive: true });

      // Write different content to each
      fs.writeFileSync(path.join(releaseDir, "addon.node"), "release binary");
      fs.writeFileSync(path.join(debugDir, "addon.node"), "debug binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('addon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      // Should use Release version (check hash matches release content)
      const releaseContent = fs.readFileSync(
        path.join(releaseDir, "addon.node")
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require("crypto");
      const releaseHash = crypto
        .createHash("md5")
        .update(releaseContent)
        .digest("hex")
        .slice(0, 8);
      expect(result.code).toContain(`addon-${releaseHash.toUpperCase()}.node`);
    });
  });

  describe("ES6 Module Support", () => {
    it("should handle ES6 imports with createRequire", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      const code = `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const bindings = require('bindings');
const addon = bindings('addon');
export { addon };`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("createRequire(import.meta.url)");
      expect(result.code).toContain(".node");
    });

    it("should inject createRequire for ES6 modules without it", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      const code = `import bindings from 'bindings';
const addon = bindings('addon');
export { addon };`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("import { createRequire } from");
      expect(result.code).toContain("createRequire(import.meta.url)");
    });
  });

  describe("Import Removal", () => {
    it("should remove bindings import after replacement", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      const code = `import bindings from 'bindings';
import path from 'path';

const addon = bindings('addon');
export { addon };`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).not.toContain("import bindings from 'bindings'");
      expect(result.code).not.toContain("bindings");
      expect(result.code).toContain("import path from 'path'");
    });

    it("should remove bindings require after replacement in CommonJS", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const bindings = require('bindings');
const path = require('path');

const addon = bindings('addon');
module.exports = { addon };`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).not.toContain("require('bindings')");
      expect(result.code).not.toContain("bindings");
      expect(result.code).toContain("require('path')");
    });
  });

  describe("Filename Format Options", () => {
    it("should use preserve format by default", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "myAddon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('myAddon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toMatch(/myAddon-[A-F0-9]{8}\.node/);
    });

    it("should use hash-only format when specified", () => {
      const plugin = nativeFilePlugin({
        filenameFormat: "hash-only",
      }) as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "myAddon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const addon = require('bindings')('myAddon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
      expect(result.code).not.toContain("myAddon");
    });
  });

  describe("node_modules Package Handling", () => {
    it("should transform bindings calls in node_modules packages", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a mock node_modules package structure
      const nodeModulesDir = path.join(tempDir, "node_modules", "test-package");
      fs.mkdirSync(nodeModulesDir, { recursive: true });

      // Create package.json to mark this as a package root
      fs.writeFileSync(
        path.join(nodeModulesDir, "package.json"),
        JSON.stringify({ name: "test-package", version: "1.0.0" })
      );

      // Create the package's build directory with .node file
      const buildDir = path.join(nodeModulesDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "native.node"), "fake binary");

      // Create the package's index.js that uses bindings
      const packageIndexPath = path.join(nodeModulesDir, "index.js");
      const packageCode = `const bindings = require('bindings');
module.exports = bindings('native');`;

      const context = { parse };
      const result = (plugin.transform as any).call(
        context,
        packageCode,
        packageIndexPath
      );

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("native-");
      expect(result.code).toContain(".node");
      expect(result.code).not.toContain("require('bindings')");
      expect(result.code).not.toContain("bindings");
    });

    it("should transform bindings calls with direct pattern in node_modules", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Simulate better-sqlite3 structure
      const packageDir = path.join(tempDir, "node_modules", "better-sqlite3");
      fs.mkdirSync(packageDir, { recursive: true });

      // Create package.json
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "better-sqlite3", version: "1.0.0" })
      );

      // Create build directory with .node file
      const buildDir = path.join(packageDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(
        path.join(buildDir, "better_sqlite3.node"),
        "fake binary"
      );

      // Create lib/database.js that uses bindings
      const libDir = path.join(packageDir, "lib");
      fs.mkdirSync(libDir, { recursive: true });
      const dbFilePath = path.join(libDir, "database.js");

      const code = `const bindings = require('bindings');
const addon = bindings('better_sqlite3.node');

function Database(filename, options) {
  return addon.Database(filename, options);
}

module.exports = Database;`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, dbFilePath);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("better_sqlite3-");
      expect(result.code).toContain(".node");
      // Should have removed bindings import
      expect(result.code).not.toContain("require('bindings')");
      expect(result.code).not.toContain("bindings('better_sqlite3.node')");
    });

    it("should handle nested node_modules packages", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create deeply nested package
      const packageDir = path.join(
        tempDir,
        "node_modules",
        "@org",
        "package",
        "node_modules",
        "native-dep"
      );
      fs.mkdirSync(packageDir, { recursive: true });

      // Create package.json
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "native-dep", version: "1.0.0" })
      );

      // Create build directory
      const buildDir = path.join(packageDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const packageFile = path.join(packageDir, "index.js");
      const code = `module.exports = require('bindings')('addon');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, packageFile);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should resolve .node files relative to the package directory", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create package with bindings in subdirectory
      const packageDir = path.join(tempDir, "node_modules", "native-pkg");
      const srcDir = path.join(packageDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      // Create package.json
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "native-pkg", version: "1.0.0" })
      );

      // .node file is at package root level
      const buildDir = path.join(packageDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "binding.node"), "fake binary");

      // But the source file is in src/
      const srcFile = path.join(srcDir, "loader.js");
      const code = `const load = require('bindings');
module.exports = load('binding');`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, srcFile);

      expect(result).not.toBeNull();
      expect(result.code).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
    });
  });

  describe("Resolution of Transformed Paths", () => {
    it("should resolve hashed filenames generated by bindings transformation", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const addon = require('bindings')('addon');`;

      // First, transform the code to generate the hashed filename
      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        jsFilePath
      );

      expect(transformResult).not.toBeNull();
      expect(transformResult.code).toBeDefined();
      expect(transformResult.code).toMatch(
        /require\("\.\/addon-[A-F0-9]{8}\.node"\)/
      );

      // Extract the hashed filename from the transformed code
      const match = transformResult.code.match(/require\("\.\/([^"]+)"\)/);
      expect(match).not.toBeNull();
      const hashedFilename = match![1];

      // Now test that resolveId can resolve this hashed filename
      const resolveResult = await (plugin.resolveId as any).call(
        {},
        `./${hashedFilename}`,
        jsFilePath
      );

      expect(resolveResult).toBeDefined();
      // resolveId now returns an object with { id, syntheticNamedExports }
      const resolvedId = typeof resolveResult === "object" ? resolveResult.id : resolveResult;
      expect(resolvedId).toMatch(/^\0native:/);
    });

    it("should resolve hashed filenames with query parameters", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const addon = require('bindings')('addon');`;

      // Transform to generate hashed filename
      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        jsFilePath
      );

      const match = transformResult.code.match(/require\("\.\/([^"]+)"\)/);
      const hashedFilename = match![1];

      // Test resolution with query parameter (like Vite adds)
      const resolveResult = await (plugin.resolveId as any).call(
        {},
        `./${hashedFilename}?commonjs-external`,
        jsFilePath
      );

      expect(resolveResult).toBeDefined();
      // resolveId now returns an object with { id, syntheticNamedExports }
      const resolvedId = typeof resolveResult === "object" ? resolveResult.id : resolveResult;
      expect(resolvedId).toMatch(/^\0native:/);
    });

    it("should resolve hash-only format filenames", async () => {
      const plugin = nativeFilePlugin({
        filenameFormat: "hash-only",
      }) as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const addon = require('bindings')('addon');`;

      // Transform to generate hashed filename
      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        jsFilePath
      );

      expect(transformResult.code).toMatch(
        /require\("\.\/[A-F0-9]{8}\.node"\)/
      );

      const match = transformResult.code.match(/require\("\.\/([^"]+)"\)/);
      const hashedFilename = match![1];

      // Test resolution
      const resolveResult = await (plugin.resolveId as any).call(
        {},
        `./${hashedFilename}`,
        jsFilePath
      );

      expect(resolveResult).toBeDefined();
      // resolveId now returns an object with { id, syntheticNamedExports }
      const resolvedId = typeof resolveResult === "object" ? resolveResult.id : resolveResult;
      expect(resolvedId).toMatch(/^\0native:/);
    });

    it("should resolve node-gyp-build transformed paths", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const addon = require('node-gyp-build')(__dirname);`;

      // Transform to generate hashed filename
      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        jsFilePath
      );

      expect(transformResult).not.toBeNull();
      const match = transformResult.code.match(/require\("\.\/([^"]+)"\)/);
      expect(match).not.toBeNull();
      const hashedFilename = match![1];

      // Test resolution
      const resolveResult = await (plugin.resolveId as any).call(
        {},
        `./${hashedFilename}`,
        jsFilePath
      );

      expect(resolveResult).toBeDefined();
      // resolveId now returns an object with { id, syntheticNamedExports }
      const resolvedId = typeof resolveResult === "object" ? resolveResult.id : resolveResult;
      expect(resolvedId).toMatch(/^\0native:/);
    });
  });

  describe("Load Hook Module Format Detection", () => {
    it("should generate ES module code in load hook for bindings in .mjs file", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const esmFilePath = path.join(tempDir, "index.mjs");
      const code = `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const bindings = require('bindings');
const addon = bindings('addon');
export { addon };`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        esmFilePath
      );

      if (!transformResult) return;

      const match = transformResult.code.match(
        /require\(['"]([^'"]+\.node)['"]\)/
      );
      if (!match) return;
      const hashedFilename = match[1];

      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        `./${hashedFilename}`,
        esmFilePath,
        {}
      );

      const loadResult = await (plugin.load as any).call({} as any, virtualId);
      expect(loadResult).toBeDefined();
      expect(loadResult).toContain("import { createRequire }");
      expect(loadResult).toContain("export default");
      expect(loadResult).not.toContain("module.exports");
    });

    it("should generate CommonJS code in load hook for bindings in .js file", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

      const cjsFilePath = path.join(tempDir, "index.js");
      const code = `const bindings = require('bindings');
const addon = bindings('addon');
module.exports = { addon };`;

      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        cjsFilePath
      );

      if (!transformResult) return;

      const match = transformResult.code.match(
        /require\(['"]([^'"]+\.node)['"]\)/
      );
      if (!match) return;
      const hashedFilename = match[1];

      const resolveResult = await (plugin.resolveId as any).call(
        {} as any,
        `./${hashedFilename}`,
        cjsFilePath,
        {}
      );

      // resolveId now returns an object with { id, syntheticNamedExports }
      const virtualId = typeof resolveResult === "object" ? resolveResult.id : resolveResult;
      const loadResult = await (plugin.load as any).call({} as any, virtualId);
      expect(loadResult).toBeDefined();
      expect(loadResult).toContain("module.exports");
      expect(loadResult).toContain("require(");
      expect(loadResult).not.toContain("import { createRequire }");
      expect(loadResult).not.toContain("export default");
    });
  });
});
