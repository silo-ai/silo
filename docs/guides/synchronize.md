# Synchronize a Database

> Share changes between machines and recover when their work conflicts.

Each machine keeps its own local database. Run `silo push` to publish changes
and `silo pull` to receive them. Neither runs in the background.

Start with one machine whose data you want to share. You will need to configure
storage; its storage and transfer charges depend on your provider.

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

Start with an existing local database and an empty remote location. Replace
the example bucket and path with your own:

```sh
silo sync init s3://my-bucket/silo/project
silo sync status
silo push
```

The initial status is `ahead`; the first push creates the remote checkpoint.

On another machine with the same repository identity, run the same `sync init`
command. If the local database is absent and the remote exists, Silo restores
the remote automatically.

Initialization needs one copy to start from:

| Local database | Remote checkpoint | What to do                                                      |
| -------------- | ----------------- | --------------------------------------------------------------- |
| Exists         | Empty             | Run `sync init`, inspect `ahead`, then `push`.                  |
| Absent         | Exists            | Run `sync init` to restore it.                                  |
| Exists         | Exists            | Initialization stops; choose an authority explicitly.           |
| Absent         | Empty             | Create a schema first, then initialize from the local database. |

When both copies exist, Silo does not merge them during setup. Inspect both
copies and choose which one to use. These recovery commands require an
unconfigured local database and a matching Git repository identity.

Enter your remote URL and the exact remote generation reported by the error:

```sh
printf 'Remote S3 URL: '
read -r SILO_REMOTE_URL
printf 'Remote generation to confirm: '
read -r REMOTE_GENERATION
```

Choose **one** of the following commands.

Preserve the local database as a recovery snapshot and install the remote:

```sh
silo sync adopt-remote "$SILO_REMOTE_URL" \
  --confirm "$REMOTE_GENERATION"
```

Preserve the old remote generation and publish the local database instead:

```sh
silo sync replace-remote "$SILO_REMOTE_URL" \
  --confirm "$REMOTE_GENERATION"
```

Both commands report the losing copy's location. If the confirmation no longer
matches, inspect the new remote generation and make the decision again; do not
retry blindly.

## Use the shared-work loop

Pull before starting shared work and push after reviewing the local changes:

```sh
silo pull
# Read and write with Silo commands.
silo sync status
silo push
```

`pull` gets the current remote checkpoint and reapplies local work that still
fits. `push` verifies a new checkpoint before publishing it. If changes
conflict, Silo stops so you can decide what to keep.

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
error before deciding what to keep:

```sh
silo sync status

```

Inspect the affected rows, query, or report with its normal `show` or `get`
command. Save any values you need before discarding work.

Discard permanently removes the selected transaction's effects from the local
database. This may affect several rows or tables if they were changed in one
transaction. The command rebuilds from the remote and reapplies the other
pending transactions.

To discard the transaction identified by the error:

```sh
printf 'Transaction id to discard: '
read -r TRANSACTION_ID
silo sync discard "$TRANSACTION_ID"
silo sync status
```

Check the new status. If another transaction conflicts, inspect it before
taking further action. Once the conflict is resolved, write any reconciled
values with the normal Silo commands and push again.

> [!WARNING]
> Never delete `_silo_outbox` rows or edit synchronization metadata directly. Those objects are part of the recovery protocol.

## Serialize schema changes

Schema changes require a fully pulled base with no pending synchronization
transactions. Pull, verify `clean`, make one schema change, and push it before
continuing. For the `issues` table from [Getting started](../getting-started.md),
save this additive change as `alter-issues.json`:

```json
{
  "add_columns": [
    {
      "name": "notes",
      "type": "text",
      "nullable": true,
      "comment": "Additional context for the issue."
    }
  ]
}
```

Then run:

```sh
silo pull
silo sync status
silo table alter issues --file alter-issues.json
silo table show issues
silo push
```

The table should now include the nullable `notes` column.

Schema changes are published as full checkpoints. They cannot be merged like
row changes. If another
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
