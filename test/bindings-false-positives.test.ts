import { describe, expect, it } from "vitest";
import nativeFilePlugin from "../src/index.js";
import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as acornParse } from "acorn";

// Wrapper to provide the same parse signature as Rollup
const parse = (code: string) => acornParse(code, { ecmaVersion: "latest" });

/**
 * Tests to ensure bindings detection doesn't affect code that doesn't use the bindings package
 */
describe("bindings False Positive Prevention", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bindings-fp-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should NOT transform code with word 'bindings' in comments", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `// This code handles data bindings
// We need to check bindings state
const dataBindings = { value: 123 };
function handleBindings() {
  return dataBindings.value;
}
module.exports = { handleBindings };`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    // Should return null (no transformation) or return unchanged code
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should NOT transform code with 'bindings' in variable names", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `const dataBindings = require('./data-bindings');
const eventBindings = { onClick: () => {} };
const bindingsManager = new BindingsManager();

function setupBindings() {
  return { dataBindings, eventBindings };
}

module.exports = setupBindings();`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should NOT transform code with 'bindings' in string literals", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `const message = "Check data bindings";
const config = {
  type: "bindings",
  value: "some bindings value"
};

function logBindings() {
  console.log("Processing bindings:", message);
}

module.exports = { logBindings };`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should NOT transform require('something-bindings')", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `const dataBindings = require('data-bindings');
const eventBindings = require('event-bindings');
module.exports = { dataBindings, eventBindings };`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should NOT transform require('@scope/bindings-utils')", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `const utils = require('@scope/bindings-utils');
const helper = require('bindings-helper');
module.exports = { utils, helper };`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should NOT transform code with bindings in object property names", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `const config = {
  bindings: {
    data: 'value'
  },
  setupBindings: function() {
    return this.bindings;
  }
};

module.exports = config;`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should NOT transform code with bindings in method calls", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    const code = `const obj = {
  setupBindings: function() {},
  getBindings: function() {}
};

obj.setupBindings();
obj.getBindings();

module.exports = obj;`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.code).toBe(code);
    }
  });

  it("should ONLY transform actual require('bindings') calls", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    // Create build directory with .node file
    const buildDir = path.join(tempDir, "build", "Release");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "addon.node"), "fake binary");

    const jsFilePath = path.join(tempDir, "index.js");

    // Code with both false positives AND actual bindings usage
    const code = `// Comments about bindings
const dataBindings = { value: 123 };
const bindingsManager = require('bindings-manager'); // NOT the bindings package

// Actual bindings package usage
const addon = require('bindings')('addon'); // SHOULD be transformed

module.exports = { addon, dataBindings };`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    expect(result).not.toBeNull();
    expect(result.code).toBeDefined();
    
    // Should transform the actual bindings call
    expect(result.code).toContain("addon-");
    expect(result.code).toContain(".node");
    expect(result.code).not.toContain("require('bindings')('addon')");
    
    // Should NOT affect the false positives
    expect(result.code).toContain("dataBindings");
    expect(result.code).toContain("require('bindings-manager')");
    expect(result.code).toContain("// Comments about bindings");
  });

  it("should NOT transform when bindings is used but no .node file exists", () => {
    const plugin = nativeFilePlugin() as Plugin;
    (plugin.configResolved as any)({
      command: "build",
      mode: "production",
    });

    const jsFilePath = path.join(tempDir, "index.js");

    // Code that uses bindings but no .node file exists
    const code = `const addon = require('bindings')('nonexistent');
module.exports = addon;`;

    const context = { parse };
    const result = (plugin.transform as any).call(context, code, jsFilePath);

    // Should return null or unchanged code since no .node file was found
    if (result === null) {
      expect(result).toBeNull();
    } else {
      // If it returns something, the code should be unchanged
      expect(result.code).toBe(code);
    }
  });
});
