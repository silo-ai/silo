# Workspace and Schema Model

> Understand which repository owns a database and which layer is authoritative before moving files, diagnosing drift, or interpreting SQLite objects.

## Repository identity selects the database

Every workspace command resolves the current Git root and reads its `origin` remote. Silo normalizes that remote to a host-and-path identity, then maps the identity beneath the platform application-data directory.

SSH and HTTPS remotes that normalize to the same host and repository path select the same local database. Different normalized origins select different databases, even when their worktrees contain similar files.

Check the mapping rather than guessing it:

```sh
silo status
```

The output shows the workspace root, normalized identity, database path, and whether the database is absent or recognized.

> [!IMPORTANT]
> Changing `origin` selects a different identity. Silo does not move or migrate the previous database.

`SILO_DATA_HOME` can override the base application-data location. Silo appends its own `silo/` directory to the value. Keep active databases on local storage rather than network mounts or cloud-synchronized folders. Optional [explicit synchronization](synchronization.md) copies verified checkpoints through object storage; it does not move the active database there.

## Logical metadata is authoritative

The logical schema preserves meaning SQLite DDL cannot fully express: semantic type names, comments, policies, imported templates, attributed agent instructions, and the schema revision. Silo compiles that contract into `STRICT` tables, checks, indexes, foreign keys, and triggers.

Use the layer that answers the question:

| Need                                   | Command                                         | Why                                                     |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Understand domain meaning and policies | `silo schema show` or `silo table show <table>` | Reads authoritative logical metadata.                   |
| Copy or inspect the portable contract  | `silo schema export`                            | Emits the canonical logical schema as JSON.             |
| Diagnose generated SQLite objects      | `silo schema ddl`                               | Shows compiled DDL without replacing semantic metadata. |
| Join, aggregate, or filter stored rows | `silo sql '<query>'`                            | Opens a read-only SQLite connection.                    |

Silo verifies the complete physical schema whenever it opens a database. Unexpected changes to managed tables, indexes, or triggers produce a mismatch instead of silently redefining the logical contract.

## Enforcement has boundaries

SQLite enforces physical types, checks, foreign keys, unique constraints, and trigger-backed policies. The CLI also canonicalizes semantic values, generates identities and timestamps, applies revision checks, and constrains natural-key upserts.

An external SQLite writer can bypass CLI-only generation and canonicalization. It cannot bypass constraints and triggers unless it also alters or disables the physical schema. Silo does not describe either path as tamper-proof auditing.
