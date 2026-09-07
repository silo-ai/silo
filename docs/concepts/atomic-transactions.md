# Atomic transactions

> Save related row changes together, or roll them all back if the operation fails.

Use the library's `SiloDatabase.transaction()` when several row changes must
succeed or fail together. For example, resolving an issue might also add an
activity record. Saving only one of those changes would leave inconsistent data.

The callback receives a `SiloTransaction` for reading and writing existing user
tables. Silo checks the writes and commits them together. For a single row
operation, use the ordinary row API or CLI command.

## Use one transaction for one state transition

This application example assumes:

- `database` is an open, writable `SiloDatabase`.
- `issues` has `id`, `status`, and an `optimistic_revision` policy on `revision`.
- `issue_activity` has a generated ID, an `issue_id` foreign key to `issues.id`,
  and a text `kind` column.
- `issueId` identifies an existing issue and `requestId` identifies the request.

The application reads the issue before attempting the change. If that revision
is no longer current when it writes, both changes fail.

```ts
const issue = database.getRow('issues', issueId)

const result = database.transaction(
  (transaction) => {
    const [activity] = transaction.addRows('issue_activity', {
      issue_id: issueId,
      kind: 'resolved',
    })

    transaction.updateRow('issues', issueId, {
      status: 'resolved',
      _expected_revision: issue.revision,
    })

    return { issueId, activity }
  },
  {
    operation: {
      command: 'issue.resolve',
      request_id: requestId,
    },
  },
)
```

On success, the issue is resolved and `result.activity` contains the new
activity row. If the revision check fails, the issue stays unchanged and the
activity insert is rolled back. Read the latest issue before deciding whether
to retry.

## The scoped API

Inside the callback, use the supplied `transaction` for every write. Its reads
can see earlier writes made in the same callback. If a decision must use data
read within the transaction, use `transaction.getRow` or `transaction.listRows`.

The scope only supports user-table row operations. It does not expose:

- Raw SQLite or SQL execution
- Schema changes
- Saved-query or report changes
- Synchronization controls

Calling mutable methods on the enclosing `database` while the callback is
active fails. This prevents writes from escaping the transaction's bookkeeping.
Do not retain the transaction object for later use; its scope ends when the
callback returns.

See the generated [library API reference](../reference/@silo-ai/silo.html#silotransaction)
for the complete method contracts and types.

## What commits together

For a successful callback that performs row mutations, Silo commits these
effects as one local SQLite transaction:

| Effect                | Contract                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| User-table rows       | All validated inserts, updates, upserts, and deletes in the callback.                                                                 |
| Mutation journal      | One entry describing the operation, touched tables, and compact row-mutation metadata. Its resource tags identify each touched table. |
| Synchronization state | When explicit synchronization is configured, one changeset-backed pending transaction containing the row changes.                     |

Use optional `operation` metadata to identify the application request. Silo
records the affected tables and row operations itself. The callback's return
value is returned after commit; Silo does not save it.

## Failure and callback rules

If a validation error, missing row, constraint failure, or revision conflict
escapes the callback, Silo rolls back its row changes and associated metadata.
A failed transaction leaves no partial journal entry or pending synchronization
transaction. Let failures propagate when the whole operation should roll back.

Errors thrown by application code are rethrown unchanged after rollback.
Database errors remain Silo errors.

The callback must be synchronous:

- Do not use `await` or return a promise.
- Do not send notifications or change external systems inside the callback.
  SQLite cannot undo those effects.
- Perform external work after the transaction returns successfully.

## Synchronization and integration boundaries

When synchronization is configured, the multi-table row changeset remains one
pending local synchronization transaction. Push and pull rebase or reject
that changeset as a unit; Silo does not merge application semantics or select
a last writer. See [Synchronization model](synchronization.md) for the
checkpoint and conflict protocol.

Your application still owns its tables and workflow rules. Silo does not
decide whether resolving an issue is the right action.

Use the [mutation journal](mutation-journal.md) only if a separate, long-running
reader needs to notice changes. It reports that data may need refreshing; it
is not an event replay API.
