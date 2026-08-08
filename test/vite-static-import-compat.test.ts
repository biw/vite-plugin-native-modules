import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build as buildVite7 } from "vite7";
import vite7Package from "vite7/package.json";
import { build as buildVite8 } from "vite8";
import vite8Package from "vite8/package.json";
import nativeFilePlugin from "../src/index.js";

type ViteBuild = (config: unknown) => Promise<unknown>;

const viteVersions = [
  { build: buildVite7 as ViteBuild, major: 7, version: vite7Package.version },
  { build: buildVite8 as ViteBuild, major: 8, version: vite8Package.version },
];

describe.each(viteVersions)(
  "direct native ESM imports on Vite $major",
  ({ build, major, version }) => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-static-import-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { force: true, recursive: true });
    });

    it("builds a direct native ESM import", async () => {
      expect(version).toMatch(new RegExp(`^${major}\\.`));

      const entryPath = path.join(tempDir, "index.js");
      fs.writeFileSync(path.join(tempDir, "addon.node"), Buffer.from("fake native module"));
      fs.writeFileSync(entryPath, 'import addon from "./addon.node";\nconsole.log(addon);\n');

      await build({
        build: {
          rollupOptions: { input: entryPath },
          ssr: true,
          write: false,
        },
        configFile: false,
        logLevel: "silent",
        plugins: [nativeFilePlugin()],
        root: tempDir,
      });
    });
  },
);
