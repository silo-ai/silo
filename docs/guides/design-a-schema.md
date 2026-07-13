# Design a Schema

> Turn durable repository concepts into tables whose meaning and invariants remain understandable to both agents and SQLite.

## Start from one durable entity

Define what one row represents, when an agent should read or write it, and what the table must not contain. Put that boundary in the table comment. Give each column a comment that explains domain meaning, units, canonical form, and the meaning of `null` when it is not obvious.

For a repository decision log, begin with the access pattern: retrieve a decision by stable ID, list decisions by creation time, and never modify an accepted record. That leads to a table rather than a generic key-value store:

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

Save the request as `decision-table.json`, then create and inspect it:

```sh
silo table create --file decision-table.json
silo table show decisions
```

The resulting table generates ULIDs and creation times through the CLI and rejects updates and deletes through both CLI checks and SQLite triggers.

## Choose semantic types deliberately

Use a semantic type when its validation and normalization match the domain. For example, use `text/datetime` for an instant, `text/date` for a calendar date, and `integer/money-minor` or configured `text/decimal` for exact amounts. Do not use a semantic name only as documentation: it changes accepted values and may add a SQLite check.

Use `text/json` for native JSON objects, arrays, strings, finite numbers, and booleans. Use `any` only for SQLite scalar values. See [Semantic types](../reference/semantic-types.md) for the complete boundary.

## Put invariants in the schema

Comments guide readers and agents; keys, foreign keys, unique constraints, checks, and policies enforce behavior. Prefer a stable natural key when the domain already has one. Add indexes for a demonstrated lookup, join, ordering, or uniqueness requirement.

Use [Policies](../reference/policies.md) for generated identities, timestamps, optimistic concurrency, immutability, and deliberate natural-key upserts.

> [!IMPORTANT]
> `silo table alter` initially supports only additive columns and indexes. New columns must be nullable or have a default. Changing existing types, keys, checks, generated columns, or policies requires a separately planned migration outside this command.

## Reuse a template when the workflow already exists

List installed templates before designing the same workflow again:

```sh
silo template list
silo template show tasks
silo schema import tasks
```

An import adds non-conflicting tables and copies the template's attributed agent instructions into the logical schema. Later changes to the installed template do not change the imported local copy. Run `silo schema show` after import and follow every attributed instruction block.

See the [Tasks template](../templates/tasks.md) for its installed tables, authorization contract, and first proposal.
