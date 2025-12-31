import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nativeFilePlugin from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as acornParse } from "acorn";

// Wrapper to provide the same parse signature as Rollup
const parse = (code: string) => acornParse(code, { ecmaVersion: "latest" });

describe("nativeFilePlugin", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vite-plugin-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Plugin Configuration", () => {
    it("should return a plugin with correct name", () => {
      const plugin = nativeFilePlugin();
      expect(plugin.name).toBe("plugin-native-modules");
    });

    it("should accept options parameter", () => {
      const plugin = nativeFilePlugin({ forced: true });
      expect(plugin).toBeDefined();
      expect(plugin.name).toBe("plugin-native-modules");
    });

    it("should have required plugin hooks", () => {
      const plugin = nativeFilePlugin();
      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.load).toBeDefined();
      expect(plugin.transform).toBeDefined();
      expect(plugin.generateBundle).toBeDefined();
    });
  });

  describe("File Resolution", () => {
    it("should resolve .node files in build mode", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      // Simulate config resolution for build mode
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a test .node file
      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test native module"));

      const importerPath = path.join(tempDir, "index.js");

      // Call resolveId
      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain("\0native:");
    });

    it("should ignore non-.node files", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./test.js",
        "/fake/path/index.js",
        {}
      );

      expect(result).toBeNull();
    });

    it("should ignore missing .node files", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const importerPath = path.join(tempDir, "index.js");

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./nonexistent.node",
        importerPath,
        {}
      );

      expect(result).toBeNull();
    });

    it("should return null when no importer is provided", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        undefined,
        {}
      );

      expect(result).toBeNull();
    });

    it("should not process files in dev mode by default", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "serve",
        mode: "development",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const importerPath = path.join(tempDir, "index.js");

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(result).toBeNull();
    });

    it("should process files in dev mode when forced", async () => {
      const plugin = nativeFilePlugin({ forced: true }) as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "serve",
        mode: "development",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const importerPath = path.join(tempDir, "index.js");

      const result = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(result).toBeDefined();
      expect(result).toContain("\0native:");
    });
  });

  describe("Content Hashing", () => {
    it("should generate consistent hash for same content", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test native module content"));

      const importerPath = path.join(tempDir, "index.js");

      const result1 = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      const result2 = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(result1).toBe(result2);
    });

    it("should generate different hash for different content", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath1 = path.join(tempDir, "test1.node");
      fs.writeFileSync(nodeFilePath1, Buffer.from("content one"));

      const nodeFilePath2 = path.join(tempDir, "test2.node");
      fs.writeFileSync(nodeFilePath2, Buffer.from("content two"));

      const importerPath = path.join(tempDir, "index.js");

      const result1 = await (plugin.resolveId as any).call(
        {} as any,
        "./test1.node",
        importerPath,
        {}
      );

      const result2 = await (plugin.resolveId as any).call(
        {} as any,
        "./test2.node",
        importerPath,
        {}
      );

      expect(result1).not.toBe(result2);
    });

    it("should create hash with uppercase format", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.load).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const importerPath = path.join(tempDir, "index.js");

      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(virtualId).toBeDefined();
      expect(typeof virtualId).toBe("string");

      const loadResult = await (plugin.load as any).call({} as any, virtualId);

      expect(loadResult).toBeDefined();
      expect(loadResult).toContain("-");
      // Hash should be uppercase
      expect(loadResult).toMatch(/test-[A-F0-9]{8}\.node/);
    });
  });

  describe("Code Transformation", () => {
    it("should transform require() calls with .node files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "addon.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("native addon"));

      const code = `const addon = require("./addon.node");`;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);

      expect(result).toBeDefined();
      expect(result.code).toContain("./addon-");
      expect(result.code).toContain(".node");
      expect(result.code).not.toBe(code);
    });

    it("should handle multiple require() calls", () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFile1 = path.join(tempDir, "addon1.node");
      const nodeFile2 = path.join(tempDir, "addon2.node");
      fs.writeFileSync(nodeFile1, Buffer.from("addon 1"));
      fs.writeFileSync(nodeFile2, Buffer.from("addon 2"));

      const code = `
        const addon1 = require("./addon1.node");
        const addon2 = require("./addon2.node");
      `;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon1-");
      expect(result.code).toContain("addon2-");
    });

    it("should handle different require variants", () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "addon.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("addon"));

      const code = `
        const addon1 = require("./addon.node");
        const addon2 = _require("./addon.node");
      `;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
    });

    it("should not transform code without .node files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const code = `const fs = require("fs");`;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);
      expect(result).toBeNull();
    });

    it("should not transform non-existent .node files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const code = `const addon = require("./nonexistent.node");`;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);
      expect(result).toBeNull();
    });
  });

  describe("Additional Native Files", () => {
    it("should handle custom file extensions with additionalNativeFiles config", () => {
      const plugin = nativeFilePlugin({
        forced: true,
        additionalNativeFiles: [
          {
            package: "test-native-pkg",
            fileNames: ["addon.node-macos", "addon.node-linux"],
          },
        ],
      }) as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.transform).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a package structure
      const pkgDir = path.join(tempDir, "node_modules", "test-native-pkg");
      fs.mkdirSync(path.join(pkgDir, "build"), { recursive: true });

      const nodeFileMac = path.join(pkgDir, "build", "addon.node-macos");
      fs.writeFileSync(nodeFileMac, Buffer.from("macos binary"));

      const jsFile = path.join(pkgDir, "lib", "index.js");
      fs.mkdirSync(path.dirname(jsFile), { recursive: true });

      const code = `const addon = require("../build/addon.node-macos");`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFile);

      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node-macos");
      expect(result.code).not.toBe(code);
    });

    it("should only process files for configured packages", () => {
      const plugin = nativeFilePlugin({
        forced: true,
        additionalNativeFiles: [
          {
            package: "specific-package",
            fileNames: ["custom.node-file"],
          },
        ],
      }) as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create file in a different package
      const otherPkgDir = path.join(tempDir, "node_modules", "other-package");
      fs.mkdirSync(otherPkgDir, { recursive: true });

      const customFile = path.join(otherPkgDir, "custom.node-file");
      fs.writeFileSync(customFile, Buffer.from("custom binary"));

      const jsFile = path.join(otherPkgDir, "index.js");
      const code = `const addon = require("./custom.node-file");`;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFile);

      // Should not transform because it's not in the configured package
      expect(result).toBeNull();
    });

    it("should still auto-detect .node files without configuration", () => {
      const plugin = nativeFilePlugin({
        forced: true,
        additionalNativeFiles: [
          {
            package: "some-package",
            fileNames: ["custom.node-file"],
          },
        ],
      }) as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFile = path.join(tempDir, "addon.node");
      fs.writeFileSync(nodeFile, Buffer.from("standard addon"));

      const code = `const addon = require("./addon.node");`;
      const id = path.join(tempDir, "index.js");

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, id);

      // Should still process standard .node files
      expect(result).toBeDefined();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node");
    });

    it("should handle multiple packages with different file names", () => {
      const plugin = nativeFilePlugin({
        forced: true,
        additionalNativeFiles: [
          {
            package: "package-a",
            fileNames: ["addon.node-darwin"],
          },
          {
            package: "package-b",
            fileNames: ["binding.node-x64"],
          },
        ],
      }) as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create package A
      const pkgADir = path.join(tempDir, "node_modules", "package-a");
      fs.mkdirSync(pkgADir, { recursive: true });
      const fileA = path.join(pkgADir, "addon.node-darwin");
      fs.writeFileSync(fileA, Buffer.from("package a"));
      const jsFileA = path.join(pkgADir, "index.js");
      const codeA = `const addon = require("./addon.node-darwin");`;

      // Create package B
      const pkgBDir = path.join(tempDir, "node_modules", "package-b");
      fs.mkdirSync(pkgBDir, { recursive: true });
      const fileB = path.join(pkgBDir, "binding.node-x64");
      fs.writeFileSync(fileB, Buffer.from("package b"));
      const jsFileB = path.join(pkgBDir, "index.js");
      const codeB = `const binding = require("./binding.node-x64");`;

      const context = { parse };
      const resultA = (plugin.transform as any).call(context, codeA, jsFileA);
      const resultB = (plugin.transform as any).call(context, codeB, jsFileB);

      expect(resultA).toBeDefined();
      expect(resultA.code).toContain("addon-");
      expect(resultA.code).toContain(".node-darwin");

      expect(resultB).toBeDefined();
      expect(resultB.code).toContain("binding-");
      expect(resultB.code).toContain(".node-x64");
    });
  });

  describe("Module Loading", () => {
    it("should load virtual modules with ESM code by default", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.load).toBeDefined();

      // Default config - no output format specified, defaults to ESM
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const importerPath = path.join(tempDir, "index.js");

      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(virtualId).toBeDefined();
      expect(typeof virtualId).toBe("string");

      const loadResult = await (plugin.load as any).call({} as any, virtualId);

      expect(loadResult).toBeDefined();
      // Default output format is ESM, so should use ESM syntax regardless of importer
      expect(loadResult).toContain("import { createRequire }");
      expect(loadResult).toContain("export default");
      expect(loadResult).toContain("import.meta.url");
      expect(loadResult).not.toContain("module.exports");

      // Test with .mjs importer - should also use ESM (same default behavior)
      const esmImporterPath = path.join(tempDir, "index.mjs");
      const esmVirtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        esmImporterPath,
        {}
      );
      const esmLoadResult = await (plugin.load as any).call({} as any, esmVirtualId);
      expect(esmLoadResult).toBeDefined();
      expect(esmLoadResult).toContain("import { createRequire }");
      expect(esmLoadResult).toContain("export default");
      expect(esmLoadResult).toContain("import.meta.url");
    });

    it("should return null for non-virtual modules", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      expect(plugin.load).toBeDefined();

      const result = await (plugin.load as any).call(
        {} as any,
        "/some/normal/file.js"
      );
      expect(result).toBeNull();
    });

    it("should default to ESM output format", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      // Default config - defaults to ESM output
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const importerPath = path.join(tempDir, "unknown.js");
      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );

      expect(virtualId).toBeDefined();

      const loadResult = await (plugin.load as any).call({} as any, virtualId);
      expect(loadResult).toBeDefined();

      // Default output format is ESM
      expect(loadResult).toContain("import { createRequire }");
      expect(loadResult).toContain("export default");
      expect(loadResult).toContain("import.meta.url");
      expect(loadResult).not.toContain("module.exports");
    });

    it("should use CJS output when explicitly configured", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      // Explicit CJS output format
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
        build: {
          rollupOptions: {
            output: {
              format: "cjs",
            },
          },
        },
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const cjsFilePath = path.join(tempDir, "index.js");
      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        cjsFilePath,
        {}
      );

      const loadResult = await (plugin.load as any).call({} as any, virtualId);

      // CJS output format should generate CommonJS syntax
      expect(loadResult).toContain("module.exports");
      expect(loadResult).toContain("require(");
      expect(loadResult).not.toContain("import { createRequire }");
      expect(loadResult).not.toContain("import.meta.url");
    });

    it("should not mix module.exports with export default in load hook output", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));

      const esmFilePath = path.join(tempDir, "index.mjs");
      const virtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        esmFilePath,
        {}
      );

      const loadResult = await (plugin.load as any).call({} as any, virtualId);
      
      // Should NOT have both module.exports and export default
      const hasModuleExports = loadResult.includes("module.exports");
      const hasExportDefault = loadResult.includes("export default");
      
      if (hasExportDefault) {
        expect(hasModuleExports).toBe(false);
      }
    });
  });

  describe("Bundle Generation", () => {
    it("should emit .node files during bundle generation", async () => {
      const plugin = nativeFilePlugin() as Plugin;
      const emittedFiles: any[] = [];

      expect(plugin.configResolved).toBeDefined();
      expect(plugin.resolveId).toBeDefined();
      expect(plugin.generateBundle).toBeDefined();

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      const testContent = Buffer.from("test native module");
      fs.writeFileSync(nodeFilePath, testContent);

      const importerPath = path.join(tempDir, "index.js");

      const mockContext = {
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-reference-id";
        },
      };

      // Resolve to populate internal map
      await (plugin.resolveId as any).call(
        mockContext,
        "./test.node",
        importerPath,
        {}
      );

      // Generate bundle
      (plugin.generateBundle as any).call(mockContext, {}, {}, false);

      expect(emittedFiles.length).toBeGreaterThan(0);
      expect(emittedFiles[0].type).toBe("asset");
      expect(emittedFiles[0].fileName).toContain(".node");
      expect(emittedFiles[0].fileName).toContain("-");
      expect(emittedFiles[0].source).toBeDefined();
      expect(Buffer.isBuffer(emittedFiles[0].source)).toBe(true);
    });
  });

  describe("Filename Format Options", () => {
    it("should use preserve format by default for direct .node imports", async () => {
      const emittedFiles: any[] = [];
      const plugin = nativeFilePlugin() as Plugin;
      (plugin.configResolved as any)({ command: "build", mode: "production" });

      const nodeFile = path.join(tempDir, "addon.node");
      fs.writeFileSync(nodeFile, Buffer.from("fake binary"));

      const importerPath = path.join(tempDir, "index.js");

      const mockContext = {
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-reference-id";
        },
      };

      // Resolve to populate internal map
      await (plugin.resolveId as any).call(
        mockContext,
        "./addon.node",
        importerPath,
        {}
      );

      // Generate bundle to emit files
      (plugin.generateBundle as any).call(mockContext, {}, {}, false);

      expect(emittedFiles.length).toBeGreaterThan(0);
      expect(emittedFiles[0].fileName).toMatch(/addon-[A-F0-9]{8}\.node/);
    });

    it("should use hash-only format when specified for direct .node imports", async () => {
      const emittedFiles: any[] = [];
      const plugin = nativeFilePlugin({
        filenameFormat: "hash-only",
      }) as Plugin;
      (plugin.configResolved as any)({ command: "build", mode: "production" });

      const nodeFile = path.join(tempDir, "addon.node");
      fs.writeFileSync(nodeFile, Buffer.from("fake binary"));

      const importerPath = path.join(tempDir, "index.js");

      const mockContext = {
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-reference-id";
        },
      };

      // Resolve to populate internal map
      await (plugin.resolveId as any).call(
        mockContext,
        "./addon.node",
        importerPath,
        {}
      );

      // Generate bundle to emit files
      (plugin.generateBundle as any).call(mockContext, {}, {}, false);

      expect(emittedFiles.length).toBeGreaterThan(0);
      // Should be just hash.node, not addon-hash.node
      expect(emittedFiles[0].fileName).toMatch(/^[A-F0-9]{8}\.node$/);
      expect(emittedFiles[0].fileName).not.toContain("addon");
    });

    it("should use preserve format when explicitly set for direct .node imports", async () => {
      const emittedFiles: any[] = [];
      const plugin = nativeFilePlugin({
        filenameFormat: "preserve",
      }) as Plugin;
      (plugin.configResolved as any)({ command: "build", mode: "production" });

      const nodeFile = path.join(tempDir, "native.node");
      fs.writeFileSync(nodeFile, Buffer.from("fake binary"));

      const importerPath = path.join(tempDir, "index.js");

      const mockContext = {
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-reference-id";
        },
      };

      // Resolve to populate internal map
      await (plugin.resolveId as any).call(
        mockContext,
        "./native.node",
        importerPath,
        {}
      );

      // Generate bundle to emit files
      (plugin.generateBundle as any).call(mockContext, {}, {}, false);

      expect(emittedFiles.length).toBeGreaterThan(0);
      expect(emittedFiles[0].fileName).toMatch(/native-[A-F0-9]{8}\.node/);
    });
  });
});
