# Specification: Git-Scoped Strict SQLite CLI for Agents

*High-level product and technical specification*

**Draft 0.1 — July 2026**

## 1. Product definition

The tool is an agent-oriented command-line interface for defining strictly typed SQLite schemas and storing typed rows in them. Each Git repository resolves to exactly one database through its normalized `origin` remote. The tool is intentionally SQLite-specific: SQLite concepts remain visible rather than being hidden behind a portable abstraction.

The interface is schema-first. A table must be defined before rows can be written. Table definitions include semantic types, comments, constraints, indexes, and optional table policies. Commands accept structured JSON input where rich input is needed and emit deterministic Markdown for inspection and results. There is no JSON output mode.

The initial release is intentionally local, single-user, and minimal. It does not provide synchronization, remote execution, template upgrades, schema rollback, audit history, multiple schemas per repository, or arbitrary SQL mutations.

## 2. Design principles

1. **SQLite is the substrate and the contract.** The product may add semantic types and policy-driven behavior, but generated schemas, constraints, indexes, queries, and transaction behavior remain understandable in SQLite terms.
2. **The logical schema is authoritative.** SQLite DDL is a compiled representation of schema metadata stored inside each database.
3. **Git identity is sufficient.** The normalized `origin` remote is the schema identity, display name, and lookup key. There is no separate hash-based identifier.
4. **One repository, one schema.** The current Git root resolves to one local schema and one database.
5. **The filesystem is the catalog.** All recognized database files live under a hard-coded application-data directory. Each database is self-describing through internal metadata.
6. **Agents are the primary users.** The CLI favors deterministic output, stdin-friendly structured writes, stable exit codes, and explicit validation over interactive prompting.
7. **Rich semantics are a feature.** Semantic types and table policies are first-class and may grow substantially, provided their storage, validation, normalization, and query semantics are precisely defined.
8. **Minimal surface, deep utility.** Avoid convenience layers whose behavior is difficult to specify or maintain. Prefer direct SQLite concepts and a small command set.

## 3. Non-goals

The initial system does not attempt to be a document database, ORM, server, synchronization protocol, collaboration layer, security-grade audit system, package manager, migration framework, or database-agnostic schema language.

Specifically excluded from the first release:

- Multiple schemas per Git root.
- Configurable database storage roots.
- Active databases in cloud-synchronized folders.
- Template inheritance, dependencies, upgrades, or registries.
- Schema rollback or automatic backups.
- Change-event or audit tables.
- Generic soft deletion.
- Raw SQL mutations.
- Cross-database queries.
- Remote or concurrent multi-machine writers.
- Markdown as a canonical schema definition format.

## 4. Workspace and identity resolution

A workspace is the current Git root, discovered by walking upward from the process working directory using Git-native resolution.

The schema identity is derived from `remote.origin.url`. Resolution fails when the process is not inside a Git worktree or when no usable `origin` remote exists.

Remote normalization must map equivalent SSH and HTTPS remotes to the same identity. At minimum:

- Remove credentials and transport-specific syntax.
- Lowercase the host.
- Convert SCP-like SSH syntax (`git@host:path`) to `host/path`.
- Remove a trailing `.git` suffix.
- Remove redundant leading and trailing slashes.
- Reject empty paths and path segments `.` or `..`.
- Preserve repository path case unless a future host-specific rule explicitly states otherwise.

Examples:

- `git@github.com:acme/payments.git` → `github.com/acme/payments`
- `https://github.com/acme/payments.git` → `github.com/acme/payments`
- `ssh://git@gitlab.example.com/team/service` → `gitlab.example.com/team/service`

The normalized origin is authoritative. Changing `origin` intentionally resolves to a different database. The tool does not silently migrate or alias databases after an origin change.

## 5. Storage layout and database discovery

Databases are stored beneath a hard-coded platform application-data directory:

- macOS: `~/Library/Application Support/<tool>/databases`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/<tool>/databases`
- Windows: `%LOCALAPPDATA%\<tool>\databases`

The recommended mapping mirrors the normalized schema identity as nested directories, avoiding lossy filename escaping:

`<database-root>/<host>/<path-segments>.sqlite`

Example:

`github.com/acme/payments` → `<database-root>/github.com/acme/payments.sqlite`

All path segments must be validated before filesystem use. The path mapping is a storage encoding only; the database’s internal metadata remains authoritative for the exact schema identity.

The directory tree itself acts as the catalog. A global catalog database is not maintained. Commands that list databases enumerate candidate `.sqlite` files and read the metadata table from each. Unrecognized, unreadable, or incompatible files are reported without aborting the entire listing operation.

## 6. Database lifecycle

A database need not exist until the first mutating schema operation. Defining the first table or instantiating a template implicitly creates the database and initializes internal metadata.

Read-only inspection commands do not create files or directories beyond harmless application cache behavior. A failed first schema mutation must not leave a partially initialized database. Creation of metadata and the first physical schema change occurs in one transaction wherever SQLite permits.

The system distinguishes these states:

- No resolvable workspace.
- Workspace resolved, database absent.
- Database present and recognized.
- Database present but incompatible with the current tool.
- File present but not recognized as a tool-managed database.
- Database corrupt or unreadable.

## 7. Internal metadata model

Each managed database contains internal tables in a reserved namespace, such as `_tool_*`. User-defined objects may not use the reserved prefix.

The minimum internal model is:

### `_tool_meta`
Key-value or fixed-column metadata containing:

- Metadata format version.
- Tool/database format version.
- Normalized schema identity.
- Original origin URL observed at creation time.
- Creation timestamp.
- Last schema update timestamp.
- Template provenance, when applicable.

### `_tool_schema`
The authoritative canonical logical schema. It may be stored as normalized JSON in one row or decomposed across internal tables. The storage representation is private, versioned, and must support lossless reconstruction of:

- Tables and table comments.
- Columns, semantic types, nullability, defaults, and comments.
- Primary keys and foreign keys.
- Unique constraints, indexes, and checks.
- Table policies and their parameters.
- Template provenance.
- Logical schema revision number.

A compact canonical JSON document is recommended initially because it simplifies atomic replacement, validation, checksumming, and schema evolution of the metadata format.

### Authority rule
`_tool_schema` is authoritative. Physical SQLite tables and indexes are generated artifacts. Any mismatch is an integrity error; the tool must not silently infer missing semantic metadata from raw SQLite DDL.

## 8. Templates

Templates are stored globally in a flat directory of JSON files, one file per template:

`<app-data>/<tool>/templates/<template-name>.json`

The filename, without `.json`, is the authoritative template name. The JSON payload does not need a second independently mutable name field.

A template contains a complete logical schema definition suitable for instantiation into an empty local database. Instantiation copies the schema definition and records provenance. After instantiation, the local schema is independent.

There are no template upgrades, dependency resolution, live inheritance, remote registries, or automatic merges. Templates may be added, edited, copied, or removed directly as files. The CLI initially needs only list, show, and instantiate operations.

Template files must be validated fully before any database mutation.

## 9. Logical schema model

A logical schema contains an ordered collection of table definitions. Ordering is retained for deterministic inspection but has no semantic effect unless needed for dependency-aware DDL generation.

A table definition contains:

- `name`: SQLite-compatible identifier subject to reserved-name rules.
- `comment`: required human/agent description. The accompanying agent skill is responsible for teaching useful routing language.
- `columns`: zero or more user-defined columns. No universal user-visible column is required.
- `primary_key`: optional single- or multi-column key.
- `foreign_keys`: optional references with SQLite actions.
- `unique_constraints`: optional named or unnamed uniqueness rules.
- `indexes`: optional indexes, including SQLite partial indexes where supported.
- `checks`: optional SQLite check expressions.
- `policies`: optional tool-managed table behaviors.
- `strict`: whether the physical table uses SQLite `STRICT`; expected to default to true.
- `without_rowid`: optional SQLite table option where compatible.

A column definition contains:

- `name`.
- `type`: semantic type identifier.
- `nullable`.
- `default`: absent, literal, or explicitly supported SQLite expression.
- `comment`: required by the agent workflow, though enforcement policy may be configurable later.
- Optional collation.
- Optional generated-column expression and storage mode.
- Optional per-column policy parameters where a table policy requires them.

The system must validate dependencies among features before generating DDL. For example, a timestamp policy cannot target a nonexistent or incompatible column.

## 10. Semantic type system

Semantic types are a central feature. They refine a small SQLite storage class with validation, canonicalization, display behavior, and optional query helpers.

The proposed syntax is `storage/semantic`, such as `text/uuid`, `text/datetime`, or `integer/boolean`. Bare SQLite-oriented types such as `text`, `integer`, `real`, and `blob` remain valid.

A semantic type definition specifies:

1. **SQLite storage representation.** The physical type used in a `STRICT` table.
2. **Accepted input forms.** Which JSON values or strings may be supplied.
3. **Canonical stored form.** The normalized representation written to SQLite.
4. **Validation behavior.** Deterministic rejection rules.
5. **Markdown rendering.** How values are displayed and escaped.
6. **Comparison and ordering semantics.** Whether SQLite’s native ordering is meaningful.
7. **Index suitability.** Whether ordinary indexes preserve expected semantics.
8. **Optional generated constraints.** Checks emitted to enforce representation even for writes outside the CLI.
9. **Optional query operators or helper functions.** SQLite-specific operations exposed by the tool.
10. **Versioning.** Semantic behavior changes require explicit type-version compatibility rules.

The semantic type system is intentionally extensible, but every built-in type must have a precise contract. A type must not be added merely because its name sounds useful.

### Initial storage families

- `text`
- `integer`
- `real`
- `blob`
- optionally `any` only if SQLite `STRICT` behavior and use cases justify it

### High-value semantic types

#### Identity and identifiers
- `text/uuid`: canonical lowercase RFC 4122-style hyphenated representation; validation and optional generation policy.
- `text/ulid`: canonical uppercase or lowercase representation chosen once; lexical time ordering documented.
- `text/slug`: normalized rules must be explicit; likely validation-only by default to avoid destructive normalization.
- `text/git-oid`: optionally parameterized by algorithm or length.

#### Time
- `text/date`: canonical ISO 8601 calendar date (`YYYY-MM-DD`).
- `text/time`: canonical time with clearly defined precision and timezone allowance.
- `text/datetime`: canonical RFC 3339 timestamp; timezone required; UTC normalization policy explicitly chosen.
- `integer/unix-seconds` and `integer/unix-milliseconds`: integer epochs with defined range.
- `integer/duration-ms` or `text/duration`: precise duration contract; avoid ambiguous calendar durations unless separately modeled.

#### Structured text
- `text/json`: valid JSON stored in canonical compact form; JSON scalar/object/array restrictions may be parameterized.
- `text/markdown`: text with semantic rendering only; no claim of sanitization.
- `text/html`: text with explicit trust/sanitization metadata if ever rendered outside the CLI.
- `text/yaml`: validation requires a chosen parser/version and should be deferred unless needed.

#### Network and resource identifiers
- `text/url`: parser and normalization behavior must be conservative and documented.
- `text/uri`: broader than URL, with a distinct contract.
- `text/email`: syntax validation only; no claim that the mailbox exists.
- `text/ip`: canonical IPv4 or IPv6 representation.
- `text/cidr`: canonical network prefix.
- `integer/port`: range 0–65535 or 1–65535, parameterized if needed.
- `text/hostname`: DNS-style validation with explicit Unicode/IDNA handling.

#### Filesystem and source control
- `text/path`: validation-only by default; optional variants such as `text/path-posix` and `text/path-relative` are preferable to hidden host-dependent behavior.
- `text/git-ref`: validation based on Git ref naming rules.
- `text/semver`: canonical semantic version contract, with ordering limitations documented because lexical order is insufficient.

#### Numeric domains
- `integer/boolean`: canonical 0 or 1 with generated check.
- `integer/positive`, `integer/nonnegative`.
- `real/percentage`: define whether stored range is 0–1 or 0–100.
- `integer/money-minor`: requires an associated currency column or parameter; avoids floating-point storage.
- `text/decimal`: canonical decimal string with parameterized precision and scale when exact arithmetic is required.

#### Encoded and content-addressed values
- `text/base64`, `text/hex`.
- `text/sha256`, `text/sha512`.
- `blob/bytes`: raw bytes.

#### Enumerations and constrained values
A parameterized enum may use a semantic expression such as `text/enum` with an allowed-values list in the column definition. The implementation should generate an SQLite `CHECK` constraint.

### Extension model
The first release may ship built-ins only. Future user-defined semantic types should not execute arbitrary code by default. A safe extension can be declarative: storage type, regular expression or SQLite check, canonicalization mode from a fixed library, and rendering hints.

## 11. Table policies

Table policies are opt-in, tool-managed behaviors that would otherwise require repetitive schema definitions, triggers, write coordination, or conventions. They are another central feature and may grow substantially.

A policy must define:

- Preconditions on the table schema.
- Physical objects it generates, such as columns, indexes, checks, or triggers.
- Write-time behavior performed by the CLI.
- Behavior for direct external SQLite writes.
- Interaction with raw SQL reads.
- Interaction and incompatibilities with other policies.
- How the policy is represented in logical schema metadata.
- Whether disabling the policy is destructive.

Policies should be concrete and named, not a generic arbitrary hook system.

### Candidate policies

#### Generated identity
Creates or manages an identifier column.

Parameters may include:
- Target column.
- Strategy: integer row ID, UUID, ULID, random token.
- Client-generated versus SQLite-generated.
- Mutability rules.

#### Timestamps
Manages creation and/or update timestamps.

Parameters may include:
- Created column.
- Updated column.
- Semantic type.
- UTC normalization.
- Whether triggers enforce behavior for external writes.

#### Optimistic revision
Maintains an integer revision column and supports compare-and-swap updates.

Parameters:
- Revision column.
- Initial value.
- Increment behavior.
- Whether updates require an expected revision through the CLI.

#### Immutable rows
Prevents updates and optionally deletes after insertion. Enforcement should use triggers if external writes must obey it.

#### Immutable columns
Prevents changes to selected fields after insertion.

#### Append-only
Allows inserts but rejects updates and deletes. Useful for logs and ledgers, without claiming tamper-proof auditing.

#### Touch-on-write
Updates one or more fields whenever a row changes. This may generalize timestamps while retaining explicit configuration.

#### Ownership or actor stamping
Populates a configured column from invocation context. This should be deferred until actor identity has a trustworthy definition.

#### Content hash
Computes or verifies a hash over selected columns. Useful for deduplication or change detection; precise canonical serialization is required.

#### Natural-key upsert
Declares a conflict target and allowed update behavior for idempotent agent writes.

#### Retention guard
Blocks deletion until a condition is met. It is not a scheduler and does not automatically purge rows.

#### State machine
Restricts transitions of an enum-like status column. This is high-value but must be modeled declaratively and compiled to triggers or enforced by the CLI plus triggers.

#### Parent-child integrity helpers
Policies such as ordered children, single-active-row, or polymorphic reference validation may be added only when they have clear SQLite enforcement semantics.

### Policy implementation rule
Where feasible, policies should generate SQLite constraints or triggers so their invariants survive direct writes outside the CLI. If a policy is enforced only by the CLI, inspection output must state that limitation.

## 12. Constraints, checks, indexes, and SQLite exposure

The tool directly exposes SQLite concepts rather than inventing a portable constraint language.

### Checks
A check definition contains an optional name, a required SQLite expression, and an optional comment. The caller supplies only the expression, not surrounding DDL. The tool owns quoting and emits `CHECK (<expression>)` or a named table constraint.

Checks are validated by compiling the proposed schema in an in-memory or temporary SQLite database before mutating the target. SQLite’s check semantics, including the treatment of `NULL`, are part of the public contract.

### Indexes
Indexes may specify:

- Name or generated name.
- Ordered column/expression list.
- Sort direction.
- Collation.
- Uniqueness.
- Partial-index `WHERE` expression.

Expression indexes are allowed because the system is SQLite-specific, but the tool must validate them through SQLite before applying them.

### Foreign keys
Foreign keys expose SQLite actions (`NO ACTION`, `RESTRICT`, `SET NULL`, `SET DEFAULT`, `CASCADE`) and deferrability where supported. Foreign key enforcement must be enabled on every managed connection.

### Defaults and generated columns
Literal defaults are preferred. SQLite expressions may be allowed from a documented safe subset or accepted directly and validated by SQLite. Generated columns expose SQLite expressions and `VIRTUAL` or `STORED` mode where supported.

The tool never accepts an arbitrary block of table DDL as a schema definition. It accepts structured schema objects containing SQLite expressions in designated fields.

## 13. Physical schema generation and migration

User tables should default to SQLite `STRICT` mode. Semantic types compile to a physical storage type plus generated checks, indexes, and policy artifacts.

Every schema mutation follows this sequence:

1. Parse and validate JSON input.
2. Validate logical identifiers, types, dependencies, and policy compatibility.
3. Construct the complete proposed logical schema.
4. Compile the proposed physical schema in an in-memory or temporary SQLite database.
5. Determine a SQLite-specific migration plan.
6. Apply the migration and update authoritative metadata in a transaction where possible.
7. Reinspect physical objects and verify they match the compiled expectation.
8. Increment the logical schema revision.

The first release may support a deliberately narrow set of alterations. Unsupported alterations must fail clearly rather than attempting unsafe inference. SQLite table rebuilds may be used where necessary, but there is no rollback promise and no automatic backup.

Destructive operations should require explicit command intent. Since agents are the only users, confirmation prompts are unnecessary; the operation must instead be unambiguous in the command or input payload.

## 14. Row input and mutation semantics

Row writes use JSON input. JSON is permitted for input and as stored data; only JSON output is excluded.

Examples of mutation operations:

- Insert one row.
- Insert multiple rows.
- Update by primary key or explicit predicate supported by the command.
- Delete by primary key.
- Upsert when a declared key or policy provides unambiguous conflict semantics.

Input values are processed through the semantic type pipeline:

1. Confirm JSON value kind is accepted.
2. Parse according to the semantic type.
3. Validate constraints.
4. Canonicalize.
5. Bind to SQLite using parameters.

Unknown fields are rejected by default. Missing fields follow nullability and default semantics. The tool must distinguish an omitted field from an explicit JSON `null`.

All writes use prepared statements and transactions. Multi-row writes are atomic by default unless a future command explicitly offers partial success.

Policies may add write requirements, such as an expected revision, idempotency key, or immutable-column checks.

## 15. Read operations and raw SQL

Ordinary reads include table inspection, row retrieval, row listing, and schema inspection. Results are rendered as deterministic Markdown.

Raw SQL reads are a first-class feature. The tool opens the database through a read-only SQLite connection rather than attempting to classify SQL by string inspection. Multiple mutating statements are therefore blocked by connection mode and authorizer/defensive settings where available.

The SQL command may support any query SQLite permits on that read-only connection, including joins, CTEs, aggregates, window functions, JSON functions, and safe pragmas. Result-set rendering must handle duplicate or unnamed columns by assigning deterministic display labels without changing query execution.

Raw SQL has no mutation mode in the initial release.

## 16. Markdown output contract

All user-visible command results are deterministic Markdown. The product does not promise that every value appears in a table; prose, headings, fenced SQL, and definition sections are permitted when they are the natural representation. Tabular result sets are emitted as GitHub-Flavored Markdown tables.

The contract includes:

- UTF-8 output.
- Stable headings and column labels for a given command version.
- Deterministic row and field ordering where the command defines ordering.
- `NULL` for SQL null.
- `true` and `false` for semantic booleans.
- Canonical semantic rendering for dates, times, identifiers, and JSON.
- Escaped pipes in table cells.
- Line breaks represented consistently, such as `<br>` in cells.
- Large text values may be truncated only when the command explicitly documents the limit and indicates truncation.
- Binary values are summarized, never dumped raw into terminal output.
- Diagnostics and errors go to stderr and also use deterministic Markdown where practical.
- Machine-significant success or failure is communicated by exit status, not prose parsing.

No `--json` or general output-format flag is provided.

## 17. CLI surface

The initial command surface should remain small. Exact naming may change, but the conceptual operations are:

### Workspace
- `tool status`

### Templates
- `tool template list`
- `tool template show <name>`
- `tool schema instantiate <template>`

### Schema
- `tool schema show`
- `tool schema export`

### Tables
- `tool table list`
- `tool table show <table>`
- `tool table create`
- `tool table alter <table>`
- `tool table drop <table>`

### Rows
- `tool row add <table>`
- `tool row get <table> <key>`
- `tool row list <table>`
- `tool row update <table> <key>`
- `tool row delete <table> <key>`
- optional `tool row upsert <table>` when semantics are declared

### SQL
- `tool sql <query>` or query via stdin

Rich definitions and row writes accept JSON through stdin or a file argument. Inspection and query results remain Markdown.

## 18. JSON input contracts

JSON request formats are versioned logical API contracts. They should be strict, reject unknown keys by default, and produce field-addressed validation errors.

A table-creation request conceptually contains:

- Table name and comment.
- Column definitions.
- Primary key.
- Foreign keys.
- Checks.
- Unique constraints.
- Indexes.
- Policies.
- SQLite table options.

A row-write request is either a single JSON object or, for bulk commands, an array or newline-delimited mode explicitly selected by the command. The initial release should prefer a single object or array to avoid introducing another protocol prematurely.

JSON schema documents for CLI input should be published with the agent skill so agents can construct valid requests without trial and error.

## 19. Validation and error behavior

Validation is layered:

1. Command and JSON shape validation.
2. Identifier and reserved-name validation.
3. Logical schema validation.
4. Semantic type and policy validation.
5. SQLite compilation validation.
6. Existing-data compatibility validation for alterations.
7. Transactional application.
8. Post-application verification.

Errors should identify the logical path and the failing rule. Example Markdown:

| Path | Code | Message |
|---|---|---|
| `columns[2].type` | `unknown_semantic_type` | `text/foobar` is not registered. |
| `checks[0].expression` | `sqlite_error` | no such column: accepted_at |

Recommended exit-code categories:

- `0`: success.
- `2`: invalid command or input shape.
- `3`: Git workspace or origin resolution failure.
- `4`: database or schema absent.
- `5`: table or row not found.
- `6`: schema or semantic validation failure.
- `7`: SQLite constraint violation.
- `8`: optimistic revision conflict.
- `9`: storage or I/O failure.
- `10`: schema migration failure or metadata/physical mismatch.

Exact numeric assignments are less important than stability once published.

## 20. Connection and SQLite settings

Every managed connection must explicitly configure SQLite rather than relying on process defaults.

At minimum:

- Enable foreign key enforcement.
- Set a busy timeout appropriate for local agent invocations.
- Use transactions for all multi-step writes.
- Use read-only URI mode for raw SQL reads.
- Consider `trusted_schema=OFF` and defensive configuration where compatible with required features.
- Record the SQLite library version in diagnostic output because checks, generated columns, strict tables, and functions may be version-dependent.

Journal mode should be chosen for local single-machine reliability. WAL may be appropriate, but the choice should be tested against the hard-coded local storage model and documented. The tool does not support active databases on network or cloud-sync filesystems.

## 21. Concurrency model

The initial model is multiple local processes against one SQLite database, relying on SQLite locking and a configured busy timeout. There is no distributed concurrency model.

Table policies may provide optimistic revision checks for rows that need compare-and-swap semantics. Commands without such a policy follow ordinary SQLite transaction behavior.

Long-lived daemon connections are outside the initial design. Each CLI invocation should open, use, and close connections predictably.

## 22. Security and trust boundaries

The tool is local and does not provide user authentication or authorization. Anyone who can modify the SQLite file can bypass CLI-level validation unless an invariant is also represented by SQLite constraints or triggers.

Template JSON, schema JSON, check expressions, generated-column expressions, index expressions, and raw SQL queries are treated as code-like input. They must be parsed and validated, and all data values must be parameter-bound.

Table comments and other descriptive metadata are guidance for agents, not authorization policy.

The tool should never describe its internal history, hashes, or policy tables as tamper-proof auditing.

## 23. Schema inspection

`schema show`, `table show`, and `schema export` render the logical schema, not merely SQLite introspection.

Inspection should show:

- Schema identity and physical database path.
- Metadata format and schema revision.
- Template provenance.
- Tables and comments.
- Columns with semantic and physical types.
- Nullability, defaults, keys, and references.
- Checks and indexes, including their SQLite expressions.
- Enabled policies, parameters, and enforcement level.
- Generated physical artifacts when useful for debugging.

A verbose inspection mode may include compiled SQLite DDL, but a general format-selection flag is unnecessary.

## 24. Compatibility and versioning

Three versions should be tracked independently:

1. CLI/tool version.
2. Internal database metadata format version.
3. Semantic type and policy registry version.

A newer tool may migrate internal metadata forward when the migration is lossless and supported. An older tool encountering a newer incompatible database must fail without mutation.

Semantic type behavior must not change silently. If canonicalization or validation rules materially change, the type contract requires a versioned migration or compatibility mode because existing stored values and indexes may depend on the prior behavior.

## 25. Initial implementation scope

A pragmatic first release should include:

- Git root and `origin` normalization.
- Hard-coded application-data storage.
- Directory-based database discovery.
- Internal metadata and canonical logical schema.
- Flat JSON template directory.
- Template list, show, and instantiate.
- SQLite `STRICT` tables.
- Table create, inspect, limited alter, and drop.
- Columns, primary keys, foreign keys, uniqueness, checks, indexes, defaults, and generated columns.
- JSON row insert, get, list, update, and delete.
- Read-only raw SQL.
- Deterministic Markdown output.
- A focused initial semantic type library.
- A focused initial policy library: generated identity, timestamps, optimistic revision, immutable rows/columns, append-only, and natural-key upsert.

Features should be added only when their exact SQLite enforcement and metadata representation are understood.

## 26. Resolved design decisions

The initial implementation uses the following decisions:

- The tool is named **Silo** and reserves `_silo_` case-insensitively as the prefix for all internal SQLite objects, including tables, indexes, and triggers.
- `text/datetime` accepts RFC 3339 offsets but canonicalizes stored values to UTC using `Z`, preserving an original timezone or offset only when the schema defines a separate domain-specific column for it.
- Exact decimals use canonical signed `TEXT` with required `precision` and `scale` options. Exponent notation is rejected, and stored values contain exactly the configured number of fractional digits. The initial release provides validation and rendering but does not claim numerically correct native SQLite ordering, indexing, arithmetic, or aggregation; those operations must be deferred until exact query semantics are available.
- Semantic type identifiers remain stable strings. Parameters are supplied through a separate `type_options` object rather than an inline type-expression grammar. For example: `"type": "text/decimal", "type_options": {"precision": 12, "scale": 2}`.
- Durable invariants are enforced in SQLite whenever SQLite can express them deterministically, preferring constraints and then triggers. CLI-only enforcement is limited to invocation-context behavior, canonicalization unavailable in stock SQLite, and enhanced conflict handling. Inspection labels each policy's enforcement as `constraint`, `trigger`, `cli`, or a combination.
- UUIDs and ULIDs are generated by the CLI. Integer identities use native SQLite `INTEGER PRIMARY KEY` behavior. Schemas do not depend on custom SQLite functions for defaults or triggers because external clients may not register them. Generated values receive SQLite validation constraints where practical.
- Databases use WAL journal mode with a 5-second busy timeout and `synchronous=NORMAL`. Initialization sets and verifies persistent WAL mode. Diagnostics report failure to establish these settings; the initial release does not expose general connection-setting configuration.
- The minimum supported SQLite version is 3.37.0, the first version with `STRICT` tables. Startup also probes required capabilities rather than trusting the version string alone. Adopting a feature introduced after 3.37.0 requires raising and documenting the minimum version.
- The initial alter surface is deliberately additive: add tables, add indexes or unique indexes, and add nullable columns or columns with compatible constant defaults. Table and column renames are supported only when Silo can safely update metadata and every dependent expression. Drops, type changes, nullability tightening, key changes, checks, generated-column changes, policy changes, and table rebuilds are unsupported in the initial release.
- The core CLI mechanically requires non-empty comments on user tables and columns so templates and non-agent callers obey the same contract. It does not silently synthesize comments or accept placeholders as a special case.
- Schema export emits only the canonical logical schema by default. Compiled DDL is diagnostic, non-authoritative output available through an explicit `schema ddl` command or verbose inspection option.

## 27. Summary

The system is a small, Git-scoped, SQLite-native database CLI for agents. It stores one authoritative logical schema inside each per-origin SQLite database, accepts JSON for definitions and writes, and returns deterministic Markdown. Its distinguishing depth comes from a rich semantic type system and opt-in table policies, both of which compile to understandable SQLite storage, constraints, indexes, and triggers wherever possible.

The design intentionally avoids a global catalog, configurable storage, Markdown schemas, template lifecycle management, raw SQL mutations, backups, rollback, audit history, synchronization, and multi-schema workspaces. This keeps the core small while leaving substantial room for domain-aware validation and reliable agent behavior.
