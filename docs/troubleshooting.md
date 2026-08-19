# Troubleshooting

> Start from the visible symptom, confirm which local database and schema are active, and make the smallest correction that preserves the contract.

## Start with the right state

When the cause is unclear, run the checks that match the state you can observe:

```sh
silo status
# If status reports a recognized database:
silo schema show
# If synchronization is configured:
silo sync status
```

`schema show` requires a recognized database. `sync status` is useful only
when synchronization has been configured. Do not edit `_silo_` metadata to
make a status look clean; those tables are part of Silo's protocol.

## The workspace cannot be resolved

**Symptom:** `silo status` reports `workspace_unresolved`.

Verify that the current directory is inside a Git worktree:

```sh
git rev-parse --show-toplevel
```

An `origin` is not required. If one is configured, verify its URL with
`git config --get remote.origin.url`, then correct it and rerun `silo status`.
Silo rejects empty repository paths and unsafe `.` or `..` path segments,
including encoded traversal segments.

If the error is `invalid_local_state`, inspect `.git/silo.json` for accidental
edits or an unsupported version. Do not delete it casually: its detached UUID
is the only stable link to the repository-local database identity.

## The expected database is absent

**Symptom:** `silo status` reports `absent`, or a read command reports
`database_absent`.

Compare the reported selection and identity with the repository you expected.
Use `silo switch origin` to select `origin`, another remote name in its place,
or `silo switch --detach` for the repository-local identity.

Create the database with the first intended schema mutation:

```sh
silo table create --file table.json
# or
silo schema import tasks
```

To inspect all locally discoverable Silo databases:

```sh
silo database list
```

If `workspace_identity_conflict` reports both detached and origin databases,
inspect `silo database list`, then select the intended database without moving
either one. `silo switch origin` selects the origin database;
`silo switch --detach` selects the detached database.

If an explicit move reports `synchronized_database_move_unsupported`, keep the
current identity. Moving would make its configured remote checkpoint disagree
with the database's workspace identity.

## A schema request is rejected

**Symptom:** table creation, alteration, or template import exits with a schema
error.

Inspect the command contract and the error path:

```sh
silo table create --help
silo table alter --help
silo schema show
```

Common causes include unknown fields, missing column comments, an unsupported
semantic type, a policy pointing to the wrong column type, or a foreign key
that does not target a declared primary or unique key. Correct the request
instead of weakening the intended invariant. A failed first table creation
does not leave a partial database.

## The physical schema does not match

**Symptom:** opening a database reports a physical schema mismatch, or
`silo database list` marks an entry as mismatched.

Use logical metadata to understand the intended contract and generated DDL to
diagnose the physical boundary:

```sh
silo schema export
silo schema ddl
```

Do not edit `_silo_` metadata or reconstruct the logical schema from DDL.
Restore the expected managed tables, indexes, and triggers from a trusted copy,
or recover the database as a deliberate migration.

## An update has a revision conflict

**Symptom:** `silo row update` rejects `_expected_revision`.

Another writer changed the row after it was read. Retrieve the current row,
reconcile its values with the intended change, and retry with the current
revision:

```sh
silo row get issues <issue-id>
```

Do not retry blindly or remove `optimistic_revision`; the conflict is protecting
a concurrent change.

## A SQL mutation is rejected

**Symptom:** `silo sql` cannot execute `INSERT`, `UPDATE`, `DELETE`, or DDL.

This is expected. Raw SQL runs through a read-only connection. Use
`silo row add`, `row update`, `row delete`, or `row upsert` for data mutations,
and use `silo table` or `schema import` for supported schema mutations.

## A report cannot be saved or refreshed

**Symptom:** `silo report put` or `silo report refresh` rejects the definition or
reports a script error.

Inspect the current report when one exists, then check the request contract:

```sh
silo report show <slug>
silo report put --help
```

Verify each of these boundaries:

- The definition contains `script`, not both `script` and the deprecated
  `markdown` and `queries` fields.
- The script returns a Markdown string rather than a promise or another value.
- Every `silo.sql` call contains one read-only statement that returns columns
  and does not read `_silo_` metadata.
- Every `silo.query` call names an existing saved query and supplies parameters
  that satisfy its current semantic contract.
- Files loaded through `require` exist relative to the Git workspace and their
  dependencies are installed.

Correct the script, dependency, or source schema and run `report put` again. A
failed replacement leaves the existing report unchanged.

## The report viewer shows a stale result

**Symptom:** the viewer says "Showing last good result" after opening the page
or returning focus to it.

The background refresh failed, so Silo kept the prior successful rendering. Run
the refresh command to see the structured error in the terminal:

```sh
silo report refresh <slug>
```

Restore a renamed or removed source table or column, correct the stored script
with `report put`, restore a required file or package, or reconcile a saved
query call with its current parameters. Reload or refocus the page after a CLI
refresh succeeds. Do not delete the report merely to clear stale state;
deletion also removes its authored script.

## Synchronization cannot start

**Symptom:** `silo sync init`, `silo pull`, or `silo push` reports that
Litestream is unavailable or incompatible.

Install Litestream 0.5.12 or newer and make it available on `PATH`, or set
`LITESTREAM_PATH` to the executable. Silo validates this capability before
changing local or remote state.

If the failure concerns S3, verify that Silo and Litestream receive the same
standard AWS credentials, region, and custom endpoint environment. The bucket
must allow object reads, writes, and conditional writes for the configured
prefix.

## Synchronization reports a conflict

**Symptom:** `silo pull` or `silo push` reports `sync_changeset_conflict`, and
status is `conflicted`.

The active local database is unchanged. Record the transaction identifier from
the error or status, inspect the originating operation and current row, and
decide the reconciled value:

```sh
silo sync status
silo row get issues <issue-id>
```

To abandon only the identified local transaction while preserving and replaying
the others:

```sh
silo sync discard <transaction-id>
```

Discard is destructive for that transaction. Preserve any values needed before
running it, then issue a new reconciled row, query, or report mutation and push.
See [Recover from a conflict](guides/synchronize.md#recover-from-a-conflict).

## A synchronized schema change is rejected

**Symptom:** a schema command requires a clean base, or a schema push fails
after remote `HEAD` changed.

Schema changes cannot merge with pending synchronization work. Push or discard
all pending transactions, pull the current remote, and retry the schema
mutation from `clean` status:

```sh
silo pull
silo sync status
silo table alter issues --file alter-issues.json
silo push
```

If a local schema transaction lost a publication race, discard that transaction
before adopting the winning schema, then deliberately reapply a compatible
change. Do not delete remote `HEAD`, overwrite a generation, or remove local
outbox metadata to force progress; those actions bypass the recovery protocol.
