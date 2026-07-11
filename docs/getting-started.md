# Getting Started

> Create repository-scoped state, verify its schema, and persist the first row without needing to locate or manage a SQLite file.

## Prerequisites

Install Silo globally:

```sh
pnpm add --global silo
```

Silo requires Node.js 22.12 or newer, SQLite 3.37.0 or newer, and a Git worktree with a usable `origin` remote. From the repository you want to associate with the data, verify the resolved identity:

```sh
silo status
```

The output reports the Git root, normalized repository identity, database path, database state, schema revision, and SQLite version. A state of `absent` is expected before the first schema mutation.

## Create a table

Create an `issues` table from a JSON request on standard input:

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

The first successful schema mutation creates the database. Silo rejects unknown request fields and leaves no database behind if initial schema compilation fails.

Inspect the logical contract before writing data:

```sh
silo schema show
silo table show issues
```

`schema show` identifies the schema revision and any imported agent instructions. `table show` displays semantic types, constraints, indexes, and each policy's enforcement boundary.

## Add and read a row

Insert an issue without supplying the generated UUID:

```sh
printf '%s\n' '{"title":"Document the release process"}' | silo row add issues
```

The result contains the complete persisted row, including the generated `id`. Copy that value to retrieve the row by its primary key:

```sh
silo row get issues 550e8400-e29b-41d4-a716-446655440000
```

To inspect the table without a known key:

```sh
silo row list issues --limit 20
```

Continue with [Design a schema](guides/design-a-schema.md) before modeling additional entities, [Work with rows](guides/work-with-rows.md) for update, upsert, and query workflows, or [Synchronize a database](guides/synchronize.md) to share the database explicitly between machines.
