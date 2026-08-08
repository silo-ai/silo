# Work with Rows

> Inspect the schema, choose an explicit row operation, and keep SQL on the read-only side of the boundary.

Silo separates reads from writes so schema validation, generated values,
concurrency rules, and synchronization bookkeeping cannot be bypassed by an
ad hoc SQL mutation.

## Start with the schema

Inspect unfamiliar data before writing:

```sh
silo status
silo schema show
silo table show issues
```

Use the exact table and column names returned by the logical schema. Silo
accepts one JSON object or an array of objects for an atomic row insertion.

## Choose the operation

| Intent                     | Command           | Requirement or boundary                                             |
| -------------------------- | ----------------- | ------------------------------------------------------------------- |
| Insert rows                | `silo row add`    | One object or an atomic array batch.                                |
| Read by key                | `silo row get`    | Primary-key values in schema order.                                 |
| List rows                  | `silo row list`   | Deterministic ordering and pagination.                              |
| Update one row             | `silo row update` | A primary key; revisioned tables also require `_expected_revision`. |
| Delete one row             | `silo row delete` | A primary key; deletion is permanent.                               |
| Repeat an idempotent write | `silo row upsert` | A declared `natural_key_upsert` policy.                             |
| Join, filter, or aggregate | `silo sql`        | Read-only SQLite connection.                                        |

If a change affects many existing rows, query the affected keys first, then
apply deliberate row updates. Silo does not provide predicate updates or raw
SQL mutations.

## Insert rows

Insert one issue from standard input:

```sh
printf '%s\n' '{"title":"Document release process"}' | silo row add issues
```

For a batch, put an array in `issues.json`:

```json
[{ "title": "Document release process" }, { "title": "Verify rollback procedure" }]
```

```sh
silo row add issues --file issues.json
```

The batch succeeds or fails as one transaction. Successful output contains the
complete persisted rows, including generated identities, defaults, timestamps,
and revisions.

## Read rows

Retrieve a row with a single-column primary key. Replace the placeholder with
the key returned by the insert command:

```sh
silo row get issues <issue-id>
```

For a composite key, pass a JSON array in primary-key order:

```sh
silo row get task_tags '["<task-id>","documentation"]'
```

List rows when you do not know the key:

```sh
silo row list issues --limit 20 --offset 0
```

## Update without overwriting concurrent work

Tables with an `optimistic_revision` policy require `_expected_revision` in the
update request. Read the row, retain its current revision, and update only
after reconciling any changes:

```sh
printf '%s\n' '{"title":"Document release and rollback","_expected_revision":3}' \
  | silo row update issues <issue-id>
```

If another writer changed the row, the update fails. Read it again, reconcile
the intended change, and retry with the new revision. Do not remove the policy
to bypass the conflict.

## Upsert through a declared natural key

`silo row upsert` works only when the table declares `natural_key_upsert`. The
policy identifies a primary key or unique constraint and limits which columns
an existing row may replace:

```sh
printf '%s\n' '{"repository":"silo-ai/silo","status":"active"}' \
  | silo row upsert repositories
```

The command inserts a missing natural key or updates the policy's allowed
columns for an existing key. Use `row add` or an explicit read/update flow when
the schema does not declare idempotent behavior.

## Delete deliberately

Deletion is explicit and permanent for the selected row:

```sh
silo row delete issues <issue-id>
```

Verify the key and the table's foreign-key delete behavior with
`silo table show` before running the command.

## Query through read-only SQL

Use row commands for key-based operations. Use `silo sql` for joins, aggregates,
CTEs, window functions, and JSON reads:

```sh
silo sql 'SELECT state, count(*) AS count FROM tasks GROUP BY state ORDER BY state'
```

The connection is read-only. Add `ORDER BY` whenever order matters, and treat
the Markdown output as presentation; the exit status determines success or
failure.

After any successful mutation, the local database contains the new state. If
synchronization is configured, the mutation remains local until an explicit
`silo push` publishes it.
