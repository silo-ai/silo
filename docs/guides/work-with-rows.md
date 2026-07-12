# Work with Rows

> Choose the narrowest row command that preserves schema validation, concurrency rules, and an explicit mutation boundary.

Inspect unfamiliar data before writing:

```sh
silo status
silo schema show
silo table show issues
```

Use the exact table and column names in the logical schema. Silo accepts a JSON object for one row or an array for an atomic batch.

## Mutation boundaries

Silo separates SQLite reads from typed row mutations. Use row commands for writes, and use `silo sql` only to inspect, join, filter, or aggregate existing rows.

| Need                | Command           | Boundary                                                                 |
| ------------------- | ----------------- | ------------------------------------------------------------------------ |
| Insert rows         | `silo row add`    | Accepts one row object or an atomic array batch.                         |
| Update one row      | `silo row update` | Requires a primary-key or generated-identity key; no predicate updates.  |
| Delete one row      | `silo row delete` | Requires a primary-key or generated-identity key; no predicate deletes.  |
| Repeat a safe write | `silo row upsert` | Requires a `natural_key_upsert` policy and updates only allowed columns. |
| Query rows          | `silo sql`        | Runs through a read-only SQLite connection.                              |

If a change affects many existing rows, read the affected keys first, then apply deliberate row updates. Silo does not expose raw SQL mutation as a shortcut around schema validation, generated values, revision checks, or synchronization bookkeeping.

## Insert rows

Insert one row from standard input:

```sh
printf '%s\n' '{"title":"Document release process"}' | silo row add issues
```

For a batch, pass an array through a file:

```json
[{ "title": "Document release process" }, { "title": "Verify rollback procedure" }]
```

```sh
silo row add issues --file issues.json
```

The batch succeeds atomically. Output includes the complete persisted rows with generated identities, defaults, timestamps, and revisions.

## Read rows

Retrieve a row with a single-column primary key:

```sh
silo row get issues 550e8400-e29b-41d4-a716-446655440000
```

For a composite key, pass the key as a JSON array in primary-key order:

```sh
silo row get task_tags '["550e8400-e29b-41d4-a716-446655440000","documentation"]'
```

List rows deterministically by primary key, or by rowid when no primary key exists:

```sh
silo row list issues --limit 20 --offset 0
```

## Update without overwriting concurrent work

Tables with an `optimistic_revision` policy require `_expected_revision` in the update request. Read the row, retain its current revision, and update only after reconciling any changes:

```sh
printf '%s\n' '{"title":"Document release and rollback","_expected_revision":3}' \
  | silo row update issues 550e8400-e29b-41d4-a716-446655440000
```

If another writer changed the row, the update fails. Read it again, reconcile the intended change, and retry with the new revision. Do not remove the policy to bypass a conflict.

## Upsert only through a declared natural key

`silo row upsert` works only when the table declares `natural_key_upsert`. The policy identifies a primary key or unique constraint and limits which columns an existing row may update.

```sh
printf '%s\n' '{"repository":"silo-ai/silo","status":"active"}' \
  | silo row upsert repositories
```

The command inserts a missing natural key or updates the policy's allowed columns for an existing key. Use add or an explicit read/update flow when the schema does not declare this idempotent behavior.

## Query through read-only SQL

Use row commands for key-based operations. Use `silo sql` for joins, aggregates, CTEs, window functions, and JSON reads:

```sh
silo sql 'SELECT state, count(*) AS count FROM tasks GROUP BY state ORDER BY state'
```

The connection is read-only. Add `ORDER BY` whenever order matters, and treat Markdown output as presentation; the exit status determines success or failure.

> [!WARNING]
> `silo row delete` permanently deletes the selected row. Verify its key and the table's foreign-key delete behavior with `silo table show` before running it.
