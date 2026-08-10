import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, RollupCommonJSOptions } from "vite";

interface NativeSidecarFileInfo {
  /** File content for emission */
  content: Buffer;
  /** Preserved filename required by the native dynamic linker */
  filename: string;
  /** Absolute path to the original runtime file */
  originalPath: string;
}

interface NativeFileInfo {
  /** File content for emission */
  content: Buffer;
  /** Hashed filename for output (e.g., addon-a1b2c3d4.node) */
  hashedFilename: string;
  /** Absolute path to the original .node file */
  originalPath: string;
  /** Runtime libraries that must remain next to the native addon */
  sidecarFiles: NativeSidecarFileInfo[];
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

interface UnaryExpressionNode extends BaseASTNode {
  type: "UnaryExpression";
  operator: string;
  argument: BaseASTNode;
}

interface IfStatementNode extends BaseASTNode {
  type: "IfStatement";
  test: BaseASTNode;
  consequent: BaseASTNode;
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

function isVariableDeclarator(node: BaseASTNode): node is VariableDeclaratorNode {
  return node.type === "VariableDeclarator";
}

function isUnaryExpression(node: BaseASTNode): node is UnaryExpressionNode {
  return node.type === "UnaryExpression";
}

function isIfStatement(node: BaseASTNode): node is IfStatementNode {
  return node.type === "IfStatement";
}

function isImportDeclaration(node: BaseASTNode): node is ImportDeclarationNode {
  return node.type === "ImportDeclaration";
}

function isImportDefaultSpecifier(node: BaseASTNode): node is ImportDefaultSpecifierNode {
  return node.type === "ImportDefaultSpecifier";
}

function isImportSpecifier(node: BaseASTNode): node is ImportSpecifierNode {
  return node.type === "ImportSpecifier";
}

export default function nativeFilePlugin(options: NativeFilePluginOptions = {}): Plugin {
  const name = "plugin-native-modules";
  const nativeRequireSuffix = "?native-require";
  const nativeRequireQuery = "?native-require=";
  const nativeFiles = new Map<string, NativeFileInfo>();
  const pendingEmittedFilesByOutput = new Map<string, Set<string>>();
  const nativeRequirePaths = new Map<string, string>();
  // Reverse mapping from hashed filename to original file path
  // Used to resolve transformed bindings/node-gyp-build calls
  const hashedFilenameToPath = new Map<string, string>();
  // Track the output format from Vite config
  // This determines whether we generate ESM or CJS code in the load hook
  let outputFormat: "es" | "cjs" = "es"; // Default to ESM (Vite's default)
  let requireReturnsDefault: RollupCommonJSOptions["requireReturnsDefault"];
  let command: "build" | "serve" = "build";
  let shouldEmptyOutDir = true;
  let root = process.cwd();
  let defaultOutDir = "dist";

  function resolveOutputDirectory(outputOptions: { dir?: string; file?: string }): string {
    if (outputOptions.dir) {
      return path.resolve(root, outputOptions.dir);
    }
    if (outputOptions.file) {
      return path.dirname(path.resolve(root, outputOptions.file));
    }
    return path.resolve(root, defaultOutDir);
  }

  function outputFileMatches(outputDirectory: string, fileName: string, content: Buffer): boolean {
    try {
      return fs.readFileSync(path.join(outputDirectory, fileName)).equals(content);
    } catch {
      return false;
    }
  }

  function commonJSRequireReturnsDefault(nativeFilePath: string): boolean {
    const virtualId = `\0native:${nativeFilePath}${nativeRequireSuffix}`;
    const option =
      typeof requireReturnsDefault === "function"
        ? requireReturnsDefault(virtualId)
        : requireReturnsDefault;

    // The internal require wrapper has an explicit named export, so "auto"
    // keeps returning its namespace. These modes always return its default.
    return option === true || option === "preferred";
  }

  function nativeRequireToken(nativeFilePath: string): string {
    const token = crypto.createHash("sha256").update(nativeFilePath).digest("hex");
    nativeRequirePaths.set(token, nativeFilePath);
    return token;
  }

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
      if (code.includes("import ") || code.includes("export ") || code.includes("import.meta")) {
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
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
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

    const normalizedCurrentFileId = currentFileId.replace(/\\/g, "/");
    const normalizedFilePath = filePath.replace(/\\/g, "/");

    // Check additional native file configurations
    if (options.additionalNativeFiles) {
      for (const pkgConfig of options.additionalNativeFiles) {
        // Check if current file is within this package's node_modules
        const pkgPath = `node_modules/${pkgConfig.package}`;
        if (normalizedCurrentFileId.includes(pkgPath)) {
          // Check if this file matches any of the configured file names
          for (const fileName of pkgConfig.fileNames) {
            if (
              normalizedFilePath.endsWith(fileName) ||
              normalizedFilePath.includes(`/${fileName}`)
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
    const prebuildsDir = path.join(directory, "prebuilds", `${platform}-${arch}`);

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

  // Resolve the platform layout emitted by swift-node 0.1.0. macOS binaries
  // sit beside the generated loader, while Linux and Windows use a
  // target-qualified subdirectory for the addon and runtime sidecars.
  function resolveSwiftNodeAddon(
    directory: string,
    moduleName: string,
  ): { nodeFilePath: string; sidecarPaths: string[] } | null {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const isMusl = process.platform === "linux" && !report?.header?.glibcVersionRuntime;
    const target = `${process.platform}-${process.arch}${isMusl ? "-musl" : ""}`;
    const binaryName = `${moduleName}.${target}.node`;
    const binaryPath = path.join(
      directory,
      ...(process.platform === "darwin" ? [] : [target]),
      binaryName,
    );

    if (!fs.existsSync(binaryPath)) return null;

    // Linux and Windows resolve the Swift runtime beside the addon. Keep their
    // original filenames because the native dynamic linker references them.
    const sidecarPaths =
      process.platform === "darwin"
        ? []
        : fs
            .readdirSync(path.dirname(binaryPath))
            .filter((filename) =>
              process.platform === "win32"
                ? filename.toLowerCase().endsWith(".dll")
                : /\.so(?:\..+)?$/i.test(filename),
            )
            .map((filename) => path.join(path.dirname(binaryPath), filename));

    return { nodeFilePath: binaryPath, sidecarPaths };
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
  function resolveBindings(directory: string, moduleName: string): string | null {
    // Ensure moduleName has .node extension
    const nodeFileName = moduleName.endsWith(".node") ? moduleName : `${moduleName}.node`;

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
  function resolveNpmPackageNodeFile(packageName: string, fromDir: string): string | null {
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
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

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
    fromDir: string,
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

                if (lowerPkg.includes(lowerPlatform) && lowerPkg.includes(lowerArch)) {
                  const packageName = `${scopeName}/${pkg}`;
                  const result = resolveNpmPackageNodeFile(packageName, currentDir);
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

  // Helper function to extract package name from a file path
  // For paths like /node_modules/@libsql/darwin-arm64/index.node -> libsql-darwin-arm64
  // For paths like /node_modules/sql/native.node -> sql
  function extractPackageName(filePath: string): string | null {
    const nodeModulesMatch = filePath.match(/node_modules[/\\](@[^/\\]+[/\\][^/\\]+|[^/\\]+)/);
    if (nodeModulesMatch) {
      // Convert to file-safe format: @scope/package -> scope-package (remove @ and replace slashes)
      return nodeModulesMatch[1].replace(/^@/, "").replace(/[/\\]/g, "-");
    }
    return null;
  }

  // Helper function to generate hashed filename based on format option
  // originalPath is optional - when provided, we can extract package name for prefix
  function generateHashedFilename(
    originalFilename: string,
    hash: string,
    originalPath?: string,
  ): string {
    const lastDotIndex = originalFilename.lastIndexOf(".");
    const extension = lastDotIndex > 0 ? originalFilename.slice(lastDotIndex) : "";
    const baseName = lastDotIndex > 0 ? originalFilename.slice(0, lastDotIndex) : originalFilename;

    if (options.filenameFormat === "hash-only") {
      // Hash-only format: HASH.node
      return `${hash.toUpperCase()}${extension}`;
    } else {
      // Preserve format (default): packagename-filename-HASH.node
      // Extract package name if we have the original path
      let prefix = "";
      if (originalPath) {
        const packageName = extractPackageName(originalPath);
        if (packageName) {
          prefix = `${packageName}-`;
        }
      }
      return `${prefix}${baseName}-${hash.toUpperCase()}${extension}`;
    }
  }

  function addNativeSidecarFiles(info: NativeFileInfo, sidecarPaths: string[]): void {
    for (const sidecarPath of sidecarPaths) {
      if (info.sidecarFiles.some((sidecar) => sidecar.originalPath === sidecarPath)) continue;

      const sidecar: NativeSidecarFileInfo = {
        content: fs.readFileSync(sidecarPath),
        filename: path.basename(sidecarPath),
        originalPath: sidecarPath,
      };
      const sameFilename = info.sidecarFiles.find(
        (existing) => existing.filename === sidecar.filename,
      );
      if (sameFilename && !sameFilename.content.equals(sidecar.content)) {
        throw new Error(
          `Native runtime files produced the same output name with different contents: ${sidecar.filename}`,
        );
      }
      if (!sameFilename) info.sidecarFiles.push(sidecar);
    }
  }

  // Helper to register a native file and return its info
  // Centralizes the hash generation, storage, and reverse mapping logic
  function registerNativeFile(absolutePath: string, sidecarPaths: string[] = []): NativeFileInfo {
    let info = nativeFiles.get(absolutePath);
    if (!info) {
      const content = fs.readFileSync(absolutePath);
      const hash = crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
      const filename = path.basename(absolutePath);
      const hashedFilename = generateHashedFilename(filename, hash, absolutePath);
      info = {
        content,
        hashedFilename,
        originalPath: absolutePath,
        sidecarFiles: [],
      };
      nativeFiles.set(absolutePath, info);
      nativeRequireToken(absolutePath);
      hashedFilenameToPath.set(hashedFilename, absolutePath);
    }
    addNativeSidecarFiles(info, sidecarPaths);
    return info;
  }

  // Helper to detect module type using Rollup context if available, with fallback
  // Centralizes the try/catch pattern used in multiple places
  function detectModuleTypeWithContext(
    context: { getModuleInfo?: (id: string) => unknown },
    fileId: string,
    code?: string,
  ): boolean {
    try {
      if (typeof context.getModuleInfo === "function") {
        const moduleInfo = context.getModuleInfo(fileId);
        const format = (moduleInfo as { format?: string })?.format;
        if (format) {
          return format === "es";
        }
      }
    } catch {
      // Fall through to fallback
    }
    return detectModuleType(fileId, code);
  }

  const plugin: Plugin = {
    buildStart() {
      // A pending emission belongs only to its current build attempt. If that
      // build failed before the output write, the next watch build must try again.
      pendingEmittedFilesByOutput.clear();
    },

    configResolved(config) {
      command = config.command;
      root = path.resolve(config.root ?? process.cwd());
      defaultOutDir = config.build?.outDir ?? "dist";
      requireReturnsDefault = config.build?.commonjsOptions?.requireReturnsDefault;

      // Detect the wrapper format from Vite config.
      // Priority: rollupOptions.output.format > lib.formats > default (es).
      // Rollup's load hook is called once per module rather than once per output,
      // so mixed-format builds must use the ESM wrapper. Rollup can lower that
      // wrapper to CommonJS while keeping createRequire() for ESM output.
      const rollupOutput = config.build?.rollupOptions?.output;
      const configuredOutputs = Array.isArray(rollupOutput) ? rollupOutput : [rollupOutput];
      const allOutputsAreInsideRoot = configuredOutputs.every((output) => {
        const outputDirectory = path.resolve(root, output?.dir ?? defaultOutDir);
        const relativeOutputDirectory = path.relative(root, outputDirectory);

        return (
          relativeOutputDirectory !== "" &&
          relativeOutputDirectory !== ".." &&
          !relativeOutputDirectory.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeOutputDirectory)
        );
      });

      // Vite defaults emptyOutDir to true only when every output is inside root.
      shouldEmptyOutDir = config.build?.emptyOutDir ?? allOutputsAreInsideRoot;

      if (rollupOutput) {
        // rollupOptions.output can be an object or array of objects
        const formats = Array.isArray(rollupOutput)
          ? rollupOutput.map((output) => output?.format)
          : [rollupOutput.format];
        outputFormat = formats.every((format) => format === "cjs" || format === "commonjs")
          ? "cjs"
          : "es";
      } else if (config.build?.lib) {
        // lib mode
        // lib can be false or LibraryOptions, check for formats property
        const lib = config.build.lib;
        if (typeof lib === "object" && lib.formats) {
          const formats = lib.formats;
          outputFormat = formats.every((format) => format === "cjs") ? "cjs" : "es";
        }
      }
      // Otherwise keep default 'es' (Vite's default for modern builds)
    },

    generateBundle(outputOptions, bundle, isWrite) {
      const outputDirectory = resolveOutputDirectory(outputOptions);
      const nativeFilesByOutputName = new Map<string, Buffer>();
      const renderedBundleCode = Object.values(bundle)
        .filter((output) => output.type === "chunk")
        .map((chunk) => chunk.code)
        .join("\n");
      const reuseWrittenAssets = this.meta?.watchMode && isWrite && !shouldEmptyOutDir;
      let pendingEmittedFiles = pendingEmittedFilesByOutput.get(outputDirectory);

      if (reuseWrittenAssets && !pendingEmittedFiles) {
        pendingEmittedFiles = new Set<string>();
        pendingEmittedFilesByOutput.set(outputDirectory, pendingEmittedFiles);
      }

      // Emit each .node file as an asset
      nativeFiles.forEach((info) => {
        // Native files are registered while modules are transformed, before
        // Rollup tree-shakes their code. Emit only the files still referenced
        // by a rendered chunk.
        if (!renderedBundleCode.includes(info.hashedFilename)) return;

        const outputFiles = [
          { content: info.content, fileName: info.hashedFilename },
          ...info.sidecarFiles.map((sidecar) => ({
            content: sidecar.content,
            fileName: sidecar.filename,
          })),
        ];

        for (const outputFile of outputFiles) {
          const existingInfo = nativeFilesByOutputName.get(outputFile.fileName);
          if (existingInfo) {
            if (!existingInfo.equals(outputFile.content)) {
              throw new Error(
                `Native files produced the same output name with different contents: ${outputFile.fileName}`,
              );
            }
            continue;
          }
          nativeFilesByOutputName.set(outputFile.fileName, outputFile.content);

          // Only emit once in watch mode (and when emptyOutDir isn't deleting the files) because file
          // writes may fail if the file is already in use by a running app, especially on Windows.
          if (
            reuseWrittenAssets &&
            (pendingEmittedFiles?.has(outputFile.fileName) ||
              outputFileMatches(outputDirectory, outputFile.fileName, outputFile.content))
          ) {
            continue;
          }

          this.emitFile({
            fileName: outputFile.fileName,
            source: outputFile.content,
            type: "asset",
          });

          if (reuseWrittenAssets) {
            pendingEmittedFiles!.add(outputFile.fileName);
          }
        }
      });
    },

    load(id) {
      if (!id.startsWith("\0native:")) return null;

      const isRequireWrapper = id.endsWith(nativeRequireSuffix);
      const originalPath = id.slice(
        "\0native:".length,
        isRequireWrapper ? -nativeRequireSuffix.length : undefined,
      );
      const info = nativeFiles.get(originalPath);

      if (!info) return null;

      // Generate code based on OUTPUT format, not the importer's format.
      // This is important because:
      // 1. Using CJS require() in an ESM output causes "Cannot determine intended
      //    module format because both require() and top-level await are present"
      // 2. CJS-only builds can use a compact raw require(), while mixed builds
      //    need the ESM wrapper that Rollup can lower for their CJS output
      // 3. The configured output formats matter more than the importer's format
      if (outputFormat === "es") {
        return `
import { createRequire } from 'node:module';
const __require = createRequire(import.meta.url);
const nativeModule = __require('./${info.hashedFilename}');
${isRequireWrapper ? "export const __vitePluginNativeModule = true;" : ""}
export default nativeModule;
`;
      } else {
        return `
const nativeModule = require('./${info.hashedFilename}');
${isRequireWrapper ? "export const __vitePluginNativeModule = true;" : ""}
export default nativeModule;
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
        const queryIndex = source.indexOf(nativeRequireQuery);
        const requireToken =
          queryIndex >= 0
            ? source.slice(queryIndex + nativeRequireQuery.length).split("&")[0]
            : null;
        const queriedPath = requireToken ? nativeRequirePaths.get(requireToken) : undefined;
        const queriedInfo = queriedPath ? nativeFiles.get(queriedPath) : null;
        const isRequireWrapper = queriedInfo?.hashedFilename === basename;
        const originalPath = isRequireWrapper ? queriedPath! : hashedFilenameToPath.get(basename)!;
        const virtualId = `\0native:${originalPath}${isRequireWrapper ? nativeRequireSuffix : ""}`;

        // Use syntheticNamedExports to enable named import/destructuring patterns
        // like `const { databaseOpen } = require('native-module')` or `import { foo } from 'native'`.
        // This tells Rollup to derive named exports from the default export's properties.
        //
        // Note: This is incompatible with `export * from 'native-module'` patterns because
        // Rollup cannot enumerate synthetic exports at bundle time. If you encounter errors
        // with export * re-exports, consider restructuring to use named imports instead.
        return {
          id: virtualId,
          syntheticNamedExports: true,
        };
      }

      // Check if this file should be processed
      if (!shouldProcessFile(source, importer)) return null;

      // Resolve the path
      const resolved = path.resolve(path.dirname(importer), source);

      // Check if file exists
      if (!fs.existsSync(resolved)) return null;

      // Register the native file (generates hash, stores mapping)
      registerNativeFile(resolved);

      // Return virtual module ID
      const virtualId = `\0native:${resolved}`;
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
      const hasTemplateLiteralNativePackage = /require\s*\(\s*`@[a-z0-9-]+\//.test(code);

      if (
        !code.includes(".node") &&
        !code.includes("node-gyp-build") &&
        !hasBindingsPackage &&
        !hasTemplateLiteralNativePackage
      )
        return null;

      let modified = false;
      const replacements: Array<{ start: number; end: number; value: string }> = [];

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

        // Track variables that hold statically evaluable strings and native file paths.
        // Swift-node loaders use these to construct target-qualified addon filenames.
        const staticStringVars = new Map<string, string>();
        const nativeFilePathVars = new Map<string, string>();
        const nativePathPreflightGuards = new Map<string, IfStatementNode>();
        const removedNativePathPreflightGuards = new Set<IfStatementNode>();
        const swiftNodeAddonResolvers = new Set<string>();

        // Track module aliases for path and url modules
        const pathModuleVars = new Set<string>(); // Variables that reference 'path' module
        const pathDirnameVars = new Set<string>(); // Named dirname imports from 'path'
        const pathJoinVars = new Set<string>(); // Named join imports from 'path'
        const pathResolveVars = new Set<string>(); // Named resolve imports from 'path'
        const fileURLToPathVars = new Set<string>(); // Variables that reference 'fileURLToPath'

        // Detect if this is an ES6 module (vs CommonJS)
        let isESModule = detectModuleTypeWithContext(this, id, code);
        let hasCreateRequireImport = false;

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
              if (metaProp.meta.name === "import" && metaProp.property.name === "meta") {
                return true;
              }
            }

            // Fallback: Check legacy structure (MemberExpression)
            if (
              isMemberExpression(metaExpr.object) &&
              isIdentifier((metaExpr.object as MemberExpressionNode).object) &&
              ((metaExpr.object as MemberExpressionNode).object as IdentifierNode).name ===
                "import" &&
              isIdentifier((metaExpr.object as MemberExpressionNode).property) &&
              ((metaExpr.object as MemberExpressionNode).property as IdentifierNode).name ===
                "meta" &&
              isIdentifier(metaExpr.property) &&
              (metaExpr.property as IdentifierNode).name === "url"
            ) {
              return true;
            }
          }

          return false;
        }

        function resolveStaticString(node: BaseASTNode): string | null {
          if (isLiteral(node) && typeof node.value === "string") {
            return node.value;
          }

          if (isIdentifier(node)) {
            return staticStringVars.get(node.name) ?? null;
          }

          if (isMemberExpression(node)) {
            if (
              isIdentifier(node.object) &&
              node.object.name === "process" &&
              isIdentifier(node.property)
            ) {
              if (node.property.name === "platform") return process.platform;
              if (node.property.name === "arch") return process.arch;
            }
            return null;
          }

          if (node.type === "TemplateLiteral") {
            const template = node as BaseASTNode & {
              expressions: BaseASTNode[];
              quasis: Array<{ value: { cooked: string | null } }>;
            };
            let value = template.quasis[0]?.value.cooked;
            if (value === null || value === undefined) return null;

            for (let index = 0; index < template.expressions.length; index++) {
              const expressionValue = resolveStaticString(template.expressions[index]);
              const suffix = template.quasis[index + 1]?.value.cooked;
              if (expressionValue === null || suffix === null || suffix === undefined) return null;
              value += expressionValue + suffix;
            }

            return value;
          }

          if (node.type === "BinaryExpression") {
            const expression = node as BaseASTNode & {
              left: BaseASTNode;
              operator: string;
              right: BaseASTNode;
            };
            if (expression.operator !== "+") return null;

            const left = resolveStaticString(expression.left);
            const right = resolveStaticString(expression.right);
            return left === null || right === null ? null : left + right;
          }

          return null;
        }

        function nativePathPreflightGuardVariable(node: BaseASTNode): string | null {
          if (!isIfStatement(node) || node.consequent.type !== "ThrowStatement") return null;
          if (!isUnaryExpression(node.test) || node.test.operator !== "!") return null;
          if (!isCallExpression(node.test.argument) || node.test.argument.arguments.length !== 1)
            return null;

          const [argument] = node.test.argument.arguments;
          if (!isIdentifier(argument)) return null;

          const callee = node.test.argument.callee;
          if (isIdentifier(callee) && callee.name === "existsSync") return argument.name;
          if (
            isMemberExpression(callee) &&
            isIdentifier(callee.property) &&
            callee.property.name === "existsSync"
          ) {
            return argument.name;
          }

          return null;
        }

        function removeNativePathPreflightGuard(variableName: string): void {
          const guard = nativePathPreflightGuards.get(variableName);
          if (
            !guard ||
            removedNativePathPreflightGuards.has(guard) ||
            guard.start === undefined ||
            guard.end === undefined
          )
            return;

          replacements.push({ start: guard.start, end: guard.end, value: "" });
          removedNativePathPreflightGuards.add(guard);
          modified = true;
        }

        // Helper to resolve directory from a CallExpression (path.dirname, path.resolve, etc.)
        function resolveDirectoryFromCall(
          callNode: CallExpressionNode,
          currentFileId: string,
        ): string | null {
          const callee = callNode.callee;

          // Check for path.dirname(), pathAlias.dirname(), or named path imports.
          let methodName: "dirname" | "join" | "resolve" | null = null;
          if (
            isMemberExpression(callee) &&
            isIdentifier(callee.object) &&
            (pathModuleVars.has(callee.object.name) || callee.object.name === "path") &&
            isIdentifier(callee.property) &&
            (callee.property.name === "dirname" ||
              callee.property.name === "join" ||
              callee.property.name === "resolve")
          ) {
            methodName = callee.property.name;
          } else if (isIdentifier(callee)) {
            if (pathDirnameVars.has(callee.name)) methodName = "dirname";
            else if (pathJoinVars.has(callee.name) || callee.name === "join") methodName = "join";
            else if (pathResolveVars.has(callee.name)) methodName = "resolve";
          }

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
            } else if (resolveStaticString(firstArg) !== null) {
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
              const staticValue = resolveStaticString(arg);
              if (staticValue !== null) {
                parts.push(staticValue);
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
                if (isImportDefaultSpecifier(specifier) && isIdentifier(specifier.local)) {
                  pathModuleVars.add(specifier.local.name);
                } else if (
                  isImportSpecifier(specifier) &&
                  isIdentifier(specifier.imported) &&
                  isIdentifier(specifier.local)
                ) {
                  if (specifier.imported.name === "dirname")
                    pathDirnameVars.add(specifier.local.name);
                  if (specifier.imported.name === "join") pathJoinVars.add(specifier.local.name);
                  if (specifier.imported.name === "resolve")
                    pathResolveVars.add(specifier.local.name);
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
                if (isImportDefaultSpecifier(specifier) && isIdentifier(specifier.local)) {
                  nodeGypBuildVars.add(specifier.local.name);
                }
              }
            }

            // Track bindings imports
            if (source === "bindings") {
              // Track the import statement node for potential removal
              bindingsImportNodes.push(node);
              for (const specifier of node.specifiers) {
                if (isImportDefaultSpecifier(specifier) && isIdentifier(specifier.local)) {
                  bindingsVars.add(specifier.local.name);
                }
              }
            }
          }

          // swift-node 0.1.0 generates a resolver function which picks the
          // target-qualified addon path before passing it to require(). Track
          // only functions whose bodies match that generated loader pattern.
          if (node.type === "FunctionDeclaration") {
            const functionNode = node as BaseASTNode & { id?: BaseASTNode };
            const functionName = functionNode.id;
            const functionCode =
              node.start !== undefined && node.end !== undefined
                ? code.slice(node.start, node.end)
                : "";
            if (
              functionName &&
              isIdentifier(functionName) &&
              functionCode.includes("process.platform") &&
              functionCode.includes("path.join") &&
              functionCode.includes("existsSync") &&
              functionCode.includes(".node")
            ) {
              swiftNodeAddonResolvers.add(functionName.name);
            }
          }

          const guardedVariable = nativePathPreflightGuardVariable(node);
          if (guardedVariable) {
            nativePathPreflightGuards.set(guardedVariable, node as IfStatementNode);
          }

          // Track variable declarations
          if (isVariableDeclarator(node)) {
            if (isIdentifier(node.id) && node.init) {
              const varName = node.id.name;
              const staticString = resolveStaticString(node.init);
              if (staticString !== null) {
                staticStringVars.set(varName, staticString);
              }

              // Track directory variable assignments
              // Pattern 1: var t = __dirname
              if (isIdentifier(node.init) && node.init.name === "__dirname") {
                directoryVars.set(varName, path.dirname(id));
              }
              // Pattern 2: var t = otherDirVar (copy directory from another variable)
              else if (isIdentifier(node.init) && directoryVars.has(node.init.name)) {
                directoryVars.set(varName, directoryVars.get(node.init.name)!);
              }
              // Pattern 3: var t = path.dirname(fileURLToPath(import.meta.url)) or path.resolve/join
              else if (isCallExpression(node.init)) {
                const resolvedDir = resolveDirectoryFromCall(node.init, id);
                if (resolvedDir) {
                  directoryVars.set(varName, resolvedDir);
                  if (resolvedDir.endsWith(".node") && fs.existsSync(resolvedDir)) {
                    nativeFilePathVars.set(varName, resolvedDir);
                  }
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
                  (calleeNode.name === "require" || customRequireVars.has(calleeNode.name)) &&
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
                  (calleeNode.name === "require" || customRequireVars.has(calleeNode.name)) &&
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
            else if (isIdentifier(calleeNode) && nodeGypBuildVars.has(calleeNode.name)) {
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
                    isLiteral(prop.value),
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
                    isLiteral(prop.value),
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
                const absolutePath = path.resolve(path.dirname(id), relativePath);

                if (fs.existsSync(absolutePath)) {
                  const info = registerNativeFile(absolutePath);
                  replacements.push({
                    start: literalNode.start,
                    end: literalNode.end,
                    value: `"./${info.hashedFilename}"`,
                  });
                  modified = true;
                }
              }
            }

            // Pattern 5b: Native paths assembled in variables. swift-node packages
            // use `join(packageDirectory, \`addon.${target}.node\`)` and pass the
            // resulting variable to a createRequire() function.
            if (
              isIdentifier(calleeNode) &&
              (calleeNode.name === "require" || customRequireVars.has(calleeNode.name)) &&
              node.arguments.length === 1 &&
              isIdentifier(node.arguments[0])
            ) {
              const nodeFilePath = nativeFilePathVars.get(node.arguments[0].name);
              if (nodeFilePath) {
                processNodeFile(nodeFilePath, node);
                removeNativePathPreflightGuard(node.arguments[0].name);
              }
            }

            // Pattern 5c: swift-node 0.1.0 resolves its addon through a local
            // function before passing it to require(resolveAddonPath(...)).
            if (
              isIdentifier(calleeNode) &&
              (calleeNode.name === "require" || customRequireVars.has(calleeNode.name)) &&
              node.arguments.length === 1 &&
              isCallExpression(node.arguments[0]) &&
              isIdentifier(node.arguments[0].callee) &&
              swiftNodeAddonResolvers.has(node.arguments[0].callee.name)
            ) {
              const resolverCall = node.arguments[0];
              const directory = resolveDirArgument(resolverCall.arguments[0], id);
              const moduleName = resolverCall.arguments[1]
                ? resolveStaticString(resolverCall.arguments[1])
                : null;
              if (directory && moduleName) {
                const resolvedAddon = resolveSwiftNodeAddon(directory, moduleName);
                if (resolvedAddon) {
                  processNodeFile(resolvedAddon.nodeFilePath, node, resolvedAddon.sidecarPaths);
                }
              }
            }

            // Pattern 6 & 6b: NAPI-RS style path.join/__dirname patterns
            // Pattern 6: path.join(__dirname, 'xxx.node') or pathAlias.join(__dirname, 'xxx.node')
            // Pattern 6b: join(__dirname, 'xxx.node') (destructured)
            // Used by NAPI-RS loaders like libsql-js: existsSync(join(__dirname, 'libsql.darwin-arm64.node'))
            const isPathJoinCall =
              (isMemberExpression(calleeNode) &&
                isIdentifier(calleeNode.object) &&
                (pathModuleVars.has(calleeNode.object.name) || calleeNode.object.name === "path") &&
                isIdentifier(calleeNode.property) &&
                (calleeNode.property.name === "join" || calleeNode.property.name === "resolve")) ||
              (isIdentifier(calleeNode) &&
                (calleeNode.name === "join" || pathJoinVars.has(calleeNode.name)));

            if (isPathJoinCall && node.arguments.length >= 2) {
              // Resolve base directory from first argument
              const firstArg = node.arguments[0];
              let baseDir: string | null = null;

              if (isIdentifier(firstArg) && firstArg.name === "__dirname") {
                baseDir = path.dirname(id);
              } else if (isIdentifier(firstArg) && directoryVars.has(firstArg.name)) {
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
                  // Resolve the full path from all arguments
                  const parts: string[] = [baseDir];
                  for (let i = 1; i < node.arguments.length; i++) {
                    const arg = node.arguments[i];
                    if (isLiteral(arg) && typeof arg.value === "string") {
                      parts.push(arg.value);
                    }
                  }
                  const absolutePath = path.join(...parts);

                  if (fs.existsSync(absolutePath)) {
                    const info = registerNativeFile(absolutePath);
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
              (calleeNode.name === "require" || customRequireVars.has(calleeNode.name)) &&
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
                const nodeFilePath = resolveNpmPackageNodeFile(packageName, path.dirname(id));

                if (nodeFilePath) {
                  const info = registerNativeFile(nodeFilePath);
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
              (calleeNode.name === "require" || customRequireVars.has(calleeNode.name)) &&
              node.arguments.length === 1 &&
              node.arguments[0].type === "TemplateLiteral"
            ) {
              const templateLiteral = node.arguments[0] as BaseASTNode & {
                quasis: Array<{ value: { raw: string; cooked: string } }>;
                expressions: BaseASTNode[];
              };

              // Check if this is a simple template like `@scope/${expr}`
              // We need at least one quasi (the prefix) and exactly one expression
              if (templateLiteral.quasis.length >= 1 && templateLiteral.expressions.length >= 1) {
                const prefix = templateLiteral.quasis[0].value.cooked;

                // Check if the prefix looks like a scoped package pattern
                // e.g., "@libsql/", "@scope/prefix-"
                if (prefix && prefix.startsWith("@") && prefix.includes("/")) {
                  // Try to find a matching platform-specific package
                  const result = findPlatformSpecificNativePackage(prefix, path.dirname(id));

                  if (result) {
                    const { nodeFilePath } = result;
                    const info = registerNativeFile(nodeFilePath);
                    const templateNode = node.arguments[0];
                    if (templateNode.start !== undefined && templateNode.end !== undefined) {
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
          currentFileId: string,
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
              (pathModuleVars.has(callee.object.name) || callee.object.name === "path") &&
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
                } else if (isLiteral(firstArg) && typeof firstArg.value === "string") {
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
                  } else if (isIdentifier(pathArg) && directoryVars.has(pathArg.name)) {
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
          callNode: CallExpressionNode,
          sidecarPaths: string[] = [],
        ): void {
          const info = registerNativeFile(nodeFilePath, sidecarPaths);

          // Determine how to generate the replacement code
          let replacementCode: string;

          if (isESModule) {
            // For ES6 modules, use inline createRequire(import.meta.url)() call
            // Use the tracked local name if available, otherwise use 'createRequire'
            const funcName = createRequireLocalName || "createRequire";
            replacementCode = `${funcName}(import.meta.url)("./${info.hashedFilename}")`;
          } else if (outputFormat === "es") {
            // In ESM output, the virtual native module is an ES module with a default export.
            // CommonJS importers need the default value to preserve native require() semantics.
            const requireCode = `require("./${info.hashedFilename}${
              nativeRequireQuery
            }${nativeRequireToken(nodeFilePath)}")`;
            replacementCode = commonJSRequireReturnsDefault(nodeFilePath)
              ? requireCode
              : `${requireCode}.default`;
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
            if (importNode.start !== undefined && importNode.end !== undefined) {
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
            if (importNode.start !== undefined && importNode.end !== undefined) {
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
            createRequireInjection = "import { createRequire } from 'module';\n";
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
              const insertPos = lastImportMatch.index + lastImportMatch[0].length;
              newCode = newCode.slice(0, insertPos) + "\n" + codePrefix + newCode.slice(insertPos);
            } else {
              // No imports found, prepend to the file
              newCode = codePrefix + "\n" + newCode;
            }
          }

          return { code: newCode, map: null };
        }
      } catch (error) {
        // If parsing fails, log and skip transformation
        console.warn(`Failed to parse ${id} for native module transformation:`, error);
        return null;
      }

      return null;
    },
  };

  const resolveId = plugin.resolveId;
  if (typeof resolveId === "function") {
    plugin.resolveId = {
      call(context: unknown, ...args: unknown[]) {
        return Reflect.apply(resolveId, context, args);
      },
      handler: resolveId,
      order: "pre",
    } as Plugin["resolveId"];
  }

  const generateBundle = plugin.generateBundle;
  if (typeof generateBundle === "function") {
    plugin.generateBundle = {
      call(context: unknown, ...args: unknown[]) {
        return Reflect.apply(generateBundle, context, args);
      },
      handler: generateBundle,
      order: "post",
    } as Plugin["generateBundle"];
  }

  return plugin;
}
