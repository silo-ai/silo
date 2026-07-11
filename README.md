# Silo

> Give agents durable, strictly typed SQLite state scoped to a Git repository without hiding SQLite’s constraints or query model.

Silo resolves the current repository’s normalized `origin` remote to one local database. An authoritative logical schema records semantic types, comments, constraints, indexes, and policies; SQLite `STRICT` tables, checks, and triggers enforce the physical contract.

## Install

```sh
pnpm add --global silo
```

Silo requires Node.js with SQLite 3.37.0 or newer and a Git worktree with an `origin` remote.

## Create the first table

Define a table through JSON on stdin:

```sh
silo table create <<'JSON'
{
  "name": "issues",
  "comment": "One actionable repository issue; read before planning work and update as its disposition changes.",
  "columns": [
    {
      "name": "id",
      "type": "text/uuid",
      "nullable": false,
      "comment": "Stable Silo-generated issue identifier."
    },
    {
      "name": "title",
      "type": "text",
      "nullable": false,
      "comment": "Short actionable issue summary."
    }
  ],
  "primary_key": ["id"],
  "policies": [
    { "type": "generated_identity", "column": "id", "strategy": "uuid" }
  ]
}
JSON
```

The first schema mutation creates the database. Inspect the resulting logical schema with `silo schema show`, then use `silo row add issues` to write rows.

Run `silo --help` and `silo <group> <command> --help` for the authoritative command syntax and examples. The self-contained [`skills/silo/`](skills/silo/) package includes both agent operating practices and the exact JSON request contracts it references.

## Import a schema template

Import the bundled agent-first task schema into the current repository:

```sh
silo schema import tasks
```

Template imports are additive. Repeat `schema import` for other templates whose table names do not conflict. Each import copies its tables and attributed agent instructions into the local authoritative schema; later template edits do not change the local copy.

## Boundaries

Silo is local and single-machine. It does not synchronize databases, migrate data when `origin` changes, accept raw SQL mutations, provide audit history, or claim that CLI-only validation survives direct external writes. Raw SQL runs through a read-only SQLite connection.

Databases use WAL with a five-second busy timeout and `synchronous=NORMAL`. Keep active database files on local storage rather than network or cloud-synchronized folders.
