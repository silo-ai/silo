# Agent Instructions

You are an expert engineering agent working in this repository.

## Code style rules

Optimize code for locality, onboarding, and long-term maintainability. A future agent or developer should be able to understand and safely change behavior by reading the fewest files possible.

## Prefer locality

Related behavior should live close together. Most changes should require reading one cohesive area of the codebase, not searching through many tiny helpers, framework hooks, distant configuration files, or unrelated utilities.

Prefer code organization that lets a reader quickly answer:

* What entity, product concept, or workflow owns this behavior?
* Where is the relevant state?
* Where is the relevant logic?
* What invariants must be preserved?
* What needs to change if this behavior changes?

## Modularize around durable concepts

Create module boundaries around stable entities, product concepts, persistent resources, external integrations, protocol/API boundaries, and workflows with durable meaning.

Do not split code into tiny files, helpers, hooks, or abstractions merely because a block can be named. Be skeptical of standalone files such as `formatThing.ts`, `getThingLabel.ts`, `handleThingClick.ts`, `useThingState.ts`, `thingHelpers.ts`, and `utils.ts`.

These are acceptable only when they clearly reduce maintenance burden, represent a real boundary, or avoid risky duplication.

## Inline implementation details by default

Prefer readable local flow over unnecessary indirection. Extract functions, hooks, classes, helpers, or modules only when the extraction pays for itself.

Good reasons to extract include:

* eliminating duplicated logic that is likely to diverge
* isolating complex logic that materially distracts from the caller
* enabling focused tests for correctness-sensitive behavior
* establishing a durable entity, domain, lifecycle, persistence, protocol, or integration boundary
* making critical invariants easier to enforce
* reducing a proven maintenance burden

Otherwise, keep implementation details local and explicit. A little duplication is often better than the wrong abstraction.

Avoid micro-abstractions that hide simple logic, fragment one cohesive operation, obscure data flow or error handling, or force readers to jump elsewhere for one or two lines of behavior.

## Prefer explicit code over hidden behavior

Behavior should be visible in ordinary source files through explicit imports, direct calls, plain functions, ordinary data structures, visible control flow, explicit dependencies, and local state where practical.

Avoid hidden coupling such as global registration, reflection, decorators that obscure behavior, monkey-patching, implicit dependency injection, ambient mutable state, global singletons, naming-convention dispatch, stringly-dispatched behavior, distant configuration that changes local behavior, or code generation that obscures source-level behavior.

The goal is code whose behavior can be understood by reading near the change.

## Comment for purpose, rationale, and invariants

Comments should preserve context that is not obvious from the code itself. Use comments to explain why code exists, what it protects, and what would break if it changed.

Comment especially carefully around persistence, migrations, concurrency, synchronization, security, permissions, billing, data loss prevention, correctness-sensitive domain logic, retries, caching, state machines, external protocols, API compatibility, destructive operations, error recovery, and cross-process or cross-service coordination.

Do not use comments to paraphrase syntax. Use them to capture purpose, rationale, tradeoffs, edge cases, failure modes, invariants, product requirements, and historical context.

Names should identify things. Comments should explain non-obvious meaning and intent. Avoid extremely long names that try to encode every edge case or rationale.

## Optimize for future changes

Before introducing a new abstraction, ask:

* Will this reduce the number of places a future change must inspect?
* Does this represent a durable entity, product concept, protocol, or lifecycle?
* Does this eliminate risky duplication?
* Does this make a critical invariant easier to preserve?
* Does this make behavior easier to test or reason about?
* Is the indirection worth the loss of locality?

When the answer is unclear, prefer locality, explicitness, and inline code.

## API snapshots

API snapshot updates must be treated as review-sensitive changes.

If API snapshot tests fail, first inspect the diff and determine whether the API drift is intentional. Do not update snapshots just to make tests pass.

Only run:

```sh
pnpm tsnapi -u
```

when you are certain the API change is expected and should become the new committed contract.

If the API drift is accidental, fix the source change instead of updating the snapshot. If intent is unclear, leave the snapshot unchanged and explain the uncertainty.
