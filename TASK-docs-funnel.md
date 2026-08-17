# Task: Reshape the Silo documentation funnel

## Goal

Rewrite the opening Silo docs so a skeptical, technically capable reader can decide whether Silo is useful without reading the internals.

The reader should get:

1. a clear reason to care;
2. a small working proof;
3. a plain explanation of the important boundaries; and
4. only then, links to the workflow or reference they actually need.

Do not make the reader walk through every document or learn Silo's internal vocabulary before seeing a result.

## Reader

Assume a developer or agent who knows a shell, Git, and basic tables, but does not know Silo. They will ask:

- Why use this instead of a file, plain SQLite, or Git?
- Where does the data live?
- What stops a bad write?
- How does sharing work, and what does it cost?

Write for a capable non-specialist. Use ordinary words.

## Read before editing

Read these files completely:

- `AGENTS.md`
- `.agents/docs.md`
- `.agents/skills/lildocs/SKILL.md`
- `docs/index.md`
- `docs/getting-started.md`
- `docs/concepts/how-silo-works.md`
- `docs/guides/design-a-schema.md`

Inspect the CLI help or source before changing any command example. Do not infer syntax from a nearby command.

Do not overwrite the existing root `TASK.md`; it describes a separate task.

## Current situation

The docs already contain the needed material, but the path is not focused enough:

- `docs/index.md` is a useful router, but it presents too many links and gives the two opening pages equal weight.
- `docs/getting-started.md` has a good local happy path, but it jumps quickly from installation to JSON. It does not show a representative result or a rejected write, and its `<id>` example is not safe to paste literally.
- `docs/concepts/how-silo-works.md` is the canonical mental model, but it also introduces deep implementation details such as detached identities, journals, outboxes, relations, checkpoints, and rebasing.
- The deeper guides and references should remain available as branches rather than becoming required reading.

## Intended funnel

### 1. `docs/index.md`: orient the reader in 30 seconds

Keep this page short. Explain, in plain language:

- Silo keeps a repository's active SQLite database on the local machine.
- A logical schema says what the data means and what values are allowed.
- Silo commands perform writes; SQL and saved queries read data.
- Sharing is optional and happens through explicit `push` and `pull` operations.

Give `docs/getting-started.md` the primary call to action. Keep `how-silo-works.md` as the secondary choice for readers who want the model first. The rest of the page can route to task guides and references, but should not compete with the main path.

The opening should answer why this is useful, not merely define Silo. Include the main tradeoffs: the database is not stored in the repository, sharing is not live replication, and Silo is not a user-facing audit history.

### 2. `docs/getting-started.md`: prove the core in about five minutes

Keep one complete `issues` example:

1. check the workspace;
2. create the table;
3. add one row;
4. show or describe the actual output;
5. read it back with a key and with a list;
6. run one read-only SQL query.

Add one small, verified example of a rejected mutation so the reader sees schema enforcement. Keep the failure example understandable and explain what the reader should observe.

Make every shell example honest:

- do not present bare `<placeholder>` tokens as pasteable commands;
- either use a shell variable or clearly say what value to substitute;
- show the next verification step after a command;
- keep the schema and row examples consistent.

End with the next decision rather than a long catalog: read `how-silo-works.md` to understand the boundaries, or continue to `design-a-schema.md` to model real repository state. Mention saved queries, reports, and synchronization as optional next branches without explaining them here.

### 3. `docs/concepts/how-silo-works.md`: explain why the proof is trustworthy

Shorten this page into a second five-minute read. Keep one focused diagram at most. It should explain only these four ideas:

1. the Git repository selects a local database, which stays outside the repository;
2. the logical schema is the contract and generated SQLite objects enforce it;
3. Silo commands are the write boundary while SQL and saved-query execution are read-only;
4. `pull` and `push` exchange published database state explicitly, and conflicting work is stopped rather than silently overwritten.

Keep a short "What Silo does not do" section because clear limits build trust.

Move or sharply reduce details about `.git/silo.json` internals, detached-database moves, semantic relation derivation, mutation journals, synchronization outboxes, checkpoint internals, and schema conflict mechanics. Link to the owning concept or guide when a reader needs those details. Do not duplicate their full explanations here.

End by sending the reader to `design-a-schema.md` for adoption, with optional links to saved queries, reports, and synchronization.

### 4. First adoption and optional branches

Use this order after the spine:

- `guides/design-a-schema.md` for modeling a real durable entity;
- `guides/work-with-rows.md` for ordinary row operations;
- `guides/run-saved-queries.md` and then `guides/publish-a-report.md` for reusable reads and human-facing output;
- `guides/synchronize.md` for multiple machines;
- `concepts/synchronization.md`, `concepts/workspace-and-schema.md`, references, and troubleshooting only when the reader needs guarantees or lookup details.

Do not put `mutation-journal`, `atomic-transactions`, relations, policies, semantic types, templates, or troubleshooting on the required beginner path.

## Writing rules

Follow the writing guidance in `AGENTS.md`:

- Start with the reader's problem or question, not a product slogan.
- Use plain, everyday words. Do not try to sound elegant, clever, or intelligent.
- Avoid poetic, promotional, abstract, or mechanical wording.
- Put evidence after important claims: a command, result, or clear verification step.
- Put limits, costs, and failure cases beside the benefit they qualify.
- Keep the `issues` example consistent across the opening path.
- Tell the reader what to read next and what they can skip.
- Do not pile up concepts or jargon before they are needed.
- Prefer a direct sentence to polished symmetry or a memorable slogan.

For example, prefer:

> Silo keeps the active database on your machine. `push` and `pull` are the steps that share it.

over:

> Silo provides local-first checkpoint exchange across repository workspaces.

## Scope

In scope:

- revise `docs/index.md`, `docs/getting-started.md`, and `docs/concepts/how-silo-works.md`;
- adjust links and nearby guide introductions so the new sequence is clear;
- add only the examples and short explanations needed to prove the core workflow;
- remove or defer introductory detail that belongs in deeper pages.

Out of scope:

- changing Silo behavior, CLI syntax, schema contracts, or synchronization semantics;
- rewriting every guide or reference page;
- adding marketing copy, a new documentation framework, or decorative diagrams;
- replacing the existing `TASK.md`;
- updating API snapshots.

## Acceptance criteria

- A new reader can understand what Silo is for, where its database lives, and how sharing works from `docs/index.md` and the first screenful of the getting-started page.
- The main path is visibly `index → getting started → how Silo works → design a schema`.
- The getting-started workflow is complete, internally consistent, and uses valid shell commands.
- The getting-started page shows at least one observable successful result and one observable schema-enforced failure.
- `how-silo-works.md` explains the four core boundaries without requiring the reader to understand journal, outbox, identity-migration, or checkpoint internals.
- Advanced material remains discoverable through links but is not presented as required reading.
- No canonical concept is redefined in competing detail on the opening pages.
- Changed links, headings, code blocks, and Mermaid diagrams work in the generated site.

Run these checks before finishing:

```sh
git diff --check
pnpm exec oxfmt --check docs
pnpm docs:build
```

Review the generated site, then report any command or product claim that could not be verified rather than guessing.

## Commit plan

Create one local commit:

```text
docs: reshape the reader funnel
```
