# Silo

> Give a Git repository a local, typed SQLite database that agents can use safely and share deliberately.

Silo keeps durable repository state in a local SQLite database. A logical
schema defines the meaning and rules of that state; Silo commands validate and
mutate it, while read-only SQL, saved queries, and reports make it useful.

Synchronization is optional. When enabled, `silo pull` and `silo push` share
published database checkpoints explicitly; they do not create a live or
background connection between machines.

## Start with the mental model

[How Silo works](concepts/how-silo-works.md) explains the five ideas that
connect the product: workspace, schema, rows, read surfaces, and
synchronization.

## Choose a path

### Learn the basic workflow

- [Getting started](getting-started.md) creates a table and completes the first
  write and read.
- [Design a schema](guides/design-a-schema.md) turns a durable repository
  concept into a table with enforceable invariants.
- [Work with rows](guides/work-with-rows.md) covers row commands and read-only
  SQL.

### Build reusable reads

- [Run saved queries](guides/run-saved-queries.md) turns repeated reads into
  typed repository-defined commands.
- [Publish a refreshable report](guides/publish-a-report.md) combines durable
  Markdown framing with current query results.

### Share state between machines

- [Synchronize a database](guides/synchronize.md) covers the explicit
  pull/work/push loop and conflict recovery.
- [Synchronization model](concepts/synchronization.md) explains the guarantees
  behind checkpoints, rebasing, and durability.

## Look up details

- [Workspace and schema model](concepts/workspace-and-schema.md) explains
  repository identity, logical metadata, and generated SQLite objects.
- [Semantic types](reference/semantic-types.md) lists accepted JSON values and
  normalization behavior.
- [Policies](reference/policies.md) compares generated values, concurrency
  controls, and immutability rules.
- [Tasks template](templates/tasks.md) installs an agent-work queue with its
  own authorization and execution rules.
- [Mutation journal](concepts/mutation-journal.md) documents the advanced local
  invalidation API.
- [Troubleshooting](troubleshooting.md) starts from common symptoms and shows
  what to verify.

Run `silo --help` and `silo <group> <command> --help` for exact command syntax.
The bundled [`skills/silo/`](https://github.com/silo-ai/silo/tree/main/skills/silo)
package contains agent operating guidance and the JSON request schemas it
references.
