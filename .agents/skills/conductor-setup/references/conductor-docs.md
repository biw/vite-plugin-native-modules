# Conductor Docs Reference

Read this reference before modifying `.conductor/settings.toml`, `.conductor/settings.local.toml`, legacy `conductor.json`, or Conductor workspace scripts. Source docs:

- https://www.conductor.build/docs/reference/settings
- https://www.conductor.build/docs/reference/settings/user-project
- https://www.conductor.build/docs/reference/settings/reference
- https://www.conductor.build/docs/reference/settings/example
- https://www.conductor.build/docs/reference/conductor-json
- https://www.conductor.build/docs/reference/scripts
- https://www.conductor.build/docs/reference/environment-variables
- https://www.conductor.build/docs/reference/files-to-copy
- https://www.conductor.build/docs/reference/worktreeinclude
- https://www.conductor.build/docs/reference/scripts/spotlight-testing
- https://www.conductor.build/docs/reference/shells
- https://www.conductor.build/docs/reference/mcp
- https://www.conductor.build/docs/reference/security-and-permissions
- https://www.conductor.build/docs/guides/repositories/monorepos
- https://www.conductor.build/docs/guides/repositories/linking-multiple-directories
- https://www.conductor.build/docs/troubleshooting/issues

## Settings Files

Conductor's current shared repository format is `.conductor/settings.toml`. Use it when setup scripts, run scripts, archive scripts, Files to copy patterns, environment variables, prompts, Git behavior, provider executable paths, or Enterprise data privacy should be shared with teammates.

Use `.conductor/settings.local.toml` for one developer's machine-local overrides for a repository. Add it to `.gitignore`:

```sh
touch .gitignore
grep -qxF ".conductor/settings.local.toml" .gitignore || printf "\n.conductor/settings.local.toml\n" >> .gitignore
```

Use `~/.conductor/settings.toml` for user-wide settings, such as model defaults and tool approval preferences. Do not put user-only settings in repository settings files; Conductor ignores them there.

Settings precedence, highest first:

1. Managed settings in `~/.conductor/settings.managed.toml`.
2. Project overrides in `<repo>/.conductor/settings.local.toml`.
3. Repository shared settings in `<repo>/.conductor/settings.toml`.
4. User shared settings in `~/.conductor/settings.toml`.
5. Built-in defaults.

Shared repository settings should be committed and merged to the repository's default branch before expecting Conductor to treat them as shared project settings for teammates.

Schema URLs:

- User settings: `https://conductor.build/schemas/settings.schema.json`
- Repository settings: `https://conductor.build/schemas/settings.repo.schema.json`
- Repository local overrides: `https://conductor.build/schemas/settings.repo.schema.json`
- Managed settings: `https://conductor.build/schemas/settings.toml.json`

## Repository Settings Shape

Minimal shared repository settings:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
setup = "pnpm install"
run_mode = "concurrent"

[scripts.run.dev]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true
icon = "play"
```

Common repository settings:

- `scripts.setup`: command run after Conductor creates a workspace.
- `scripts.archive`: command run before Conductor archives a workspace.
- `scripts.run_mode`: `"concurrent"` or `"nonconcurrent"`.
- `scripts.run.<id>.command`: command run from the Run button.
- `scripts.run.<id>.args`: optional string array passed with the command.
- `scripts.run.<id>.options.cwd`: optional working directory relative to the workspace.
- `scripts.run.<id>.default`: selects the default script when multiple run scripts exist.
- `scripts.run.<id>.icon`: Lucide icon name shown with the script.
- `scripts.run.<id>.available_in`: `"local"`, `"cloud"`, or both.
- `scripts.run`: legacy single run script string. New shared config should prefer named run scripts under `scripts.run.<id>`.
- `enterprise_data_privacy`: repository-level Enterprise data privacy.
- `spotlight_testing`: run projects from the repository root when a workspace path will not work.
- `file_include_globs`: Files to copy patterns when `.worktreeinclude` is not present.
- `environment_variables`, `environment_variables.local`, `environment_variables.cloud`: repository-specific variables for agents, terminals, setup scripts, and run scripts.
- `prompts.general`, `prompts.code_review`, `prompts.create_pr`, `prompts.fix_errors`, `prompts.resolve_merge_conflicts`, `prompts.rename_branch`: repository action prompts.
- `git.delete_branch_on_archive`, `git.archive_on_merge`, `git.worktree_push_auto_setup_remote`, `git.branch_prefix_type`, `git.branch_prefix`: Git behavior.

## Migrating From `conductor.json`

`conductor.json` is Conductor's legacy repository configuration file. New shared repository settings should use `.conductor/settings.toml`.

If a repository has `.conductor/settings.toml`, Conductor treats the repository as migrated and ignores repo-level `conductor.json`.

Legacy field mapping:

- `scripts.setup` -> `scripts.setup`
- `scripts.run` -> `scripts.run.<id>.command`
- `scripts.archive` -> `scripts.archive`
- `runScriptMode` -> `scripts.run_mode`
- `enterpriseDataPrivacy` -> `enterprise_data_privacy`

Manual migration steps:

1. Create `.conductor/settings.toml`.
2. Move each supported legacy field to its TOML replacement.
3. Delete `conductor.json` unless the user explicitly asks to keep it for a legacy workflow.
4. Commit both changes.

Example migration:

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev --port $CONDUCTOR_PORT",
    "archive": "./script/workspace-archive.sh"
  },
  "runScriptMode": "concurrent",
  "enterpriseDataPrivacy": true
}
```

becomes:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"
enterprise_data_privacy = true

[scripts]
setup = "pnpm install"
archive = "./script/workspace-archive.sh"
run_mode = "concurrent"

[scripts.run.dev]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true
icon = "play"
```

## Environment Variables

Conductor exposes these variables in workspace terminals and scripts:

- `CONDUCTOR_WORKSPACE_NAME`: workspace name.
- `CONDUCTOR_WORKSPACE_PATH`: workspace path.
- `CONDUCTOR_ROOT_PATH`: repository root path.
- `CONDUCTOR_DEFAULT_BRANCH`: default branch name, usually `main`.
- `CONDUCTOR_PORT`: first port in a range of 10 assigned to the workspace.
- `CONDUCTOR_IS_LOCAL`: `1` in local workspaces, `0` in cloud workspaces.

Use `$CONDUCTOR_ROOT_PATH` for root-level shared resources such as `.env` files, dependency caches, and artifacts shared between workspaces. Use `$CONDUCTOR_PORT` for local servers to avoid port conflicts across parallel workspaces. Use `$CONDUCTOR_IS_LOCAL` when setup or run behavior must differ between local Mac and cloud workspaces.

Custom variables can be configured in repository settings:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[environment_variables]
API_BASE_URL = "http://localhost:3000"

[environment_variables.local]
CONDUCTOR_TARGET = "local"

[environment_variables.cloud]
CONDUCTOR_TARGET = "cloud"
```

Do not commit secrets to `.conductor/settings.toml`. Use `.conductor/settings.local.toml`, shell configuration, or gitignored files copied into workspaces for machine-local secret values.

## Setup Scripts

The setup script runs inside the newly created workspace directory after Git checks out tracked files. Use it for commands not covered by checkout:

- install dependencies;
- copy or symlink `.env` files;
- build generated assets;
- initialize local services or workspace-specific resources.

Use Files to copy instead of a setup script when Conductor only needs to copy static gitignored local files. Use a setup script when the workspace needs commands, generated files, symlinks, conditional logic, or workspace-specific resources.

Setup scripts run in non-interactive shells. If a command works in a normal terminal but fails in setup, check shell initialization assumptions. Prefer putting required PATH/toolchain setup directly in the script. Avoid depending on `.zshrc` or `.zshenv` behavior that prompts, runs slowly, or assumes an interactive terminal.

For workspace-specific resources, use `$CONDUCTOR_WORKSPACE_NAME` in generated names and `$CONDUCTOR_PORT` for ports. This prevents one workspace from overwriting another workspace's database, data directory, app identifier, or local service.

## Run Scripts

Run scripts launch long-running apps, servers, test watchers, workers, or equivalent commands from the workspace directory. A project can define one or more run scripts. Prefer named run scripts:

```toml
[scripts]
run_mode = "concurrent"

[scripts.run.web]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true
icon = "play"
available_in = [ "local", "cloud" ]

[scripts.run.worker]
command = "pnpm worker:dev"
icon = "server"
```

Use `$CONDUCTOR_PORT` when starting a local server; Conductor allocates ten ports from `$CONDUCTOR_PORT` through `$CONDUCTOR_PORT+9`.

When a run script starts multiple processes, keep them in the same process group so Conductor can stop them together. Use `concurrently` or a similar supervisor. Avoid backgrounding commands with `&`; backgrounded processes can keep ports, memory, or resources after Conductor stops the script.

Use `scripts.run_mode = "nonconcurrent"` when the project depends on a single shared resource, such as one fixed port, one local database, one Docker stack, or another resource that multiple workspaces cannot use at the same time. Otherwise default to concurrent workspace runs.

Conductor stops script processes by sending `SIGHUP`, waiting up to 200 ms, then sending `SIGKILL` if the process is still running.

## Files to Copy

Files to copy use gitignore-style glob patterns for gitignored files that should be copied into each new local workspace. Conductor defaults to `.env*`.

For project-shared patterns, commit `.worktreeinclude` at the repository root or set `file_include_globs` in `.conductor/settings.toml`:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

file_include_globs = """
.env.local
config/local.json
certs/local/**
"""
```

Resolution order:

1. `.worktreeinclude` at the repository root. If present, it wins and the settings UI shows a read-only preview.
2. Repository settings, stored as `file_include_globs`.
3. Default `.env*` pattern.

If you add `.worktreeinclude` or `file_include_globs`, those patterns replace the default `.env*` pattern. Include `.env*` yourself when you still want Conductor to copy environment files.

Conductor copies a gitignored file into a new local workspace when both of these are true:

1. The file is gitignored.
2. The file matches a Files to copy or `.worktreeinclude` pattern.

Tracked files are already present in the new worktree. Untracked files that are not gitignored are not eligible. Generated files, dependency folders, and files that need commands to create them usually belong in a setup script instead.

## Shell Configuration

Conductor captures the login shell environment, then runs most commands, including setup and run scripts, with `zsh`. Slow or interactive shell startup can break agents and scripts.

When reliability matters, make scripts self-contained:

```sh
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
eval "$(mise activate zsh)"
pnpm install
```

Keep `.zshenv` minimal. Do not put prompts, terminal UI setup, slow network calls, or commands requiring stdin in shell files that Conductor may load.

## Spotlight Testing

Spotlight testing is for projects that cannot run cleanly from workspace directories. It syncs one workspace's tracked changes back to the repository root, letting the root checkout keep using root-relative paths, fixed local resources, expensive build artifacts, or one heavy Docker/microservice stack.

Use normal run scripts when each workspace can run its own copy with workspace-specific ports and resources. Use `scripts.run_mode = "nonconcurrent"` first if the only problem is preventing multiple run scripts from sharing one fixed port or database.

Spotlight is one-way: root checkout changes do not sync back to the workspace. Edit in the workspace and let Conductor sync tracked changes to the root.

## Archive / Shutdown Script

The archive script runs before Conductor archives a workspace. Use it to clean up resources outside the workspace directory and to update shared caches under `$CONDUCTOR_ROOT_PATH`.

Do not rely on long graceful shutdown work inside a run script process; put deterministic cleanup and cache updates in `scripts.archive`.

## Repository Layouts

For monorepos, Conductor creates workspaces at the repository root by default. If agents should only see specific packages or services, use Conductor's working-directory selection, which hides unselected directories with Git sparse checkout.

If the monorepo uses submodules, add `git submodule update --init --recursive` to the setup script so each workspace initializes them consistently.

For related repositories or sibling services, use Conductor's `/add-dir` flow to link workspaces from multiple directories. Do not hard-code assumptions that a sibling checkout exists at a developer-specific path.

When a workspace must run several services at once, create a run script that launches all needed services in one process group, or create per-repository run scripts for linked directories.

## MCP, Privacy, and Secrets

Project-level `.mcp.json` files are inherited by Conductor agents. MCP servers can send data to external services, so only add or edit MCP configuration when it is part of the task and acceptable under the repository's privacy policy.

Do not commit provider credentials or machine-local secrets in `.conductor/settings.toml`. Provider variables belong in `.conductor/settings.local.toml`, Conductor environment settings, or the user's shell environment; runtime app secrets should come from ignored files copied or symlinked into each workspace.

`enterprise_data_privacy` can be set in `.conductor/settings.toml` for repository-wide policy. Only change it when the user asks or the repository policy clearly requires it, because it affects features that rely on external AI providers, including custom MCP servers.

## Troubleshooting Signals

For setup failures, check `conductor-setup.log`, missing ignored files, dependencies installed only in the repository root, fixed absolute paths, and unavailable authentication.

For run failures, check fixed ports, shared databases or caches, backgrounded processes, and commands that only work from the root checkout. Use `$CONDUCTOR_PORT`, workspace-specific resource names, `nonconcurrent`, or Spotlight testing based on the actual cause.

For settings issues, check whether `.conductor/settings.local.toml` overrides shared settings, whether shared `.conductor/settings.toml` has been merged to the default branch, whether `.worktreeinclude` overrides `file_include_globs`, and whether legacy `conductor.json` is being ignored because `.conductor/settings.toml` exists.

For archive failures, keep the script focused on cleanup outside the workspace directory and cache updates under `$CONDUCTOR_ROOT_PATH`; failed archive scripts can block archiving.
