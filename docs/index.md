# Silo

> Use Silo when agents need durable, structured state tied to a Git repository and SQLite's constraints should remain visible.

Silo maps the current repository's normalized `origin` remote to a local SQLite database. A logical schema records semantic types, comments, constraints, indexes, and policies; SQLite `STRICT` tables, checks, and triggers enforce the physical contract.

## Start here

- [Getting started](getting-started.md) creates a table and completes the first write and read.
- [Design a schema](guides/design-a-schema.md) turns a durable repository concept into a table Silo can enforce.
- [Tasks template](templates/tasks.md) installs an agent-work queue with explicit human authorization and execution tracking.
- [Work with rows](guides/work-with-rows.md) covers inserts, reads, updates, upserts, and read-only SQL.
- [Publish a refreshable report](guides/publish-a-report.md) combines durable Markdown framing with saved-query results for human readers.
- [Synchronize a database](guides/synchronize.md) configures an S3-compatible remote and covers the pull, push, and conflict-recovery workflow.
- [Workspace and schema model](concepts/workspace-and-schema.md) explains how repository identity, logical metadata, and SQLite fit together.
- [Synchronization model](concepts/synchronization.md) explains remote authority, checkpoint publication, changeset merging, and durability boundaries.
- [Semantic types](reference/semantic-types.md) lists accepted JSON values and normalization behavior.
- [Policies](reference/policies.md) compares generated values, concurrency controls, and immutability rules.
- [Troubleshooting](troubleshooting.md) starts from common symptoms and shows what to verify.

## What Silo owns

Silo owns one local database per normalized Git `origin`. It validates JSON row input, stores an authoritative logical schema, compiles that schema to SQLite objects, and verifies the physical database whenever it opens the file. It also stores refreshable Markdown report definitions, saved queries, and last successful renderings beside their source data.

Synchronization is optional and explicit. When configured, Silo exchanges immutable Litestream checkpoints through S3-compatible storage and merges pending row and report transactions with SQLite changesets. It has no automatic synchronization, branches, or user-visible history.

Silo does not migrate data when `origin` changes, accept raw SQL mutations, or provide audit history. Raw SQL uses a read-only SQLite connection.

Run `silo --help` and `silo <group> <command> --help` for the exact command syntax. The bundled [`skills/silo/`](https://github.com/silo-ai/silo/tree/main/skills/silo) package contains agent operating guidance and JSON request schemas.
