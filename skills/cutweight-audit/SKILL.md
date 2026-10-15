---
name: cutweight-audit
description: >
  Audit and weigh the always-on context cost of an agent setup: installed
  skills, memory files (CLAUDE.md, AGENTS.md), and MCP tool schemas. Use
  when asked to audit, weigh, trim, shrink, or cut skills or context; when
  the agent picks the wrong skill or feels dumber after the setup grew; when
  MCP servers eat the context window; or when the token bill grows without
  more work getting done. Produces a keep/trim/cut table with measured
  numbers, assigns a weight class, prints a shareable fight card, and shows
  the delta from the last weigh-in. Read-only except for its own append-only
  log; it never deletes anything.
metadata:
  opencode/autoinvoke: "true"
---

# Cutweight Audit

The scale and the bill for your agent. Measure what every message costs
before any work happens, find what to cut, prove the cut worked.

Skill descriptions, memory files, MCP tool schemas: your agent reads all of
it on every message before any work happens. Caching makes that cheap in
dollars. It still fills the context window, and full windows measurably
degrade output. This skill reads the whole bill, then puts the agent on the
scale before and after a cut.

## When To Use

After installing a skill pack or connecting an MCP server. When the agent
picks the wrong skill. When the bill grows without more work done. Before and
after any cut, to prove the delta.

## Method

Rough tokens for English markdown: characters / 3 on Claude models carrying
the Opus 4.7 tokenizer (Opus 4.7+, Sonnet 5, Fable 5), characters / 3.5 to 4
on older Claude (Sonnet 4.6, Haiku 4.5) and on GPT-style tokenizers. The
newer Claude tokenizer counts roughly 30% higher, varying by content, so
never reuse counts across models. When exact matters, Anthropic's
count-tokens endpoint is free and per-model; for GPT, tiktoken runs locally.
Label every number measured or estimated.

1. Skills. Find every installed skill: `~/.config/opencode/skills`,
   `.opencode/skills`, `~/.claude/skills`, `.claude/skills`,
   `.agents/skills`, `$XDG_CONFIG_HOME/opencode/skills`, plugin
   directories. Record two numbers each: always-on (frontmatter name plus
   description, injected into every request) and on-trigger (body plus every
   file it tells the agent to read). In OpenCode, only `id` + `name` +
   `description` are always advertised; the body loads on demand.
2. Memory files. Find everything loaded at session start: CLAUDE.md and
   AGENTS.md at user level, project level, subdirectories, local variants,
   plus `instructions` entries in `opencode.json(c)` and files they import.
   All always-on. Measure each. Leave style linting to linters; the job here
   is the bill. Files a human wrote (CLAUDE.md, AGENTS.md) are fair to trim.
   Files an agent maintains for itself (auto-memory indexes, session
   memories) get billed, NEVER hand-trimmed: their lines are retrieval keys,
   and cutting them breaks the agent's recall in ways that surface weeks
   later. If one must shrink, the owning agent compacts it in-context.
3. MCP tool schemas. Usually the biggest line item: each connected server
   injects its tool catalog into every request, commonly 500-1,400 tokens
   per tool. List servers from `mcp` in `opencode.json(c)` and client
   settings, count each server's tools, estimate schema cost. If the client
   defers tool loading (tool search, lazy loading), bill only what loads
   eagerly and say so. A server you cannot enumerate is unknown, never zero.
4. Overlap and dead weight (skills). Name pairs claiming the same trigger
   phrases. If session history exists, list skills that never fired;
   otherwise ask the user and mark the rest unknown, not unused.
5. Read the fattest items. Rules earn their tokens. Backstory does not.

## Output Shape

```markdown
| item | kind | always-on | on-trigger | notes | verdict |
|---|---|---|---|---|---|
| github (94 tools) | mcp | 17,600 | - | eager-loaded | trim: disable unused toolsets |
| CLAUDE.md (project) | memory | 3,900 | - | half is lint rules | trim: linters enforce those |
| seo-writer | skill | 71 | 18,400 | never fired | cut: dead |
| commit-helper | skill | 62 | 1,410 | overlaps git-flow | keep |
```

Close with three totals: always-on today, always-on after the cuts, what that
saves on every single call.

## Trim Moves

- Disable MCP servers you rarely use; reconnect when needed. Disable per
  project where the client allows: a server idle in this repo may be
  load-bearing in another. Prefer clients that defer tool loading.
- Cut memory-file rules a linter or formatter already enforces.
- Move backstory and examples out of skill bodies and human-authored memory
  files into reference files fetched on demand.
- Merge colliding skills, or sharpen both descriptions until triggers stop
  overlapping.
- Hide a rarely-triggered skill from the always-on list without deleting it:
  in OpenCode set `metadata.opencode/autoinvoke: false` in its frontmatter.
  The skill stays loadable by ID (`@skill-id`) but is no longer advertised on
  every step.
- Delete the duplicate when something is installed at user and project
  level. Cut your user-level copy first: the project copy may be the team's,
  and cutting it from a shared repo cuts it for everyone.

## The Card

Step on the scale first, cut, step on it again. Read the last card from
`.cutweight/weigh-ins.md` if it exists. Compute the delta.

Weight classes, by always-on tokens per message:

| class | always-on |
|---|---|
| flyweight | under 1,000 |
| lightweight | under 3,000 |
| middleweight | under 8,000 |
| heavyweight | under 20,000 |
| superheavyweight | 20,000 and up |

```text
cutweight weigh-in: 2026-07-10
always-on: 7,412 tokens on every message
  skills: 3,509 (27 installed)
  memory files: 3,903
  mcp schemas: ~0 (deferred loading)
class: middleweight
last weigh-in: 9,180 (-19%, was heavyweight)
next cut: the 25-skill plugin billing 2,462 for 4 skills used
```

Keep the card under 12 lines. It is made to be posted. Append it to
`.cutweight/weigh-ins.md`; never edit old cards.

## Hard Rules

- Never delete or edit anything but your own log. Output the list, the human
  cuts.
- Measured numbers only; estimates get labeled. No benchmark folklore.
- No fire history available means unknown, not unused.
- Every verdict says why: overlap, dead, fat body, duplicate, eager schemas.
- The log is append-only. A rewritten history is not a weigh-in.
- The card always names the single next cut, or says "at weight" if lean.
- Never name an agent-maintained memory file (auto-memory index, session
  memory) as the next cut. Bill it on the card, flag it to its owner. Its
  lines are the agent's retrieval keys; hand-trimming them breaks recall.
- A card meant for posting shows counts and categories, never private tool,
  server, or plugin names. Generalize anything internal before it leaves
  the machine.
- Keep `.cutweight/` out of version control; the log stays on the machine.
