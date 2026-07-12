# Synchronization Model

> Decide when Silo's explicit checkpoint exchange is sufficient, which conflicts it can rebase, and which durability and security guarantees must come from the operator and object store.

## Synchronization is explicit and local-first

Silo continues to use one SQLite database on local storage for each normalized Git origin. Ordinary reads and writes use that local database, work offline, and do not contact the configured remote. Nothing runs in the background: use `silo pull` to incorporate published work and `silo push` to publish local work.

After synchronization is enabled, every supported row or report mutation atomically records an ordered SQLite changeset and operation context alongside the change. Report definitions, saved queries, rendered snapshots, refresh status, and deletions therefore follow the same explicit push and pull boundary as table data. A local transaction is durable only according to the local machine until a push confirms a new remote head.

The configured remote contains:

```text
<prefix>/HEAD
<prefix>/generations/<generation-id>/...
```

Each generation is an immutable Litestream checkpoint. `HEAD` is a small versioned manifest that names the current generation and records its content hash, schema revision, generated database identity, expected Git workspace identity, parent generation, and idempotent publication identifier.

The database identity is generated when synchronization is configured. The Git remote identifies the expected workspace but is not proof that a caller is authorized. Initialization accepts one existing authority: it can publish an existing local database to an empty remote or restore an existing remote when no local database exists. If both databases already exist, Silo refuses to reconcile them instead of choosing one.

## What publication guarantees

Push publishes a new immutable generation, restores it independently, and verifies its hash, identity, logical schema, physical schema, and SQLite integrity before updating `HEAD`. The `HEAD` write uses an S3 conditional request against the previously read entity tag. This compare-and-swap is the serialization point for concurrent publishers.

If another publisher advances `HEAD`, the losing generation remains unreferenced and harmless. Silo rereads the winner and rebases non-conflicting local changesets before trying to publish again. An ambiguous network result is resolved by rereading `HEAD` and matching the publication identifier. Pending local transactions are marked clean only after the new head is confirmed.

Conflict handling is deliberately mechanical:

| Concurrent change                                                     | Result                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Transactions affect different rows or reports and satisfy constraints | Silo rebases the pending transactions in order.             |
| Transactions incompatibly affect the same row or report               | Pull or push stops and preserves the active local database. |
| Reapplying a transaction violates a constraint                        | Pull or push stops and preserves the active local database. |
| The remote and pending transaction use incompatible schemas           | Pull or push stops and preserves the active local database. |

Silo never picks a semantic winner or silently applies last-writer-wins behavior. A person or agent must inspect the conflict, discard the rejected local transaction if appropriate, and write the reconciled result as a new transaction.

Schema mutations have stricter rules. They require a fully pulled base and an empty row outbox, then publish as serialized full checkpoints. Concurrent DDL is not merged: when another schema publication wins, the losing change must be discarded and deliberately reapplied against the winning schema.

## What operators and the object store guarantee

Once `HEAD` is confirmed, the referenced generation is Silo's durable remote authority and can restore a machine with no local copy. Whether that authority remains available is outside Silo's control. The configured S3-compatible service and bucket policy are responsible for durability, retention, access control, encryption, versioning, replication, and disaster recovery.

Silo uses the standard AWS credential chain and environment, including custom endpoints through `AWS_ENDPOINT_URL_S3`; Litestream must be able to access the same destination. Credentials remain outside SQLite. Operators must provision, back up, rotate, and scope credentials to the object read and conditional-write permissions required for the configured prefix.

The remote manifest and immutable generations are protocol data, not a user-facing commit graph. `silo sync prune` provides conservative operator cleanup: it previews by default, excludes the generation named by `HEAD`, requires an age grace period, and revalidates the `HEAD` entity tag immediately before deletion. If publication advances `HEAD` during discovery, cleanup stops without deleting anything.

The age boundary is part of the concurrency protection. A conforming push always writes a new, uniquely named generation before advancing `HEAD`, so a generation old enough for cleanup cannot be the unpublished candidate of an in-flight push. Bucket policies should restrict direct rollback or mutation of `HEAD`; prune is not a substitute for protocol-compliant writers or object-store versioning and backups.

## Current limits

- Litestream 0.5.12 or newer is required, but Silo does not bundle its binary.
- Only S3-compatible Litestream remotes are supported, and they must implement conditional object writes.
- The active SQLite database must remain on local storage.
- Every synchronized table must have a stable, non-null primary key.
- Pull, push, and atomic database replacement block concurrent Silo writers through cross-process locks.
- There is no hosted coordinator, branch model, checkout, history or audit traversal, or background generation cleanup.
- Silo does not store or manage object-store credentials.

Temporary restores and candidate checkpoints are removed after use. Process safety does not replace object-store access control: anyone able to write the configured `HEAD` and generation prefix can affect the remote authority.

See [Synchronize a database](../guides/synchronize.md) for the operator workflow and conflict recovery commands.
