# Silo

> Give agents a local database for project work.

Keep findings, plans, and progress available across agent sessions without adding working data to Git.

Agents write through Silo's CLI, which checks each write against the table's rules. They can query the data with SQL, so one agent can analyze or continue another agent's work.

## What you can use it for

- **Collect audit findings.** Have agents record dataset problems in a common table. Another agent can analyze the findings together to identify patterns and summarize results.
- **Plan and track migrations.** Record work ahead of time, then update progress as it proceeds. A coordinating agent can use the migration table to assign work to subagents and decide what comes next.
- **Keep work available between sessions.** Give the next agent a place to read outstanding work and record what changed.

You define what the tables hold. Agents decide how to use them; Silo does not assign or schedule their work.

Each Git repository selects a local SQLite database stored outside the repository. Git does not commit the database, and cloning a repository does not copy its data. Sharing between machines is optional and uses explicit push and pull commands.

## Install

```sh
pnpm add --global @silo-ai/silo
```

You need:

- Node.js 24.10.0 or newer
- SQLite 3.37.0 or newer
- A Git worktree

## Track a migration

Run these commands from the repository you are migrating. This example uses one row per component, so an agent can see which components still need work.

Save this table definition as `migration-table.json`. It is an input file for the command below; you do not need to commit it.

```json
{
  "name": "migration",
  "comment": "One component to migrate. Read before assigning work and update as work proceeds.",
  "columns": [
    {
      "name": "component",
      "type": "text",
      "nullable": false,
      "comment": "Unique component name."
    },
    {
      "name": "state",
      "type": "text/enum",
      "type_options": {
        "values": ["planned", "in_progress", "completed"]
      },
      "nullable": false,
      "comment": "Current migration progress."
    }
  ],
  "primary_key": ["component"]
}
```

Create the table:

```sh
silo table create --file migration-table.json
```

The first table creation also creates the local database. The rules above require a unique component name and one of the three listed states.

### Record planned work

```sh
printf '%s\n' '{"component":"settings","state":"planned"}' | silo row add migration
```

The command prints the saved row. It remains available after the agent session ends.

### Update progress

```sh
printf '%s\n' '{"state":"in_progress"}' | silo row update migration settings
```

The `settings` row now has the state `in_progress`. A value such as `"started"` would be rejected because it is not one of the allowed states.

### See what remains

```sh
silo sql "SELECT component, state FROM migration WHERE state <> 'completed' ORDER BY component"
```

The result includes `settings` with its updated state. A coordinating agent can read this table before deciding what to do next.

SQL is read-only. Use Silo's row commands to change data so writes are checked against the schema.

This small table records progress; it does not prevent two agents from choosing the same work. For concurrent updates, Silo supports a revision policy that rejects writes based on an outdated row. See [Work with rows](docs/guides/work-with-rows.md#update-without-overwriting-concurrent-work).

See [Design a schema](docs/guides/design-a-schema.md) to add fields and rules for your workflow, or [Getting started](docs/getting-started.md) for a walkthrough that also tests a rejected write.

## Give your agent the instructions

Silo includes guidance that agents can read from the CLI. Add this rule to your global `AGENTS.md`:

> When told to “use Silo” or do something with Silo, run `silo skill` and follow its instructions. Read any referenced task guide or JSON Schema with `silo skill <relative-path>`.

The guidance covers table design, commands, and JSON inputs. Agents can read it from any directory:

```sh
silo skill
silo skill tasks/create-table.md
```

Use `silo --help` to explore commands. Each command also has its own help, such as `silo row update --help`.

## Start with a task template

If you need task tracking, you can import a bundled schema instead of designing one:

```sh
silo schema import tasks
```

This adds the template's tables, agent instructions, and any default queries and reports to the local database. It is separate from the migration example above.

The import copies the template. Later changes to the bundled template do not update your database. Imports must not conflict with existing table names, saved query names, or default report slugs.

## Reuse queries and open reports

**Saved queries** let you name a SQL query and run it as a command. Query parameters become command-line arguments with declared types, so callers can reuse the query without rewriting SQL.

See [Run saved queries](docs/guides/run-saved-queries.md) to define one.

**Reports** turn database results into Markdown you can open in your browser. For a migration, a report could show how many components are complete and which still need work.

Reports refresh when opened or when the page regains focus. If a refresh fails, the viewer keeps the last successful result visible.

Report scripts are trusted JavaScript with access to your machine through Node.js. Only run scripts you trust. The viewer runs locally; it does not provide remote hosting or scheduled refreshes.

See [Publish a refreshable report](docs/guides/publish-a-report.md) to create and open one.

## Share between machines

Local work needs no remote service. To share a database, you need:

- An S3-compatible storage bucket
- Credentials for that storage
- Litestream 0.5.12 or newer

Configure synchronization and publish your local changes. Replace the example bucket and path with your own:

```sh
silo sync init s3://my-bucket/silo/project
silo push
```

On another machine, run the same `silo sync init` command to restore the remote database. After setup:

- Run `silo pull` before work to get shared changes.
- Run `silo push` when local changes are ready to share.

Silo combines changes that do not conflict and stops when they do. It does not silently choose the last writer. Nothing pushes or pulls in the background.

See [Synchronize a database](docs/guides/synchronize.md) for setup and recovery.

## Limits to know

- **Data stays outside Git.** Silo does not provide database branches or a user-facing history of changes.
- **Use Silo commands for writes.** Writing directly to the SQLite file bypasses Silo's validation and synchronization bookkeeping.
- **Keep the active database on local storage.** Do not put it in a network drive or a cloud-synchronized folder.
- **Sharing requires setup.** Synchronization uses your storage service and its storage and transfer costs. It is not a live connection between machines.

See [How Silo works](docs/concepts/how-silo-works.md) for the database, schema, and synchronization model, or browse the [documentation](docs/index.md).
