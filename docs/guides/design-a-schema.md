# Design a Schema

> Decide what one row means, then encode its identity, relationships, valid values, and lifecycle rules in a table Silo can enforce.

Start with the domain boundary, not with column names. A useful table answers
these questions before you write its JSON:

| Question                              | Schema location                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- |
| What does one row represent?          | Table `comment`                                                         |
| Which fields identify or relate it?   | `primary_key`, foreign keys, unique constraints, and semantic relations |
| Which values are valid and canonical? | Column `type`, `type_options`, and `nullable`                           |
| What must happen when it changes?     | `checks`, indexes, and policies                                         |

## Model one durable entity

For a repository decision log, one row is one accepted decision. It has a
stable identity, the decision itself, and the time it was recorded. Accepted
decisions are never revised in place, so the schema uses an immutable-row
policy.

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

The request gives Silo four kinds of information: what the entity means, what
its columns store, how it is found, and what its lifecycle permits. The table
show output is the quickest way to confirm the effective semantic types,
constraints, indexes, and policy enforcement.

The resulting table generates ULIDs and creation times through the CLI and
rejects updates and deletes through both CLI checks and SQLite triggers.

## Choose types for the value, not the label

Use a semantic type when its validation and normalization match the domain:

- `text/datetime` represents an instant and stores it in UTC.
- `text/date` represents a calendar date without a time zone.
- `integer/money-minor` or configured `text/decimal` represents exact money;
  do not use `real` when rounding must be exact.
- `text/json` accepts native JSON objects, arrays, strings, finite numbers, and
  booleans.
- `any` is for SQLite scalar values when no narrower contract fits.

Do not use a semantic name as decoration. It changes accepted input and may
add a physical SQLite check. See [Semantic types](../reference/semantic-types.md)
for the complete registry.

## Put invariants in the schema

Comments explain meaning to people and agents. Schema structure enforces it:

| Need                                  | Use                                          |
| ------------------------------------- | -------------------------------------------- |
| Stable identity                       | Primary key or a generated identity policy   |
| Physical referential integrity        | Foreign key                                  |
| Domain relationship meaning           | Semantic relation backed by that foreign key |
| No duplicate combination              | Unique constraint                            |
| Valid range or domain rule            | Semantic type or check                       |
| Fast demonstrated lookup or ordering  | Index                                        |
| Generated values or lifecycle control | Policy                                       |

Prefer a natural key when the domain already has one. Use
`natural_key_upsert` only when repeating the same input should deliberately
update a known set of columns. Use `optimistic_revision` when multiple agents
may update the same row; the update then requires the revision read with the
row.

## Add domain meaning to a foreign key

A foreign key is enough when its physical constraint is the only durable fact
you need. Add a semantic relation when agents or other consumers should know
the relationship's domain name and meaning:

```json
{
  "from": { "table": "posts", "columns": ["author_id"], "name": "author" },
  "to": { "table": "authors", "columns": ["id"] },
  "inverse_name": "posts",
  "comment": "Author responsible for this post.",
  "inverse_comment": "Posts authored by this author."
}
```

Save that object as `post-author-relation.json` and run
`silo relation add --file post-author-relation.json` after both tables exist.
The relation must match exactly one foreign key. Do not declare cardinality or
optionality: Silo derives those from local nullability and uniqueness. See
[Semantic relations](../reference/relations.md) for composite keys,
multiple foreign keys, inverse names, and junction-table guidance.

See [Policies](../reference/policies.md) for compatibility rules and examples.

## Make a supported schema change

The initial `silo table alter` command supports additive columns and indexes.
New columns must be nullable or have a default:

```sh
silo table alter decisions --file alter-decisions.json
```

Changing existing types, keys, checks, generated columns, or policies requires
a separately planned migration outside this command. If synchronization is
configured, schema changes also require a clean pulled base and are published
as full checkpoints rather than merged with row changes.

## Reuse an existing workflow

List installed templates before designing the same workflow again:

```sh
silo template list
silo template show tasks
silo schema import tasks
```

An import adds non-conflicting tables and copies the template's attributed
agent instructions into the local logical schema. It is a one-time copy, not a
subscription: later edits to the installed template do not update a workspace
that already imported it. Run `silo schema show` after import and follow every
attributed instruction block.

See the [Tasks template](../templates/tasks.md) for its tables, authorization
boundary, and lifecycle.
