# Workspace and Schema Model

> Explain which local database a repository uses and why Silo's logical schema is more authoritative than its generated SQLite objects.

## Repository identity selects the database

Every workspace command resolves the current Git root and reads `.git/silo.json` from the repository's common Git directory. This versioned local state contains a persistent detached UUID and an `auto`, `detached`, or named-remote selection. Silo maps the selected identity to a database beneath the platform application-data directory. The active database is not stored inside the Git repository.

SSH and HTTPS remotes that normalize to the same host and repository path select the same local database. Different normalized origins select different databases, even when their worktrees contain similar files.

The detached UUID and selection belong only to that local Git repository. Repeated commands and linked worktrees share the state, but clones do not copy it because Git metadata is not versioned. Silo writes this file atomically; do not edit it by hand. Invalid state stops resolution instead of silently generating another identity.

Check the mapping rather than guessing it:

```sh
silo status
```

The output shows the workspace root, selection, normalized identity, database path, and whether the database is absent or recognized.

> [!IMPORTANT]
> In `auto` mode, adding `origin` moves an existing unsynchronized detached database only when the origin identity has no database. If both databases exist, Silo stops and requires an explicit selection.

## Select or move a Silo

Use a named Git remote when this repository should select the identity derived
from that remote's current URL:

```sh
silo switch origin
silo status
```

The first command changes only repository-local selection. The status output
then shows `remote:origin` and the selected database, which may be absent.

Select the persistent repository-local identity instead:

```sh
silo switch --detach
silo status
```

Restore the default behavior after an explicit selection with
`silo switch --auto`. Automatic selection uses `origin` when it exists and the
detached identity otherwise.

Add `--move` when the current database should become the selected identity:

```sh
silo switch origin --move
silo status
```

Movement requires an existing source, an empty destination, and an
unsynchronized database. Silo holds both writer locks, verifies the source,
creates and verifies a re-identified copy, installs it atomically, and only
then removes the old local file. A synchronized database cannot move because
its remote checkpoint records the existing workspace identity.

Changing a selected remote's URL changes the identity derived from that remote;
it does not infer that the previous database should move. To carry an
unsynchronized database across an `origin` URL change, stage it through the
detached identity:

```sh
silo switch --detach --move
git remote set-url origin git@github.com:acme/renamed-project.git
silo switch origin --move
silo status
```

The final status reports the normalized identity for the new URL. This workflow
does not apply to synchronized databases, whose remote checkpoints retain the
existing identity.

`SILO_DATA_HOME` can override the base application-data location. Silo appends its own `silo/` directory to the value. Keep active databases on local storage rather than network mounts or cloud-synchronized folders. Optional [explicit synchronization](synchronization.md) copies verified checkpoints through object storage; it does not move the active database there.

## The schema has two layers

The logical schema is the contract. It preserves meaning SQLite DDL cannot fully express: semantic type names, comments, semantic relations, policies, imported templates, attributed agent instructions, and the schema revision. A semantic relation names and documents an existing foreign-key connection; it does not replace the foreign key or add a physical object. Silo compiles the physical part of that contract into `STRICT` tables, checks, indexes, foreign keys, and triggers.

Treat the generated SQLite objects as an enforcement artifact. Do not edit them
or infer the domain model from them.

Use the layer that answers the question:

| Need                                   | Command                                                     | Why                                                     |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Understand domain meaning and policies | `silo schema show` or `silo table show <table>`             | Reads authoritative logical metadata.                   |
| Inspect semantic relationships         | `silo relation list` or `silo relation show <table> <name>` | Reads named relations and derived cardinality.          |
| Copy or inspect the portable contract  | `silo schema export`                                        | Emits the canonical logical schema as JSON.             |
| Diagnose generated SQLite objects      | `silo schema ddl`                                           | Shows compiled DDL without replacing semantic metadata. |
| Join, aggregate, or filter stored rows | `silo sql '<query>'`                                        | Opens a read-only SQLite connection.                    |

Silo verifies the complete physical schema whenever it opens a database. Unexpected changes to managed tables, indexes, or triggers produce a mismatch instead of silently redefining the logical contract.

## Enforcement has boundaries

SQLite enforces physical types, checks, foreign keys, unique constraints, and trigger-backed policies. The CLI also canonicalizes semantic values, generates identities and timestamps, applies revision checks, and constrains natural-key upserts.

An external SQLite writer can bypass CLI-only generation and canonicalization. It cannot bypass constraints and triggers unless it also alters or disables the physical schema. A long-lived local consumer can use the [mutation journal](mutation-journal.md) to observe supported Silo commits; direct external commits are only reported as unknown/global changes through SQLite `data_version`, never as resource-specific events. Silo does not describe either path as tamper-proof auditing.
