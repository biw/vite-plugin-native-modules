import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nativeFilePlugin from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import crypto from "node:crypto";
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

      expect(result).not.toBeNull();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node-macos");
      expect(result.code).not.toBe(code);
    });

    it("should match additional native files for Windows-style importer paths", () => {
      const plugin = nativeFilePlugin({
        forced: true,
        additionalNativeFiles: [
          {
            package: "test-native-pkg",
            fileNames: ["addon.node-macos"],
          },
        ],
      }) as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      const pkgDir = path.join(tempDir, "node_modules", "test-native-pkg");
      const nativeFile = path.join(pkgDir, "build", "addon.node-macos");
      fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
      fs.writeFileSync(nativeFile, Buffer.from("windows path binary"));

      const windowsStyleImporter = path
        .join(pkgDir, "lib", "index.js")
        .replace(/\//g, "\\");
      const code = `const addon = require(${JSON.stringify(nativeFile)});`;

      const context = { parse };
      const result = (plugin.transform as any).call(
        context,
        code,
        windowsStyleImporter
      );

      expect(result).not.toBeNull();
      expect(result.code).toContain("addon-");
      expect(result.code).toContain(".node-macos");
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

    it("should keep the CommonJS auto-interoperability marker internal", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
        build: {
          commonjsOptions: {
            requireReturnsDefault: "auto",
          },
        },
      });

      const nodeFilePath = path.join(tempDir, "test.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test"));
      const importerPath = path.join(tempDir, "index.js");

      const directVirtualId = await (plugin.resolveId as any).call(
        {} as any,
        "./test.node",
        importerPath,
        {}
      );
      const directLoadResult = await (plugin.load as any).call(
        {} as any,
        directVirtualId
      );

      expect(directLoadResult).not.toContain("__vitePluginNativeModule");

      const hashedFilename = directLoadResult.match(
        /__require\('\.\/([^']+\.node)'\)/
      )?.[1];
      expect(hashedFilename).toBeDefined();

      const requireResolution = await (plugin.resolveId as any).call(
        {} as any,
        `./${hashedFilename}?native-require=${crypto
          .createHash("sha256")
          .update(nodeFilePath)
          .digest("hex")}`,
        importerPath,
        {}
      );
      const requireVirtualId =
        typeof requireResolution === "object"
          ? requireResolution.id
          : requireResolution;
      const requireLoadResult = await (plugin.load as any).call(
        {} as any,
        requireVirtualId
      );

      expect(requireVirtualId).toContain("?native-require");
      expect(requireLoadResult).toContain(
        "export const __vitePluginNativeModule = true;"
      );
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

      // Rollup input remains ESM so syntheticNamedExports has a concrete default export.
      // Rollup lowers this wrapper to CommonJS in the generated output.
      expect(loadResult).toContain("export default nativeModule");
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
    const writeEmittedFiles = (outputDirectory: string, files: any[]) => {
      fs.mkdirSync(outputDirectory, { recursive: true });
      files.forEach((file) => {
        fs.writeFileSync(path.join(outputDirectory, file.fileName), file.source);
      });
    };

    const createWatchHarness = async ({
      projectRoot = path.join(tempDir, "project"),
      outputDirectory = path.join(projectRoot, "dist"),
      emptyOutDir = false as boolean | null,
      configuredOutDirs,
    }: {
      projectRoot?: string;
      outputDirectory?: string;
      emptyOutDir?: boolean | null;
      configuredOutDirs?: string[];
    } = {}) => {
      const plugin = nativeFilePlugin() as Plugin;
      const nodeFilePath = path.join(projectRoot, "watch.node");
      const importerPath = path.join(projectRoot, "index.js");

      fs.mkdirSync(projectRoot, { recursive: true });
      fs.writeFileSync(nodeFilePath, Buffer.from("watch native module"));

      (plugin.configResolved as any)({
        command: "build",
        mode: "development",
        root: projectRoot,
        build: {
          emptyOutDir,
          outDir: outputDirectory,
          rollupOptions: configuredOutDirs
            ? {
                output: configuredOutDirs.map((dir) => ({ dir })),
              }
            : undefined,
        },
      });
      await (plugin.resolveId as any).call(
        {},
        "./watch.node",
        importerPath,
        {}
      );

      const createContext = (emittedFiles: any[], watchMode = true) => ({
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-reference-id";
        },
        meta: { watchMode },
      });
      const startBuild = (context: any = {}) =>
        (plugin.buildStart as any).call(context, {});
      const generate = (
        context: any,
        output = outputDirectory,
        isWrite = true
      ) =>
        (plugin.generateBundle as any).call(
          context,
          { dir: output },
          {},
          isWrite
        );

      return {
        plugin,
        outputDirectory,
        createContext,
        startBuild,
        generate,
      };
    };

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

    it.each([
      { watchMode: true, emptyOutDir: false, isWrite: true, expectedEmits: 1 },
      { watchMode: true, emptyOutDir: true, isWrite: true, expectedEmits: 2 },
      { watchMode: false, emptyOutDir: false, isWrite: true, expectedEmits: 2 },
      { watchMode: true, emptyOutDir: false, isWrite: false, expectedEmits: 2 },
    ])(
      "should only suppress re-emits when watchMode=$watchMode, emptyOutDir=$emptyOutDir, and isWrite=$isWrite",
      async ({ watchMode, emptyOutDir, isWrite, expectedEmits }) => {
        const emittedFiles: any[] = [];
        const harness = await createWatchHarness({ emptyOutDir });
        const context = harness.createContext(emittedFiles, watchMode);

        harness.startBuild(context);
        harness.generate(context, harness.outputDirectory, isWrite);
        expect(emittedFiles).toHaveLength(1);
        if (isWrite) {
          writeEmittedFiles(harness.outputDirectory, emittedFiles);
        }

        harness.startBuild(context);
        harness.generate(context, harness.outputDirectory, isWrite);
        expect(emittedFiles).toHaveLength(expectedEmits);
      }
    );

    it("should emit once per output directory across watch rebuilds", async () => {
      const harness = await createWatchHarness();
      const outputDirectories = [
        path.join(tempDir, "project", "dist-es"),
        path.join(tempDir, "project", "dist-cjs"),
      ];
      const emissions = new Map<string, any[]>();

      const generateFor = (outputDirectory: string) => {
        const emittedFiles = emissions.get(outputDirectory) ?? [];
        emissions.set(outputDirectory, emittedFiles);
        const context = harness.createContext(emittedFiles);

        harness.generate(context, outputDirectory);
        writeEmittedFiles(outputDirectory, emittedFiles);
      };

      // Rollup invokes generateBundle once per output during the initial build.
      harness.startBuild();
      outputDirectories.forEach(generateFor);

      expect(emissions.get(outputDirectories[0])).toHaveLength(1);
      expect(emissions.get(outputDirectories[1])).toHaveLength(1);

      // Subsequent watch builds should reuse each output's existing native file.
      harness.startBuild();
      outputDirectories.forEach(generateFor);

      expect(emissions.get(outputDirectories[0])).toHaveLength(1);
      expect(emissions.get(outputDirectories[1])).toHaveLength(1);
    });

    it("should retry native asset emission after a failed watch build", async () => {
      const harness = await createWatchHarness();
      const emittedFiles: any[] = [];
      const context = harness.createContext(emittedFiles);

      // Simulate a build that fails after generateBundle but before output write.
      harness.startBuild(context);
      harness.generate(context);
      expect(emittedFiles).toHaveLength(1);

      // The recovery build must schedule the asset again.
      harness.startBuild(context);
      harness.generate(context);
      expect(emittedFiles).toHaveLength(2);
      writeEmittedFiles(harness.outputDirectory, emittedFiles.slice(-1));

      // Once a write succeeds, later rebuilds can reuse the on-disk asset.
      harness.startBuild(context);
      harness.generate(context);
      expect(emittedFiles).toHaveLength(2);
    });

    it("should retry when a same-directory sibling output succeeds without the asset", async () => {
      const harness = await createWatchHarness();
      const emissions = [[], [], []] as any[][];
      const contexts = emissions.map((files) => harness.createContext(files));

      harness.startBuild(contexts[0]);
      harness.generate(contexts[0]);
      harness.generate(contexts[1]);

      expect(emissions[0]).toHaveLength(1);
      expect(emissions[1]).toHaveLength(0);

      // The output that scheduled the asset fails, while its sibling completes.
      (harness.plugin.writeBundle as any)?.call(
        contexts[1],
        { dir: harness.outputDirectory },
        {}
      );

      harness.startBuild(contexts[2]);
      harness.generate(contexts[2]);

      expect(emissions[2]).toHaveLength(1);
    });

    it("should re-emit a native asset removed between watch builds", async () => {
      const harness = await createWatchHarness();
      const emittedFiles: any[] = [];
      const context = harness.createContext(emittedFiles);

      harness.startBuild(context);
      harness.generate(context);
      writeEmittedFiles(harness.outputDirectory, emittedFiles);

      harness.startBuild(context);
      harness.generate(context);
      expect(emittedFiles).toHaveLength(1);

      fs.rmSync(
        path.join(harness.outputDirectory, emittedFiles[0].fileName)
      );

      harness.startBuild(context);
      harness.generate(context);
      expect(emittedFiles).toHaveLength(2);
    });

    it.each([
      {
        condition: "truncated",
        corrupt: (source: Buffer) => source.subarray(0, source.length - 1),
      },
      {
        condition: "same-size corrupt",
        corrupt: (source: Buffer) => Buffer.alloc(source.length),
      },
    ])(
      "should replace a $condition native asset on the next watch build",
      async ({ corrupt }) => {
        const harness = await createWatchHarness();
        const emittedFiles: any[] = [];
        const context = harness.createContext(emittedFiles);

        harness.startBuild(context);
        harness.generate(context);
        expect(emittedFiles).toHaveLength(1);

        const emittedFile = emittedFiles[0];
        fs.mkdirSync(harness.outputDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(harness.outputDirectory, emittedFile.fileName),
          corrupt(emittedFile.source)
        );

        harness.startBuild(context);
        harness.generate(context);
        expect(emittedFiles).toHaveLength(2);
      }
    );

    it("should reuse an existing native asset after watcher restart", async () => {
      const firstEmissions: any[] = [];
      const firstWatcher = await createWatchHarness();
      const firstContext = firstWatcher.createContext(firstEmissions);

      firstWatcher.startBuild(firstContext);
      firstWatcher.generate(firstContext);
      writeEmittedFiles(firstWatcher.outputDirectory, firstEmissions);

      const restartedEmissions: any[] = [];
      const restartedWatcher = await createWatchHarness();
      const restartedContext =
        restartedWatcher.createContext(restartedEmissions);

      restartedWatcher.startBuild(restartedContext);
      restartedWatcher.generate(restartedContext);

      expect(restartedEmissions).toHaveLength(0);
    });

    it.each([
      {
        location: "inside the project root",
        relativeOutDir: "dist",
        expectedEmits: 2,
      },
      {
        location: "outside the project root",
        relativeOutDir: "../dist-outside-root",
        expectedEmits: 1,
      },
      {
        location: "inside root when another output is outside root",
        relativeOutDir: "dist",
        configuredOutDirs: ["dist", "../dist-outside-root"],
        expectedEmits: 1,
      },
    ])(
      "should follow Vite's emptyOutDir default for output $location",
      async ({ relativeOutDir, configuredOutDirs, expectedEmits }) => {
        const projectRoot = path.join(tempDir, "project");
        const outputDirectory = path.resolve(projectRoot, relativeOutDir);
        const emittedFiles: any[] = [];
        const harness = await createWatchHarness({
          projectRoot,
          outputDirectory,
          emptyOutDir: null,
          configuredOutDirs,
        });
        const context = harness.createContext(emittedFiles);

        // Vite exposes null in configResolved, then treats it as true only
        // when every configured output is inside the project root.
        harness.startBuild(context);
        harness.generate(context);
        writeEmittedFiles(outputDirectory, emittedFiles);
        harness.startBuild(context);
        harness.generate(context);

        expect(emittedFiles).toHaveLength(expectedEmits);
      }
    );
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

    it("should emit identical hash-only native files once", async () => {
      const emittedFiles: any[] = [];
      const plugin = nativeFilePlugin({ filenameFormat: "hash-only" }) as Plugin;
      (plugin.configResolved as any)({ command: "build", mode: "production" });

      const firstNativeFile = path.join(tempDir, "first.node");
      const secondNativeFile = path.join(tempDir, "second.node");
      const content = Buffer.from("shared native binary");
      fs.writeFileSync(firstNativeFile, content);
      fs.writeFileSync(secondNativeFile, content);

      const importerPath = path.join(tempDir, "index.js");
      await (plugin.resolveId as any).call({}, "./first.node", importerPath, {});
      await (plugin.resolveId as any).call({}, "./second.node", importerPath, {});

      const mockContext = {
        emitFile: (file: any) => {
          emittedFiles.push(file);
          return "mock-reference-id";
        },
      };
      (plugin.generateBundle as any).call(mockContext, {}, {}, false);

      expect(emittedFiles).toHaveLength(1);
      expect(emittedFiles[0].source).toEqual(content);
    });

    it("should reject an output-name collision with different contents", async () => {
      const plugin = nativeFilePlugin({ filenameFormat: "hash-only" }) as Plugin;
      (plugin.configResolved as any)({ command: "build", mode: "production" });

      // These distinct strings share the same first eight MD5 hex characters,
      // which is the hash length used in emitted native filenames.
      const firstContent = Buffer.from("collision-83147");
      const secondContent = Buffer.from("collision-143822");
      expect(crypto.createHash("md5").update(firstContent).digest("hex").slice(0, 8)).toBe(
        crypto.createHash("md5").update(secondContent).digest("hex").slice(0, 8)
      );

      fs.writeFileSync(path.join(tempDir, "first.node"), firstContent);
      fs.writeFileSync(path.join(tempDir, "second.node"), secondContent);
      const importerPath = path.join(tempDir, "index.js");
      await (plugin.resolveId as any).call({}, "./first.node", importerPath, {});
      await (plugin.resolveId as any).call({}, "./second.node", importerPath, {});

      const mockContext = {
        emitFile: () => "mock-reference-id",
      };

      expect(() =>
        (plugin.generateBundle as any).call(mockContext, {}, {}, false)
      ).toThrow(
        "Native files produced the same output name with different contents: 94141742.node"
      );
    });
  });
});
