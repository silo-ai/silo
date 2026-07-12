# Synchronize a database

> Exchange local Silo transactions through an already authorized S3-compatible remote without silently choosing a conflict winner.

Before initialization, verify Litestream 0.5.12 or newer is installed and that the standard AWS credential environment is available to both Silo and Litestream. Keep the active database on local storage.

Initialize once, then inspect the result:

```sh
silo sync init s3://my-bucket/silo/project
silo sync status
```

An existing local database with an empty remote becomes `ahead`; push it to establish remote `HEAD`. An absent local database restores an existing remote. Do not attempt to combine an existing unconfigured local database with an existing remote.

For normal shared work:

```sh
silo pull
# Inspect and mutate through ordinary Silo commands.
silo push
```

Treat `ahead`, `behind`, and `diverged` as synchronization state, not errors to bypass. Pull rebases non-conflicting pending row transactions. If status is `conflicted`, preserve any values needed from the identified operation, then discard only that transaction and issue a deliberate reconciled mutation:

```sh
silo sync discard <transaction-id>
```

Discard rebuilds from remote and replays the remaining pending transactions; it permanently removes the selected transaction's effects. Never delete an outbox row directly.

Schema commands require `clean` status and no pending data transaction. Pull first, make one schema mutation, and push it before further work. Concurrent schema changes do not merge; discard the losing schema transaction, adopt the remote winner, and reapply a compatible change deliberately.

Synchronization is explicit. There is no background replication, Git-style history, automatic conflict winner, or background remote generation cleanup. Operators can preview generations older than the default seven-day grace period, then deliberately apply the reviewed cleanup:

```sh
silo sync prune
silo sync prune --apply
```

Use `--older-than <days>` for a longer retention boundary. Never bypass the preview or remove the generation named by remote `HEAD` directly.
