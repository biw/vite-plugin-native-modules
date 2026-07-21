---
name: conductor-setup
description: Configure .conductor/settings.toml, migrate legacy conductor.json, and set up Conductor workspace scripts, env vars, files, and caches.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Conductor Setup

When this skill is invoked directly, proactively audit the repository's Conductor setup and either apply the needed configuration changes or report that no changes are needed.

Use this skill when configuring a repository for Conductor workspaces. Focus first on `.conductor/settings.toml`; treat root-level `conductor.json` as legacy input to migrate.

## Workflow

1. Inspect `.conductor/settings.toml`, `.conductor/settings.local.toml`, legacy `conductor.json`, `.worktreeinclude`, existing `conductor-setup.sh`, `conductor-run.sh`, `conductor-shutdown.sh`, `conductor-archive.sh`, package scripts, and repo docs.
2. Read `references/conductor-docs.md` before changing script fields or environment variable usage.
3. Choose the right settings file:
   - Use committed `.conductor/settings.toml` for shared team defaults.
   - Use `.conductor/settings.local.toml` for machine-local project overrides, and keep it gitignored.
   - Use `~/.conductor/settings.toml` only for user-wide preferences outside the repository.
   - If `conductor.json` exists, migrate supported fields into `.conductor/settings.toml` and remove `conductor.json` unless the user asks to keep the legacy file.
4. Keep setup, run, and archive/shutdown responsibilities separate:
   - `scripts.setup`: prepare a new workspace.
   - `scripts.run.<id>.command`: start long-running app/server/test processes from the Run button.
   - `scripts.archive`: run shutdown cleanup before a workspace is archived.
   - `scripts.run_mode`: decide whether run scripts can overlap.
5. Use Conductor variables instead of hard-coded paths or ports:
   - `$CONDUCTOR_WORKSPACE_PATH` for the active workspace.
   - `$CONDUCTOR_ROOT_PATH` for shared root-level resources and caches.
   - `$CONDUCTOR_WORKSPACE_NAME` for workspace-specific names.
   - `$CONDUCTOR_PORT` for server ports.
   - `$CONDUCTOR_IS_LOCAL` to branch between local Mac and cloud workspace behavior.
6. For monorepos and multi-repo systems, prefer Conductor's working-directory selection, `/add-dir`, or per-repository run scripts over hard-coded sibling checkout paths.
7. Validate TOML syntax and run the narrowest relevant local check for any script you touch.

## Required Conventions

- Put shared repository settings in `.conductor/settings.toml` with the repository schema URL. Do not create new `conductor.json` files.
- Prefer named run scripts under `[scripts.run.<id>]` with `command`, `default`, and `icon`. `scripts.run = "..."` is still read as a legacy single run script, but new shared config should use named run scripts.
- Always use copy-on-write cloning for files over 100 MB when duplicating large artifacts. On macOS prefer `cp -c`; on Linux prefer `cp --reflink=auto`. If clone/reflink is unavailable, prefer a symlink or shared cache under `$CONDUCTOR_ROOT_PATH` unless the repo needs a true copy.
- Route every `conductor-setup.sh` run to `conductor-setup.log` so setup failures are easy to debug in loops. Preserve exit codes with `pipefail` when piping through `tee`.
- Use a committed `.worktreeinclude` or `file_include_globs` in `.conductor/settings.toml` for static gitignored files that should be copied into every workspace. Keep setup scripts for commands, generated files, symlinks, and workspace-specific resources.
- Put required PATH/toolchain setup directly in setup or run scripts when possible. Do not rely on slow, interactive, or prompt-producing shell startup files.
- Put shared caches outside individual workspaces under `$CONDUCTOR_ROOT_PATH`, and use the archive/shutdown script to flush, update, compact, or clean those shared caches.
- Do not background long-running run-script processes with `&`. Use `concurrently`, a supervisor, or a single foreground process group so Conductor can stop everything cleanly.
- Use `scripts.run_mode = "nonconcurrent"` only when the project cannot safely run multiple workspace instances because of a single fixed port, database, or shared local resource.
- Use Spotlight testing instead of overcomplicated run/setup scripts when the project truly needs the repository root checkout, expensive root build artifacts, or one heavy local stack.
- Do not commit secrets, provider API keys, or machine-specific credentials in `.conductor/settings.toml`. Put machine-local values in `.conductor/settings.local.toml`, local shell config, or gitignored files copied into workspaces. Only change `.mcp.json` or `enterprise_data_privacy` when the user asks or the repository policy requires it.

## Snippet

Use this as a starting point and adapt command names to the repository:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
setup = "bash -lc 'set -o pipefail; ./conductor-setup.sh 2>&1 | tee conductor-setup.log'"
archive = "./conductor-shutdown.sh"
run_mode = "concurrent"

[scripts.run.dev]
command = "./conductor-run.sh"
default = true
icon = "play"
```

Inside `conductor-setup.sh`, make large-file copies explicit:

```bash
copy_large_file() {
  src="$1"
  dest="$2"
  size="$(wc -c < "$src" | tr -d ' ')"
  if [ "$size" -gt 104857600 ]; then
    cp -c "$src" "$dest" 2>/dev/null || cp --reflink=auto "$src" "$dest" 2>/dev/null || ln -s "$src" "$dest"
  else
    cp "$src" "$dest"
  fi
}
```

## Review Checklist

- `.conductor/settings.toml` has a repository schema URL and uses only documented repository fields.
- Legacy `conductor.json` has been migrated or intentionally left in place with a clear reason.
- Named run scripts use stable IDs under `[scripts.run.<id>]`; one script is marked `default = true` when there are multiple commands.
- Setup work that only copies static gitignored files is not over-engineered; prefer `.worktreeinclude` for team-shared file-copy patterns.
- Scripts contain their own required shell setup and do not depend on interactive prompts or slow startup files.
- Setup logs land in `conductor-setup.log`.
- Run scripts use `$CONDUCTOR_PORT` or `scripts.run_mode = "nonconcurrent"` when needed.
- Shared caches live under `$CONDUCTOR_ROOT_PATH`, not inside transient workspace directories.
- Shutdown/archive logic updates shared caches and cleans only resources owned by the workspace.
- Root-only, fixed-resource, or very expensive local stacks are handled with Spotlight testing or `nonconcurrent`, not brittle workspace path hacks.
- Monorepo and multi-repository needs are handled with Conductor working-directory selection, `/add-dir`, or separate per-repository scripts.
