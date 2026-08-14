# Atomic transactions

> Keep a cross-table state transition, its optimistic checks, and Silo's local metadata in one validated commit.

`SiloDatabase.transaction()` is a library API for an application operation
that must not leave partial row state. Its synchronous callback receives a
scoped `SiloTransaction`. The scope can read and mutate several already-defined
user tables; Silo validates each row operation, then commits the result and
its mutation metadata together.

This is a general row primitive. Silo does not interpret event/state meaning,
run application workflows, or choose a semantic winner when synchronization
finds a conflict.

## Use one transaction for one state transition

Use a transaction when a successful operation must append or update more than
one user-table row. For example, an application can record activity and update
the current issue state only if the issue still has the revision it read:

```ts
// `database` is an open SiloDatabase. The application schema defines both
// `issues` and `issue_activity`; `issues` uses an optimistic_revision policy.
const result = database.transaction(
  (transaction) => {
    const issue = transaction.getRow('issues', issueId)
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

If another writer changes the issue after it is read, the compare-and-set
update fails and the activity insert is rolled back with it. For a single row
operation, use the ordinary validated row API or the corresponding CLI command.

## The scoped API

The callback receives only validated operations on logical user tables:

| Method                          | Purpose                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `getRow(name, key)`             | Read one keyed row from the transaction's current view.                                       |
| `listRows(name, limit, offset)` | Read a bounded page of rows from the current view.                                            |
| `addRows(name, input, upsert?)` | Insert one row or an array of rows; pass `true` for a declared natural-key upsert.            |
| `updateRow(name, key, input)`   | Update one keyed row; include `_expected_revision` when the table requires a compare-and-set. |
| `deleteRow(name, key)`          | Delete one keyed row.                                                                         |

Reads can observe earlier writes made through the same scope. Use the scoped
reads when a read, revision check, and write form one transition. The scope
does not expose SQLite handles, SQL execution, schema changes, query/report
mutations, synchronization controls, or Silo's internal metadata.

The callback must use this scope for every mutation in the transition. Even if
it closes over the enclosing `SiloDatabase`, calling its mutable APIs directly
while the callback is active is rejected. This keeps all row changes under one
mutation, journal, and synchronization boundary.

## What commits together

For a successful callback that performs row mutations, Silo commits these
effects as one local SQLite transaction:

| Effect                | Contract                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| User-table rows       | All validated inserts, updates, upserts, and deletes in the callback.                                                                 |
| Mutation journal      | One entry describing the operation, touched tables, and compact row-mutation metadata. Its resource tags identify each touched table. |
| Synchronization state | When explicit synchronization is configured, one changeset-backed pending transaction containing the row changes.                     |

The optional `operation` metadata is caller context such as a command or
request ID. Silo supplies the actual touched tables and compact mutations; a
caller-provided `command` is preserved. The callback's return value is
returned after commit and is not persisted by Silo.

## Failure and callback rules

Any Silo validation error, constraint failure, missing row, optimistic-revision
conflict, or transaction-scope violation rolls back every row change and the
associated journal and synchronization metadata. A failed transaction does
not produce a partial journal entry or pending synchronization transaction.

An error deliberately thrown by application callback code is rethrown as the
same error after rollback. This lets application control flow retain its own
error type and identity; database errors remain Silo errors.

The callback is synchronous. Do not return a promise or use `await`, and do
not perform external side effects that cannot be undone if the transaction
later fails. Publish notifications or update external systems after the
database call returns successfully.

## Synchronization and integration boundaries

When synchronization is configured, the multi-table row changeset remains one
pending local synchronization transaction. Push and pull rebase or reject
that changeset as a unit; Silo does not merge application semantics or select
a last writer. See [Synchronization model](synchronization.md) for the
checkpoint and conflict protocol.

The transaction API does not create a workflow model. The integrating
application must define the logical schema, primary keys, revision policies,
foreign keys, and state-transition rules for its own tables. It should also
use [Mutation journal](mutation-journal.md) only when it needs a separate
long-lived local invalidation consumer; the journal is metadata about the
commit, not an event replay API.
