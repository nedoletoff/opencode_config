---
name: refactor
description: >
  Restructure code safely without changing its behavior — rename, extract,
  inline, move, split a module — proving behavior is unchanged at every step.
  Use when asked to refactor, restructure, clean up, переписать, вынести,
  разбить модуль, or reduce duplication, and behavior must stay identical.
---

# Refactor

Refactoring changes structure and nothing else. If behavior changed, it was
not a refactor — it was a rewrite, and it needs its own tests and review.

## The Rule

Every refactor has two halves:
1. A **behavior-preserving** transformation.
2. A **green check** proving behavior is unchanged.

Never do both halves in one unverified step. Never mix a refactor with a
feature or a fix in the same commit.

## Before Touching Anything

1. **Establish the safety net.** Find the tests covering the code you will
   move. Run them and record they pass: `git stash` is not a test.
2. **If there is no net, build one first.** Write characterization tests —
   tests that pin the current behavior as-is, bugs included — and only then
   refactor. A refactor with no test is a guess.
3. **Commit the net separately.** The test commit and the refactor commit are
   different commits; if the refactor goes wrong, the net survives.
4. **Bound the change.** Write down, in one sentence, the structural goal.
   If mid-way you find a bug, stop and note it; fix it after, in its own
   commit, with its own test.

## The Loop

For each small step:

```text
change → run the narrowest test → run the full suite → commit
```

- **Rename** — one name at a time; use the language's rename tool or a
  compiler-checked change, not find-and-replace across the repo.
- **Extract** — pull code into a function/module with the same body, call it
  from the original site. Behavior identical by construction.
- **Inline** — the inverse; only when the indirection earns nothing.
- **Move** — relocate a unit, update every import; the compiler or linter
  must still pass before you commit.
- **Split a module** — draw the seam along existing boundaries, not a new
  abstraction you invent mid-move.

Keep each step small enough to describe in one line. If a step needs a
paragraph to explain, it is too big.

## Checkpoints

After each step, verify in this order:
1. The narrowest relevant test passes.
2. The full test suite passes.
3. The build/lint passes.
4. The diff contains only structural change — no logic edits, no new
   features, no reformatting of untouched lines.

If any check fails, revert the step (`git checkout -- <files>`) and try a
smaller one. Do not fix forward inside a refactor.

## Anti-Patterns

- Renaming and changing logic in the same pass.
- Refactoring code with no tests, then "testing" it by running the app by eye.
- Reformatting entire files so the real diff is buried — keep formatting
  changes in their own commit.
- A refactor PR with no reviewer-visible statement of what structure changed.
- Continuing after a red test because "it will pass once I finish".

## Hard Rules

- Behavior-preserving, or it is not a refactor.
- Tests run before and after every step; a claim without a run is not a
  check.
- One structural idea per commit; describe it in the message.
- Bugs found mid-refactor are fixed later, separately, with a test.
- Refactor on a branch, never straight onto a shared trunk.
