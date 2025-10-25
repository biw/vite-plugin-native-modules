import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

interface NativeFileInfo {
  /** File content for emission */
  content: Buffer;
  /** Hashed filename for output (e.g., addon-a1b2c3d4.node) */
  hashedFilename: string;
  /** Absolute path to the original .node file */
  originalPath: string;
}

interface NativeFilePluginOptions {
  /** Enable the plugin. Defaults to true in build mode, false in dev mode */
  forced?: boolean;
}

export const nativeFilePlugin = (
  options: NativeFilePluginOptions = {}
): Plugin => {
  const name = "native-file-plugin";
  const nativeFiles = new Map<string, NativeFileInfo>();
  let command: "build" | "serve";

  return {
    configResolved(config) {
      command = config.command;
    },

    generateBundle() {
      // Emit each .node file as an asset
      nativeFiles.forEach((info) => {
        this.emitFile({
          fileName: info.hashedFilename,
          source: info.content,
          type: "asset",
        });
      });
    },

    load(id) {
      if (!id.startsWith("\0native:")) return null;

      const originalPath = id.slice("\0native:".length);
      const info = nativeFiles.get(originalPath);

      if (!info) return null;

      // Return proxy code that requires the hashed file
      // The hashed file will be in the same directory as the output bundle
      return `
        const { createRequire } = require('node:module');
        const require = createRequire(import.meta.url);
        module.exports = require('./${info.hashedFilename}');
      `;
    },

    name,

    async resolveId(source, importer) {
      // Check if enabled
      const enabled = options.forced ?? command === "build";

      if (!enabled) return null;

      // Check if this is a .node file
      if (!source.endsWith(".node")) return null;
      if (!importer) return null;

      // Resolve the path
      const resolved = path.resolve(path.dirname(importer), source);

      // Check if file exists
      if (!fs.existsSync(resolved)) return null;

      // Generate hash from file content
      const content = fs.readFileSync(resolved);
      const hash = crypto
        .createHash("md5")
        .update(content)
        .digest("hex")
        .slice(0, 8);
      const basename = path.basename(source, ".node");
      const hashedFilename = `${basename}-${hash.toUpperCase()}.node`;

      // Store the mapping
      nativeFiles.set(resolved, {
        content,
        hashedFilename,
        originalPath: resolved,
      });

      // Return a virtual module ID
      return `\0native:${resolved}`;
    },

    transform(code, id) {
      // Check if enabled
      const enabled = options.forced ?? command === "build";

      if (!enabled) return null;

      // Only process files that mention .node
      if (!code.includes(".node")) return null;

      // Match require("../build/Release/addon.node") or similar patterns
      // Handles various require function names (require, _require, l, etc.)
      const requireRegex =
        /(?:require|_require|l)\s*\(\s*["`']([^"`']*\.node)["`']\s*\)/g;
      let modified = false;
      let newCode = code;

      const matchList: RegExpExecArray[] = Array.from(
        code.matchAll(requireRegex)
      );

      for (const match of matchList) {
        const relativePath = match[1];

        // Resolve the actual path
        const absolutePath = path.resolve(path.dirname(id), relativePath);

        if (!fs.existsSync(absolutePath)) continue;

        // Check if we already processed this file
        let info = nativeFiles.get(absolutePath);

        if (!info) {
          // Generate hash and store
          const content = fs.readFileSync(absolutePath);
          const hash = crypto
            .createHash("md5")
            .update(content)
            .digest("hex")
            .slice(0, 8);
          const basename = path.basename(relativePath, ".node");
          const hashedFilename = `${basename}-${hash.toUpperCase()}.node`;

          info = {
            content,
            hashedFilename,
            originalPath: absolutePath,
          };
          nativeFiles.set(absolutePath, info);
        }

        // Replace the require path with the hashed filename
        const replacement = match[0].replace(
          relativePath,
          `./${info.hashedFilename}`
        );
        newCode = newCode.replace(match[0], replacement);
        modified = true;
      }

      if (modified) {
        return { code: newCode, map: null };
      }

      return null;
    },
  };
};
