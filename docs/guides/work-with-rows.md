# Work with Rows

> Add, read, update, and delete rows through Silo's CLI.

Use row commands to change data. They check values against the schema and
record the changes needed for synchronization. Use read-only SQL when you
need to filter or combine data.

The basic examples below use the `issues` table from
[Getting started](../getting-started.md). It has a generated `id` and a text
`title`. The sections on revision checks and upserts explain the additional
policies those operations require.

## Start with the schema

Before changing unfamiliar data, check the selected database and table:

```sh
silo status
silo table show issues
```

Confirm the database path, column names, and policies. Do not assume that two
repositories have the same `issues` table.

## Choose the operation

| Intent                          | Command           | What to know                                                       |
| ------------------------------- | ----------------- | ------------------------------------------------------------------ |
| Insert rows                     | `silo row add`    | Accepts one object or an array; the whole batch succeeds or fails. |
| Read by key                     | `silo row get`    | Requires the primary-key value.                                    |
| List rows                       | `silo row list`   | Supports a limit and offset.                                       |
| Update one row                  | `silo row update` | Requires a key and, on revisioned tables, `_expected_revision`.    |
| Delete one row                  | `silo row delete` | Requires a key; deletion is permanent.                             |
| Insert or update by a known key | `silo row upsert` | Requires a `natural_key_upsert` policy.                            |
| Filter, join, or count rows     | `silo sql`        | Read-only.                                                         |

For a composite primary key, pass the values as a JSON array in the key's
declared column order.

## Insert rows

```sh
printf '%s\n' '{"title":"Document the release process"}' | silo row add issues
```

The output shows the saved row, including its generated ID.

For a batch, save this array as `issues.json`:

```json
[{ "title": "Verify the rollback procedure" }, { "title": "Check the release checklist" }]
```

```sh
silo row add issues --file issues.json
```

Both rows are saved together. If either row is invalid, neither is added.

## Read rows

List rows when you do not know their IDs:

```sh
silo row list issues --limit 20 --offset 0
```

To look up one row, copy an ID from the output when prompted:

```sh
printf 'Paste an issue id: '
read -r ISSUE_ID
silo row get issues "$ISSUE_ID"
```

The result should contain the same ID and title. Keep `ISSUE_ID` set for the
update and delete examples below.

## Update a row

Change the title of that issue:

```sh
printf '%s\n' '{"title":"Document the release and rollback process"}' \
  | silo row update issues "$ISSUE_ID"
silo row get issues "$ISSUE_ID"
```

The lookup should show the new title. Fields you omit stay unchanged.

There is no SQL-style update of all matching rows. To change several rows,
query their keys first, then update each deliberately.

## Update without overwriting concurrent work

A table with an `optimistic_revision` policy rejects updates based on an old
revision. The getting-started table does not have this policy; see
[Policies](../reference/policies.md#protect-concurrent-updates) to define a table
that does.

For a revisioned table:

1. Read the row and keep its revision.
2. Include that value as `_expected_revision` in the update JSON.
3. If the revision check fails, read the row again and reconcile your change
   with the new data before retrying.

For example, if the stored revision is `3`, the update input might be:

```json
{
  "title": "Document the release and rollback process",
  "_expected_revision": 3
}
```

A successful update increments the stored revision. If another agent already
changed the row, the stale update fails without overwriting its work. Do not
remove the policy to bypass a failed check.

## Upsert through a declared natural key

An upsert inserts a missing row or updates an existing row with the same key.
It requires a `natural_key_upsert` policy that declares:

- Which primary key or unique constraint identifies the row
- Which columns a repeated write may replace

Use this for repeated observations that should update the same record. Use
`row add` when a duplicate should fail, or `row update` when the row must
already exist. See [Policies](../reference/policies.md#enable-deliberate-upserts)
for an example.

## Delete deliberately

Deletion is permanent. Before deleting, read the row and inspect the table's
foreign keys to check whether other rows will be deleted or changed too.

To delete the issue selected above:

```sh
silo row get issues "$ISSUE_ID"
silo row delete issues "$ISSUE_ID"
silo row get issues "$ISSUE_ID"
```

The final lookup should fail because the row no longer exists.

## Query through read-only SQL

For example, count the remaining issues:

```sh
silo sql 'SELECT count(*) AS issue_count FROM issues'
```

The result contains one row with `issue_count`. SQL also supports joins and
filtered reads. Add `ORDER BY` when row order matters.

Commands return Markdown for reading. In scripts, use the exit status to
determine success or failure.

Successful writes are saved locally. If synchronization is configured, they
remain local until `silo push` publishes them.
