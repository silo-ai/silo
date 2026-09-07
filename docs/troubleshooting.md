# Troubleshooting

> Find the symptom, check the cause, and fix it without losing work.

## Start with the right state

First check which database the repository selects:

```sh
silo status
```

If it reports a recognized database, inspect the schema:

```sh
silo schema show
```

If synchronization is configured, also run `silo sync status`.

Do not edit `_silo_` metadata to make a status look clean. Silo uses those
tables to validate data and recover from interrupted operations.

## The workspace cannot be resolved

**Symptom:** `silo status` reports `workspace_unresolved`.

Check that the current directory is inside a Git worktree:

```sh
git rev-parse --show-toplevel
```

If this fails, change to the intended repository and rerun `silo status`.
An `origin` remote is not required.

If the error concerns a configured remote URL, inspect it with
`git remote -v`. Silo rejects empty repository paths and unsafe `.` or `..`
path segments, including encoded forms. Correct the selected remote URL and
rerun `silo status`.

If the error is `invalid_local_state`, inspect `silo.json` in the common Git
directory, usually `.git/silo.json`. Accidental edits or an unsupported version
can make it unreadable. Preserve the file before recovery: its detached UUID
links the repository to its local database. Do not delete it to force a new
identity. See [Workspace and schema model](concepts/workspace-and-schema.md).

## The expected database is absent

**Symptom:** `silo status` reports `absent`, or a read reports `database_absent`.

If you expected existing data, check the selection before creating anything:

```sh
silo status
silo database list
```

Compare the reported identity and database path with the database you need:

- `silo switch origin` selects the identity for `origin`.
- `silo switch --detach` selects the repository's local identity.
- `silo switch` followed by another remote name selects that remote's identity.

Run `silo status` again to verify the selection.

For a new database, follow [Getting started](getting-started.md) to create the
first table. If you intended to restore shared data, follow
[Synchronize a database](guides/synchronize.md) instead.

If `workspace_identity_conflict` reports both detached and origin databases,
inspect `silo database list` and select one without moving either.

If a move reports `synchronized_database_move_unsupported`, keep the existing
identity. Its remote checkpoint records that identity, so the database cannot
move through `silo switch --move`.

## A schema request is rejected

**Symptom:** creating or altering a table, or importing a template, fails with
a schema error.

Read the error's field path, then inspect the relevant command's help:

```sh
silo table create --help
silo table alter --help
```

When a recognized database exists, `silo schema show` lets you compare the
request with its current definition. Common causes:

- An unknown field or missing column comment
- An unsupported semantic type
- A policy using the wrong column type
- A foreign key that does not reference a primary or unique key
- A table or report name that already exists during template import

Correct the request and retry. Preserve the rule you intended to enforce;
do not weaken it merely to make the command succeed. A failed first table
creation does not leave a partial database.

## The physical schema does not match

**Symptom:** opening a database reports `physical_schema_mismatch`, or
`silo database list` marks it as mismatched.

Silo checks generated SQLite objects when it opens a database. A managed table,
index, or trigger differs from the stored logical schema.

Use `silo database list` to identify the affected file. Normal commands such
as `silo schema export` and `silo schema ddl` also require a successful open,
so they cannot diagnose this mismatched copy directly.

Preserve the affected database before recovery. Compare it with a trusted
backup or checkpoint and plan a restore or migration that preserves needed
rows. On a healthy copy, `silo schema export` shows the logical schema and
`silo schema ddl` shows the generated definitions.

Do not edit `_silo_` metadata to bless an unexpected change, or reconstruct the
logical schema from DDL. See [Workspace and schema model](concepts/workspace-and-schema.md#the-schema-has-two-layers).

## An update has a revision conflict

**Symptom:** `silo row update` rejects `_expected_revision`.

The expected revision does not match the stored row. Another writer may have
changed it, or the request may contain the wrong revision. For an issue table,
read the affected row:

```sh
printf 'Issue id: '
read -r ISSUE_ID
silo row get issues "$ISSUE_ID"
```

Compare its current values with your intended change. If the change still
makes sense, retry with the revision you just read. Verify the result with
another lookup. Do not retry blindly or remove the revision policy.

## A SQL mutation is rejected

**Symptom:** `silo sql` rejects `INSERT`, `UPDATE`, `DELETE`, or a schema change.

SQL is read-only. Use:

- `silo row add` to insert data
- `silo row update` to change an existing row
- `silo row delete` to delete a row
- `silo row upsert` when the table declares an upsert policy
- `silo table` commands or `silo schema import` for supported schema changes

See [Work with rows](guides/work-with-rows.md) for examples.

## A report cannot be saved or refreshed

**Symptom:** `silo report put` or `silo report refresh` rejects a definition or
reports a script error.

If a saved report exists, inspect it without running its script:

```sh
printf 'Report slug: '
read -r REPORT_SLUG
silo report show "$REPORT_SLUG" --definition
```

Check the reported error against these requirements:

- The definition uses `script`, without the deprecated `markdown` and `queries`
  fields alongside it.
- The script returns a Markdown string synchronously, not a promise.
- SQL calls use one read-only statement that returns columns and does not read
  Silo's internal tables.
- Saved-query calls name existing queries and supply valid parameters.
- Required files exist relative to the Git workspace root, and dependencies
  are installed.

Fix the cause, then use `report put --file` with your corrected definition.
If only the data or dependencies needed fixing, rerun `report refresh` instead.
Both commands execute trusted code with access to your machine. A failed
replacement leaves the existing report unchanged.

See [Publish a refreshable report](guides/publish-a-report.md) for the complete
input format and commands.

## The report viewer shows a stale result

**Symptom:** the viewer says "Showing last good result" after opening the page
or returning focus to it.

Refresh failed, so Silo kept the last successful result. For a report whose
script you trust, rerun refresh to see the error:

```sh
printf 'Report slug: '
read -r REPORT_SLUG
silo report refresh "$REPORT_SLUG"
```

Fix the cause indicated by the error:

- Update the script if a source table or column changed.
- Restore a required file or package.
- Update a saved-query call if its parameters changed.

Refresh again and verify that it succeeds. Then reload or refocus the viewer.
Do not delete the report to clear the error; deletion removes its script too.

## Synchronization cannot start

**Symptom:** initialization, pull, or push reports an unavailable or incompatible
Litestream binary.

Install Litestream 0.5.12 or newer on `PATH`, or set `LITESTREAM_PATH` to its
executable. Silo checks compatibility before changing local or remote state.
Retry the command after correcting the installation.

For an S3 error, check that Silo and Litestream use the same:

- AWS credentials
- Region
- Custom endpoint, if any

The bucket must allow object reads, writes, and conditional writes under the
configured prefix. See [Synchronize a database](guides/synchronize.md#prepare-the-environment).

## Synchronization reports a conflict

**Symptom:** pull or push reports `sync_changeset_conflict`, and status is
`conflicted`.

The active local database is unchanged. Run `silo sync status` and record the
conflicting transaction ID. Inspect the operation and affected rows, query, or
report before deciding what to keep.

Discarding a transaction permanently removes its effects from the rebuilt
local database. It can affect several rows or tables. Save any values you need
before following [Recover from a conflict](guides/synchronize.md#recover-from-a-conflict).
That workflow rebuilds from the remote and reapplies the other pending work.

After recovery, write any reconciled values with normal Silo commands. Verify
them, then push.

## A synchronized schema change is rejected

**Symptom:** a schema command requires a clean base, or a schema push fails
after remote `HEAD` changes.

Schema changes cannot be combined with pending synchronization transactions.
Inspect `silo sync status` and resolve pending work first. Publish work you need
to keep; discard only transactions whose effects you intend to remove.

Then pull and verify `clean` status before retrying the schema change. Follow
[Serialize schema changes](guides/synchronize.md#serialize-schema-changes) for
a complete example.

If another schema publication won, discard the losing local schema transaction
and adopt the winning schema before reapplying a compatible change. Do not
rewrite remote `HEAD`, overwrite a generation, or remove outbox metadata to
force progress.
