import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { nativeFilePlugin } from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as acornParse } from "acorn";

// Wrapper to provide the same parse signature as Rollup
const parse = (code: string) => acornParse(code, { ecmaVersion: "latest" });

/**
 * Tests for prebuild packages issue
 * https://github.com/vite-plugin/vite-plugin-native/issues/18
 *
 * The issue: Some npm packages (like better-sqlite3, sharp, etc.) provide
 * prebuilt native binaries in their node_modules. These packages often have
 * complex directory structures like:
 * - node_modules/better-sqlite3/build/Release/better_sqlite3.node
 * - node_modules/sharp/build/Release/sharp-darwin-arm64v8.node
 *
 * The problem with vite-plugin-native: It requires Webpack and attempts to bundle
 * everything, which can fail with prebuilt binaries that have complex dependencies.
 *
 * Our solution: Simply copy the .node files to the output directory with content
 * hashing for cache busting, without attempting to bundle or transform them.
 */
describe("Prebuild Packages Support (Issue #18)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prebuild-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("better-sqlite3 scenario", () => {
    it("should handle better-sqlite3 native module", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Simulate better-sqlite3 structure
      const nodeModulesDir = path.join(
        tempDir,
        "node_modules",
        "better-sqlite3"
      );
      fs.mkdirSync(path.join(nodeModulesDir, "build", "Release"), {
        recursive: true,
      });

      const sqliteNodePath = path.join(
        nodeModulesDir,
        "build",
        "Release",
        "better_sqlite3.node"
      );
      fs.writeFileSync(
        sqliteNodePath,
        Buffer.from("fake better-sqlite3 binary")
      );

      // Create a JS file that requires it
      const jsFilePath = path.join(nodeModulesDir, "lib", "database.js");
      fs.mkdirSync(path.dirname(jsFilePath), { recursive: true });

      const code = `const binding = require("../build/Release/better_sqlite3.node");`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      // Should transform the path to use hashed filename
      expect(result.code).toContain("better_sqlite3-");
      expect(result.code).toContain(".node");
      expect(result.code).not.toContain("../build/Release/");
    });

    it("should resolve nested node_modules .node files", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create nested structure
      const pkgDir = path.join(tempDir, "node_modules", "some-package");
      fs.mkdirSync(path.join(pkgDir, "build", "Release"), { recursive: true });

      const nodeFilePath = path.join(pkgDir, "build", "Release", "addon.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("prebuilt binary"));

      const importerPath = path.join(pkgDir, "index.js");

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./build/Release/addon.node",
        importerPath,
        {}
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain("\0native:");
    });
  });

  describe("sharp scenario", () => {
    it("should handle sharp platform-specific native modules", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Simulate sharp structure with platform-specific binary
      const sharpDir = path.join(tempDir, "node_modules", "sharp");
      fs.mkdirSync(path.join(sharpDir, "build", "Release"), {
        recursive: true,
      });

      const platform = process.platform;
      const arch = process.arch;
      const sharpNodePath = path.join(
        sharpDir,
        "build",
        "Release",
        `sharp-${platform}-${arch}.node`
      );
      fs.writeFileSync(sharpNodePath, Buffer.from("fake sharp binary"));

      const jsFilePath = path.join(sharpDir, "lib", "sharp.js");
      fs.mkdirSync(path.dirname(jsFilePath), { recursive: true });

      const code = `const binding = require("../build/Release/sharp-${platform}-${arch}.node");`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      // Should transform with platform-specific name
      expect(result.code).toContain(`sharp-${platform}-${arch}-`);
      expect(result.code).toContain(".node");
    });
  });

  describe("Multiple native modules", () => {
    it("should handle projects with multiple prebuild packages", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create multiple packages with native modules
      const packages = ["sqlite3", "canvas", "serialport"];

      for (const pkg of packages) {
        const pkgDir = path.join(tempDir, "node_modules", pkg);
        fs.mkdirSync(path.join(pkgDir, "build", "Release"), {
          recursive: true,
        });

        const nodeFilePath = path.join(
          pkgDir,
          "build",
          "Release",
          `${pkg}.node`
        );
        fs.writeFileSync(nodeFilePath, Buffer.from(`${pkg} binary`));
      }

      // Import all of them in one file
      const appPath = path.join(tempDir, "app.js");
      const code = `
        const sqlite3 = require("./node_modules/sqlite3/build/Release/sqlite3.node");
        const canvas = require("./node_modules/canvas/build/Release/canvas.node");
        const serialport = require("./node_modules/serialport/build/Release/serialport.node");
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, appPath);

      expect(result).toBeDefined();
      // All three should be transformed with hashes
      expect(result.code).toContain("sqlite3-");
      expect(result.code).toContain("canvas-");
      expect(result.code).toContain("serialport-");
    });
  });

  describe("Electron compatibility", () => {
    it("should work with Electron app structure", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Simulate Electron app structure
      const electronDir = path.join(tempDir, "electron-app");
      fs.mkdirSync(electronDir, { recursive: true });

      // Create a native module in node_modules
      const nativeModuleDir = path.join(
        electronDir,
        "node_modules",
        "native-addon"
      );
      fs.mkdirSync(path.join(nativeModuleDir, "build", "Release"), {
        recursive: true,
      });

      const addonPath = path.join(
        nativeModuleDir,
        "build",
        "Release",
        "addon.node"
      );
      fs.writeFileSync(addonPath, Buffer.from("electron native addon"));

      // Main process file
      const mainPath = path.join(electronDir, "main.js");
      const code = `const addon = require("./node_modules/native-addon/build/Release/addon.node");`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, mainPath);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });
  });

  describe("Edge cases", () => {
    it("should handle .node files with dashes in names", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "my-native-addon.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("addon"));

      const code = `const addon = require("./my-native-addon.node");`;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);

      expect(result).toBeDefined();
      expect(result.code).toContain("my-native-addon-");
      expect(result.code).toContain(".node");
    });

    it("should handle deeply nested paths", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const deepPath = path.join(
        tempDir,
        "a",
        "b",
        "c",
        "d",
        "e",
        "addon.node"
      );
      fs.mkdirSync(path.dirname(deepPath), { recursive: true });
      fs.writeFileSync(deepPath, Buffer.from("deep addon"));

      const importerPath = path.join(tempDir, "index.js");

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./a/b/c/d/e/addon.node",
        importerPath,
        {}
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle same .node file required from multiple locations", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.load).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "shared.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("shared"));

      const file1 = path.join(tempDir, "file1.js");
      const file2 = path.join(tempDir, "sub", "file2.js");
      fs.mkdirSync(path.dirname(file2), { recursive: true });

      // Resolve from two different locations
      const result1 = await (plugin.resolveId as any).call(
        {} as any,
        "./shared.node",
        file1,
        {}
      );
      const result2 = await (plugin.resolveId as any).call(
        {} as any,
        "../shared.node",
        file2,
        {}
      );

      // Both should resolve to the same virtual module (same absolute path)
      expect(result1).toBe(result2);
      expect(result1).toBeDefined();
      expect(typeof result1).toBe("string");

      const loadResult = await (plugin.load as any).call({} as any, result1);
      expect(loadResult).toBeDefined();
      expect(loadResult).toContain("shared-");
    });
  });

  describe("No Webpack required", () => {
    it("should work without any webpack configuration", () => {
      // This test verifies that unlike vite-plugin-native,
      // we don't require webpack at all
      const plugin = nativeFilePlugin();

      expect(plugin).toBeDefined();
      expect(plugin.name).toBe("native-file-plugin");

      // Plugin should have all necessary hooks without webpack
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.load).toBeDefined();
      expect(plugin.transform).toBeDefined();
      expect(plugin.generateBundle).toBeDefined();
    });

    it("should handle all operations without bundling", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.generateBundle).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "addon.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("native code"));

      const emittedFiles: any[] = [];
      const mockContext = {
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-id";
        },
      };

      const importerPath = path.join(tempDir, "index.js");

      // Resolve the module
      await (plugin.resolveId as any).call(
        mockContext,
        "./addon.node",
        importerPath,
        {}
      );

      // Generate bundle (emit files)
      (plugin.generateBundle as any).call(mockContext, {}, {});

      // Verify file was emitted directly without any bundling
      expect(emittedFiles.length).toBe(1);
      expect(emittedFiles[0].type).toBe("asset");
      expect(emittedFiles[0].source).toBeInstanceOf(Buffer);
    });
  });
});
