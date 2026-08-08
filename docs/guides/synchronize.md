# Synchronize a Database

> Share a repository's local Silo state through explicit pull and push operations, then recover safely when concurrent changes cannot be combined.

Synchronization keeps the active SQLite database on each machine. It does not
turn Silo into a live shared database or run in the background.

## Use the shared-work loop

Pull before starting shared work and push after reviewing the local changes:

```sh
silo pull
# Read and mutate through ordinary Silo commands.
silo sync status
silo push
```

The loop is safe to repeat. `pull` starts from the remote's current checkpoint
and reapplies compatible local pending work. `push` creates and verifies a new
checkpoint before publishing it. If the same data changed incompatibly on two
machines, Silo stops instead of choosing a last writer.

## Prepare the environment

Synchronization requires:

- Litestream 0.5.12 or newer on `PATH`, or selected with `LITESTREAM_PATH`.
- An S3-compatible bucket that supports conditional object writes.
- Credentials available to both Silo and Litestream through the standard AWS
  environment or credential chain.
- A stable, non-null primary key on every synchronized table.

For AWS, the usual environment includes `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`; temporary credentials may also need
`AWS_SESSION_TOKEN`. Set `AWS_ENDPOINT_URL_S3` for a custom S3-compatible
endpoint. The active SQLite file must remain on local storage.

Silo does not store credentials in the database. The bucket must allow object
reads, writes, and conditional writes for the configured prefix.

## Initialize one authority

Connect an existing local database to an empty remote:

```sh
silo sync init s3://my-bucket/silo/project
silo sync status
silo push
```

The initial status is `ahead`; the first push creates the remote checkpoint.

On another machine with the same repository identity, run the same `sync init`
command. If the local database is absent and the remote exists, Silo restores
the remote automatically.

The starting state must have exactly one authority:

| Local database | Remote checkpoint | What to do                                                      |
| -------------- | ----------------- | --------------------------------------------------------------- |
| Exists         | Empty             | Run `sync init`, inspect `ahead`, then `push`.                  |
| Absent         | Exists            | Run `sync init` to restore it.                                  |
| Exists         | Exists            | Initialization stops; choose an authority explicitly.           |
| Absent         | Empty             | Create a schema first, then initialize from the local database. |

When both sides exist, Silo refuses to compare application rows or guess a
winner. Record the remote generation from the error, inspect the local state,
and confirm that exact generation in one of these workflows:

Preserve the local database as a recovery snapshot and install the remote:

```sh
silo sync adopt-remote s3://my-bucket/silo/project \
  --confirm <remote-generation>
```

Preserve the old remote generation and publish the local database instead:

```sh
silo sync replace-remote s3://my-bucket/silo/project \
  --confirm <remote-generation>
```

Both commands report the losing copy's location. If the confirmation no longer
matches, inspect the new remote generation and make the decision again; do not
retry blindly.

## Read synchronization status

Check state before and after shared work:

```sh
silo sync status
```

| State          | Meaning                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| `unconfigured` | This local database has no synchronization remote.                         |
| `clean`        | No local work is pending and the local base matches remote `HEAD`.         |
| `ahead`        | Local synchronization transactions are pending on the current remote base. |
| `behind`       | Remote `HEAD` advanced and there is no pending local work.                 |
| `diverged`     | Remote `HEAD` advanced while local work is pending.                        |
| `conflicted`   | A pending local transaction could not be applied to the remote base.       |

Status also reports the local base generation, current remote generation,
pending count, and conflict transaction ID when one exists.

## Recover from a conflict

When `pull` or `push` reports `sync_changeset_conflict`, the active local
database remains unchanged. Inspect the status and the operation named by the
error before deciding what the reconciled value should be:

```sh
silo sync status
silo row get issues <issue-id>
```

To abandon only the identified local transaction, rebuild from the current
remote and replay every other pending transaction:

```sh
silo sync discard <transaction-id>
```

Discard permanently removes the selected transaction's effects from the
rebuilt local database. Preserve any values needed for a reconciled write
before running it. Then issue the ordinary row, query, or report mutation and
push again.

> [!WARNING]
> Never delete `_silo_outbox` rows or edit synchronization metadata directly. Those objects are part of the recovery protocol.

## Serialize schema changes

Schema changes require a fully pulled base with no pending synchronization
transactions. Pull, verify `clean`, make one schema change, and push it before
continuing:

```sh
silo pull
silo sync status
silo table alter issues --file alter-issues.json
silo push
```

Schema changes are full checkpoints, not mergeable row changesets. If another
schema publication wins, discard the losing schema transaction, pull the
winning schema, and deliberately reapply a compatible change. Silo does not
apply older-schema row changesets to a newer schema.

## Prune old remote generations

Silo previews cleanup by default. Review unreferenced generations older than
the seven-day grace period:

```sh
silo sync prune
```

Apply the reviewed default boundary only after checking the preview:

```sh
silo sync prune --apply
```

Use a longer grace period when publication or recovery procedures may remain
active:

```sh
silo sync prune --older-than 30
silo sync prune --older-than 30 --apply
```

Prune never deletes the generation named by the `HEAD` it reads and stops if
that pointer changes during cleanup. Applying cleanup permanently deletes
objects under eligible generation prefixes; retain object-store versioning or
backups when older checkpoints are part of your recovery policy.

For the checkpoint protocol, durability responsibilities, and current limits,
see [Synchronization model](../concepts/synchronization.md).
