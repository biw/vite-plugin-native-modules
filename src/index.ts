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

interface PackageConfig {
  /** Package name to target (e.g., 'native-package-123') */
  package: string;
  /** Additional file names to copy (e.g., ['native-file.node-macos', 'addon.node-linux']) */
  fileNames: string[];
}

export interface NativeFilePluginOptions {
  /** Enable the plugin. Defaults to true in build mode, false in dev mode */
  forced?: boolean;
  /** Additional native file configurations for packages with non-standard file extensions */
  additionalNativeFiles?: PackageConfig[];
  /** Format for generated native file names. 'preserve' keeps original name with hash suffix, 'hash-only' uses only the hash. Defaults to 'preserve' */
  filenameFormat?: "preserve" | "hash-only";
}

// ESTree AST Node types
interface BaseASTNode {
  type: string;
  start?: number;
  end?: number;
}

interface IdentifierNode extends BaseASTNode {
  type: "Identifier";
  name: string;
}

interface LiteralNode extends BaseASTNode {
  type: "Literal";
  value: string | number | boolean | null;
  start: number;
  end: number;
}

interface CallExpressionNode extends BaseASTNode {
  type: "CallExpression";
  callee: BaseASTNode;
  arguments: BaseASTNode[];
  start: number;
  end: number;
}

interface MemberExpressionNode extends BaseASTNode {
  type: "MemberExpression";
  object: BaseASTNode;
  property: BaseASTNode;
}

interface VariableDeclaratorNode extends BaseASTNode {
  type: "VariableDeclarator";
  id: BaseASTNode;
  init?: BaseASTNode;
}

interface ImportDeclarationNode extends BaseASTNode {
  type: "ImportDeclaration";
  specifiers: BaseASTNode[];
  source: LiteralNode;
}

interface ImportDefaultSpecifierNode extends BaseASTNode {
  type: "ImportDefaultSpecifier";
  local: IdentifierNode;
}

interface ImportSpecifierNode extends BaseASTNode {
  type: "ImportSpecifier";
  imported: IdentifierNode;
  local: IdentifierNode;
}

interface MetaPropertyNode extends BaseASTNode {
  type: "MetaProperty";
  meta: IdentifierNode;
  property: IdentifierNode;
}

// Type guard functions
function isCallExpression(node: BaseASTNode): node is CallExpressionNode {
  return node.type === "CallExpression";
}

function isLiteral(node: BaseASTNode): node is LiteralNode {
  return node.type === "Literal";
}

function isIdentifier(node: BaseASTNode): node is IdentifierNode {
  return node.type === "Identifier";
}

function isMemberExpression(node: BaseASTNode): node is MemberExpressionNode {
  return node.type === "MemberExpression";
}

function isVariableDeclarator(
  node: BaseASTNode
): node is VariableDeclaratorNode {
  return node.type === "VariableDeclarator";
}

function isImportDeclaration(node: BaseASTNode): node is ImportDeclarationNode {
  return node.type === "ImportDeclaration";
}

function isImportDefaultSpecifier(
  node: BaseASTNode
): node is ImportDefaultSpecifierNode {
  return node.type === "ImportDefaultSpecifier";
}

function isImportSpecifier(node: BaseASTNode): node is ImportSpecifierNode {
  return node.type === "ImportSpecifier";
}

export default function nativeFilePlugin(
  options: NativeFilePluginOptions = {}
): Plugin {
  const name = "plugin-native-modules";
  const nativeFiles = new Map<string, NativeFileInfo>();
  // Reverse mapping from hashed filename to original file path
  // Used to resolve transformed bindings/node-gyp-build calls
  const hashedFilenameToPath = new Map<string, string>();
  // Track module type (ES module vs CommonJS) for virtual modules
  // Maps virtual module ID to whether it's an ES module
  const virtualModuleTypes = new Map<string, boolean>();
  let command: "build" | "serve" = "build";

  // Helper function to detect if a file is an ES module based on extension and content
  function detectModuleType(fileId: string, code?: string): boolean {
    // Check file extension - .mjs is always ES module, .cjs is always CommonJS
    if (fileId.endsWith(".mjs") || fileId.endsWith(".mts")) {
      return true;
    }
    if (fileId.endsWith(".cjs") || fileId.endsWith(".cts")) {
      return false;
    }

    // If we have code, check for import/export statements
    if (code) {
      // Quick check for ES module indicators
      if (
        code.includes("import ") ||
        code.includes("export ") ||
        code.includes("import.meta")
      ) {
        return true;
      }
      // CommonJS indicators
      if (
        code.includes("require(") ||
        code.includes("module.exports") ||
        code.includes("exports.")
      ) {
        return false;
      }
    }

    // Check for package.json with "type": "module" in the directory hierarchy
    try {
      let dir = path.dirname(fileId);
      const root = path.parse(fileId).root;

      // Walk up the directory tree looking for package.json
      while (dir !== root && dir !== path.dirname(dir)) {
        const packageJsonPath = path.join(dir, "package.json");
        if (fs.existsSync(packageJsonPath)) {
          try {
            const packageJson = JSON.parse(
              fs.readFileSync(packageJsonPath, "utf-8")
            );
            if (packageJson.type === "module") {
              return true;
            }
            if (packageJson.type === "commonjs") {
              return false;
            }
          } catch {
            // Ignore JSON parse errors
          }
        }
        dir = path.dirname(dir);
      }
    } catch {
      // Ignore errors when checking package.json
    }

    // Default: assume CommonJS for .js files (Node.js default)
    return false;
  }

  // Helper function to check if a file path should be processed based on package configs
  function shouldProcessFile(filePath: string, currentFileId: string): boolean {
    // Always process .node files
    if (filePath.endsWith(".node")) return true;

    // Check additional native file configurations
    if (options.additionalNativeFiles) {
      for (const pkgConfig of options.additionalNativeFiles) {
        // Check if current file is within this package's node_modules
        const pkgPath = `node_modules/${pkgConfig.package}`;
        if (currentFileId.includes(pkgPath)) {
          // Check if this file matches any of the configured file names
          for (const fileName of pkgConfig.fileNames) {
            if (
              filePath.endsWith(fileName) ||
              filePath.includes(`/${fileName}`)
            ) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  // Helper function to resolve node-gyp-build style native module loading
  // Mimics node-gyp-build's behavior: check prebuilds/ first, then build/Release/
  function resolveNodeGypBuild(directory: string): string | null {
    const platform = process.platform;
    const arch = process.arch;

    // Try prebuilds directory first
    const prebuildsDir = path.join(
      directory,
      "prebuilds",
      `${platform}-${arch}`
    );

    if (fs.existsSync(prebuildsDir)) {
      try {
        const files = fs.readdirSync(prebuildsDir);
        const nodeFiles = files.filter((f) => f.endsWith(".node"));

        if (nodeFiles.length > 0) {
          // If multiple .node files exist, prefer napi over abi-specific
          const napiFile = nodeFiles.find((f) => f.includes("napi"));
          const selectedFile = napiFile || nodeFiles[0];
          const fullPath = path.join(prebuildsDir, selectedFile);

          if (fs.existsSync(fullPath)) {
            return fullPath;
          }
        }
      } catch {
        // Continue to fallback
      }
    }

    // Fallback to build/Release directory
    const buildDir = path.join(directory, "build", "Release");

    if (fs.existsSync(buildDir)) {
      try {
        const files = fs.readdirSync(buildDir);
        const nodeFiles = files.filter((f) => f.endsWith(".node"));

        if (nodeFiles.length > 0) {
          const fullPath = path.join(buildDir, nodeFiles[0]);

          if (fs.existsSync(fullPath)) {
            return fullPath;
          }
        }
      } catch {
        // Continue
      }
    }

    return null;
  }

  // Helper function to find package root by walking up directories
  // Looks for package.json or node_modules directory
  function findPackageRoot(startDir: string): string {
    let dir = startDir;
    let prev: string | undefined;

    while (true) {
      // Check if package.json or node_modules exists in this directory
      if (
        fs.existsSync(path.join(dir, "package.json")) ||
        fs.existsSync(path.join(dir, "node_modules"))
      ) {
        return dir;
      }

      // Move up one directory
      prev = dir;
      dir = path.dirname(dir);

      // Stop if we've reached the root or can't go up anymore
      if (dir === prev || dir === "." || dir === "/") {
        return startDir; // Fall back to original directory
      }
    }
  }

  // Helper function to resolve bindings-style native module loading
  // Mimics bindings package behavior: searches common build directories
  function resolveBindings(
    directory: string,
    moduleName: string
  ): string | null {
    // Ensure moduleName has .node extension
    const nodeFileName = moduleName.endsWith(".node")
      ? moduleName
      : `${moduleName}.node`;

    // Find the package root (where build/ directory typically lives)
    const packageRoot = findPackageRoot(directory);

    // Common build paths to check (in priority order)
    const searchPaths = [
      path.join(packageRoot, "build", "Release", nodeFileName),
      path.join(packageRoot, "build", "Debug", nodeFileName),
      path.join(packageRoot, "out", "Release", nodeFileName),
      path.join(packageRoot, "out", "Debug", nodeFileName),
      path.join(packageRoot, "build", "default", nodeFileName),
      path.join(packageRoot, "compiled", nodeFileName),
      // Also check direct path (sometimes used in development)
      path.join(packageRoot, nodeFileName),
    ];

    // Return the first path that exists
    for (const searchPath of searchPaths) {
      if (fs.existsSync(searchPath)) {
        return searchPath;
      }
    }

    return null;
  }

  // Helper function to resolve an npm package and find a .node file
  // Returns the path to the .node file if found, null otherwise
  function resolveNpmPackageNodeFile(
    packageName: string,
    fromDir: string
  ): string | null {
    // Walk up directories looking for node_modules
    let currentDir = fromDir;
    const root = path.parse(fromDir).root;

    while (currentDir !== root && currentDir !== path.dirname(currentDir)) {
      const nodeModulesDir = path.join(currentDir, "node_modules");

      if (fs.existsSync(nodeModulesDir)) {
        // Handle scoped packages (@scope/name) and regular packages
        const packageDir = path.join(nodeModulesDir, packageName);

        if (fs.existsSync(packageDir)) {
          // Try to read package.json to find the main entry
          const packageJsonPath = path.join(packageDir, "package.json");

          if (fs.existsSync(packageJsonPath)) {
            try {
              const packageJson = JSON.parse(
                fs.readFileSync(packageJsonPath, "utf-8")
              );

              // Check if main points to a .node file
              if (packageJson.main && packageJson.main.endsWith(".node")) {
                const mainPath = path.join(packageDir, packageJson.main);
                if (fs.existsSync(mainPath)) {
                  return mainPath;
                }
              }
            } catch {
              // Ignore JSON parse errors
            }
          }

          // Check for index.node as fallback
          const indexNodePath = path.join(packageDir, "index.node");
          if (fs.existsSync(indexNodePath)) {
            return indexNodePath;
          }

          // Check for any .node file directly in the package directory
          try {
            const files = fs.readdirSync(packageDir);
            const nodeFile = files.find((f) => f.endsWith(".node"));
            if (nodeFile) {
              return path.join(packageDir, nodeFile);
            }
          } catch {
            // Ignore read errors
          }
        }
      }

      currentDir = path.dirname(currentDir);
    }

    return null;
  }

  // Helper function to find platform-specific native packages matching a scope pattern
  // Used for template literal requires like require(`@libsql/${target}`)
  // Returns the path to the .node file for the current platform, or null
  function findPlatformSpecificNativePackage(
    scopePrefix: string, // e.g., "@libsql/" or "@scope/prefix-"
    fromDir: string
  ): { packageName: string; nodeFilePath: string } | null {
    // Common platform/arch combinations for native modules
    const platform = process.platform;
    const arch = process.arch;

    // Common naming patterns for platform-specific packages
    const platformPatterns = [
      `${platform}-${arch}`, // darwin-arm64, linux-x64
      `${platform}-${arch}-gnu`, // linux-x64-gnu
      `${platform}-${arch}-musl`, // linux-x64-musl
      `${platform}${arch === "x64" ? "64" : arch === "ia32" ? "32" : arch}`, // darwin64, linux64
    ];

    // Walk up directories looking for node_modules
    let currentDir = fromDir;
    const root = path.parse(fromDir).root;

    while (currentDir !== root && currentDir !== path.dirname(currentDir)) {
      const nodeModulesDir = path.join(currentDir, "node_modules");

      if (fs.existsSync(nodeModulesDir)) {
        // Try each platform pattern
        for (const platformPattern of platformPatterns) {
          const packageName = `${scopePrefix}${platformPattern}`;
          const result = resolveNpmPackageNodeFile(packageName, currentDir);
          if (result) {
            return { packageName, nodeFilePath: result };
          }
        }

        // If scope prefix starts with @, also try scanning the scope directory
        if (scopePrefix.startsWith("@")) {
          const scopeName = scopePrefix.split("/")[0]; // @libsql
          const scopeDir = path.join(nodeModulesDir, scopeName);

          if (fs.existsSync(scopeDir)) {
            try {
              const packages = fs.readdirSync(scopeDir);
              for (const pkg of packages) {
                // Check if this package matches current platform
                const lowerPkg = pkg.toLowerCase();
                const lowerPlatform = platform.toLowerCase();
                const lowerArch = arch.toLowerCase();

                if (
                  lowerPkg.includes(lowerPlatform) &&
                  lowerPkg.includes(lowerArch)
                ) {
                  const packageName = `${scopeName}/${pkg}`;
                  const result = resolveNpmPackageNodeFile(
                    packageName,
                    currentDir
                  );
                  if (result) {
                    return { packageName, nodeFilePath: result };
                  }
                }
              }
            } catch {
              // Ignore read errors
            }
          }
        }
      }

      currentDir = path.dirname(currentDir);
    }

    return null;
  }

  // Helper function to generate hashed filename based on format option
  function generateHashedFilename(
    originalFilename: string,
    hash: string
  ): string {
    const lastDotIndex = originalFilename.lastIndexOf(".");
    const extension =
      lastDotIndex > 0 ? originalFilename.slice(lastDotIndex) : "";

    if (options.filenameFormat === "hash-only") {
      // Hash-only format: HASH.node
      return `${hash.toUpperCase()}${extension}`;
    } else {
      // Preserve format (default): filename-HASH.node
      return lastDotIndex > 0
        ? `${originalFilename.slice(
            0,
            lastDotIndex
          )}-${hash.toUpperCase()}${extension}`
        : `${originalFilename}-${hash.toUpperCase()}`;
    }
  }

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

      // Check if this virtual module is being loaded in an ES module context
      // Try to get the tracked module type first
      let isESModule = virtualModuleTypes.get(id);

      // If not tracked, try to detect from the original path or use getModuleInfo if available
      if (isESModule === undefined) {
        // Try to detect from file extension as fallback
        isESModule = detectModuleType(originalPath);

        // If getModuleInfo is available, try to use it (though it may not work for virtual modules)
        try {
          if (typeof this.getModuleInfo === "function") {
            const moduleInfo = this.getModuleInfo(id);
            const format = (moduleInfo as { format?: string }).format;
            if (moduleInfo && format) {
              isESModule = format === "es";
            }
          }
        } catch {
          // Ignore errors, use fallback detection
        }

        // If still undefined, default to CommonJS (safer than ES module)
        // This prevents mixing require() with import.meta.url
        if (isESModule === undefined) {
          isESModule = false;
        }
      }

      // Return proxy code that requires the hashed file
      // The hashed file will be in the same directory as the output bundle
      if (isESModule) {
        // ES module syntax
        return `
          import { createRequire } from 'node:module';
          const createRequireLocal = createRequire(import.meta.url);
          export default createRequireLocal('./${info.hashedFilename}');
        `;
      } else {
        // CommonJS syntax - use require directly since we're in CommonJS context
        return `
          module.exports = require('./${info.hashedFilename}');
        `;
      }
    },

    name,

    async resolveId(source, importer) {
      // Check if enabled
      const enabled = options.forced ?? command === "build";

      if (!enabled) return null;
      if (!importer) return null;

      // Check if this is a hashed filename generated by our transformations
      // Handle both relative paths (./filename-HASH.node) and bare filenames (filename-HASH.node)
      // Also handle Vite query parameters like ?commonjs-external
      const sourceWithoutQuery = source.split("?")[0];
      const normalizedSource = sourceWithoutQuery.startsWith("./")
        ? sourceWithoutQuery.slice(2)
        : sourceWithoutQuery;
      const basename = path.basename(normalizedSource);

      // Check if this matches a hashed filename we've generated
      if (hashedFilenameToPath.has(basename)) {
        const originalPath = hashedFilenameToPath.get(basename)!;
        // Detect module type of the importing file using Rollup's getModuleInfo if available
        let importingModuleType = false;
        try {
          if (typeof this.getModuleInfo === "function" && importer) {
            const moduleInfo = this.getModuleInfo(importer);
            // ModuleInfo may have format property at runtime even if TypeScript types don't include it
            const format = (moduleInfo as { format?: string }).format;
            if (moduleInfo && format) {
              importingModuleType = format === "es";
            } else {
              // Fallback to detectModuleType if format is not available
              importingModuleType = detectModuleType(importer);
            }
          } else {
            // Fallback to detectModuleType if getModuleInfo is not available
            importingModuleType = detectModuleType(importer);
          }
        } catch {
          // Fallback to detectModuleType if getModuleInfo throws
          importingModuleType = detectModuleType(importer);
        }
        const virtualId = `\0native:${originalPath}`;
        // Always track module type for this virtual module (even if false/CommonJS)
        virtualModuleTypes.set(virtualId, importingModuleType);
        // Return virtual module ID so load hook can handle it
        return virtualId;
      }

      // Check if this file should be processed
      if (!shouldProcessFile(source, importer)) return null;

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

      // Generate hashed filename
      const filename = path.basename(source);
      const hashedFilename = generateHashedFilename(filename, hash);

      // Store the mapping
      nativeFiles.set(resolved, {
        content,
        hashedFilename,
        originalPath: resolved,
      });
      // Track reverse mapping for resolveId hook
      hashedFilenameToPath.set(hashedFilename, resolved);

      // Detect module type of the importing file using Rollup's getModuleInfo if available
      let importingModuleType = false;
      try {
        if (typeof this.getModuleInfo === "function" && importer) {
          const moduleInfo = this.getModuleInfo(importer);
          // ModuleInfo may have format property at runtime even if TypeScript types don't include it
          const format = (moduleInfo as { format?: string }).format;
          if (moduleInfo && format) {
            importingModuleType = format === "es";
          } else {
            // Fallback to detectModuleType if format is not available
            importingModuleType = detectModuleType(importer);
          }
        } else {
          // Fallback to detectModuleType if getModuleInfo is not available
          importingModuleType = detectModuleType(importer);
        }
      } catch {
        // Fallback to detectModuleType if getModuleInfo throws
        importingModuleType = detectModuleType(importer);
      }
      const virtualId = `\0native:${resolved}`;
      // Always track module type for this virtual module (even if false/CommonJS)
      virtualModuleTypes.set(virtualId, importingModuleType);

      // Return a virtual module ID
      return virtualId;
    },

    transform(code, id) {
      // Check if enabled
      const enabled = options.forced ?? command === "build";

      if (!enabled) return null;

      // Only process files that mention .node, node-gyp-build, bindings, or native platform packages
      // For bindings, we check for the exact package name patterns to avoid false positives
      const hasBindingsPackage =
        code.includes("require('bindings')") ||
        code.includes('require("bindings")') ||
        code.includes("from 'bindings'") ||
        code.includes('from "bindings"');

      // Check for template literal requires that might be platform-specific native packages
      // These patterns are used by NAPI-RS/neon-rs for platform-specific native modules
      // e.g., require(`@libsql/${target}`) or require(`@scope/${platform}`)
      const hasTemplateLiteralNativePackage =
        /require\s*\(\s*`@[a-z0-9-]+\//.test(code);

      if (
        !code.includes(".node") &&
        !code.includes("node-gyp-build") &&
        !hasBindingsPackage &&
        !hasTemplateLiteralNativePackage
      )
        return null;

      let modified = false;
      const replacements: Array<{ start: number; end: number; value: string }> =
        [];

      try {
        // Parse the code using Rollup's built-in parser
        // In tests, this.parse may not be available, so we check first

        const ast = this.parse(code);

        // Track variables for the createRequire pattern
        let createRequireLocalName: string | null = null; // The actual local name of createRequire import (e.g., "createRequire" or "createRequire$1")
        const customRequireVars = new Set<string>(); // Variables that are custom require functions
        const nodeGypBuildVars = new Set<string>(); // Variables that hold node-gyp-build

        // Track node-gyp-build import/require statements for potential removal
        const nodeGypBuildImportNodes: BaseASTNode[] = []; // ImportDeclaration or VariableDeclarator nodes to remove if unused
        let nodeGypBuildUsageCount = 0; // Count of node-gyp-build calls we've replaced

        // Track bindings package variables and imports
        const bindingsVars = new Set<string>(); // Variables that hold the bindings function
        const bindingsImportNodes: BaseASTNode[] = []; // ImportDeclaration or VariableDeclarator nodes to remove if unused
        let bindingsUsageCount = 0; // Count of bindings calls we've replaced

        // Track variables that hold directory paths
        const directoryVars = new Map<string, string>(); // varName -> resolved directory path

        // Track module aliases for path and url modules
        const pathModuleVars = new Set<string>(); // Variables that reference 'path' module
        const fileURLToPathVars = new Set<string>(); // Variables that reference 'fileURLToPath'

        // Detect if this is an ES6 module (vs CommonJS)
        // Try to use Rollup's built-in module info first (most reliable)
        let isESModule = false;
        let hasCreateRequireImport = false;

        // Use Rollup's getModuleInfo if available (most reliable)
        // getModuleInfo returns module metadata including format
        try {
          if (typeof this.getModuleInfo === "function") {
            const moduleInfo = this.getModuleInfo(id);
            // ModuleInfo may have format property at runtime even if TypeScript types don't include it
            const format = (moduleInfo as { format?: string }).format;
            if (moduleInfo && format) {
              // format indicates the module format: 'es' = ES module, 'cjs' = CommonJS
              isESModule = format === "es";
            } else {
              // Fallback to our detection if format is not available
              isESModule = detectModuleType(id, code);
            }
          } else {
            // Fallback to our detection if getModuleInfo is not available
            isESModule = detectModuleType(id, code);
          }
        } catch {
          // Fallback to our detection if getModuleInfo throws
          isESModule = detectModuleType(id, code);
        }

        // Also check AST for ImportDeclaration/ExportDeclaration nodes (most reliable)
        // This will override other detection if we find import/export statements

        // Helper to check if a node is fileURLToPath(import.meta.url)
        function isFileURLToPathPattern(node: BaseASTNode): boolean {
          if (!isCallExpression(node)) return false;

          const callee = node.callee;
          if (!isIdentifier(callee)) return false;
          if (!fileURLToPathVars.has(callee.name)) return false;

          // Check if argument is import.meta.url
          if (node.arguments.length !== 1) return false;
          const arg = node.arguments[0];

          if (isMemberExpression(arg)) {
            const metaExpr = arg as MemberExpressionNode;

            // Check if this is import.meta.url
            // import.meta is represented as a MetaProperty node, not a MemberExpression
            if (
              metaExpr.object.type === "MetaProperty" &&
              isIdentifier(metaExpr.property) &&
              (metaExpr.property as IdentifierNode).name === "url"
            ) {
              const metaProp = metaExpr.object as MetaPropertyNode;
              if (
                metaProp.meta.name === "import" &&
                metaProp.property.name === "meta"
              ) {
                return true;
              }
            }

            // Fallback: Check legacy structure (MemberExpression)
            if (
              isMemberExpression(metaExpr.object) &&
              isIdentifier((metaExpr.object as MemberExpressionNode).object) &&
              (
                (metaExpr.object as MemberExpressionNode)
                  .object as IdentifierNode
              ).name === "import" &&
              isIdentifier(
                (metaExpr.object as MemberExpressionNode).property
              ) &&
              (
                (metaExpr.object as MemberExpressionNode)
                  .property as IdentifierNode
              ).name === "meta" &&
              isIdentifier(metaExpr.property) &&
              (metaExpr.property as IdentifierNode).name === "url"
            ) {
              return true;
            }
          }

          return false;
        }

        // Helper to resolve directory from a CallExpression (path.dirname, path.resolve, etc.)
        function resolveDirectoryFromCall(
          callNode: CallExpressionNode,
          currentFileId: string
        ): string | null {
          const callee = callNode.callee;

          // Check for path.dirname() or pathAlias.dirname()
          if (isMemberExpression(callee)) {
            const memberExpr = callee as MemberExpressionNode;
            if (
              isIdentifier(memberExpr.object) &&
              (pathModuleVars.has(memberExpr.object.name) ||
                memberExpr.object.name === "path") &&
              isIdentifier(memberExpr.property)
            ) {
              const methodName = memberExpr.property.name;

              // path.dirname(fileURLToPath(import.meta.url))
              if (methodName === "dirname") {
                if (callNode.arguments.length === 1) {
                  const arg = callNode.arguments[0];
                  if (isFileURLToPathPattern(arg)) {
                    // This is equivalent to __dirname
                    return path.dirname(currentFileId);
                  }
                  // path.dirname(someVar) where someVar is a known directory
                  if (isIdentifier(arg) && directoryVars.has(arg.name)) {
                    const baseDir = directoryVars.get(arg.name)!;
                    return path.dirname(baseDir);
                  }
                }
              }

              // path.resolve() or path.join()
              if (methodName === "resolve" || methodName === "join") {
                if (callNode.arguments.length === 0) return null;

                // Determine the base directory from the first argument
                let baseDir: string | null = null;
                let startIndex = 0;

                const firstArg = callNode.arguments[0];
                if (isIdentifier(firstArg)) {
                  if (firstArg.name === "__dirname") {
                    baseDir = path.dirname(currentFileId);
                    startIndex = 1;
                  } else if (directoryVars.has(firstArg.name)) {
                    baseDir = directoryVars.get(firstArg.name)!;
                    startIndex = 1;
                  } else {
                    // Unknown variable
                    return null;
                  }
                } else if (
                  isLiteral(firstArg) &&
                  typeof firstArg.value === "string"
                ) {
                  // Absolute or relative path
                  baseDir = path.dirname(currentFileId);
                  startIndex = 0;
                } else {
                  // Complex expression
                  return null;
                }

                const parts: string[] = [baseDir];

                // Process remaining arguments
                for (let i = startIndex; i < callNode.arguments.length; i++) {
                  const arg = callNode.arguments[i];
                  if (isLiteral(arg) && typeof arg.value === "string") {
                    parts.push(arg.value);
                  } else if (isIdentifier(arg) && directoryVars.has(arg.name)) {
                    // Another directory variable - use it
                    parts.push(directoryVars.get(arg.name)!);
                  } else {
                    // Can't resolve
                    return null;
                  }
                }

                return path.join(...parts);
              }
            }
          }

          return null;
        }

        // Walk the AST to find CallExpression nodes
        const walk = (node: BaseASTNode): void => {
          // Track import declarations for createRequire from 'module'
          if (isImportDeclaration(node)) {
            // Any ImportDeclaration means this is an ES6 module
            isESModule = true;
          }
          // Also check for export declarations (more robust ES module detection)
          else if (
            node.type === "ExportDefaultDeclaration" ||
            node.type === "ExportNamedDeclaration" ||
            node.type === "ExportAllDeclaration"
          ) {
            // Any export declaration means this is an ES6 module
            isESModule = true;
          }

          if (isImportDeclaration(node)) {
            const source = node.source.value;

            // Track createRequire imports
            if (source === "module" || source === "node:module") {
              for (const specifier of node.specifiers) {
                if (isImportSpecifier(specifier)) {
                  if (
                    isIdentifier(specifier.imported) &&
                    specifier.imported.name === "createRequire" &&
                    isIdentifier(specifier.local)
                  ) {
                    // Store the actual local name (could be renamed like createRequire$1)
                    createRequireLocalName = specifier.local.name;
                    hasCreateRequireImport = true;
                  }
                }
              }
            }

            // Track path module imports
            if (source === "path" || source === "node:path") {
              for (const specifier of node.specifiers) {
                if (
                  isImportDefaultSpecifier(specifier) &&
                  isIdentifier(specifier.local)
                ) {
                  pathModuleVars.add(specifier.local.name);
                }
              }
            }

            // Track fileURLToPath imports from url
            if (source === "url" || source === "node:url") {
              for (const specifier of node.specifiers) {
                if (isImportSpecifier(specifier)) {
                  if (
                    isIdentifier(specifier.imported) &&
                    specifier.imported.name === "fileURLToPath" &&
                    isIdentifier(specifier.local)
                  ) {
                    fileURLToPathVars.add(specifier.local.name);
                  }
                }
              }
            }

            // Track node-gyp-build imports
            if (source === "node-gyp-build") {
              // Track the import statement node for potential removal
              nodeGypBuildImportNodes.push(node);
              for (const specifier of node.specifiers) {
                if (
                  isImportDefaultSpecifier(specifier) &&
                  isIdentifier(specifier.local)
                ) {
                  nodeGypBuildVars.add(specifier.local.name);
                }
              }
            }

            // Track bindings imports
            if (source === "bindings") {
              // Track the import statement node for potential removal
              bindingsImportNodes.push(node);
              for (const specifier of node.specifiers) {
                if (
                  isImportDefaultSpecifier(specifier) &&
                  isIdentifier(specifier.local)
                ) {
                  bindingsVars.add(specifier.local.name);
                }
              }
            }
          }

          // Track variable declarations
          if (isVariableDeclarator(node)) {
            if (isIdentifier(node.id) && node.init) {
              const varName = node.id.name;

              // Track directory variable assignments
              // Pattern 1: var t = __dirname
              if (isIdentifier(node.init) && node.init.name === "__dirname") {
                directoryVars.set(varName, path.dirname(id));
              }
              // Pattern 2: var t = otherDirVar (copy directory from another variable)
              else if (
                isIdentifier(node.init) &&
                directoryVars.has(node.init.name)
              ) {
                directoryVars.set(varName, directoryVars.get(node.init.name)!);
              }
              // Pattern 3: var t = path.dirname(fileURLToPath(import.meta.url)) or path.resolve/join
              else if (isCallExpression(node.init)) {
                const resolvedDir = resolveDirectoryFromCall(node.init, id);
                if (resolvedDir) {
                  directoryVars.set(varName, resolvedDir);
                }

                // Also track createRequire and node-gyp-build assignments
                const calleeNode = node.init.callee;

                // Check if it's a call to createRequire
                if (
                  isIdentifier(calleeNode) &&
                  createRequireLocalName &&
                  calleeNode.name === createRequireLocalName
                ) {
                  customRequireVars.add(varName);
                }
                // Check if it's require('node-gyp-build') or customRequire('node-gyp-build')
                else if (
                  isIdentifier(calleeNode) &&
                  (calleeNode.name === "require" ||
                    customRequireVars.has(calleeNode.name)) &&
                  node.init.arguments.length === 1 &&
                  isLiteral(node.init.arguments[0]) &&
                  node.init.arguments[0].value === "node-gyp-build"
                ) {
                  // Track the variable declarator node for potential removal
                  nodeGypBuildImportNodes.push(node);
                  nodeGypBuildVars.add(varName);
                }
                // Check if it's require('bindings') or customRequire('bindings')
                else if (
                  isIdentifier(calleeNode) &&
                  (calleeNode.name === "require" ||
                    customRequireVars.has(calleeNode.name)) &&
                  node.init.arguments.length === 1 &&
                  isLiteral(node.init.arguments[0]) &&
                  node.init.arguments[0].value === "bindings"
                ) {
                  // Track the variable declarator node for potential removal
                  bindingsImportNodes.push(node);
                  bindingsVars.add(varName);
                }
              }
            }
          }

          if (isCallExpression(node)) {
            const calleeNode = node.callee;

            // Pattern 1: Direct call require('node-gyp-build')(__dirname) or customRequire('node-gyp-build')(__dirname)
            if (
              isCallExpression(calleeNode) &&
              isIdentifier(calleeNode.callee) &&
              (calleeNode.callee.name === "require" ||
                customRequireVars.has(calleeNode.callee.name)) &&
              calleeNode.arguments.length === 1 &&
              isLiteral(calleeNode.arguments[0]) &&
              calleeNode.arguments[0].value === "node-gyp-build"
            ) {
              // This is require('node-gyp-build')(...) or customRequire('node-gyp-build')(...)
              const dirArg = node.arguments[0];
              const directory = resolveDirArgument(dirArg, id);

              if (directory) {
                const nodeFilePath = resolveNodeGypBuild(directory);
                if (nodeFilePath) {
                  processNodeFile(nodeFilePath, node);
                }
              }
            }
            // Pattern 2: Variable call nodeGypBuildVar(__dirname)
            else if (
              isIdentifier(calleeNode) &&
              nodeGypBuildVars.has(calleeNode.name)
            ) {
              const dirArg = node.arguments[0];
              const directory = resolveDirArgument(dirArg, id);

              if (directory) {
                const nodeFilePath = resolveNodeGypBuild(directory);
                if (nodeFilePath) {
                  processNodeFile(nodeFilePath, node);
                }
              }
            }
            // Pattern 3: bindings package - direct call require('bindings')('addon')
            else if (
              isCallExpression(calleeNode) &&
              isIdentifier(calleeNode.callee) &&
              (calleeNode.callee.name === "require" ||
                customRequireVars.has(calleeNode.callee.name)) &&
              calleeNode.arguments.length === 1 &&
              isLiteral(calleeNode.arguments[0]) &&
              calleeNode.arguments[0].value === "bindings" &&
              node.arguments.length === 1
            ) {
              // This is require('bindings')('addon') or require('bindings')({ bindings: 'addon' })
              const arg = node.arguments[0];
              let moduleName: string | null = null;

              // Check if argument is a string literal
              if (isLiteral(arg) && typeof arg.value === "string") {
                moduleName = arg.value;
              }
              // Check if argument is an object with bindings property
              else if (arg.type === "ObjectExpression" && "properties" in arg) {
                const properties = arg.properties as Array<{
                  type: string;
                  key?: { name: string };
                  value: BaseASTNode;
                }>;
                const bindingsProp = properties.find(
                  (prop) =>
                    prop.type === "Property" &&
                    prop.key?.name === "bindings" &&
                    isLiteral(prop.value)
                );
                if (bindingsProp && isLiteral(bindingsProp.value)) {
                  moduleName = bindingsProp.value.value as string;
                }
              }

              if (moduleName) {
                const directory = path.dirname(id);
                const nodeFilePath = resolveBindings(directory, moduleName);
                if (nodeFilePath) {
                  processNodeFile(nodeFilePath, node);
                  bindingsUsageCount++;
                }
              }
            }
            // Pattern 4: bindings package - variable call bindingsVar('addon')
            else if (
              isIdentifier(calleeNode) &&
              bindingsVars.has(calleeNode.name) &&
              node.arguments.length === 1
            ) {
              const arg = node.arguments[0];
              let moduleName: string | null = null;

              // Check if argument is a string literal
              if (isLiteral(arg) && typeof arg.value === "string") {
                moduleName = arg.value;
              }
              // Check if argument is an object with bindings property
              else if (arg.type === "ObjectExpression" && "properties" in arg) {
                const properties = arg.properties as Array<{
                  type: string;
                  key?: { name: string };
                  value: BaseASTNode;
                }>;
                const bindingsProp = properties.find(
                  (prop) =>
                    prop.type === "Property" &&
                    prop.key?.name === "bindings" &&
                    isLiteral(prop.value)
                );
                if (bindingsProp && isLiteral(bindingsProp.value)) {
                  moduleName = bindingsProp.value.value as string;
                }
              }

              if (moduleName) {
                const directory = path.dirname(id);
                const nodeFilePath = resolveBindings(directory, moduleName);
                if (nodeFilePath) {
                  processNodeFile(nodeFilePath, node);
                  bindingsUsageCount++;
                }
              }
            }
            // Pattern 5: Regular require('./addon.node') calls
            // Note: Using nested if instead of early return to allow Pattern 7 to run
            else if (
              node.arguments.length === 1 &&
              isLiteral(node.arguments[0]) &&
              typeof node.arguments[0].value === "string"
            ) {
              const literalNode = node.arguments[0];
              const relativePath = literalNode.value as string;

              // Check if this file should be processed (either .node or package-specific)
              // Only process relative paths with .node extension here
              // Non-relative paths will be handled by Pattern 7
              if (shouldProcessFile(relativePath, id)) {
                // Resolve the actual path
                const absolutePath = path.resolve(path.dirname(id), relativePath);

                if (fs.existsSync(absolutePath)) {
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

                    // Generate hashed filename
                    // e.g., addon.node -> addon-HASH.node (or HASH.node if hash-only)
                    //       native-file.node-macos -> native-file-HASH.node-macos (or HASH.node-macos if hash-only)
                    const filename = path.basename(relativePath);
                    const hashedFilename = generateHashedFilename(filename, hash);

                    info = {
                      content,
                      hashedFilename,
                      originalPath: absolutePath,
                    };
                    nativeFiles.set(absolutePath, info);
                    // Track reverse mapping for resolveId hook
                    hashedFilenameToPath.set(hashedFilename, absolutePath);
                  }

                  // Record the replacement
                  replacements.push({
                    start: literalNode.start,
                    end: literalNode.end,
                    value: `"./${info.hashedFilename}"`,
                  });
                  modified = true;
                }
              }
            }

            // Pattern 6: NAPI-RS style join(__dirname, 'xxx.node') or path.join(__dirname, 'xxx.node')
            // This pattern is used by NAPI-RS generated loaders like libsql-js:
            //   existsSync(join(__dirname, 'libsql.darwin-arm64.node'))
            // We need to rewrite the string literal to use the hashed filename
            if (
              isMemberExpression(calleeNode) &&
              isIdentifier(calleeNode.object) &&
              (pathModuleVars.has(calleeNode.object.name) ||
                calleeNode.object.name === "path") &&
              isIdentifier(calleeNode.property) &&
              (calleeNode.property.name === "join" ||
                calleeNode.property.name === "resolve") &&
              node.arguments.length >= 2
            ) {
              // Check if first arg is __dirname or a directory variable
              const firstArg = node.arguments[0];
              let baseDir: string | null = null;

              if (isIdentifier(firstArg) && firstArg.name === "__dirname") {
                baseDir = path.dirname(id);
              } else if (
                isIdentifier(firstArg) &&
                directoryVars.has(firstArg.name)
              ) {
                baseDir = directoryVars.get(firstArg.name)!;
              }

              if (baseDir) {
                // Check if last argument is a .node file string literal
                const lastArg = node.arguments[node.arguments.length - 1];
                if (
                  isLiteral(lastArg) &&
                  typeof lastArg.value === "string" &&
                  lastArg.value.endsWith(".node")
                ) {
                  const nodeFileName = lastArg.value;
                  // Resolve the full path
                  const parts: string[] = [baseDir];
                  for (let i = 1; i < node.arguments.length - 1; i++) {
                    const arg = node.arguments[i];
                    if (isLiteral(arg) && typeof arg.value === "string") {
                      parts.push(arg.value);
                    }
                  }
                  parts.push(nodeFileName);
                  const absolutePath = path.join(...parts);

                  if (fs.existsSync(absolutePath)) {
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

                      const hashedFilename = generateHashedFilename(
                        nodeFileName,
                        hash
                      );

                      info = {
                        content,
                        hashedFilename,
                        originalPath: absolutePath,
                      };
                      nativeFiles.set(absolutePath, info);
                      hashedFilenameToPath.set(hashedFilename, absolutePath);
                    }

                    // Record the replacement for the string literal
                    replacements.push({
                      start: lastArg.start,
                      end: lastArg.end,
                      value: `'${info.hashedFilename}'`,
                    });
                    modified = true;
                  }
                }
              }
            }

            // Pattern 6b: Destructured join(__dirname, 'xxx.node') without path. prefix
            // Handles: const { join } = require('path'); join(__dirname, 'xxx.node')
            if (
              isIdentifier(calleeNode) &&
              calleeNode.name === "join" &&
              node.arguments.length >= 2
            ) {
              // Check if first arg is __dirname or a directory variable
              const firstArg = node.arguments[0];
              let baseDir: string | null = null;

              if (isIdentifier(firstArg) && firstArg.name === "__dirname") {
                baseDir = path.dirname(id);
              } else if (
                isIdentifier(firstArg) &&
                directoryVars.has(firstArg.name)
              ) {
                baseDir = directoryVars.get(firstArg.name)!;
              }

              if (baseDir) {
                // Check if last argument is a .node file string literal
                const lastArg = node.arguments[node.arguments.length - 1];
                if (
                  isLiteral(lastArg) &&
                  typeof lastArg.value === "string" &&
                  lastArg.value.endsWith(".node")
                ) {
                  const nodeFileName = lastArg.value;
                  // Resolve the full path
                  const parts: string[] = [baseDir];
                  for (let i = 1; i < node.arguments.length - 1; i++) {
                    const arg = node.arguments[i];
                    if (isLiteral(arg) && typeof arg.value === "string") {
                      parts.push(arg.value);
                    }
                  }
                  parts.push(nodeFileName);
                  const absolutePath = path.join(...parts);

                  if (fs.existsSync(absolutePath)) {
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

                      const hashedFilename = generateHashedFilename(
                        nodeFileName,
                        hash
                      );

                      info = {
                        content,
                        hashedFilename,
                        originalPath: absolutePath,
                      };
                      nativeFiles.set(absolutePath, info);
                      hashedFilenameToPath.set(hashedFilename, absolutePath);
                    }

                    // Record the replacement for the string literal
                    replacements.push({
                      start: lastArg.start,
                      end: lastArg.end,
                      value: `'${info.hashedFilename}'`,
                    });
                    modified = true;
                  }
                }
              }
            }

            // Pattern 7: npm package require that resolves to a .node file
            // Handles: require('@libsql/darwin-arm64') or require('native-addon')
            // where the package's main entry is a .node file
            if (
              isIdentifier(calleeNode) &&
              (calleeNode.name === "require" ||
                customRequireVars.has(calleeNode.name)) &&
              node.arguments.length === 1 &&
              isLiteral(node.arguments[0]) &&
              typeof node.arguments[0].value === "string"
            ) {
              const packageName = node.arguments[0].value as string;

              // Skip relative paths (already handled by Pattern 5)
              // Skip Node.js built-ins
              if (
                !packageName.startsWith(".") &&
                !packageName.startsWith("/") &&
                !packageName.startsWith("node:")
              ) {
                // Try to resolve the package and find a .node file
                const nodeFilePath = resolveNpmPackageNodeFile(
                  packageName,
                  path.dirname(id)
                );

                if (nodeFilePath) {
                  // Check if we already processed this file
                  let info = nativeFiles.get(nodeFilePath);

                  if (!info) {
                    // Generate hash and store
                    const content = fs.readFileSync(nodeFilePath);
                    const hash = crypto
                      .createHash("md5")
                      .update(content)
                      .digest("hex")
                      .slice(0, 8);

                    const filename = path.basename(nodeFilePath);
                    const hashedFilename = generateHashedFilename(
                      filename,
                      hash
                    );

                    info = {
                      content,
                      hashedFilename,
                      originalPath: nodeFilePath,
                    };
                    nativeFiles.set(nodeFilePath, info);
                    hashedFilenameToPath.set(hashedFilename, nodeFilePath);
                  }

                  // Record the replacement for the entire require call argument
                  const literalNode = node.arguments[0] as LiteralNode;
                  replacements.push({
                    start: literalNode.start,
                    end: literalNode.end,
                    value: `"./${info.hashedFilename}"`,
                  });
                  modified = true;
                }
              }
            }

            // Pattern 8: Template literal require with platform-specific packages
            // Handles: require(`@libsql/${target}`) or require(`@scope/${variable}`)
            // where the package name is dynamically constructed but follows platform patterns
            if (
              isIdentifier(calleeNode) &&
              (calleeNode.name === "require" ||
                customRequireVars.has(calleeNode.name)) &&
              node.arguments.length === 1 &&
              node.arguments[0].type === "TemplateLiteral"
            ) {
              const templateLiteral = node.arguments[0] as BaseASTNode & {
                quasis: Array<{ value: { raw: string; cooked: string } }>;
                expressions: BaseASTNode[];
              };

              // Check if this is a simple template like `@scope/${expr}`
              // We need at least one quasi (the prefix) and exactly one expression
              if (
                templateLiteral.quasis.length >= 1 &&
                templateLiteral.expressions.length >= 1
              ) {
                const prefix = templateLiteral.quasis[0].value.cooked;

                // Check if the prefix looks like a scoped package pattern
                // e.g., "@libsql/", "@scope/prefix-"
                if (prefix && prefix.startsWith("@") && prefix.includes("/")) {
                  // Try to find a matching platform-specific package
                  const result = findPlatformSpecificNativePackage(
                    prefix,
                    path.dirname(id)
                  );

                  if (result) {
                    const { nodeFilePath } = result;

                    // Check if we already processed this file
                    let info = nativeFiles.get(nodeFilePath);

                    if (!info) {
                      // Generate hash and store
                      const content = fs.readFileSync(nodeFilePath);
                      const hash = crypto
                        .createHash("md5")
                        .update(content)
                        .digest("hex")
                        .slice(0, 8);

                      const filename = path.basename(nodeFilePath);
                      const hashedFilename = generateHashedFilename(
                        filename,
                        hash
                      );

                      info = {
                        content,
                        hashedFilename,
                        originalPath: nodeFilePath,
                      };
                      nativeFiles.set(nodeFilePath, info);
                      hashedFilenameToPath.set(hashedFilename, nodeFilePath);
                    }

                    // Replace the entire template literal with the resolved path
                    const templateNode = node.arguments[0];
                    if (
                      templateNode.start !== undefined &&
                      templateNode.end !== undefined
                    ) {
                      replacements.push({
                        start: templateNode.start,
                        end: templateNode.end,
                        value: `"./${info.hashedFilename}"`,
                      });
                      modified = true;
                    }
                  }
                }
              }
            }
          }

          // Recursively walk child nodes
          for (const key in node) {
            if (key === "type" || key === "start" || key === "end") continue;
            const child = (node as unknown as Record<string, unknown>)[key];
            if (child && typeof child === "object") {
              if (Array.isArray(child)) {
                child.forEach((c) => {
                  if (c && typeof c === "object" && "type" in c) {
                    walk(c as BaseASTNode);
                  }
                });
              } else if ("type" in child) {
                walk(child as BaseASTNode);
              }
            }
          }
        };

        // Helper to resolve directory argument (__dirname, path.join, etc.)
        function resolveDirArgument(
          arg: BaseASTNode | undefined,
          currentFileId: string
        ): string | null {
          if (!arg) return null;

          // Case 1: __dirname
          if (isIdentifier(arg) && arg.name === "__dirname") {
            return path.dirname(currentFileId);
          }

          // Case 2: Variable that holds a directory path
          if (isIdentifier(arg) && directoryVars.has(arg.name)) {
            return directoryVars.get(arg.name)!;
          }

          // Case 3: String literal
          if (isLiteral(arg) && typeof arg.value === "string") {
            return path.resolve(path.dirname(currentFileId), arg.value);
          }

          // Case 4: require.resolve("./") - resolves to current directory
          if (isCallExpression(arg)) {
            const callee = arg.callee;

            // Check for require.resolve("./") pattern
            if (
              isMemberExpression(callee) &&
              isIdentifier(callee.object) &&
              callee.object.name === "require" &&
              isIdentifier(callee.property) &&
              callee.property.name === "resolve" &&
              arg.arguments.length === 1 &&
              isLiteral(arg.arguments[0]) &&
              arg.arguments[0].value === "./"
            ) {
              return path.dirname(currentFileId);
            }

            // Check for path.join, path.resolve, etc. (with any path module alias)
            if (
              isMemberExpression(callee) &&
              isIdentifier(callee.object) &&
              (pathModuleVars.has(callee.object.name) ||
                callee.object.name === "path") &&
              isIdentifier(callee.property)
            ) {
              const methodName = callee.property.name;
              if (methodName === "join" || methodName === "resolve") {
                if (arg.arguments.length === 0) return null;

                // Determine the base directory from the first argument
                let baseDir: string | null = null;
                let startIndex = 0;

                const firstArg = arg.arguments[0];
                if (isIdentifier(firstArg)) {
                  if (firstArg.name === "__dirname") {
                    baseDir = path.dirname(currentFileId);
                    startIndex = 1;
                  } else if (directoryVars.has(firstArg.name)) {
                    baseDir = directoryVars.get(firstArg.name)!;
                    startIndex = 1;
                  } else {
                    // Unknown variable
                    return null;
                  }
                } else if (
                  isLiteral(firstArg) &&
                  typeof firstArg.value === "string"
                ) {
                  // Absolute or relative path
                  baseDir = path.dirname(currentFileId);
                  startIndex = 0;
                } else {
                  // Complex expression
                  return null;
                }

                const parts: string[] = [baseDir];

                // Process remaining arguments
                for (let i = startIndex; i < arg.arguments.length; i++) {
                  const pathArg = arg.arguments[i];
                  if (isLiteral(pathArg) && typeof pathArg.value === "string") {
                    parts.push(pathArg.value);
                  } else if (
                    isIdentifier(pathArg) &&
                    directoryVars.has(pathArg.name)
                  ) {
                    // Another directory variable
                    parts.push(directoryVars.get(pathArg.name)!);
                  } else {
                    // Can't resolve
                    return null;
                  }
                }

                return path.join(...parts);
              }
            }
          }

          return null;
        }

        // Helper to process a found .node file and replace the call expression
        function processNodeFile(
          nodeFilePath: string,
          callNode: CallExpressionNode
        ): void {
          // Check if we already processed this file
          let info = nativeFiles.get(nodeFilePath);

          if (!info) {
            // Generate hash and store
            const content = fs.readFileSync(nodeFilePath);
            const hash = crypto
              .createHash("md5")
              .update(content)
              .digest("hex")
              .slice(0, 8);

            const filename = path.basename(nodeFilePath);
            const hashedFilename = generateHashedFilename(filename, hash);

            info = {
              content,
              hashedFilename,
              originalPath: nodeFilePath,
            };
            nativeFiles.set(nodeFilePath, info);
            // Track reverse mapping for resolveId hook
            hashedFilenameToPath.set(hashedFilename, nodeFilePath);
          }

          // Determine how to generate the replacement code
          let replacementCode: string;

          if (isESModule) {
            // For ES6 modules, use inline createRequire(import.meta.url)() call
            // Use the tracked local name if available, otherwise use 'createRequire'
            const funcName = createRequireLocalName || "createRequire";
            replacementCode = `${funcName}(import.meta.url)("./${info.hashedFilename}")`;
          } else {
            // For CommonJS, use require()
            replacementCode = `require("./${info.hashedFilename}")`;
          }

          // Replace the entire call expression
          replacements.push({
            start: callNode.start,
            end: callNode.end,
            value: replacementCode,
          });
          modified = true;

          // Track that we replaced a node-gyp-build usage
          nodeGypBuildUsageCount++;
        }

        walk(ast);

        // Remove unused node-gyp-build imports if we replaced all usages
        if (nodeGypBuildUsageCount > 0 && nodeGypBuildImportNodes.length > 0) {
          // Remove the tracked import/require statements
          for (const importNode of nodeGypBuildImportNodes) {
            if (
              importNode.start !== undefined &&
              importNode.end !== undefined
            ) {
              // For ImportDeclaration, remove the entire statement including newline
              if (importNode.type === "ImportDeclaration") {
                replacements.push({
                  start: importNode.start,
                  end: importNode.end,
                  value: "",
                });
                modified = true;
              }
              // For VariableDeclarator (require), remove just the declarator
              // We'll leave the const/let/var keyword if there are other declarators
              else if (importNode.type === "VariableDeclarator") {
                replacements.push({
                  start: importNode.start,
                  end: importNode.end,
                  value: "",
                });
                modified = true;
              }
            }
          }
        }

        // Remove unused bindings imports if we replaced all usages
        if (bindingsUsageCount > 0 && bindingsImportNodes.length > 0) {
          // Remove the tracked import/require statements
          for (const importNode of bindingsImportNodes) {
            if (
              importNode.start !== undefined &&
              importNode.end !== undefined
            ) {
              // For ImportDeclaration, remove the entire statement
              if (importNode.type === "ImportDeclaration") {
                replacements.push({
                  start: importNode.start,
                  end: importNode.end,
                  value: "",
                });
                modified = true;
              }
              // For VariableDeclarator (require), remove just the declarator
              else if (importNode.type === "VariableDeclarator") {
                replacements.push({
                  start: importNode.start,
                  end: importNode.end,
                  value: "",
                });
                modified = true;
              }
            }
          }
        }

        // Apply replacements in reverse order to maintain correct positions
        if (modified) {
          let newCode = code;

          // For ES6 modules, we need to inject createRequire if not already present
          let createRequireInjection = "";

          // Only inject createRequire infrastructure if we actually modified something (replaced node-gyp-build)
          if (isESModule && modified && !hasCreateRequireImport) {
            createRequireInjection =
              "import { createRequire } from 'module';\n";
            // Set the local name since we're creating the import
            createRequireLocalName = "createRequire";
          }

          // Apply replacements and injections in correct order
          // Strategy: Build up the injections to prepend, then apply replacements

          let codePrefix = "";

          // Add createRequire import if needed
          if (createRequireInjection) {
            codePrefix += createRequireInjection;
          }

          // Apply replacements to the code (in reverse order to maintain positions)
          replacements
            .sort((a, b) => b.start - a.start)
            .forEach((replacement) => {
              newCode =
                newCode.slice(0, replacement.start) +
                replacement.value +
                newCode.slice(replacement.end);
            });

          // If we have injections, we need to insert them after existing imports
          if (codePrefix) {
            // Find the position after the last import in the (potentially modified) code
            // We'll look for the last "import" statement and insert after it
            const importRegex = /^import\s+.*?;?\s*$/gm;
            let lastImportMatch;
            let match;
            while ((match = importRegex.exec(newCode)) !== null) {
              lastImportMatch = match;
            }

            if (lastImportMatch) {
              // Insert after the last import
              const insertPos =
                lastImportMatch.index + lastImportMatch[0].length;
              newCode =
                newCode.slice(0, insertPos) +
                "\n" +
                codePrefix +
                newCode.slice(insertPos);
            } else {
              // No imports found, prepend to the file
              newCode = codePrefix + "\n" + newCode;
            }
          }

          return { code: newCode, map: null };
        }
      } catch (error) {
        // If parsing fails, log and skip transformation
        console.warn(
          `Failed to parse ${id} for native module transformation:`,
          error
        );
        return null;
      }

      return null;
    },
  };
}
