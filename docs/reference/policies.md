# Policies

> Choose rules for generated values, concurrent edits, and which changes a table allows.

Policies go in a table definition's `policies` array. Each policy type can
appear at most once per table. They control writes; they do not authenticate
agents or record a tamper-proof history.

## Choose by the behavior you need

| Need                                       | Policy                |
| ------------------------------------------ | --------------------- |
| Generate an identity                       | `generated_identity`  |
| Set creation or update times               | `timestamps`          |
| Detect a stale read before updating        | `optimistic_revision` |
| Reject every update and delete             | `immutable_rows`      |
| Reject changes to selected columns         | `immutable_columns`   |
| Allow inserts but never updates or deletes | `append_only`         |
| Insert or update by a known unique key     | `natural_key_upsert`  |

After creating a table, inspect its policies with `silo table show` followed
by its name. For the getting-started table:

```sh
silo table show issues
```

The output shows which rules the CLI enforces and which SQLite also enforces.
Direct SQLite writes bypass CLI-only behavior, including generated values and
revision checks.

## Policy reference

| Policy                | Fields                                         |
| --------------------- | ---------------------------------------------- |
| `generated_identity`  | `column`, `strategy`                           |
| `timestamps`          | `created_column` and/or `updated_column`       |
| `optimistic_revision` | `column`; optional `initial`                   |
| `immutable_rows`      | None                                           |
| `immutable_columns`   | Non-empty `columns`                            |
| `append_only`         | None                                           |
| `natural_key_upsert`  | Non-empty `columns`; optional `update_columns` |

Silo's CLI enforces all these policies. SQLite also enforces immutable rows,
immutable columns, and append-only rules through triggers. Timestamp policies
use CLI generation with trigger protection for managed values. Integer
identity generation also uses SQLite rowid behavior.

## Generated identities and timestamps

Match the strategy to the identity column:

- `uuid` requires `text/uuid`.
- `ulid` requires `text/ulid`.
- `integer` requires an `integer` column that is the table's single primary key.

For a table with an `id` UUID column and `created_at` and `updated_at` datetime
columns, use this `policies` array:

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

Timestamp columns must use `text/datetime`. On insertion, Silo generates the
ID and both timestamps. On update, it advances `updated_at`.

Keep the time of a real-world event in a separate column. A finding's discovery
time may differ from the time an agent saves it in Silo.

## Protect concurrent updates

Use `optimistic_revision` when multiple agents may update the same row. An
update must include the revision that the agent read; Silo rejects it if the
row has changed since then.

For a complete example, use a workspace without an `issues` table. Save this
as `revisioned-issues.json`:

```json
{
  "name": "issues",
  "comment": "Issues edited by several agents.",
  "columns": [
    { "name": "id", "type": "text", "nullable": false, "comment": "Unique issue key." },
    { "name": "title", "type": "text", "nullable": false, "comment": "Work to do." },
    {
      "name": "revision",
      "type": "integer/positive",
      "nullable": false,
      "comment": "Silo-managed edit revision."
    }
  ],
  "primary_key": ["id"],
  "policies": [{ "type": "optimistic_revision", "column": "revision", "initial": 1 }]
}
```

Create the table and a row:

```sh
silo table create --file revisioned-issues.json
printf '%s\n' '{"id":"release-docs","title":"Document the release process"}' | silo row add issues
silo row get issues release-docs
```

The row has `revision: 1`. Update using that revision:

```sh
printf '%s\n' '{"title":"Document release and rollback","_expected_revision":1}' \
  | silo row update issues release-docs
silo row get issues release-docs
```

The title changes and the revision becomes `2`. Repeating that update with
`_expected_revision: 1` fails. Read the current row and reconcile your change
before retrying. See [Work with rows](../guides/work-with-rows.md#update-without-overwriting-concurrent-work).

## Make rows or columns immutable

- `immutable_rows` prevents all updates and deletes.
- `append_only` has the same write restrictions, named for tables that only
  accept new records.
- `immutable_columns` prevents changes to selected columns while allowing
  others to change.

For a runnable immutable table, see the decision log in
[Design a schema](../guides/design-a-schema.md#define-a-table).

An immutable or append-only table may use a created timestamp but not an
updated timestamp. It cannot use update-oriented `optimistic_revision` or
`natural_key_upsert` behavior.

## Enable deliberate upserts

An upsert inserts a missing row or updates an existing one. The policy's
`columns` must exactly match the primary key or a declared unique constraint,
including column order.

For example, a `repositories` table might use `repository` as its primary key
and have `status` and `observed_at` columns. This policy allows a repeated
observation to replace only those two values:

```json
{
  "type": "natural_key_upsert",
  "columns": ["repository"],
  "update_columns": ["status", "observed_at"]
}
```

Put this object in that table's `policies` array before creating it. With the
policy, `silo row upsert repositories` inserts an unknown repository or updates
only `status` and `observed_at` for an existing one. It does not enable upserts
on other tables.

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
