# vite-plugin-native-modules

A Vite plugin for seamlessly integrating Node.js native modules (`.node` files) into your Vite project.

## Features

- 🔧 **Automatic handling** of `.node` files in your Vite build
- 📦 **Content-addressed filenames** for optimal caching
- 🚀 **Zero configuration** for most use cases
- 🔒 **Production-ready** with proper file emission
- 🎯 **TypeScript support** out of the box

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
import { nativeFilePlugin } from "vite-plugin-native-modules";

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

1. Detect the `.node` file import
2. Hash the file contents for cache busting
3. Emit it to your build output with a hashed filename (e.g., `addon-A1B2C3D4.node`)
4. Update the import path to use the hashed filename

## Configuration

### Options

```typescript
interface NativeFilePluginOptions {
  /**
   * Enable the plugin.
   * Defaults to true in build mode, false in dev mode.
   */
  forced?: boolean;
}
```

### Example with Options

```typescript
nativeFilePlugin({
  // Force enable in dev mode (not typically recommended)
  forced: true,
});
```

## How It Works

The plugin intercepts imports of `.node` files during the Vite build process:

1. **Resolution**: Detects when a `.node` file is imported
2. **Hashing**: Generates a content-based hash for cache invalidation
3. **Emission**: Emits the file as a build asset with the hashed filename
4. **Transformation**: Updates the import to reference the hashed filename

This ensures that:

- Native modules are properly included in your build output
- File names change when content changes (cache busting)
- Multiple versions can coexist without conflicts

## Why This Plugin?

Vite doesn't natively support `.node` files since they're binary Node.js addons that can't be bundled like JavaScript. This plugin bridges that gap by:

- Treating `.node` files as static assets
- Ensuring they're copied to the output directory
- Maintaining proper `require()` calls in the built code
- Supporting content-based cache invalidation

## Compatibility

- **Vite**: 3.x, 4.x, 5.x, 6.x
- **Node.js**: 18+

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Ben Williams](https://github.com/biw)

## Related

- [Vite](https://vitejs.dev/)
- [Native Addons](https://nodejs.org/api/addons.html)
- [node-gyp](https://github.com/nodejs/node-gyp)
