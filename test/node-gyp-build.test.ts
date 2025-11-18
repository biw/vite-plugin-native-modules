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
 * Tests for node-gyp-build runtime selector support
 *
 * node-gyp-build uses a pattern like: require('node-gyp-build')(__dirname)
 * which dynamically loads the correct native module based on platform/arch.
 *
 * This plugin detects these patterns and rewrites them to direct require()
 * calls with the appropriate .node file for the current build platform.
 */
describe("node-gyp-build Support", () => {
  let tempDir: string;
  const platform = process.platform;
  const arch = process.arch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-gyp-build-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Direct require('node-gyp-build')(__dirname) pattern", () => {
    it("should detect and rewrite direct call with prebuilds directory", () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create prebuilds directory structure
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });

      const nodeFilePath = path.join(prebuildsDir, "binding.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // Create a file that uses node-gyp-build
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("require(");
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
      expect(result.code).not.toContain("node-gyp-build");
      expect(result.code).not.toContain("__dirname");
    });

    it("should handle napi.node files in prebuilds", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create prebuilds with napi file
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });

      const napiFile = path.join(prebuildsDir, "node.napi.node");
      fs.writeFileSync(napiFile, Buffer.from("napi binding"));

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `module.exports = require('node-gyp-build')(__dirname)`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("node.napi-");
      expect(result.code).toContain(".node");
    });

    it("should prefer napi over abi-specific files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });

      // Create both napi and abi-specific files
      fs.writeFileSync(
        path.join(prebuildsDir, "node.abi93.node"),
        Buffer.from("abi93")
      );
      fs.writeFileSync(
        path.join(prebuildsDir, "node.napi.node"),
        Buffer.from("napi")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      // Should prefer napi over abi93
      expect(result.code).toContain("node.napi-");
    });
  });

  describe("Variable binding pattern", () => {
    it("should handle const load = require('node-gyp-build'); load(__dirname)", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "addon.node"),
        Buffer.from("addon")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const load = require('node-gyp-build');
        const binding = load(__dirname);
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("require(");
      expect(result.code).toContain("addon-");
      // The load(__dirname) call should be replaced, even if the declaration remains
      expect(result.code).not.toContain("load(__dirname)");
    });

    it("should handle different variable names", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("binding")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const nodeGypBuild = require('node-gyp-build');
        module.exports = nodeGypBuild(__dirname);
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("binding-");
    });
  });

  describe("ES6 import pattern", () => {
    it("should handle import load from 'node-gyp-build'; load(__dirname)", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "native.node"),
        Buffer.from("native")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import load from 'node-gyp-build';
        const binding = load(__dirname);
      `;

      // Use module-aware parser for ES6 import syntax
      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("native-");
      expect(result.code).not.toContain("load(__dirname)");
    });
  });

  describe("Fallback to build/Release", () => {
    it("should fallback to build/Release when prebuilds doesn't exist", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create build/Release directory instead of prebuilds
      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });

      const nodeFilePath = path.join(buildDir, "addon.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("compiled addon"));

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should handle build/Release with multiple .node files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });

      // Create multiple .node files (should pick first one)
      fs.writeFileSync(path.join(buildDir, "addon.node"), Buffer.from("addon"));
      fs.writeFileSync(path.join(buildDir, "other.node"), Buffer.from("other"));

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `module.exports = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toMatch(
        /addon-[A-F0-9]{8}\.node|other-[A-F0-9]{8}\.node/
      );
    });
  });

  describe("path.join with __dirname", () => {
    it("should handle require('node-gyp-build')(path.join(__dirname, 'subdir'))", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create nested structure
      const subdir = path.join(tempDir, "native");
      const prebuildsDir = path.join(
        subdir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("binding")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(path.join(__dirname, 'native'));`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).not.toContain("path.join");
    });

    it("should handle path.resolve with __dirname", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const subdir = path.join(tempDir, "lib");
      const buildDir = path.join(subdir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(
        path.join(buildDir, "native.node"),
        Buffer.from("native")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(path.resolve(__dirname, 'lib'));`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("native-");
    });
  });

  describe("Real-world package scenarios", () => {
    it("should work with better-sqlite3 style structure", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Simulate better-sqlite3 in node_modules
      const pkgDir = path.join(tempDir, "node_modules", "better-sqlite3");
      const prebuildsDir = path.join(
        pkgDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "node.napi.node"),
        Buffer.from("better-sqlite3 binding")
      );

      const jsFilePath = path.join(pkgDir, "lib", "index.js");
      fs.mkdirSync(path.dirname(jsFilePath), { recursive: true });

      const code = `
        const nodeGypBuild = require('node-gyp-build');
        const binding = nodeGypBuild(path.join(__dirname, '..'));
        module.exports = binding;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("node.napi-");
    });

    it("should work with sharp style structure", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const pkgDir = path.join(tempDir, "node_modules", "sharp");
      const buildDir = path.join(pkgDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(
        path.join(buildDir, `sharp-${platform}-${arch}.node`),
        Buffer.from("sharp binding")
      );

      const jsFilePath = path.join(pkgDir, "lib", "index.js");
      fs.mkdirSync(path.dirname(jsFilePath), { recursive: true });

      const code = `const binding = require('node-gyp-build')(path.join(__dirname, '..'));`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain(`sharp-${platform}-${arch}-`);
    });
  });

  describe("Edge cases", () => {
    it("should return null when no .node file is found", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Empty directory - no prebuilds or build/Release
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should return null when no .node file found
      expect(result).toBeNull();
    });

    it("should not transform in dev mode by default", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "serve",
        mode: "development",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("binding")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeNull();
    });

    it("should transform in dev mode when forced", () => {
      const plugin = nativeFilePlugin({ forced: true }) as Plugin;

      (plugin.configResolved as any)({
        command: "serve",
        mode: "development",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("binding")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("binding-");
    });

    it("should handle multiple node-gyp-build calls in one file", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create two separate addon directories
      const addon1Dir = path.join(tempDir, "addon1");
      const addon2Dir = path.join(tempDir, "addon2");

      const prebuilds1 = path.join(
        addon1Dir,
        "prebuilds",
        `${platform}-${arch}`
      );
      const prebuilds2 = path.join(
        addon2Dir,
        "prebuilds",
        `${platform}-${arch}`
      );

      fs.mkdirSync(prebuilds1, { recursive: true });
      fs.mkdirSync(prebuilds2, { recursive: true });

      fs.writeFileSync(
        path.join(prebuilds1, "addon1.node"),
        Buffer.from("addon1")
      );
      fs.writeFileSync(
        path.join(prebuilds2, "addon2.node"),
        Buffer.from("addon2")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const addon1 = require('node-gyp-build')(path.join(__dirname, 'addon1'));
        const addon2 = require('node-gyp-build')(path.join(__dirname, 'addon2'));
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon1-");
      expect(result.code).toContain("addon2-");
    });

    it("should still handle regular require('./addon.node') alongside node-gyp-build", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create both a regular .node file and a prebuilds structure
      const regularNode = path.join(tempDir, "regular.node");
      fs.writeFileSync(regularNode, Buffer.from("regular"));

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "dynamic.node"),
        Buffer.from("dynamic")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const regular = require('./regular.node');
        const dynamic = require('node-gyp-build')(__dirname);
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("regular-");
      expect(result.code).toContain("dynamic-");
      expect(result.code).not.toContain("node-gyp-build");
    });
  });

  describe("Content hashing", () => {
    it("should generate consistent hash for same .node file content", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("consistent content")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result1 = (plugin.transform as any).call(context, code, jsFilePath);
      const result2 = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result1.code).toBe(result2.code);
    });

    it("should generate uppercase hash in filename", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("test content")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const binding = require('node-gyp-build')(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      // Should have uppercase hash
      expect(result.code).toMatch(/binding-[A-F0-9]{8}\.node/);
    });
  });

  describe("createRequire pattern support", () => {
    it("should handle createRequire with node-gyp-build pattern", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("native binding")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire } from "module";
        var require2 = createRequire(import.meta.url);
        var nodeGypBuild = require2("node-gyp-build");
        var binding = nodeGypBuild(__dirname);
      `;

      // Use module-aware parser for ES6 import syntax
      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
      expect(result.code).not.toContain("nodeGypBuild(__dirname)");
    });

    it("should handle createRequire from 'node:module'", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "addon.node"),
        Buffer.from("addon")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire } from "node:module";
        const customRequire = createRequire(import.meta.url);
        const load = customRequire("node-gyp-build");
        const binding = load(__dirname);
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
    });

    it("should handle direct call pattern with createRequire", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "native.node"),
        Buffer.from("native")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire } from "module";
        const _require = createRequire(import.meta.url);
        const binding = _require("node-gyp-build")(__dirname);
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("native-");
      expect(result.code).not.toContain('_require("node-gyp-build")');
    });

    it("should handle minified variable names", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const buildDir = path.join(tempDir, "build", "Release");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "addon.node"), Buffer.from("addon"));

      const jsFilePath = path.join(tempDir, "index.js");
      // Simulating minified code with short variable names
      const code = `
        import { createRequire } from "module";
        var r = createRequire(import.meta.url);
        var n = r("node-gyp-build");
        var b = n(__dirname);
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).not.toContain("n(__dirname)");
    });

    it("should handle createRequire with path.join and __dirname", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const subdir = path.join(tempDir, "native");
      const prebuildsDir = path.join(
        subdir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("binding")
      );

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `
        import { createRequire } from "module";
        var require2 = createRequire(import.meta.url);
        var nodeGypBuild = require2("node-gyp-build");
        var binding = nodeGypBuild(path.join(__dirname, "native"));
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).not.toContain("nodeGypBuild(path.join");
    });

    it("should handle renamed createRequire import", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "addon.node"),
        Buffer.from("addon")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire as makeRequire } from "module";
        const customReq = makeRequire(import.meta.url);
        const loader = customReq("node-gyp-build");
        const binding = loader(__dirname);
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).not.toContain("loader(__dirname)");
    });

    it("should handle multiple custom requires in same file", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuilds1 = path.join(
        tempDir,
        "pkg1",
        "prebuilds",
        `${platform}-${arch}`
      );
      const prebuilds2 = path.join(
        tempDir,
        "pkg2",
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuilds1, { recursive: true });
      fs.mkdirSync(prebuilds2, { recursive: true });
      fs.writeFileSync(
        path.join(prebuilds1, "addon1.node"),
        Buffer.from("addon1")
      );
      fs.writeFileSync(
        path.join(prebuilds2, "addon2.node"),
        Buffer.from("addon2")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire } from "module";
        const req1 = createRequire(import.meta.url);
        const req2 = createRequire(import.meta.url);
        const loader1 = req1("node-gyp-build");
        const loader2 = req2("node-gyp-build");
        const binding1 = loader1(path.join(__dirname, "pkg1"));
        const binding2 = loader2(path.join(__dirname, "pkg2"));
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon1-");
      expect(result.code).toContain("addon2-");
    });

    it("should handle mixed regular require and createRequire patterns", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuilds1 = path.join(
        tempDir,
        "pkg1",
        "prebuilds",
        `${platform}-${arch}`
      );
      const prebuilds2 = path.join(
        tempDir,
        "pkg2",
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuilds1, { recursive: true });
      fs.mkdirSync(prebuilds2, { recursive: true });
      fs.writeFileSync(
        path.join(prebuilds1, "native1.node"),
        Buffer.from("native1")
      );
      fs.writeFileSync(
        path.join(prebuilds2, "native2.node"),
        Buffer.from("native2")
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire } from "module";
        const customReq = createRequire(import.meta.url);
        const loader1 = customReq("node-gyp-build");
        const loader2 = require("node-gyp-build");
        const binding1 = loader1(path.join(__dirname, "pkg1"));
        const binding2 = loader2(path.join(__dirname, "pkg2"));
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain("native1-");
      expect(result.code).toContain("native2-");
      expect(result.code).not.toContain("loader1(path.join");
      expect(result.code).not.toContain("loader2(path.join");
    });

    it("should return null when createRequire pattern has no matching .node file", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // No .node files created
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        import { createRequire } from "module";
        const req = createRequire(import.meta.url);
        const loader = req("node-gyp-build");
        const binding = loader(__dirname);
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should return null when no .node file found
      expect(result).toBeNull();
    });
  });

  describe("Real-world minified code patterns", () => {
    it("should handle default import of node-gyp-build with path.resolve and variable directory", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create prebuilds structure matching the image (libopus package example)
      const platforms = [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "win32-x64",
      ];

      for (const platformArch of platforms) {
        const prebuildsDir = path.join(tempDir, "prebuilds", platformArch);
        fs.mkdirSync(prebuildsDir, { recursive: true });
        fs.writeFileSync(
          path.join(prebuildsDir, "libopus-node.glibc.node"),
          Buffer.from(`libopus for ${platformArch}`)
        );
      }

      // Also add musl variant for linux-x64
      fs.writeFileSync(
        path.join(tempDir, "prebuilds", "linux-x64", "libopus-node.musl.node"),
        Buffer.from("libopus for linux-x64 musl")
      );

      // Create a subdirectory for the JS file (like dist/)
      // so that path.resolve(dirname, "..") points back to tempDir where prebuilds are
      const distDir = path.join(tempDir, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      const jsFilePath = path.join(distDir, "index.js");

      // This is the exact minified pattern from the user's code
      const code = `import e from"path";import{fileURLToPath as o}from"url";import n from"node-gyp-build";var t=e.dirname(o(import.meta.url)),r=n(e.resolve(t,"..")),{OpusEncoder:p}=r,d=r;export{p as OpusEncoder,d as default};`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // This test documents the expected behavior
      // The plugin should detect the node-gyp-build pattern and rewrite it
      expect(result).toBeDefined();
      expect(result.code).toContain("libopus-node");
      expect(result.code).toContain(".node");
      expect(result.code).not.toContain("n(e.resolve(t,");
    });

    it("should handle minified code with variable holding directory path", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${platform}-${arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(
        path.join(prebuildsDir, "binding.node"),
        Buffer.from("binding")
      );

      // Create a subdirectory for the JS file so path.resolve(currentDir, "..") points to tempDir
      const srcDir = path.join(tempDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      const jsFilePath = path.join(srcDir, "index.js");

      // Similar pattern but slightly more readable
      const code = `
        import path from "path";
        import { fileURLToPath } from "url";
        import nodeGypBuild from "node-gyp-build";
        var currentDir = path.dirname(fileURLToPath(import.meta.url));
        var binding = nodeGypBuild(path.resolve(currentDir, ".."));
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should detect and rewrite the pattern
      expect(result).toBeDefined();
      expect(result.code).toContain("binding-");
      expect(result.code).not.toContain("nodeGypBuild(path.resolve(currentDir");
    });
  });

  describe("ES6 Module Context Handling", () => {
    it("should use createRequire when rewriting ES6 import of node-gyp-build", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory structure
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "binding.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // ES6 module using import
      const code = `import nodeGypBuild from 'node-gyp-build';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should transform successfully
      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should NOT have bare require() call without createRequire
      const hasCreateRequire = result.code.includes("createRequire");
      const hasRequireCall = result.code.includes("require(");

      if (hasRequireCall) {
        // If there's a require call, createRequire must be present
        expect(hasCreateRequire).toBe(true);
        expect(result.code).toContain("import { createRequire } from");
        expect(result.code).toMatch(/const\s+require\s*=\s*createRequire/);
      }

      // Should contain the hashed node file
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
    });

    it("should handle ESM file that already has createRequire", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // ESM file already using createRequire to load node-gyp-build
      const code = `import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const nodeGypBuild = require("node-gyp-build");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should transform successfully
      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should keep existing createRequire import
      expect(result.code).toContain("import { createRequire } from 'module'");

      // Should NOT duplicate createRequire import
      const createRequireMatches = (
        result.code.match(/import.*createRequire.*from/g) || []
      ).length;
      expect(createRequireMatches).toBe(1);

      // Should NOT duplicate require variable declaration
      const requireDeclMatches = (
        result.code.match(/const\s+require\s*=/g) || []
      ).length;
      expect(requireDeclMatches).toBe(1);

      // Should contain the hashed node file
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should handle multiple node-gyp-build calls in same ES6 module", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create two prebuilds directories
      const pkg1Dir = path.join(tempDir, "pkg1");
      const pkg2Dir = path.join(tempDir, "pkg2");

      [pkg1Dir, pkg2Dir].forEach((pkgDir, idx) => {
        const prebuildsDir = path.join(
          pkgDir,
          "prebuilds",
          `${process.platform}-${process.arch}`
        );
        fs.mkdirSync(prebuildsDir, { recursive: true });
        fs.writeFileSync(
          path.join(prebuildsDir, `addon${idx + 1}.node`),
          `fake binary ${idx + 1}`
        );
      });

      const jsFilePath = path.join(tempDir, "index.mjs");

      const code = `import nodeGypBuild from 'node-gyp-build';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding1 = nodeGypBuild(path.join(__dirname, 'pkg1'));
const binding2 = nodeGypBuild(path.join(__dirname, 'pkg2'));`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should have createRequire
      if (result.code.includes("require(")) {
        expect(result.code).toContain("createRequire");
        // Should only have ONE createRequire import and ONE require declaration
        const createRequireMatches = (
          result.code.match(/import.*createRequire/g) || []
        ).length;
        expect(createRequireMatches).toBeLessThanOrEqual(1);
      }

      // Should transform both calls
      expect(result.code).toContain("addon1");
      expect(result.code).toContain("addon2");
    });

    it("should NOT assume file is CommonJS when it uses createRequire to load node-gyp-build", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "native.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // This is ESM, NOT CommonJS! (has import statement)
      const code = `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const nodeGypBuild = require("node-gyp-build");
const binding = nodeGypBuild(require.resolve("./"));`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();

      if (result.code) {
        // Should keep it as ESM (has import statement)
        expect(result.code).toContain("import");

        // Should not add duplicate createRequire
        const createRequireImports = (
          result.code.match(/import.*createRequire/g) || []
        ).length;
        expect(createRequireImports).toBe(1);
      }
    });

    it("should correctly detect CommonJS vs ESM in different files", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), "fake binary");

      // Test CommonJS file
      const cjsFilePath = path.join(tempDir, "cjs.js");
      const cjsCode = `const nodeGypBuild = require('node-gyp-build');
const binding = nodeGypBuild(__dirname);`;

      const cjsContext = { parse };
      const cjsResult = (plugin.transform as any).call(
        cjsContext,
        cjsCode,
        cjsFilePath
      );

      // Test ESM file
      const esmFilePath = path.join(tempDir, "esm.mjs");
      const esmCode = `import nodeGypBuild from 'node-gyp-build';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const esmContext = { parse: moduleAwareParse };
      const esmResult = (plugin.transform as any).call(
        esmContext,
        esmCode,
        esmFilePath
      );

      // CommonJS should use plain require
      expect(cjsResult).toBeDefined();
      if (cjsResult.code) {
        expect(cjsResult.code).toContain("require(");
        expect(cjsResult.code).not.toContain("import");
      }

      // ESM should use createRequire (if it rewrites with require)
      expect(esmResult).toBeDefined();
      if (esmResult.code && esmResult.code.includes("require(")) {
        expect(esmResult.code).toContain("createRequire");
      }
    });

    it("should NOT inject createRequire for ES6 files without node-gyp-build", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      const jsFilePath = path.join(tempDir, "no-node-gyp.mjs");

      // ES6 module that doesn't use node-gyp-build at all
      const code = `import { something } from 'some-package';
import path from 'path';

export const myFunc = () => {
  return path.join(__dirname, 'test');
};`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should return null or code unchanged (no modification)
      if (result === null) {
        // Perfect - no transformation
        expect(result).toBeNull();
      } else {
        // If it returns something, it should NOT inject createRequire
        expect(result.code).not.toContain("createRequire");
        expect(result.code).not.toContain("import.meta.url");
      }
    });

    it("should respect renamed createRequire imports (Vite remapping)", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // Simulating Vite's remapping: createRequire imported as createRequire$1
      const code = `import { createRequire as createRequire$1 } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire$1(import.meta.url);
const nodeGypBuild = require("node-gyp-build");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should NOT have any bare calls to createRequire(import.meta.url)
      // without a variable or using the wrong name
      expect(result.code).not.toMatch(
        /createRequire\(import\.meta\.url\)[^;]*;?\s*$/m
      );

      // Should use createRequire$1 if it needs to reference it
      if (result.code.includes("createRequire$1")) {
        // Good! Using the renamed import
        expect(result.code).toContain("createRequire$1");
      }

      // Should NOT use the literal "createRequire" if it was renamed
      if (
        result.code.includes("createRequire(") &&
        result.code.includes("createRequire$1")
      ) {
        // If both exist, something is wrong

        console.error(
          "Should not have both 'createRequire' and 'createRequire$1' - use only the renamed version"
        );
        expect(false).toBe(true);
      }

      // Should contain the transformed node file
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should use renamed createRequire in inline calls", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "binding.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // Has renamed createRequire
      const code = `import { createRequire as myCreateRequire } from 'module';
import nodeGypBuild from 'node-gyp-build';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should use myCreateRequire in the inline call, not createRequire
      expect(result.code).toContain("myCreateRequire(import.meta.url)(");
      expect(result.code).not.toContain("createRequire(import.meta.url)(");

      // Should NOT inject a require variable
      expect(result.code).not.toContain("const require =");

      // Should contain the transformed node file
      expect(result.code).toContain("binding-");
    });

    it("should use inline createRequire calls for ES6 modules", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "test.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // ES6 module without createRequire - plugin needs to inject import and use inline calls
      const code = `import nodeGypBuild from 'node-gyp-build';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const addon = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should inject createRequire import
      expect(result.code).toContain("import { createRequire } from");

      // Should use inline createRequire(import.meta.url)() pattern, NOT const require =
      expect(result.code).toContain("createRequire(import.meta.url)(");
      expect(result.code).not.toContain("const require =");

      // Should contain the transformed node file
      expect(result.code).toContain("test-");
      expect(result.code).toMatch(
        /createRequire\(import\.meta\.url\)\("\.\/test-[A-F0-9]+\.node"\)/
      );
    });

    it("should not cause reference errors with inline createRequire calls", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // Complex ES6 module with multiple imports and code
      const code = `import { something } from 'package1';
import nodeGypBuild from 'node-gyp-build';
import { another } from 'package2';
import path from 'path';
import { fileURLToPath } from 'url';

const config = { test: true };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const addon = nodeGypBuild(__dirname);
const result = addon.doSomething();`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Verify structure: imports, then user code with inline createRequire calls
      const lines = result.code.split("\n");

      // Find key positions
      let lastImportLine = -1;
      let createRequireLine = -1;
      let configLine = -1;

      lines.forEach((line: string, idx: number) => {
        // Match actual import statements, not just any line with "import" in it
        if (/^import\s+/.test(line) && !line.includes("createRequire")) {
          lastImportLine = Math.max(lastImportLine, idx);
        }
        if (line.includes("import { createRequire }")) {
          createRequireLine = idx;
        }
        if (line.includes("const config =")) {
          configLine = idx;
        }
      });

      // Verify order: normal imports -> createRequire import -> user code
      expect(createRequireLine).toBeGreaterThan(lastImportLine);
      expect(configLine).toBeGreaterThan(createRequireLine);

      // Verify inline createRequire call is used
      expect(result.code).toContain("createRequire(import.meta.url)(");
      expect(result.code).not.toContain("const require =");
    });

    it("should NOT affect normal imports when there is no node-gyp-build", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );
      const jsFilePath = path.join(tempDir, "index.mjs");

      // ES6 module without any node-gyp-build usage
      const code = `import { something } from 'package1';
import { another } from 'package2';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const config = { test: true };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hash = crypto.createHash('sha256');
export { config, hash };`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should return null because no transformation is needed
      expect(result).toBeNull();
    });

    it("should NOT modify files without native modules even if they import other packages", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );
      const jsFilePath = path.join(tempDir, "utils.js");

      // CommonJS module with various requires
      const code = `const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lodash = require('lodash');

function doSomething() {
  return crypto.randomBytes(32);
}

module.exports = { doSomething };`;

      const result = (plugin.transform as any).call({}, code, jsFilePath);

      // Should return null because no transformation is needed
      expect(result).toBeNull();
    });
  });

  describe("Import Removal", () => {
    it("should remove ES6 import of node-gyp-build when all usages are replaced", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "addon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.mjs");

      // ES6 module with node-gyp-build import
      const code = `import nodeGypBuild from 'node-gyp-build';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const addon = nodeGypBuild(__dirname);
export { addon };`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should NOT contain the node-gyp-build import
      expect(result.code).not.toContain(
        "import nodeGypBuild from 'node-gyp-build'"
      );
      expect(result.code).not.toContain("node-gyp-build");

      // Should still contain other imports
      expect(result.code).toContain("import path from 'path'");
      expect(result.code).toContain("import { fileURLToPath } from 'url'");

      // Should contain the transformed code
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should remove CommonJS require of node-gyp-build when all usages are replaced", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "binding.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      // CommonJS module with node-gyp-build require
      const code = `const nodeGypBuild = require('node-gyp-build');
const path = require('path');

const binding = nodeGypBuild(__dirname);
module.exports = { binding };`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should NOT contain the node-gyp-build require
      expect(result.code).not.toContain("require('node-gyp-build')");
      expect(result.code).not.toContain("node-gyp-build");

      // Should still contain other requires
      expect(result.code).toContain("require('path')");

      // Should contain the transformed code
      expect(result.code).toContain("binding-");
      expect(result.code).toContain(".node");
    });
  });

  describe("Filename Format Options", () => {
    it("should use preserve format by default (filename-HASH.node)", () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "myAddon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const load = require('node-gyp-build');
const addon = load(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should preserve filename with hash: myAddon-HASH.node
      expect(result.code).toMatch(/myAddon-[A-F0-9]{8}\.node/);
    });

    it("should use hash-only format when filenameFormat is 'hash-only'", () => {
      const plugin = nativeFilePlugin({
        filenameFormat: "hash-only",
      }) as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "myAddon.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const load = require('node-gyp-build');
const addon = load(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should use hash-only format: HASH.node (no original filename)
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
      expect(result.code).not.toContain("myAddon");
    });

    it("should use preserve format when explicitly set to 'preserve'", () => {
      const plugin = nativeFilePlugin({ filenameFormat: "preserve" }) as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "node-gyp-build-test-")
      );

      // Create prebuilds directory
      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "native.node"), "fake binary");

      const jsFilePath = path.join(tempDir, "index.js");

      const code = `const load = require('node-gyp-build');
const binding = load(__dirname);`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should preserve filename with hash: native-HASH.node
      expect(result.code).toMatch(/native-[A-F0-9]{8}\.node/);
    });
  });

  describe("Load Hook Module Format Detection", () => {
    it("should generate ES module code in load hook for node-gyp-build in .mjs file", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "binding.node"), "fake binary");

      const esmFilePath = path.join(tempDir, "index.mjs");
      const code = `import nodeGypBuild from 'node-gyp-build';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binding = nodeGypBuild(__dirname);`;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        esmFilePath
      );

      if (!transformResult) return;

      let match = transformResult.code.match(
        /createRequire\(import\.meta\.url\)\(['"]([^'"]+\.node)['"]\)/
      );
      if (!match) {
        match = transformResult.code.match(/require\(['"]([^'"]+\.node)['"]\)/);
      }
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

    it("should generate CommonJS code in load hook for node-gyp-build in .js file", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const prebuildsDir = path.join(
        tempDir,
        "prebuilds",
        `${process.platform}-${process.arch}`
      );
      fs.mkdirSync(prebuildsDir, { recursive: true });
      fs.writeFileSync(path.join(prebuildsDir, "binding.node"), "fake binary");

      const cjsFilePath = path.join(tempDir, "index.js");
      const code = `const nodeGypBuild = require('node-gyp-build');
const binding = nodeGypBuild(__dirname);`;

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

      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        `./${hashedFilename}`,
        cjsFilePath,
        {}
      );

      const loadResult = await (plugin.load as any).call({} as any, virtualId);
      expect(loadResult).toBeDefined();
      expect(loadResult).toContain("module.exports");
      expect(loadResult).toContain("require(");
      expect(loadResult).not.toContain("import { createRequire }");
      expect(loadResult).not.toContain("export default");
    });
  });
});
