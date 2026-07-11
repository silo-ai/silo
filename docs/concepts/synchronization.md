# Synchronization Model

> Understand what becomes durable, how concurrent work converges, and which guarantees remain the operator's responsibility when explicit synchronization is enabled.

## Local work remains authoritative until push

Silo continues to use one local SQLite database per normalized Git origin. After synchronization is enabled, every supported row mutation atomically records an ordered SQLite changeset and operation context alongside the row changes. Local commits therefore continue to work offline.

The configured remote contains:

```text
<prefix>/HEAD
<prefix>/generations/<generation-id>/...
```

Each generation is an immutable Litestream checkpoint. `HEAD` is a small versioned manifest that names the current generation and records its content hash, schema revision, generated database identity, expected Git workspace identity, parent generation, and idempotent publication identifier.

The database identity is generated when synchronization is configured. The Git remote identifies the expected workspace but is not treated as proof that a caller is authorized.

## Publication has one serialization point

Push publishes a new immutable generation, restores it independently, and verifies its hash, identity, logical schema, physical schema, and SQLite integrity before updating `HEAD`. The `HEAD` write uses an S3 conditional request against the previously read entity tag. This compare-and-swap is the serialization point for concurrent publishers.

If another publisher advances `HEAD`, the losing generation remains unreferenced and harmless. Silo rereads the winner and rebases non-conflicting local changesets before trying to publish again. An ambiguous network result is resolved by rereading `HEAD` and matching the publication identifier; pending local transactions are marked clean only after the new head is confirmed.

Changesets use abort-on-conflict semantics. Concurrent changes to different rows can converge, while incompatible changes to the same row, constraint failures, and schema mismatches stop without changing the active local database. Silo never makes a semantic conflict decision automatically.

Schema mutations have stricter rules: they require a fully pulled base and an empty row outbox, and they publish as serialized full checkpoints. Concurrent DDL is not merged.

## Durability belongs to the object store

Once `HEAD` is confirmed, the referenced generation is the durable remote authority and can restore a machine with no local copy. Availability, retention, access control, encryption, versioning, replication, and disaster recovery are properties of the configured S3-compatible service and bucket policy.

Silo deliberately does not provide:

- continuous replication or automatic pull and push;
- branches, checkout, history traversal, or audit history;
- automatic retention or garbage collection for superseded and unreferenced generations;
- bundled Litestream binaries or a hosted coordinator;
- credential backup, rotation, or authorization management;
- non-S3 Litestream backends in the first release.

The remote manifest and immutable generations are synchronization protocol data, not a user-facing commit graph. Deleting superseded generations requires an external retention process that never removes the generation currently referenced by `HEAD`.

## Credentials and process safety

Silo uses the standard AWS credential chain and environment, including custom endpoints through `AWS_ENDPOINT_URL_S3`; Litestream must be able to access the same destination. Credentials remain outside SQLite. Grant only the object read and conditional-write permissions required for the configured prefix.

Cross-process locks prevent ordinary Silo writers from racing a pull or atomic database replacement. Temporary restores and candidate checkpoints are removed after use. Process safety does not replace object-store access control: anyone able to write the configured `HEAD` and generation prefix can affect the remote authority.

See [Synchronize a database](../guides/synchronize.md) for the operator workflow and conflict recovery commands.
