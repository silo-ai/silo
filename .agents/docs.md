# Documentation Rules

> Preserve Silo's mental model while helping readers complete the next task.

These rules supplement the general documentation guidance in the repository's
docs skill. They protect Silo-specific vocabulary, page ownership, examples,
and system boundaries.

## Canonical mental model

Keep this sentence true across the documentation:

> Silo gives each Git repository a local SQLite database. The logical schema
> defines the contract, Silo commands own writes, SQL/queries/reports are read
> surfaces, and synchronization is explicit checkpoint exchange.

[`docs/concepts/how-silo-works.md`](../docs/concepts/how-silo-works.md) owns the
canonical explanation of these relationships. Link to it instead of
re-explaining the architecture in every guide.

The basic system boundaries are:

- the Git repository identity selects a local database; the active database is
  not stored inside the repository;
- the logical schema is authoritative, while generated SQLite objects enforce
  its contract;
- row, schema, saved-query, and report commands are supported mutation
  boundaries; `silo sql` and saved-query execution are read-only;
- saved queries and reports are read surfaces over the same database, not
  separate databases;
- synchronization is explicit and local-first; it is not live replication;
- the mutation journal is bounded local invalidation metadata, not audit
  history or a replay log.

## Page ownership

Each page must have one durable reader job:

- `docs/index.md` is a short overview and router.
- `docs/getting-started.md` is one complete happy path.
- `docs/concepts/how-silo-works.md` owns the product vocabulary and system map.
- Other concept pages explain one boundary or protocol in depth.
- Guide pages complete one workflow from prerequisite to verified result.
- Reference pages optimize for lookup with boundaries, tables, defaults, and
  examples.
- `docs/templates/` documents behavior added by a template, not core Silo
  behavior.
- `docs/troubleshooting.md` starts from symptoms and leads to verification and
  the smallest safe fix.

Do not duplicate a canonical explanation merely to make a page standalone.
Give the local page the minimum context needed for its task, then link to the
owning concept page.

## Stable vocabulary

Use these terms consistently:

| Use | Meaning |
| --- | --- |
| `local database` | The active SQLite file on a machine. |
| `remote checkpoint` | Published synchronization state used to share or restore a database. |
| `logical schema` | Authoritative table meaning, types, constraints, policies, and metadata. |
| `generated SQLite objects` | Compiled tables, indexes, checks, foreign keys, and triggers. |
| `row mutation` | A supported insert, update, delete, or upsert. |
| `read-only SQL` | `silo sql` or saved-query execution. |
| `explicit synchronization` | The pull/push workflow between local state and a published checkpoint. |
| `mutation journal` | Bounded local invalidation metadata for a long-lived consumer. |

Avoid describing synchronization as a live connection or background replication,
the remote as a SQL server, generated DDL as the source of domain meaning, or
the mutation journal as an audit log.

## Example discipline

Use `issues` for general cross-page examples. Use `tasks` only when a page
explicitly depends on the Tasks template. If an example uses another domain,
state its prerequisite and why that domain is useful.

Every non-trivial example must show:

1. why the example applies;
2. the smallest complete input;
3. the command or configuration;
4. the observable result or next verification step.

Commands presented as copy/paste must be valid shell. Explain placeholders or
use named variables; do not present bare `<placeholder>` tokens as if the
command can be pasted unchanged. Prefer `--file` when a command accepts it.

Keep examples consistent with the actual schema, policy, template, and CLI
syntax they claim to use. Do not silently switch from `issues` to `tasks`, or
introduce columns that the preceding example never created.

## Source and change discipline

Verify behavior from source, tests, bundled task guides, installed package
documentation, or CLI help. Do not infer command syntax or guarantees from a
similar command.

When a command, schema contract, synchronization guarantee, or public API
changes, search for dependent explanations, links, and anchors before editing:

```sh
rg -n 'old term|old command|old anchor' docs README.md
```

Update the page that owns the concept and then update affected workflow pages.
Do not create competing definitions of the same term.

Public TypeScript API behavior belongs in TSDoc and generated declarations.
Guides may explain composition and workflows, but must not become a second
hand-maintained API reference.

## Diagrams and callouts

Use Mermaid only when structure is the point: architecture, ownership,
dependencies, sequencing, branching, or lifecycle. Keep one diagram focused on
one relationship and explain its meaning in prose immediately around it.

Use callouts only when a detail changes how the reader should interpret or
perform the surrounding action. Keep warnings beside the destructive or
irreversible operation they qualify.

## Required checks

Before completing documentation changes, run:

```sh
git diff --check
pnpm exec oxfmt --check docs
pnpm docs:build
```

Review changed links, anchors, examples, and Mermaid diagrams in the generated
site. If a documentation change affects a command, schema contract,
synchronization guarantee, or public API claim, also run the narrowest relevant
CLI help command or test.
