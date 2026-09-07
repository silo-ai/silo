# Workspace and Schema Model

> Check which database a repository uses and where its data rules are stored.

## Repository identity selects the database

Silo reads the repository's selection from `silo.json` in the common Git
directory, usually `.git/silo.json`. It uses that selection to find a database
in your machine's application-data directory, outside the repository.

The selection can be:

- `auto`: use `origin` when present, otherwise the repository's local identity
- `detached`: use a persistent local UUID
- A named remote: use the identity derived from that remote's current URL

For example, `git@github.com:acme/project.git` and
`https://github.com/acme/project.git` select the same database on one machine.
Different repository paths select different databases, even if their files
are identical.

Linked worktrees share this selection and local UUID. Clones do not copy them
because the file is Git metadata, not a tracked file. Clones with matching
remote identities can still select the same database on the same machine.

Do not edit the file by hand. Silo writes it atomically and stops on invalid
contents rather than silently selecting a new database.

Check the mapping rather than guessing it:

```sh
silo status
```

The output shows:

- The Git workspace root
- The selection and resulting identity
- The local database path
- Whether a database exists there

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

Add `--move` when you want to carry the current database to that identity:

```sh
silo switch origin --move
silo status
```

A move requires:

- An existing source database
- No database at the destination
- Synchronization not yet configured

Silo locks both locations, verifies a copy under the new identity, and installs
it before removing the old local file. A synchronized database cannot move
because its remote checkpoint records the existing identity.

Changing a selected remote's URL changes the identity derived from that remote;
it does not infer that the previous database should move. To carry an
unsynchronized database across an `origin` URL change, stage it through the
detached identity. Replace the example remote URL with the new URL for your
repository:

```sh
silo switch --detach --move
git remote set-url origin git@github.com:acme/renamed-project.git
silo switch origin --move
silo status
```

The final status reports the normalized identity for the new URL. This workflow
does not apply to synchronized databases, whose remote checkpoints retain the
existing identity.

`SILO_DATA_HOME` overrides the base application-data location. Silo appends
`silo/` to that path. For example, `/data/silo-work` becomes
`/data/silo-work/silo/`.

Keep active databases on local storage. Use [synchronization](synchronization.md)
to share checkpoints through object storage; do not put the active database on
a network drive or in a cloud-synchronized folder.

## The schema has two layers

The **logical schema** stores the table definitions and information that SQLite
DDL alone does not describe:

- Semantic types and comments
- Named relationships between tables
- Policies for writes
- Imported templates and their agent instructions
- The schema revision

Silo compiles the enforceable parts into **generated SQLite objects**, such as
`STRICT` tables, checks, indexes, foreign keys, and triggers. A named semantic
relation describes an existing foreign key; it does not create one.

Read the logical schema to understand the data. Do not edit generated SQLite
objects directly; they are Silo's implementation of the stored rules.

Use the layer that answers the question:

| Need                                   | Command                                                     | Why                                                     |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Understand domain meaning and policies | `silo schema show` or `silo table show <table>`             | Reads authoritative logical metadata.                   |
| Inspect semantic relationships         | `silo relation list` or `silo relation show <table> <name>` | Reads named relations and derived cardinality.          |
| Copy or inspect the portable contract  | `silo schema export`                                        | Emits the canonical logical schema as JSON.             |
| Diagnose generated SQLite objects      | `silo schema ddl`                                           | Shows compiled DDL without replacing semantic metadata. |
| Join, aggregate, or filter stored rows | `silo sql '<query>'`                                        | Opens a read-only SQLite connection.                    |

Whenever Silo opens a database, it checks the generated SQLite objects against
the logical schema. Unexpected changes to a managed table, index, or trigger
cause a schema mismatch error.

## Enforcement has boundaries

SQLite enforces column types and constraints, along with policies implemented
by triggers. Silo commands also:

- Convert accepted inputs to the type's stored form
- Generate IDs and timestamps
- Check revisions before updates
- Restrict which fields an upsert can replace

A direct SQLite writer bypasses those command checks. Existing SQLite
constraints and triggers still apply unless that writer changes or disables
them. Neither layer is a tamper-proof audit system.

A long-running reader can use the [mutation journal](mutation-journal.md) to
notice changes made through Silo. Direct external commits can be reported as
unknown changes through SQLite's `data_version`; they do not receive reliable
table or row attribution.
