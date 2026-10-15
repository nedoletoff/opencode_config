---
name: sqlite-ops
description: >
  Inspect, query, and safely modify SQLite databases — schema, indexes,
  migrations, WAL, integrity. Use when a task touches a .db file, asks to
  look inside a SQLite store (OpenCode's opencode.db, Magic Context's
  context.db), write a migration, or debug a database locked / corrupt /
  growing-WAL problem.
---

# SQLite Operations

SQLite is a file, but it is not a text file. Never open it with `cat`,
`sed`, or an editor — you will corrupt it.

## Read Safely

```sh
# Schema, without touching the file
sqlite3 db.sqlite '.schema'
sqlite3 db.sqlite '.tables'
sqlite3 db.sqlite 'PRAGMA table_info(users);'
sqlite3 db.sqlite 'PRAGMA index_list(users);'

# Query in read-only mode — cannot write even by accident
sqlite3 'file:db.sqlite?mode=ro' 'SELECT count(*) FROM sessions;'

# Wide output for inspection
sqlite3 -header -column db.sqlite 'SELECT id, created_at FROM sessions LIMIT 20;'
```

For a **WAL** database, a read-only open may fail if the `-wal` file is not
writable. Copy all three files first, then inspect the copy:

```sh
cp db.sqlite db.sqlite-wal db.sqlite-shm /tmp/opencode/
```

## Before Any Write

1. **Back up all three files** (`.db`, `-wal`, `-shm`). A copy of just the
   `.db` can lose the most recent committed data.
2. Stop the process that owns the database. Writing while a server holds it
   risks `SQLITE_BUSY` and, worse, a torn state if you kill it mid-write.
3. Check integrity first: `PRAGMA integrity_check;` — expect `ok`.
4. Wrap multi-statement writes in a transaction:
   `BEGIN; ... ; COMMIT;` — never a bare sequence of statements.

## Migrations

```sql
BEGIN;
-- forward migration only; keep it idempotent where possible
ALTER TABLE notes ADD COLUMN anchor_ordinal INTEGER;
CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, tag_number);
PRAGMA user_version = 31;   -- or your own schema_version table
COMMIT;
```

- Every migration is **reversible in principle**: know the down path before
  running the up path.
- One idea per migration; number them.
- Test on a copy of production-shaped data, never first on live data.
- Bump the recorded version in the same transaction.

## Diagnostics

```sql
PRAGMA integrity_check;      -- full check (slow on big DBs)
PRAGMA quick_check;          -- fast subset
PRAGMA journal_mode;         -- expect 'wal' for concurrent servers
PRAGMA page_count;           -- size in pages
PRAGMA freelist_count;       -- free pages; large = needs VACUUM
PRAGMA foreign_key_check;    -- orphaned references
```

| symptom | likely cause | move |
|---|---|---|
| `database is locked` | another writer holds it | wait, add busy timeout, don't force |
| WAL file huge | readers never checkpoint | `PRAGMA wal_checkpoint(TRUNCATE);` with writers stopped |
| file shrinks never | free pages not reclaimed | `VACUUM;` (needs free space equal to the DB) |
| `database disk image is malformed` | corruption | stop writes, restore backup, `PRAGMA integrity_check` on the copy |

## This Machine

- OpenCode state: `~/.local/share/opencode/opencode.db` (+ `-shm`, `-wal`).
- Magic Context: `~/.local/share/cortexkit/magic-context/context.db` — has
  its own migration lane (`user_version` / internal schema version) and a
  `PRAGMA integrity_check` at boot. Never hand-edit it; use its tooling.
- Both are owned by a running service. Stop or restart the service around
  manual reads if a lock appears.

## Hard Rules

- Never edit a `.db` with a text tool.
- Back up `.db` + `-wal` + `-shm` together before any write.
- Never run a write while you are unsure the owning process is stopped.
- `integrity_check` before and after any manual surgery.
- No `DROP`, `DELETE` without a `WHERE` clause the user agreed to.
- Report the exact command and its output; "it should be fine" is not
  evidence.
