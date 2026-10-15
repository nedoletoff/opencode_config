---
name: code-review
description: >
  Review a diff, a commit, a branch, or a pull request against a checklist
  before it is merged. Use when asked to review code, check a PR, ревью,
  посмотреть дифф, or verify a change is safe to land. Produces findings
  ordered by severity with file:line references, each backed by evidence
  from the code, and an explicit verdict.
---

# Code Review

Review the change, not the author. Every finding names a file and a line,
quotes the evidence, and says what breaks. No style opinions without a rule
behind them.

## Before Reviewing

1. Read the diff completely: `git diff <base>...<head>` (or `git show <sha>`,
   or the PR's changed files). Never review from a summary alone.
2. Read the surrounding code for each hunk, not just the changed lines.
   A hunk that is correct in isolation can be wrong in context.
3. Read the tests that cover the changed paths. If none exist, say so.

## Checklist

**Correctness**
- Does the change do what its message claims? Does the message match the diff?
- Off-by-one, inverted conditions, wrong variable, shadowed binding.
- Null/undefined/empty paths: what happens on the empty input?
- Error paths: are errors caught, propagated, or silently swallowed?
- Concurrency: shared mutable state, races, missing awaits.

**Contracts**
- Public signatures, return types, and error types unchanged — or every
  caller updated.
- Config keys, env vars, and CLI flags still read the same names.
- API/DB shape changes have a migration, and the migration is reversible.

**Safety**
- No hardcoded secrets, tokens, or passwords. Credentials from env or a
  gitignored `.env` only.
- No widened permissions, removed auth checks, or disabled validation.
- Destructive operations (delete, drop, force push, `rm -rf`) are guarded.

**Tests**
- New behavior has a test that would fail without the change.
- Existing tests updated for intended behavior changes, not deleted to pass.
- Test asserts the outcome, not the implementation's internals.

**Style and structure** (lowest priority — cite a project rule or linter)
- Matches surrounding naming, layout, and comment language.
- No dead code, commented-out blocks, or debugging leftovers.

## Finding Format

````markdown
### [severity] file:line — short title
**What:** the problem in one sentence.
**Evidence:** the quoted line(s) or the failing path.
**Why it matters:** the concrete failure or risk.
**Fix:** the smallest change that resolves it.
````

Severity, in order:
- **blocker** — wrong result, data loss, security hole, breaks the build.
- **major** — a real bug on a reachable path, or a broken contract.
- **minor** — works today, fragile or confusing; fix before it bites.
- **nit** — taste; take it or leave it.

## Verdict

End with exactly one:
- **Approve** — land it as is.
- **Approve with nits** — land it; nits are optional.
- **Request changes** — a blocker or major must be fixed first.

Name the single most important thing to fix, if any. If the diff is clean,
say so plainly; do not invent findings to look thorough.

## Hard Rules

- Never claim a line is wrong without quoting it.
- A finding with no evidence is an opinion — label it or drop it.
- Do not rewrite the change yourself unless asked; review first.
- Do not approve code you have not read end to end.
