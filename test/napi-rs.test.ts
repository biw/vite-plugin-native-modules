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

  describe("Template literal require patterns (Pattern 8)", () => {
    it("should handle template literal require with scoped packages", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a scoped package with a .node file for current platform
      const nodeModulesDir = path.join(tempDir, "node_modules");
      const scopeDir = path.join(nodeModulesDir, "@libsql");
      const packageDir = path.join(scopeDir, `${platform}-${arch}`);
      fs.mkdirSync(packageDir, { recursive: true });

      // Create index.node file
      const nodeFilePath = path.join(packageDir, "index.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("platform native binding"));

      // Create package.json with main pointing to index.node
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: `@libsql/${platform}-${arch}`,
          main: "index.node",
        })
      );

      // Code uses template literal require like real libsql does
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { currentTarget } = require('@neon-rs/load');
        let target = currentTarget();
        const binding = require(\`@libsql/\${target}\`);
        module.exports = binding;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should have transformed the template literal to a hashed path
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);

      // Original template literal should be replaced
      expect(result.code).not.toContain("`@libsql/");
    });

    it("should find platform package by scanning scope directory", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a package with slightly different naming convention
      const nodeModulesDir = path.join(tempDir, "node_modules");
      const scopeDir = path.join(nodeModulesDir, "@nativelib");
      // Use platform name in a different format (matches platform scanning logic)
      const packageDir = path.join(scopeDir, `${platform}-${arch}-binding`);
      fs.mkdirSync(packageDir, { recursive: true });

      // Create native.node file
      const nodeFilePath = path.join(packageDir, "native.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("native binding content"));

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: `@nativelib/${platform}-${arch}-binding`,
          main: "native.node",
        })
      );

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const lib = require(\`@nativelib/\${process.platform}-\${process.arch}-binding\`);
        module.exports = lib;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();

      // Should have transformed the template literal
      expect(result.code).toMatch(/[A-F0-9]{8}\.node/);
    });

    it("should NOT transform template literals that don't match platform packages", () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Don't create any platform packages

      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const config = require(\`@myapp/\${env}\`);
        module.exports = config;
      `;

      const context = { parse };
      const result = (plugin.transform as any).call(context, code, jsFilePath);

      // Should not transform (no matching packages)
      if (result) {
        expect(result.code).toContain("`@myapp/");
        expect(result.code).not.toMatch(/[A-F0-9]{8}\.node/);
      }
    });
  });

  describe("Rollup interop - syntheticNamedExports", () => {
    /**
     * This test suite covers the fix for the "databaseOpen is not a function" error.
     *
     * The issue: When Rollup bundles a native module, it wraps it with getAugmentedNamespace
     * which creates { __esModule: true, default: nativeModule }. When code destructures
     * like `const { databaseOpen } = require('@libsql/...')`, it fails because databaseOpen
     * is on the default export, not the namespace object.
     *
     * The fix: resolveId returns { id, syntheticNamedExports: true } which tells Rollup
     * to resolve named exports from the default export's properties.
     */

    it("should return syntheticNamedExports: true from resolveId for hashed .node files", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFilePath = path.join(tempDir, "native.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("native binary"));

      // Transform code to generate hashed filename
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `const native = require('./native.node');`;

      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        jsFilePath
      );

      expect(transformResult).toBeDefined();

      // Extract hashed filename from transformed code
      const match = transformResult.code.match(/require\("\.\/([^"]+\.node)"\)/);
      expect(match).toBeDefined();
      const hashedFilename = match![1];

      // Now test resolveId returns object with syntheticNamedExports
      const resolveResult = await (plugin.resolveId as any).call(
        {} as any,
        `./${hashedFilename}`,
        jsFilePath,
        {}
      );

      expect(resolveResult).toBeDefined();
      expect(typeof resolveResult).toBe("object");
      expect(resolveResult.id).toContain("\0native:");
      expect(resolveResult.syntheticNamedExports).toBe(true);
    });

    it("should generate ES module code in load hook that enables destructuring", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create a .node file
      const nodeFilePath = path.join(tempDir, "native.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("native binary"));

      // Transform code to generate hashed filename
      const esmFilePath = path.join(tempDir, "index.mjs");
      const code = `
        import { createRequire } from 'module';
        const require = createRequire(import.meta.url);
        const native = require('./native.node');
      `;

      const moduleAwareParse = (code: string) =>
        acornParse(code, { ecmaVersion: "latest", sourceType: "module" });
      const context = { parse: moduleAwareParse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        esmFilePath
      );

      expect(transformResult).toBeDefined();

      // Extract hashed filename - try multiple patterns
      let match = transformResult.code.match(
        /createRequire\(import\.meta\.url\)\("\.\/([^"]+\.node)"\)/
      );
      if (!match) {
        match = transformResult.code.match(/require\("\.\/([^"]+\.node)"\)/);
      }
      if (!match) {
        match = transformResult.code.match(/require\('\.\/([^']+\.node)'\)/);
      }
      expect(match).not.toBeNull();
      const hashedFilename = match![1];

      // Get virtual module ID
      const resolveResult = await (plugin.resolveId as any).call(
        {} as any,
        `./${hashedFilename}`,
        esmFilePath,
        {}
      );

      const virtualId =
        typeof resolveResult === "object" ? resolveResult.id : resolveResult;

      // Test load hook output
      const loadResult = await (plugin.load as any).call({} as any, virtualId);

      expect(loadResult).toBeDefined();
      // Should use ES module syntax with default export
      expect(loadResult).toContain("export default");
      expect(loadResult).toContain("createRequire");
      // The default export enables syntheticNamedExports to work
      // When Rollup sees `import { foo } from 'virtual-module'` and syntheticNamedExports is true,
      // it will look for `foo` on the default export
    });

    it("should work with libsql-style destructuring pattern", async () => {
      const plugin = nativeFilePlugin() as Plugin;

      (plugin.configResolved as any)({
        command: "build",
        mode: "production",
      });

      // Create platform package with .node file
      const nodeModulesDir = path.join(tempDir, "node_modules");
      const scopeDir = path.join(nodeModulesDir, "@libsql");
      const packageDir = path.join(scopeDir, `${platform}-${arch}`);
      fs.mkdirSync(packageDir, { recursive: true });

      const nodeFilePath = path.join(packageDir, "index.node");
      fs.writeFileSync(nodeFilePath, Buffer.from("libsql native binding"));

      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: `@libsql/${platform}-${arch}`,
          main: "index.node",
        })
      );

      // Code that destructures named exports (like libsql does)
      // This pattern was failing with "databaseOpen is not a function"
      const jsFilePath = path.join(tempDir, "index.js");
      const code = `
        const { currentTarget } = require('@neon-rs/load');
        let target = currentTarget();

        // This destructuring pattern requires syntheticNamedExports to work
        const {
          databaseOpen,
          databaseClose,
          databaseExecSync,
        } = require(\`@libsql/\${target}\`);

        module.exports = { databaseOpen, databaseClose, databaseExecSync };
      `;

      const context = { parse };
      const transformResult = (plugin.transform as any).call(
        context,
        code,
        jsFilePath
      );

      expect(transformResult).toBeDefined();
      expect(transformResult.code).toBeDefined();

      // Should have transformed the template literal to use hashed .node file
      expect(transformResult.code).toMatch(/[A-F0-9]{8}\.node/);

      // The require should be rewritten to a relative path
      expect(transformResult.code).not.toContain("`@libsql/");

      // Extract the hashed filename and verify resolveId returns syntheticNamedExports
      const match = transformResult.code.match(/require\("\.\/([^"]+\.node)"\)/);
      expect(match).toBeDefined();

      const resolveResult = await (plugin.resolveId as any).call(
        {} as any,
        `./${match![1]}`,
        jsFilePath,
        {}
      );

      // This is the critical fix - syntheticNamedExports must be true
      // so that destructuring like { databaseOpen, ... } works
      expect(resolveResult.syntheticNamedExports).toBe(true);
    });
  });
});
