---
name: opencode-v2-config
description: >
  Edit or debug OpenCode V2 configuration — opencode.json(c), cli.json,
  plugins, providers, models, agents, permissions, MCP, skills, themes. Use
  when changing OpenCode settings, adding a provider or model, troubleshooting
  why a config value has no effect, or migrating V1 fields to the V2 shape.
  Covers this machine's DeepSeek setup specifically.
---

# OpenCode V2 Configuration

V2 config has two separate worlds. Putting a key in the wrong one is the most
common silent failure.

| file | scope | holds |
|---|---|---|
| `~/.config/opencode/opencode.json(c)` | server + project | model, providers, plugins, agents, permissions, mcp, skills, compaction |
| `~/.config/opencode/cli.json` | terminal only | theme, keybinds, diffs, session UI, animations |

There is **no project-local CLI config**. TUI settings in `opencode.json`
are ignored; provider settings in `cli.json` are ignored.

## Before Editing

1. Read the current file in full. Preserve every unrelated key.
2. Know the shape: `opencode debug config` prints the **resolved** config —
   what OpenCode actually uses after normalization, with defaults applied.
   This is authoritative; the raw file is not.
3. Fetch the V2 doc page for the area before guessing a field name:
   `https://opencode.ai/v2/docs/config`, `/cli/config`, `/cli/keybinds`,
   `/build/plugins`, `/skills`. The schema at
   `https://opencode.ai/config.json` describes V1 — never infer V2 field
   names from it.

## V1 → V2 shape (most-missed)

| V1 | V2 |
|---|---|
| provider `npm` | provider `package` (`aisdk:` prefix) |
| provider `options` | `settings` / `headers` / `body` |
| `options.baseURL` | `settings.baseURL` |
| model `id` | `modelID` |
| `prompt` | `system` |
| `permission` | `permissions` (ordered array; `bash` → `shell`) |
| `plugin` (array) | `plugins` (array) |
| — | `compaction.auto` (kept) |

V2 still **accepts** the V1 shape and normalizes it in memory, so an old file
often "works" — until one field silently does nothing.

## This Machine

- Binary: `/home/nik/.opencode/bin/opencode` (v2.0.29), wrapper `opencode2`.
- Provider `deepseek`, package `@ai-sdk/openai-compatible`,
  `settings.baseURL: https://api.deepseek.com/v1`.
- Models: `deepseek-flash` (thinking disabled), `deepseek-v4-pro` (thinking
  enabled, 8192 budget). Both `limit: {context: 1000000, output: 393216}`.
- Default model: `deepseek/deepseek-flash`.
- Theme: `gruvbox` (dark) in `cli.json`.
- Plugins: DCP (pruning, threshold 750k) + Magic Context (memory only,
  compaction off) + three local ports. See their own configs.

## Local Plugins

- Directory discovery scans `plugins/` **and** `plugin/` under the config
  dir. A directory resolves its entrypoint to `index.ts`.
- Shape: `export default Plugin.define({ id, async setup(ctx) { ... } })`
  from `@opencode/plugin`. V1's `@opencode-ai/plugin` is V1-only.
- Do **not** also list a discovered local plugin in `plugins` — it loads
  twice.
- V1 hook → V2 map: `event`→`ctx.event.subscribe()`,
  `chat.message`→`session.hook("prompt")`, `chat.params`→
  `session.hook("context")`, `chat.headers`→`session.hook("model.request")`,
  `shell.env`→`ctx.shell.hook("create.before")`,
  `experimental.chat.system.transform`→`session.hook("context")` editing
  `event.system`, `config` fetch-wrap→`session.hook("http.request"/"http.response")`.

## Verify After Every Change

```sh
opencode2 service restart            # reload plugins/config
opencode2 api get /api/plugin        # every plugin must be "active"
opencode2 api get /api/model         # check resolved limits
opencode debug config                # resolved config, defaults applied
opencode2 run "Reply with exactly: OK"   # end-to-end smoke test
```

- Plugin failures: `grep 'failed to load plugin' ~/.local/share/opencode/log/opencode.log`.
- Restart the service after config/plugin edits; a running service keeps the
  old config until then.

## Hard Rules

- Never put TUI settings in `opencode.json` or server settings in `cli.json`.
- Never guess a V2 field name; check the doc page.
- Preserve unrelated keys when editing; make a minimal diff.
- Verify with `/api/plugin` + `opencode debug config` before claiming a
  config change works.
- No secrets in config: use `{env:VAR}` and a gitignored `.env`.
