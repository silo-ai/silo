# Atomic commits

> Keep each supported write and its synchronization metadata together.

Each supported Silo database mutation commits its data change and mutation
journal entry in one SQLite transaction. When synchronization is configured,
the pending outbox change is committed in that same transaction. If any part
of that mutation fails, SQLite rolls it back.

## Add several rows as one operation

`silo row add` accepts one row or a JSON array. Use an array when the rows must
succeed or fail together. This example assumes the `issues` table from
[Getting started](../getting-started.md):

```sh
printf '%s\n' '[{"title":"Review migration plan"},{"title":"Update release notes"}]' \
  | silo row add issues
```

Silo validates every row before commit. If either row fails validation or a
SQLite constraint, neither row is saved. On success, the rows, one mutation
journal entry, and—when synchronization is enabled—one outbox changeset commit
together. Two separate CLI commands are two separate operations.

## What commits together

| Effect                | Contract                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- |
| User data             | The rows, schema, saved query, or report changed by the command.                              |
| Mutation journal      | One entry records the operation and resources that may need refreshing.                       |
| Synchronization state | When configured, one changeset-backed pending transaction contains the supported data change. |

Schema changes use a full-checkpoint transaction instead of a row changeset.
Synchronization reapplies or rejects each pending transaction as a unit; it
does not merge application semantics or select a last writer. See
[Synchronization model](synchronization.md) for the checkpoint and conflict
protocol.

## Failure and boundaries

If validation, a missing row, a constraint, or a revision check fails, the
operation leaves no partial data, journal entry, or pending synchronization
transaction. Read the latest state before deciding whether to retry.

The Rust database crate owns writable SQLite access. `silo sql` and saved-query
execution are read-only. Writing directly to the SQLite file bypasses Silo's
validation and bookkeeping. Separate CLI commands do not share a larger
transaction; use one array input for a set of row additions or upserts that must
commit together.

The [mutation journal](mutation-journal.md) is bounded change metadata for
internal readers. It is not an event replay API or audit history.
