# Policies

> Add generated values, concurrency checks, or immutability only when the table's lifecycle requires them, and account for each policy's enforcement boundary.

A policy may appear at most once per table. Some policies generate or validate values in the CLI; others also compile SQLite triggers.

| Policy                | Required fields                                | Purpose                                                     | Enforcement                                            |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `generated_identity`  | `column`, `strategy`                           | Generates an integer, UUID, or ULID identity.               | CLI; integer strategy also uses SQLite rowid behavior. |
| `timestamps`          | `created_column` and/or `updated_column`       | Sets creation and update instants.                          | CLI generation; trigger protection for managed values. |
| `optimistic_revision` | `column`; optional `initial`                   | Requires an expected revision and increments it on update.  | CLI.                                                   |
| `immutable_rows`      | None                                           | Rejects every update and delete.                            | Trigger and CLI.                                       |
| `immutable_columns`   | non-empty `columns`                            | Rejects changes to selected columns.                        | Trigger and CLI.                                       |
| `append_only`         | None                                           | Allows inserts but rejects updates and deletes.             | Trigger and CLI.                                       |
| `natural_key_upsert`  | non-empty `columns`; optional `update_columns` | Enables idempotent insert-or-update through a declared key. | CLI.                                                   |

## Generated values

Match identity strategy to the column type. UUID requires `text/uuid`, ULID requires `text/ulid`, and integer requires an `integer` column that is the table's single primary key.

```json
[
  { "type": "generated_identity", "column": "id", "strategy": "uuid" },
  {
    "type": "timestamps",
    "created_column": "created_at",
    "updated_column": "updated_at"
  }
]
```

Timestamp columns must use `text/datetime`. Use these fields for operational creation and update times; preserve a domain event time in its own column.

## Optimistic revision

Use optimistic revision when multiple agents may update the same row. The revision column must use an integer type.

```json
{
  "type": "optimistic_revision",
  "column": "revision",
  "initial": 1
}
```

An update must include `_expected_revision` matching the persisted row. Silo increments the stored revision after a successful update. See [Work with rows](../guides/work-with-rows.md#update-without-overwriting-concurrent-work) for the read-update-retry flow.

## Natural-key upsert

The `columns` sequence must exactly match the table's primary key or one declared unique constraint. Limit `update_columns` to fields that an idempotent repeat may deliberately replace:

```json
{
  "type": "natural_key_upsert",
  "columns": ["repository"],
  "update_columns": ["status", "observed_at"]
}
```

With this policy, `silo row upsert repositories` may update only `status` and `observed_at` when `repository` already exists.

## Compatibility rules

- Do not combine `append_only` with `immutable_rows`; the guarantees are redundant.
- Do not combine `append_only` or `immutable_rows` with `optimistic_revision` or `natural_key_upsert`; immutable rows cannot use update-oriented behavior.
- A table with immutable or append-only rows may use a created timestamp but not an updated timestamp.
- Do not include the managed updated-timestamp or revision column in `immutable_columns`.

Inspect the effective boundary after creating a table:

```sh
silo table show repositories
```

The policy table reports whether behavior is enforced by a SQLite constraint or trigger, by the CLI, or by both.
