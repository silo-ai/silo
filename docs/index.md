# Silo

> Keep repository state queryable and checked without putting the active database in Git.

Use Silo when repository state needs current, queryable rows and a shared write
contract. A file is easy to overwrite, plain SQLite leaves each caller to define
its own write rules, and Git is better at source history than current rows. Silo
gives each Git repository a local SQLite database, a logical schema, and a
supported write boundary. Agents can read current state with SQL or saved
queries, and people can consume refreshable reports.

## The boundaries that matter

- **Local database:** The active SQLite database stays on your machine, outside
  the Git repository. A clone does not contain the database.
- **Logical schema:** The schema says what tables and values mean and what is
  allowed. Silo commands perform supported writes; `silo sql` and saved-query
  execution are read-only.
- **Explicit sharing:** Sharing is optional. `silo push` publishes a remote
  checkpoint and `silo pull` restores and reapplies compatible local work. This
  is explicit exchange, not live replication; it needs a configured
  S3-compatible remote and adds storage, transfer, and operator setup.
- **Current state, not audit history:** Silo helps agents keep current
  repository state. It is not a user-facing, actor-attributed audit history.

## Follow the short path

The intended path is [Getting started](getting-started.md) →
[How Silo works](concepts/how-silo-works.md) →
[Design a schema](guides/design-a-schema.md).

**Start here:** [Getting started](getting-started.md) creates an `issues` table,
writes one row, reads it with SQL and row commands, and shows a rejected value.

**Prefer the model first?** [How Silo works](concepts/how-silo-works.md) explains
where the database lives, how the schema is enforced, which operations can
write, and what `push` and `pull` actually share.

## Continue by task

- [Design a schema](guides/design-a-schema.md) is the first adoption step for
  a real durable entity.
- [Work with rows](guides/work-with-rows.md) covers ordinary inserts, reads,
  updates, upserts, deletes, and read-only SQL.
- [Run saved queries](guides/run-saved-queries.md), then [publish a refreshable
  report](guides/publish-a-report.md), when a repeated read should be reusable
  or human-facing.
- [Synchronize a database](guides/synchronize.md) when several machines need
  the same state.

Use the deeper [Workspace and schema model](concepts/workspace-and-schema.md),
[Semantic types](reference/semantic-types.md), [Policies](reference/policies.md),
[Semantic relations](reference/relations.md), [Atomic transactions](concepts/atomic-transactions.md),
[Mutation journal](concepts/mutation-journal.md), [Synchronization model](concepts/synchronization.md),
and [Troubleshooting](troubleshooting.md) only when the workflow needs their
guarantees or lookup details. The [Tasks template](templates/tasks.md) is a
specialized workflow, not a prerequisite.

Agents can also use the bundled [agent skill](https://github.com/silo-ai/silo/tree/main/skills/silo)
when they need operating guidance and request schemas.

Run `silo --help` and `silo <group> <command> --help` for exact command syntax.
