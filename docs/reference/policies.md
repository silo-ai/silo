# Policies

> Choose a policy from the table's write behavior: generate values, protect concurrent edits, make rows immutable, or allow a deliberate idempotent upsert.

Policies belong to one table and may appear at most once per policy type. They
change how supported mutations are accepted; they are not an authorization
system or a tamper-proof audit trail.

## Choose by the behavior you need

| Need                                           | Policy                |
| ---------------------------------------------- | --------------------- |
| Generate an identity                           | `generated_identity`  |
| Set operational creation or update times       | `timestamps`          |
| Detect a stale read before updating            | `optimistic_revision` |
| Reject every update and delete                 | `immutable_rows`      |
| Reject changes to selected columns             | `immutable_columns`   |
| Allow inserts but never updates or deletes     | `append_only`         |
| Repeat a write through a declared conflict key | `natural_key_upsert`  |

Inspect the effective policy after creating a table:

```sh
silo table show <table>
```

The output distinguishes behavior enforced by the CLI, a SQLite constraint or
trigger, or both. The CLI also owns semantic canonicalization, generated
values, revision checks, and natural-key upsert rules.

## Policy reference

| Policy                | Required fields                                | Purpose                                                    | Enforcement                                            |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| `generated_identity`  | `column`, `strategy`                           | Generates an integer, UUID, or ULID identity.              | CLI; integer strategy also uses SQLite rowid behavior. |
| `timestamps`          | `created_column` and/or `updated_column`       | Sets operational creation and update instants.             | CLI generation; trigger protection for managed values. |
| `optimistic_revision` | `column`; optional `initial`                   | Requires an expected revision and increments it on update. | CLI.                                                   |
| `immutable_rows`      | None                                           | Rejects every update and delete.                           | Trigger and CLI.                                       |
| `immutable_columns`   | Non-empty `columns`                            | Rejects changes to selected columns.                       | Trigger and CLI.                                       |
| `append_only`         | None                                           | Allows inserts but rejects updates and deletes.            | Trigger and CLI.                                       |
| `natural_key_upsert`  | Non-empty `columns`; optional `update_columns` | Enables insert-or-update through a declared key.           | CLI.                                                   |

## Generated identities and timestamps

Match the identity strategy to the column type. UUID requires `text/uuid`, ULID
requires `text/ulid`, and integer requires an `integer` column that is the
table's single primary key.

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

Timestamp columns must use `text/datetime`. Use these fields for operational
creation and update times; preserve a domain event time in its own column.

## Protect concurrent updates

Use optimistic revision when multiple agents may update the same row:

```json
{
  "type": "optimistic_revision",
  "column": "revision",
  "initial": 1
}
```

An update must include `_expected_revision` matching the persisted row. Silo
increments the stored revision after a successful update. The workflow is
read → reconcile → update; see [Work with rows](../guides/work-with-rows.md#update-without-overwriting-concurrent-work).

## Make rows or columns immutable

Use `immutable_rows` when a record can never be changed or deleted. Use
`append_only` when the table is log-like and should accept inserts only. Use
`immutable_columns` when only selected facts must remain fixed while other
columns may change.

An immutable or append-only table may use a created timestamp but not an
updated timestamp. It cannot use update-oriented `optimistic_revision` or
`natural_key_upsert` behavior.

## Enable deliberate upserts

The `columns` sequence must exactly match the table's primary key or one
declared unique constraint. Limit `update_columns` to fields that an idempotent
repeat may deliberately replace:

```json
{
  "type": "natural_key_upsert",
  "columns": ["repository"],
  "update_columns": ["status", "observed_at"]
}
```

With this policy, `silo row upsert repositories` may update only `status` and
`observed_at` when `repository` already exists.

## Compatibility rules

- Do not combine `append_only` with `immutable_rows`; the guarantees are
  redundant.
- Do not combine `append_only` or `immutable_rows` with
  `optimistic_revision` or `natural_key_upsert`; immutable rows cannot use
  update-oriented behavior.
- A table with immutable or append-only rows may use a created timestamp but
  not an updated timestamp.
- Do not include the managed updated-timestamp or revision column in
  `immutable_columns`.
