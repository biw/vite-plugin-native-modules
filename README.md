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

### Output Filename Format

By default, emitted native modules keep their original filename and add an
eight-character content hash before the extension. For example,
`addon.node` becomes `addon-A1B2C3D4.node`. This makes cache invalidation
reliable while keeping build outputs easy to identify.

Set `filenameFormat` to `"hash-only"` when you prefer filenames that contain
only the hash and extension:

```typescript
nativeFilePlugin({
  filenameFormat: "hash-only", // e.g., A1B2C3D4.node
});
```

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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

This repository uses Vite+ for its development workflow (with pnpm as the package manager):

```bash
vp install
vp check
vp run test
vp pack
```

## License

MIT © [Ben Williams](https://github.com/biw)
