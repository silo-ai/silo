# Silo

> Give agents a local database for project work.

Keep findings, plans, and progress available across agent sessions without
adding working data to Git.

Use Silo when several agents need to build on the same work:

- **Audit a dataset.** Agents record findings in a common table. Another agent
  queries the findings together to identify patterns.
- **Manage a migration.** Plan work in a table and update progress as it proceeds.
  A coordinating agent uses that table to assign work to subagents.
- **Continue in a later session.** The next agent reads outstanding work and
  records what changed.

You define the tables and their rules. Silo checks writes against those rules,
and agents can read the data with SQL. Agents make the decisions about what to
work on; Silo stores the data they use.

## Start here

[Getting started](getting-started.md) walks through creating an `issues` table,
adding a row, and reading it back. It also shows what happens when a write
contains an invalid value.

Then use [Design a schema](guides/design-a-schema.md) to define tables for your
own work.

## Before you use it

- **The database stays outside Git.** Each repository selects a local SQLite
  database. A clone does not include its data.
- **Write through Silo commands.** SQL and saved queries are read-only.
- **Sharing is optional and manual.** Sharing between machines requires
  S3-compatible storage and explicit `silo push` and `silo pull` commands.
  Storage and transfer costs depend on your provider.
- **There is no user-facing history of changes.** The database holds your
  current data; Silo does not provide an audit trail.

[How Silo works](concepts/how-silo-works.md) explains where the database lives,
how the schema is enforced, and how sharing works.

## Choose your next task

- [Work with rows](guides/work-with-rows.md): read and change the data in a table.
- [Run saved queries](guides/run-saved-queries.md): save SQL and run it by name
  with typed arguments.
- [Publish a refreshable report](guides/publish-a-report.md): turn query results
  into Markdown you can open in a local browser viewer. Reports run trusted
  JavaScript on your machine.
- [Synchronize a database](guides/synchronize.md): share changes between machines
  and handle conflicts.
- [Use the Tasks template](templates/tasks.md): start with a bundled schema for
  task tracking instead of designing your own.
- [Troubleshoot a problem](troubleshooting.md): check a symptom and find the
  smallest fix.

## Give your agent the instructions

Run this from any directory to read Silo's bundled agent guidance:

```sh
silo skill
```

It prints instructions for using Silo, with links to task guides and JSON
request schemas. Agents can read those links through the CLI too:

```sh
silo skill tasks/create-table.md
```

For command syntax, run `silo --help` or a command's own help, such as
`silo row add --help`.
