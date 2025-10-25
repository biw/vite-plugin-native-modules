import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { nativeFilePlugin } from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
      expect(plugin.name).toBe("native-file-plugin");
    });

    it("should accept options parameter", () => {
      const plugin = nativeFilePlugin({ forced: true });
      expect(plugin).toBeDefined();
      expect(plugin.name).toBe("native-file-plugin");
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

      const result = (plugin.transform as any).call({} as any, code, id);

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

      const result = (plugin.transform as any).call({} as any, code, id);

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

      const result = (plugin.transform as any).call({} as any, code, id);

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

      const result = (plugin.transform as any).call({} as any, code, id);
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

      const result = (plugin.transform as any).call({} as any, code, id);
      expect(result).toBeNull();
    });
  });

  describe("Module Loading", () => {
    it("should load virtual modules with proper require code", async () => {
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
      expect(loadResult).toContain("createRequire");
      expect(loadResult).toContain("module.exports");
      expect(loadResult).toContain("require(");
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
});
