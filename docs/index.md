# Silo

> Give AI agents durable, structured state for a Git repository.

AI agents often need state that lasts longer than one run.

Silo gives each Git repository a local SQLite database for that state.

A logical schema says what the data means and which values are valid. Silo
commands check supported writes against that schema.

Agents can read the data with SQL or saved queries. They can also put query
results into refreshable Markdown reports for people.

The database stays local unless you choose to share it. `silo pull` and
`silo push` exchange remote checkpoints explicitly.

Silo includes a bundled [agent skill](https://github.com/silo-ai/silo/tree/main/skills/silo)
with operating guidance and JSON request schemas.

## Start here

- [Getting started](getting-started.md) creates a table, writes a row, and
  reads it back.
- [How Silo works](concepts/how-silo-works.md) explains the full mental model.

## Define and use state

- [Design a schema](guides/design-a-schema.md) turns a durable repository
  concept into a table with enforceable invariants.
- [Work with rows](guides/work-with-rows.md) covers row commands and read-only
  SQL.
- [Atomic transactions](concepts/atomic-transactions.md) combines validated
  library row mutations across user tables.

## Create reusable reads

- [Run saved queries](guides/run-saved-queries.md) turns repeated reads into
  typed repository-defined commands.
- [Publish a refreshable report](guides/publish-a-report.md) combines durable
  Markdown framing with current query results.

## Share state

- [Synchronize a database](guides/synchronize.md) covers the explicit
  pull/work/push loop and conflict recovery.
- [Synchronization model](concepts/synchronization.md) explains the guarantees
  behind checkpoints, rebasing, and durability.

## Look up details

- [Workspace and schema model](concepts/workspace-and-schema.md) explains
  repository identity, logical metadata, and generated SQLite objects.
- [Semantic types](reference/semantic-types.md) lists accepted JSON values and
  normalization behavior.
- [Semantic relations](reference/relations.md) explains named domain
  relationships backed by foreign keys and their derived cardinality.
- [Policies](reference/policies.md) compares generated values, concurrency
  controls, and immutability rules.
- [Tasks template](templates/tasks.md) installs an agent-work queue with its
  own authorization and execution rules.
- [Mutation journal](concepts/mutation-journal.md) documents the advanced local
  invalidation API.
- [Troubleshooting](troubleshooting.md) starts from common symptoms and shows
  what to verify.

Run `silo --help` and `silo <group> <command> --help` for exact command syntax.
