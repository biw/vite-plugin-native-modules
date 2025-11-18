# vite-plugin-native-modules

[![CI](https://badgen.net/github/checks/biw/vite-plugin-native-modules)](https://github.com/biw/vite-plugin-native-modules/actions)
[![npm version](https://badgen.net/npm/v/vite-plugin-native-modules)](https://www.npmjs.com/package/vite-plugin-native-modules)
[![npm downloads](https://badgen.net/npm/dt/vite-plugin-native-modules)](https://www.npmjs.com/package/vite-plugin-native-modules)

A Vite plugin for seamlessly integrating Node.js native modules (`.node` files) into your Vite project.

## Features

- **Automatic handling** of `.node` files in your Vite build
- **Zero configuration** for most use cases
- **Electron compatible** for building desktop apps with native modules
- **`node-gyp-build` support** - automatically detects and rewrites runtime selectors
- **`bindings` package support** - automatically handles `bindings('addon')` patterns
- **Zero dependencies** - uses Rollup's built-in parser (via Vite)

## Installation

```bash
npm install vite-plugin-native-modules
# or
yarn add vite-plugin-native-modules
# or
pnpm add vite-plugin-native-modules
```

## Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import nativeFilePlugin from "vite-plugin-native-modules";

export default defineConfig({
  plugins: [nativeFilePlugin()],
});
```

### Basic Example

```typescript
// Your code that imports a native module
import addon from "./build/Release/addon.node";

// Use the native module
const result = addon.hello();
```

The plugin will automatically:

1. Detect the `.node` file import (and any configured additional native files)
2. Hash the file contents for cache busting
3. Emit it to your build output with a hashed filename (e.g., `addon-A1B2C3D4.node`)
4. Update the import path to use the hashed filename

### Handling Non-Standard Extensions

Some packages use platform-specific native files with custom extensions. For example:

```typescript
// In node_modules/native-package-123/lib/loader.js
const addon = require("../../build/native-file.node-macos");
```

Configure the plugin to handle these:

```typescript
nativeFilePlugin({
  additionalNativeFiles: [
    {
      package: "native-package-123",
      fileNames: ["native-file.node-macos", "native-file.node-linux"],
    },
  ],
});
```

The plugin will then copy and hash these files just like standard `.node` files, transforming them to:

```typescript
const addon = require("./native-file-A1B2C3D4.node-macos");
```

## Configuration

### Options

```typescript
interface NativeFilePluginOptions {
  /**
   * Enable the plugin.
   * Defaults to true in build mode, false in dev mode.
   */
  forced?: boolean;

  /**
   * Additional native file configurations for packages with non-standard file extensions.
   * Use this for packages that use custom extensions like .node-macos, .node-linux, etc.
   */
  additionalNativeFiles?: {
    /** Package name to target (e.g., 'native-package-123') */
    package: string;
    /** Additional file names to copy (e.g., ['native-file.node-macos', 'addon.node-linux']) */
    fileNames: string[];
  }[];

  /**
   * Format for generated native file names.
   * - 'preserve' (default): Keeps original filename with hash suffix (e.g., addon-A1B2C3D4.node)
   * - 'hash-only': Uses only the hash as filename (e.g., A1B2C3D4.node)
   */
  filenameFormat?: "preserve" | "hash-only";
}
```

### Example with Options

```typescript
nativeFilePlugin({
  // Force enable in dev mode (not typically recommended)
  forced: true,

  // Use hash-only filenames for simpler output
  filenameFormat: "hash-only", // Generates A1B2C3D4.node instead of addon-A1B2C3D4.node

  // Handle packages with non-standard native file extensions
  additionalNativeFiles: [
    {
      package: "native-package-123",
      fileNames: ["native-file.node-macos", "native-file.node-linux"],
    },
  ],
});
```

## How It Works

The plugin intercepts imports of `.node` files during the Vite build process:

1. **Resolution**: Detects when a `.node` file is imported directly or via `node-gyp-build`
2. **AST Transformation**: Parses bundled JavaScript using Rollup's built-in AST parser to find:
   - Direct `.node` file requires/imports
   - `node-gyp-build` runtime selector calls
   - Works regardless of minification or variable name changes
   - No fragile regex patterns - uses proper Abstract Syntax Tree parsing
3. **node-gyp-build Resolution**: For `node-gyp-build` patterns:
   - Resolves the directory path (handles `__dirname`, `path.join`, etc.)
   - Searches `prebuilds/{platform}-{arch}/` for platform-specific binaries
   - Falls back to `build/Release/` if needed
   - Selects the appropriate `.node` file for current platform
4. **Hashing**: Generates a content-based MD5 hash (8 chars) for cache invalidation
5. **Emission**: Emits the file as a build asset with the hashed filename (e.g., `addon-A1B2C3D4.node`)
6. **Path Rewriting**: Updates all references to use the hashed filename

This ensures that:

- Native modules are properly included in your build output
- File names change when content changes (cache busting)
- Multiple versions can coexist without conflicts
- Works reliably even with code minification and mangling
- Runtime selectors are replaced with direct, optimized requires

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Ben Williams](https://github.com/biw)
