# Design a Schema

> Define what one row means and which rules Silo should enforce.

Use this guide after [Getting started](../getting-started.md) when you need
tables for your own work.

Before writing JSON, answer these questions:

| Question                                       | Where to record the answer                            |
| ---------------------------------------------- | ----------------------------------------------------- |
| What does one row represent?                   | Table `comment`                                       |
| How do you identify a row?                     | `primary_key` and unique constraints                  |
| How does it connect to other rows?             | Foreign keys and semantic relations                   |
| Which values are allowed?                      | Column `type`, `type_options`, `nullable`, and checks |
| Should Silo generate values or restrict edits? | Policies                                              |
| Which lookups need an index?                   | Indexes                                               |

## Define a table

This example creates a new `decisions` table. It uses a decision log to show
how Silo can generate values and prevent later edits. Each row records an
accepted decision; corrections would be new rows rather than changes to old ones.

Save this request as `decision-table.json`:

```json
{
  "name": "decisions",
  "comment": "One accepted repository decision; append after agreement and never revise in place.",
  "columns": [
    {
      "name": "id",
      "type": "text/ulid",
      "nullable": false,
      "comment": "Stable Silo-generated decision identifier."
    },
    {
      "name": "summary",
      "type": "text/markdown",
      "nullable": false,
      "comment": "Accepted decision and the rationale needed to apply it later."
    },
    {
      "name": "created_at",
      "type": "text/datetime",
      "nullable": false,
      "comment": "UTC instant when the decision was recorded."
    }
  ],
  "primary_key": ["id"],
  "indexes": [
    {
      "name": "decisions_created_at",
      "columns": [{ "column": "created_at", "direction": "desc" }],
      "comment": "Lists the newest accepted decisions first."
    }
  ],
  "policies": [
    { "type": "generated_identity", "column": "id", "strategy": "ulid" },
    { "type": "timestamps", "created_column": "created_at" },
    { "type": "immutable_rows" }
  ]
}
```

Create and inspect the table:

```sh
silo table create --file decision-table.json
silo table show decisions
```

Check that `silo table show decisions` lists all three columns, the index,
and the three policies. Together, the policies:

- Generate a ULID for each new row
- Record its creation time
- Reject updates and deletes through CLI checks and SQLite triggers

Add a decision and read it back:

```sh
printf '%s\n' '{"summary":"Keep the active database on local storage."}' | silo row add decisions
silo sql 'SELECT id, summary, created_at FROM decisions ORDER BY created_at DESC'
```

The result should include the summary, a generated ID, and a creation time.
The `decisions_created_at` index supports listing recent decisions.

## Choose types for the value, not the label

A semantic type tells Silo which values to accept and how to store them:

- `text/datetime` represents an instant and stores it in UTC.
- `text/date` represents a calendar date without a time zone.
- `integer/money-minor` or configured `text/decimal` represents exact money;
  do not use `real` when rounding must be exact.
- `text/json` accepts native JSON objects, arrays, strings, finite numbers, and
  booleans.
- `any` is for SQLite scalar values when no narrower contract fits.

Choosing a type changes which inputs are accepted. Some types also add a
SQLite check. See [Semantic types](../reference/semantic-types.md)
for the complete registry.

## Turn rules into checks

Comments explain meaning to people and agents. Schema structure enforces it:

| Need                                      | Use                                          |
| ----------------------------------------- | -------------------------------------------- |
| Stable identity                           | Primary key or a generated identity policy   |
| A referenced row must exist               | Foreign key                                  |
| A name and explanation for a relationship | Semantic relation backed by that foreign key |
| No repeated combination of values         | Unique constraint                            |
| Valid range or domain rule                | Semantic type or check                       |
| A faster lookup or sort                   | Index                                        |
| Generated values or restrictions on edits | Policy                                       |

- Use an existing unique identifier as the primary key when it fits the data.
- Use `natural_key_upsert` when repeated input should update a known set of
  columns on an existing row.
- Use `optimistic_revision` when multiple agents may update the same row. An
  update must include the revision the agent read, so stale writes fail.

See [Policies](../reference/policies.md) for examples and compatibility rules.

## Add domain meaning to a foreign key

A foreign key makes sure a referenced row exists. A semantic relation adds a
name and explanation that agents can read.

For example, a foreign key from `posts.author_id` to `authors.id` could have a
relation named `author` and an inverse name `posts`. This requires both tables
and the foreign key to exist first. The relation adds meaning; it does not
create the foreign key.

Silo derives whether the relationship is optional or one-to-many from the
columns and constraints. See [Semantic relations](../reference/relations.md)
for a complete example.

## Make a supported schema change

`silo table alter` can add columns and indexes. A new column must allow `null`
or have a default so existing rows remain valid.

For example, save this as `alter-decisions.json` to add an optional reference:

```json
{
  "add_columns": [
    {
      "name": "reference",
      "type": "text",
      "nullable": true,
      "comment": "Supporting document or issue for this decision."
    }
  ]
}
```

```sh
silo table alter decisions --file alter-decisions.json
silo table show decisions
```

The table definition should now include `reference`. Existing rows have `null`
in that column. The immutable-row policy still prevents editing those rows;
you can supply a reference when adding a new decision.

This command cannot change existing types, keys, checks, generated columns, or
policies. Those changes need a separately planned migration. If synchronization is
configured, schema changes also require a clean pulled base and are published
as full checkpoints rather than merged with row changes.

## Reuse an existing workflow

List installed templates before designing the same workflow again:

```sh
silo template list
silo template show tasks
silo schema import tasks
```

An import copies:

- Tables that do not conflict with existing tables
- Agent instructions, stored with their source in the logical schema
- Any default saved queries and reports, saved separately from the schema

Import is atomic. Existing table names, query names, or report slugs cause a
conflict rather than overwriting existing records.

Later edits to the installed template do not update your local copy. Run
`silo schema show`, `silo query list`, and `silo report list` after import to inspect what was added.
Read and follow the imported agent instructions.

See the [Tasks template](../templates/tasks.md) for its tables, authorization
boundary, and lifecycle. Use the [Source audit template](../templates/source-audits.md)
for resumable source coverage, findings, and per-run assessments.
