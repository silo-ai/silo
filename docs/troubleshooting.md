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
