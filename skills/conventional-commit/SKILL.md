---
name: conventional-commit
description: >
  Write a commit message in Conventional Commits format, in the project's
  language. Use when asked to commit, составить сообщение коммита, named
  "conventional commits", or when a commit must follow the repo's rules
  before pushing. Produces one message in the correct type/scope/subject
  shape, matching the repository's existing history.
---

# Conventional Commits

One commit, one message, one reason.

## Format

```text
<type>(<scope>): <subject>

<body>

<footer>
```

- `subject` — imperative, lowercase first letter, no trailing period.
- Keep the subject line under 72 characters.
- `body` — optional; the *why*, not the *what*. Separate from the subject by
  one blank line. Wrap at 72 characters.
- `footer` — optional; issue refs (`Refs: #12`, `Closes: #34`) and breaking
  changes (`BREAKING CHANGE: ...`).

## Types

| type | use for |
|---|---|
| `feat` | a new feature |
| `fix` | a bug fix |
| `docs` | documentation only |
| `style` | formatting, no behavior change |
| `refactor` | code change, no feature or fix |
| `perf` | a performance improvement |
| `test` | tests only |
| `build` | build system, dependencies |
| `ci` | CI configuration |
| `chore` | maintenance, no src or test change |
| `revert` | revert a previous commit |

Use `!` after the type or scope (or a `BREAKING CHANGE:` footer) when the
change breaks compatibility: `feat(api)!: drop the v1 endpoint`.

## Language

Match the repository:
- Read the last 20 subjects: `git log --oneline -20`. Follow their language,
  casing, and any scope vocabulary they already use.
- If the project's rules (AGENTS.md / CLAUDE.md / CONTRIBUTING) name a
  language, that wins over the history.
- This project (see `AGENTS.md`) requires **Russian** commit messages:
  `fix: исправлена опечатка в README`, `feat: добавлена валидация формы`.
  Scope names and type keywords stay English; the subject is Russian.

## Before Committing

1. `git status` — see what is staged and untracked. Stage deliberately.
2. `git diff --staged` — read the change you are about to describe. The
   message must match this diff, not an earlier mental model of it.
3. Check for secrets in the diff: keys, tokens, passwords, `.env` contents.
   If found, stop and remove them before committing.
4. One logical change per commit. If the diff mixes unrelated work, split it:
   `git add -p` and commit in parts.

## Examples

```text
feat: добавлена валидация формы регистрации

Проверяем email и минимальную длину пароля на клиенте,
чтобы не гонять заведомо неверные данные на сервер.

Closes: #128
```

```text
fix(auth): устранена утечка сессии при выходе

refresh-токен не отзывался на сервере, из-за чего старая
сессия оставалась валидной до истечения срока.

BREAKING CHANGE: эндпоинт /logout теперь требует заголовок
Authorization.
```

## Hard Rules

- Do not commit secrets. Ever.
- Do not write a message that describes a change the diff does not contain.
- Do not use `--no-verify` to skip a hook without saying so.
- Do not amend or force-push a shared branch without being asked.
