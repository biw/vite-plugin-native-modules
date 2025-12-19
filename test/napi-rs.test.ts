import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nativeFilePlugin from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as acornParse } from "acorn";

// Wrapper to provide the same parse signature as Rollup
const parse = (code: string) =>
  acornParse(code, { ecmaVersion: "latest", sourceType: "module" });

/**
 * Tests for NAPI-RS auto-generated loader support
 *
 * NAPI-RS generates native module loaders with a pattern like:
 *   const { existsSync } = require('fs')
 *   const { join } = require('path')
 *   localFileExisted = existsSync(join(__dirname, 'libsql.darwin-arm64.node'))
 *   if (localFileExisted) {
 *     nativeBinding = require('./libsql.darwin-arm64.node')
 *   } else {
 *     nativeBinding = require('@libsql/darwin-arm64')
 *   }
 *
 * This plugin detects these patterns and rewrites BOTH the existsSync path
 * AND the require path to use the hashed filename.
 */
describe("NAPI-RS Support", () => {
  let tempDir: string;
  const platform = process.platform;
  const arch = process.arch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "napi-rs-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("join(__dirname, 'xxx.node') pattern", () => {
    it("should rewrite .node path in join() calls", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // Code that uses join(__dirname, 'xxx.node')
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { join } = require('path');
        const filePath = join(__dirname, '${nodeFileName}');
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain(".node");
      // Should contain hashed filename (uppercase hash)
      // Format: libsql.{platform}-{arch}-{HASH}.node
      expect(result.code).toMatch(/libsql\.[a-z]+-[a-z0-9]+-[A-F0-9]+\.node/);
      // Should NOT contain original unhashed filename
      expect(result.code).not.toContain(`'${nodeFileName}'`);
    });

    it("should rewrite path in existsSync(join(__dirname, 'xxx.node'))", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // Code that uses existsSync with join
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { existsSync } = require('fs');
        const { join } = require('path');
        const exists = existsSync(join(__dirname, '${nodeFileName}'));
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toContain(".node");
      // Should contain hashed filename
      expect(result.code).toMatch(/libsql\.[a-z]+-[a-z0-9]+-[A-F0-9]+\.node/);
    });

    it("should use consistent hash for same file", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // Code that references the same file twice
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { join } = require('path');
        const path1 = join(__dirname, '${nodeFileName}');
        const path2 = join(__dirname, '${nodeFileName}');
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      // Extract all hashed filenames from the result
      const matches = result.code.match(/libsql\.[a-z]+-[a-z0-9]+-[A-F0-9]+\.node/g);
      expect(matches).toBeDefined();
      expect(matches!.length).toBe(2);
      // Both should have the same hash
      expect(matches![0]).toBe(matches![1]);
    });
  });

  describe("Coordinated rewriting", () => {
    it("should rewrite BOTH existsSync path AND require path with same hash", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // The actual NAPI-RS pattern
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { existsSync } = require('fs');
        const { join } = require('path');

        let nativeBinding;
        const localFileExisted = existsSync(join(__dirname, '${nodeFileName}'));
        if (localFileExisted) {
          nativeBinding = require('./${nodeFileName}');
        } else {
          nativeBinding = require('@libsql/${platform}-${arch}');
        }

        module.exports = nativeBinding;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();

      // Extract hashed filename from existsSync path (in join call)
      const joinMatch = result.code.match(/join\(__dirname,\s*['"]([^'"]+)['"]\)/);
      expect(joinMatch).toBeDefined();
      const joinFilename = joinMatch![1];

      // Extract hashed filename from require call
      const requireMatch = result.code.match(/require\(['"]\.\/([^'"]+)['"]\)/);
      expect(requireMatch).toBeDefined();
      const requireFilename = requireMatch![1];

      // CRITICAL: Both must use the SAME hashed filename
      expect(joinFilename).toBe(requireFilename);

      // Both should be hashed (contain uppercase hex)
      expect(joinFilename).toMatch(/[A-F0-9]{8}/);
      expect(requireFilename).toMatch(/[A-F0-9]{8}/);
    });
  });

  describe("Real-world libsql structure", () => {
    it("should handle complete NAPI-RS loader code", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file for the current platform
      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding content"));

      // Simplified NAPI-RS loader pattern (like libsql-js)
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { existsSync } = require('fs');
        const { join } = require('path');

        let nativeBinding;
        let loadError;

        switch (process.platform) {
          case '${platform}':
            switch (process.arch) {
              case '${arch}':
                const localFileExisted = existsSync(join(__dirname, '${nodeFileName}'));
                try {
                  if (localFileExisted) {
                    nativeBinding = require('./${nodeFileName}');
                  } else {
                    nativeBinding = require('@libsql/${platform}-${arch}');
                  }
                } catch (e) {
                  loadError = e;
                }
                break;
              default:
                throw new Error('Unsupported architecture');
            }
            break;
          default:
            throw new Error('Unsupported platform');
        }

        if (!nativeBinding) {
          throw loadError || new Error('Failed to load native binding');
        }

        module.exports.Database = nativeBinding.Database;
        module.exports.Statement = nativeBinding.Statement;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should have rewritten the .node references
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);

      // Original unhashed filename should not appear
      expect(result.code).not.toContain(`'${nodeFileName}'`);
      expect(result.code).not.toContain(`"./${nodeFileName}"`);

      // The npm package fallback should remain unchanged
      expect(result.code).toContain(`@libsql/${platform}-${arch}`);
    });

    it("should only bundle .node files that exist for current platform", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create .node file ONLY for current platform
      const currentPlatformFile = `libsql.${platform}-${arch}.node`;
      fs.writeFileSync(
        path.join(tempDir, currentPlatformFile),
        Buffer.from("current platform binding")
      );

      // Also create a file for a different platform that should NOT be processed
      const otherPlatformFile = "libsql.other-platform.node";
      // Don't create this file - it shouldn't exist

      // Code references current platform (which exists) and other platform (which doesn't)
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { existsSync } = require('fs');
        const { join } = require('path');

        let nativeBinding;

        // Current platform - file exists
        if (existsSync(join(__dirname, '${currentPlatformFile}'))) {
          nativeBinding = require('./${currentPlatformFile}');
        }
        // Other platform - file does NOT exist
        else if (existsSync(join(__dirname, '${otherPlatformFile}'))) {
          nativeBinding = require('./${otherPlatformFile}');
        }

        module.exports = nativeBinding;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Only the current platform's file should be hashed (it exists)
      // Other platforms' files should remain unchanged (they don't exist)
      const hashedPattern = /[A-F0-9]{8}\.node/g;
      const hashedMatches = result.code.match(hashedPattern) || [];

      // Should have hashed references for the file that exists (appears twice in code)
      expect(hashedMatches.length).toBe(2);

      // The other platform file should remain unchanged (not hashed)
      expect(result.code).toContain(otherPlatformFile);
    });
  });

  describe("ES module context", () => {
    it("should handle NAPI-RS pattern in ESM files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // ESM version of NAPI-RS pattern
      const jsFilePath = path.join(tempDir, "index.mjs");
      const code = `
        import { existsSync } from 'fs';
        import { join, dirname } from 'path';
        import { fileURLToPath } from 'url';
        import { createRequire } from 'module';

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const require = createRequire(import.meta.url);

        let nativeBinding;
        const localFileExisted = existsSync(join(__dirname, '${nodeFileName}'));
        if (localFileExisted) {
          nativeBinding = require('./${nodeFileName}');
        }

        export const Database = nativeBinding?.Database;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();

      // Should have rewritten the .node references with hash
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
    });
  });

  describe("path.join variant patterns", () => {
    it("should handle path.join(__dirname, 'xxx.node') pattern", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `binding.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // Code using path.join (not destructured)
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const path = require('path');
        const fs = require('fs');
        const exists = fs.existsSync(path.join(__dirname, '${nodeFileName}'));
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
    });

    it("should handle imported path module with alias", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFileName = `binding.node`;
      const nodeFilePath = path.join(tempDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding"));

      // Code using aliased path import
      const jsFilePath = path.join(tempDir, "index.mjs");
      const code = `
        import nodePath from 'path';
        import { existsSync } from 'fs';
        const exists = existsSync(nodePath.join(__dirname, '${nodeFileName}'));
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
    });
  });

  describe("Platform-specific npm package require pattern", () => {
    it("should detect and rewrite require('@scope/platform-arch') with .node file", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a mock npm package structure with a .node file
      // node_modules/@libsql/darwin-arm64/libsql.darwin-arm64.node
      const scopeDir = path.join(tempDir, "node_modules", "@libsql");
      const packageDir = path.join(scopeDir, `${platform}-${arch}`);
      fs.mkdirSync(packageDir, { recursive: true });

      const nodeFileName = `libsql.${platform}-${arch}.node`;
      const nodeFilePath = path.join(packageDir, nodeFileName);
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding from npm"));

      // Create package.json pointing to the .node file
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: `@libsql/${platform}-${arch}`, main: nodeFileName })
      );

      // The NAPI-RS loader code that uses the npm package fallback
      const jsFilePath = path.join(tempDir, "node_modules", "libsql", "index.js");
      fs.mkdirSync(path.dirname(jsFilePath), { recursive: true });
      const code = `
        const { existsSync } = require('fs');
        const { join } = require('path');

        let nativeBinding;
        const localFileExisted = existsSync(join(__dirname, '${nodeFileName}'));
        if (localFileExisted) {
          nativeBinding = require('./${nodeFileName}');
        } else {
          nativeBinding = require('@libsql/${platform}-${arch}');
        }

        module.exports = nativeBinding;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // The npm package require should be rewritten with hashed filename
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
      // Original package name should be replaced
      expect(result.code).not.toContain(`require('@libsql/${platform}-${arch}')`);
    });

    it("should handle require('@scope/package') that resolves to .node file", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a simpler package structure
      const packageDir = path.join(tempDir, "node_modules", "@test", "native");
      fs.mkdirSync(packageDir, { recursive: true });

      const nodeFilePath = path.join(packageDir, "binding.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("test native binding"));

      // Package.json with main pointing to the .node file
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "@test/native", main: "binding.node" })
      );

      // Code that requires the package (include .node reference to trigger transform)
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        // This package exports a .node binding
        const native = require('@test/native');
        module.exports = native;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should be rewritten to use hashed filename
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
    });

    it("should handle package with index.node as entry point", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create package with index.node
      const packageDir = path.join(tempDir, "node_modules", "native-addon");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(
        path.join(packageDir, "index.node"),
        Buffer.from("index native binding")
      );

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon" })
        // No main field - should default to index.node
      );

      const jsFilePath = path.join(tempDir, "index.js");
      // Include .node reference to trigger transform
      const code = `
        // Load native .node addon
        const addon = require('native-addon');
        module.exports = addon;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should be rewritten to use hashed filename
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
    });

    it("should NOT rewrite require for packages without .node files", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a normal JS package (no .node file)
      const packageDir = path.join(tempDir, "node_modules", "regular-package");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(
        path.join(packageDir, "index.js"),
        "module.exports = { foo: 'bar' };"
      );

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "regular-package", main: "index.js" })
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const pkg = require('regular-package');
        module.exports = pkg;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should return null (no transformation) or code unchanged
      if (result) {
        expect(result.code).toContain("require('regular-package')");
        expect(result.code).not.toMatch(/[A-F0-9]{8}\.node/);
      }
    });
  });
});
