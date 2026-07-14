# Troubleshooting

> Start from the visible symptom, verify repository and schema state, and make the smallest correction without weakening durable constraints.

## The workspace cannot be resolved

**Symptom:** `silo status` reports `workspace_unresolved`.

Verify that the current directory is inside a Git worktree and that `origin` has a usable URL:

```sh
git rev-parse --show-toplevel
git config --get remote.origin.url
```

Add or correct `origin`, then rerun `silo status`. Silo rejects empty repository paths and unsafe `.` or `..` path segments, including encoded traversal segments.

## The expected database is absent

**Symptom:** `silo status` reports `absent`, or a read command reports `database_absent`.

Compare the reported identity with the repository you expected. A changed or missing `origin` does not migrate the old database; it selects a different path. Use the first intended schema mutation, such as `silo table create` or `silo schema import`, to create a database for the current identity.

To inspect all locally discoverable Silo databases:

```sh
silo database list
```

## A schema request is rejected

**Symptom:** table creation, alteration, or template import exits with a schema error.

Check the error code and path in the Markdown error output, then inspect the exact request contract:

```sh
silo table create --help
silo table alter --help
```

The bundled agent package contains JSON schemas for create, alter, and row-write requests. Common causes include unknown fields, missing column comments, an unsupported semantic type, a policy pointing to the wrong column type, or a foreign key that does not target a declared primary or unique key.

Correct the request instead of weakening the intended invariant. A failed first table creation does not leave a partial database.

## The physical schema does not match

**Symptom:** opening a database reports a physical schema mismatch, or `silo database list` marks an entry as mismatched.

Use the logical schema and diagnostic DDL to identify the boundary:

```sh
silo schema export
silo schema ddl
```

Do not edit `_silo_` metadata or reconstruct the logical schema from DDL. Restore the expected managed tables, indexes, and triggers from a trusted copy or recover the database as a deliberate migration.

## An update has a revision conflict

**Symptom:** `silo row update` rejects `_expected_revision`.

Another writer changed the row after it was read. Retrieve the current row, reconcile its values with the intended change, and retry with the current revision:

```sh
silo row get issues 550e8400-e29b-41d4-a716-446655440000
```

Do not retry blindly and do not remove `optimistic_revision`; the conflict is protecting a concurrent change.

## A SQL mutation is rejected

**Symptom:** `silo sql` cannot execute `INSERT`, `UPDATE`, `DELETE`, or DDL.

This is expected: raw SQL runs through a read-only connection. Use `silo row add`, `row update`, `row delete`, or `row upsert` for data mutations and the `silo table` or `schema import` commands for supported schema mutations.

## A report cannot be saved or refreshed

**Symptom:** `silo report put` or `silo report refresh` rejects the definition, slot, or saved SQL query.

Inspect the current report when one exists, then verify the request against the bundled report schema:

```sh
silo report show execution-brief
silo report put --help
```

Every `{{silo-query:name}}` slot must name a report query, every report query must be used, and names begin with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens. Each query requires exactly one of inline `sql` or a `saved_query` reference. Inline SQL must be one read-only statement that returns columns and does not read `_silo_` metadata. A saved-query reference must exist and its stored named-object or positional-array parameters must satisfy the current semantic contract. Correct the definition or source schema and run `report put` again; a failed replacement leaves the existing report unchanged.

## The report viewer shows a stale result

**Symptom:** the viewer says “Showing last good result” after opening the page or returning focus to it.

The background refresh failed, so Silo kept the prior successful rendering. Run the refresh command to see the structured error in the terminal:

```sh
silo report refresh execution-brief
```

Restore a renamed or removed source table or column, correct invalid inline SQL with `report put`, reconcile a referenced saved query or its fixed parameters, or resolve the reported database constraint. Reload or refocus the page after a CLI refresh succeeds. Do not delete the report merely to clear the stale state; deletion also removes its authored Markdown and query definitions.

## Synchronization cannot start

**Symptom:** `silo sync init`, `silo pull`, or `silo push` reports that Litestream is unavailable or incompatible.

Install Litestream 0.5.12 or newer and make it available on `PATH`, or set `LITESTREAM_PATH` to the executable. Silo validates this capability before changing local or remote state.

If the failure concerns S3, verify that Silo and Litestream receive the same standard AWS credentials, region, and custom endpoint environment. The bucket must allow object reads, writes, and conditional writes for the configured prefix.

## Synchronization reports a conflict

**Symptom:** `silo pull` or `silo push` reports `sync_changeset_conflict`, and status is `conflicted`.

The active local database is unchanged. Record the transaction identifier from the error or status, inspect the originating operation and current row, and decide the reconciled value. To abandon the conflicting local transaction while preserving and replaying the others:

```sh
silo sync discard <transaction-id>
```

Discard is destructive for that transaction. Preserve any values needed before running it, then issue a new reconciled row mutation and push. See [Recover from a row conflict](guides/synchronize.md#recover-from-a-row-conflict).

## A synchronized schema change is rejected

**Symptom:** a schema command requires a clean base, or a schema push fails after remote `HEAD` changed.

Schema changes cannot merge. Push or discard all pending row transactions, pull the current remote, and retry the schema mutation from `clean` status. If a local schema transaction lost a publication race, discard that transaction before adopting the winning schema, then deliberately reapply a compatible change.

Do not delete remote `HEAD`, overwrite a generation, or remove local outbox metadata to force progress. Those actions bypass the protocol's recovery guarantees.
