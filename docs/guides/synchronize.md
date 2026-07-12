# Synchronize a Database

> Connect a repository's local Silo database to S3-compatible storage, exchange work explicitly, and recover safely when concurrent changes conflict.

Silo has no background synchronization. Plan each shared-work cycle around an explicit pull before work and push when the work is ready to publish. Review the [synchronization guarantees, responsibilities, and current limits](../concepts/synchronization.md) before choosing the remote as a recovery authority.

## Prepare the environment

Synchronization requires:

- Litestream 0.5.12 or newer installed on `PATH`, or selected with `LITESTREAM_PATH`.
- An S3-compatible bucket that supports conditional object writes.
- Credentials available to both Silo and Litestream through the standard AWS environment or credential chain. Silo never stores credentials in the database.
- Stable, non-null primary keys on every synchronized table.

For AWS, the usual environment starts with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`; temporary credentials also use `AWS_SESSION_TOKEN`. Set `AWS_ENDPOINT_URL_S3` for a custom S3-compatible endpoint. Confirm the endpoint's conditional `PUT` behavior before relying on concurrent publication.

The active SQLite file must remain on local storage. S3 holds remote checkpoint data, not the live database.

## Initialize synchronization

Connect an existing local database to an empty remote:

```sh
silo sync init s3://my-bucket/silo/project
silo sync status
silo push
```

The initial status is `ahead`; the first push creates the durable remote checkpoint and `HEAD` pointer.

To restore an existing remote on another machine, use the same repository identity and remote URL:

```sh
silo sync init s3://my-bucket/silo/project
```

Initialization restores automatically when the remote exists and no local database exists.

> [!IMPORTANT]
> Start with an existing database on only one side. Silo rejects initialization when local and remote databases both already exist instead of choosing or merging them. It also rejects initialization when neither side has a database.

## Pull, work, and push

Pull before beginning shared work, then push only when the resulting local transactions are ready for others:

```sh
silo pull
# Use ordinary Silo row or report commands.
silo push
```

`silo pull` restores remote `HEAD` into a temporary database, verifies it, and reapplies pending local row and report transactions in order. The active database is replaced only after the entire operation succeeds.

`silo push` first incorporates a newer remote head when necessary, creates and verifies a clean checkpoint, then conditionally advances `HEAD`. If another publisher wins the race, Silo cannot overwrite it. Non-conflicting transactions are rebased; a conflicting transaction stops the operation.

Check state at any time:

```sh
silo sync status
```

| State          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `unconfigured` | This local database has no synchronization remote.                      |
| `clean`        | Local state has no pending transactions and matches remote `HEAD`.      |
| `ahead`        | Local transactions are pending on the current remote generation.        |
| `behind`       | Remote `HEAD` advanced and there is no pending local work.              |
| `diverged`     | Remote `HEAD` advanced while local transactions are pending.            |
| `conflicted`   | A pending local transaction could not be applied to the current remote. |

Status also reports the local base generation, current remote generation, pending count, and conflict transaction identifier when available.

## Recover from a row conflict

A failed pull or push preserves the original local database. The error identifies the pending transaction and, when available, its originating operation, table, and key. Inspect the current data and status before choosing a resolution:

```sh
silo sync status
silo row get issues 550e8400-e29b-41d4-a716-446655440000
```

Silo does not attempt a last-writer-wins resolution. To abandon only the identified local transaction, rebuild from the current remote and replay every other pending transaction:

```sh
silo sync discard <transaction-id>
```

> [!WARNING]
> Discard permanently removes the selected transaction's effects from the rebuilt local database. Verify the transaction identifier and preserve any values needed for a reconciled write first.

After discard succeeds, issue an ordinary Silo mutation containing the reconciled row or report, then push it. See [Publish a refreshable report](publish-a-report.md#share-reports-through-explicit-synchronization) for report-specific refresh behavior.

## Serialize schema changes

Schema changes are full checkpoints, not mergeable row changesets. Pull and reach a clean state before creating, importing, altering, or dropping schema objects:

```sh
silo pull
silo sync status
silo table alter issues < alter-issues.json
silo push
```

Only one pending schema mutation is allowed, with no earlier pending row transactions. If remote `HEAD` advances first, the schema push fails and preserves the local database. Discard that schema transaction, pull the winner, and deliberately reapply a compatible schema change. Silo does not merge concurrent DDL or apply older-schema row changesets to a newer schema.

## Prune old remote generations

Preview generations that are unreferenced by the current `HEAD` and at least seven days old:

```sh
silo sync prune
```

The preview reports the current generation, cutoff, number scanned, and eligible generation IDs. Review that list before applying the same default boundary:

```sh
silo sync prune --apply
```

Use a longer grace period when publication or disaster-recovery procedures can remain active for more than seven days:

```sh
silo sync prune --older-than 30
silo sync prune --older-than 30 --apply
```

> [!WARNING]
> Applying cleanup permanently deletes every object under each eligible generation prefix. Prune never deletes the generation referenced by the `HEAD` it reads, and it aborts before deletion if that pointer changes during discovery. Keep object-store versioning or backups when older checkpoints are part of your recovery policy.

Cleanup is an explicit operator action and does not pull, push, or change local synchronization state. A partial object-store failure stops the command and identifies the generation whose deletion failed; rerun the preview to inspect what remains before retrying.

For the protocol and durability limits behind these commands, read [Synchronization model](../concepts/synchronization.md).
