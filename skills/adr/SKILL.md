---
name: adr
description: >
  Capture an architecture decision as a numbered ADR (Architecture Decision
  Record) in the repository, recording context, the decision, alternatives
  rejected, and consequences. Use when a design choice is made or revisited —
  choosing a library, a data store, an API shape, a migration path — or when
  asked to document why something is the way it is, зафиксировать решение,
  записать ADR.
---

# Architecture Decision Record

An ADR records a decision **and why it won**, so the next person (or the next
session) does not relitigate it from scratch. The rejected options matter as
much as the chosen one.

## When To Write One

Write an ADR when a decision:
- is hard or expensive to reverse (data model, protocol, dependency, storage),
- affects more than one module or team,
- was contested, or will be questioned later,
- replaced an earlier decision (then also mark the old ADR superseded).

Do not write one for a routine change a commit message already explains.

## Where It Lives

```text
docs/adr/
├── 0001-record-architecture-decisions.md
├── 0002-use-sqlite-for-local-state.md
└── 0003-replace-plugin-format-with-v2-api.md
```

- One directory, one file per decision, zero-padded sequential number.
- If the repo has no `docs/adr/`, create it and seed `0001` with the
  "we record decisions in ADRs" record.
- Filenames are lowercase kebab-case; the number is never reused.

## Template

```markdown
# NNNN. <short decision title>

- Status: proposed | accepted | rejected | superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Deciders: <names or roles>

## Context

What forces are at play: the problem, the constraints (time, platform,
existing stack), and what breaks if we do nothing. Facts and numbers, not
opinions.

## Decision

The decision, in one or two sentences, present tense: "We use X for Y."

## Consequences

What becomes easier and what becomes harder. Include the costs we accept:
new dependency, migration work, operational burden, lock-in.

## Alternatives Considered

| option | why rejected |
|---|---|
| ... | ... |

Every rejected option names the concrete reason it lost, not "not ideal".
```

## Workflow

1. Find the next number: `ls docs/adr/` and take one past the highest.
2. Write the file with status `proposed` while it is under discussion.
3. On agreement, change status to `accepted` in the same commit that lands
   the decision — or the PR that implements it.
4. If a later ADR overrides it, edit only the old one's **Status** line to
   `superseded by ADR-NNNN`; never rewrite its body. History is the point.

## Hard Rules

- One decision per ADR. If you are writing "and also", write two.
- Never delete or rewrite a superseded ADR's content.
- The Context section carries real constraints with numbers where possible.
- Alternatives must have honest rejections; an ADR with no alternatives is
  a note, not a record.
- Match the repository's documentation language (this project: Russian prose
  is fine; keep the template's section headings as written).
