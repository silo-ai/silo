# Silo

> Give agents durable, strictly typed SQLite state scoped to a Git repository without hiding SQLite’s constraints or query model.

Silo resolves the current repository’s normalized `origin` remote to one local database. An authoritative logical schema records semantic types, comments, constraints, indexes, and policies; SQLite `STRICT` tables, checks, and triggers enforce the physical contract.

## Install

```sh
pnpm add --global @silo-ai/silo
```

Silo requires Node.js 24.10.0 or newer with SQLite 3.37.0 or newer, and a Git worktree with an `origin` remote.

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

To make the packaged guidance discoverable without installing a separate agent skill, add this rule to your global `AGENTS.md`:

> - When told to “use Silo” or do something with Silo, run `silo skill` and follow its instructions. Read any referenced task guide or JSON Schema with `silo skill <relative-path>`.

`silo skill` prints the main skill. Its relative links can be read from any directory, for example with `silo skill tasks/create-table.md` or `silo skill schemas/row-write.schema.json`.

## Import a schema template

Import the bundled agent-first task schema into the current repository:

```sh
silo schema import tasks
```

Template imports are additive. Repeat `schema import` for other templates whose table names do not conflict. Each import copies its tables and attributed agent instructions into the local authoritative schema; later template edits do not change the local copy.

## Synchronize explicitly

Synchronization is optional. With Litestream 0.5.12 or newer installed and standard AWS credentials available, connect the local database to an S3-compatible remote:

```sh
silo sync init s3://my-bucket/silo/project
silo push
```

On another machine, run the same `sync init` command to restore the remote database. Thereafter, use `silo pull` before work and `silo push` when the local changes are ready to share. Silo merges non-conflicting row transactions and stops on conflicts; it never chooses a last writer automatically.

See [Synchronize a database](docs/guides/synchronize.md) for setup and recovery, and [Synchronization model](docs/concepts/synchronization.md) for durability and concurrency guarantees.

## Save a typed query

Turn a repeated read into a repository-defined command with semantic parameter validation:

```sh
silo query put <<'JSON'
{
  "name": "blocked-work",
  "description": "Blocked tasks for one owner, ordered by their last update.",
  "sql": "SELECT title, updated_at FROM tasks WHERE status = 'blocked' AND owner = :owner ORDER BY updated_at",
  "parameters": [
    {
      "name": "owner",
      "type": "text",
      "description": "Canonical owner identifier."
    }
  ]
}
JSON

silo query blocked-work --owner alec
```

Named parameters become CLI options. Positional definitions use declared order and SQLite `?` or `?N` placeholders. `silo query <name> --help` shows the stored types, defaults, and descriptions.

Saved query definitions synchronize explicitly with other durable Silo state; execution remains read-only and does not create a pending transaction. See [Run saved queries](docs/guides/run-saved-queries.md) for parameter styles, management commands, and safety boundaries.

## Publish a refreshable report

Reports keep agent-authored Markdown framing and saved SQL beside the Silo data they explain. Create a report definition after its source tables contain data:

```sh
silo report put <<'JSON'
{
  "slug": "execution-brief",
  "title": "Project execution brief",
  "markdown": "# Project execution brief\n\n## Work by status\n\n{{silo-query:work_by_status}}",
  "queries": [
    {
      "name": "work_by_status",
      "sql": "SELECT status, count(*) AS tasks FROM tasks GROUP BY status ORDER BY tasks DESC",
      "empty_markdown": "_No tasks._"
    }
  ]
}
JSON
```

`report put` validates and runs every query before atomically publishing the definition and its initial rendering. Changing facts belong in query slots; ordinary Markdown is not regenerated when the report refreshes.

Open the packaged viewer for a human reader:

```sh
silo report open execution-brief
```

The command starts a foreground HTTP server on a random loopback port and opens the default browser. The server-rendered page shows the last successful result immediately, refreshes after opening and whenever the page regains focus, and leaves stale output visible if a refresh fails. Interrupt the command to stop the server.

The viewer renders GitHub-flavored Markdown without executing report-authored HTML. Refresh requests remain local and require the page's origin and per-server token; the server is not intended for remote hosting.

See [Publish a refreshable report](docs/guides/publish-a-report.md) for the complete authoring, viewer, refresh, synchronization, and recovery workflow.

## Boundaries

The active database remains local and synchronization is always explicit: Silo has no background daemon, automatic push or pull, branches, or user-visible history. Saved-query and report mutations join the same pending transaction stream as row mutations and are shared only on `silo push`. Silo does not migrate data when `origin` changes, accept raw SQL mutations, provide audit history, or claim that CLI-only validation survives direct external writes. Raw and saved SQL run through read-only boundaries. Report-private queries remain parameterless; reports do not support schedules, charts, cross-Silo queries, remote hosting, or AI-generated refresh prose.

Databases use WAL with a five-second busy timeout and `synchronous=NORMAL`. Keep active database files on local storage rather than network or cloud-synchronized folders.
