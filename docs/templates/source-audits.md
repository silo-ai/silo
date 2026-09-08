# Source Audit Template

> Track package source reviews across sessions without losing coverage or earlier assessments.

Use `source-audit` to record source discovery, evidence-backed findings, and
recommendations. It does not run an audit, install `scc`, or authorize changes to
the audited source. An audit is not security certification or a claim of
exhaustive correctness. Keep findings and coverage in Silo; do not maintain a
second Markdown findings file.

## Import and inspect

From the Git worktree that owns the audit:

```sh
silo context
silo template show source-audit
silo schema import source-audit
silo context
silo report list
```

If Silo cannot resolve the repository, fix that blocker before starting; do not
substitute a Markdown tracker. Import creates the local database if needed and
atomically installs three tables, four relations, six saved queries, three
reports, and instructions attributed to `template:source-audit`.

Existing table names, query names, or report slugs cause an import to fail
without overwriting data. Reimport is not an update mechanism. Updating Silo
does not change an already imported template. See [Design a schema](../guides/design-a-schema.md#reuse-an-existing-workflow)
for template behavior.

## Records and history

| Table                       | One row represents                                  | Read it for                                                                    |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `source_audit_runs`         | One package, source state, and audit scope          | Source revision, coverage inventory, scan evidence, exclusions, remaining work |
| `source_audit_findings`     | One distinct issue with a stable UUID across passes | The latest assessment and first/last run references                            |
| `source_audit_observations` | One assessment of one finding in one run            | The evidence, ratings, and recommendation actually recorded in that run        |

All three tables manage creation/update instants and optimistic revisions.
Runs and findings generate UUIDs. Composite foreign keys prevent a finding or
observation from referencing another package's run. Observations use
`run_id` plus `finding_id` as their key. No upsert policy is declared.

The observation table preserves run membership and assessment details when a
finding is later rechecked. `last_checked_run_id` alone cannot do that. Missing
an observation means no evaluation was recorded, not that an issue was fixed.
There is no mandatory resolution workflow. Later reassessments belong in
notes, with their evidence and uncertainty.

Keep earlier runs and observations. Reconcile interrupted writes between a
finding and its observation before completing a run. The database enforces
keys, types, enum values, top-level JSON arrays, immutable identity fields, and
revision checks. Agents enforce JSON item shapes, deduplication, snapshot
consistency, historical preservation, and completion criteria.

## Start or resume a run

First inspect earlier work for the exact package (`.` means repository root):

```sh
silo query source-audit-runs --package .
silo table show source_audit_runs
```

Resume only when package, scope, commit, and relevant dirty source state match.
Read the run and revisit its outstanding work. A changed source state needs a
new run and renewed review of affected coverage. Record relevant untracked
source and dirty differences without copying secrets.

For a new root-package audit, save `run.json` with this shape. Replace the
example commit with the full lowercase output of `git rev-parse HEAD`; both
40-character SHA-1 and 64-character SHA-256 object IDs are accepted. Set dirty
state and notes from the actual inspected worktree.

```json
{
  "package_path": ".",
  "commit_sha": "1111111111111111111111111111111111111111",
  "worktree_dirty": false,
  "scope": "src implementation, package entry points, and all exported APIs",
  "exclusions": "Generated files in dist; inspect their source instead"
}
```

```sh
silo row add source_audit_runs --file run.json
```

The returned row contains the generated `run_id`, timestamps, revision `1`,
status `in_progress`, and empty coverage/remaining-work arrays. Empty arrays do
not establish completion. Keep its ID for subsequent commands:

```sh
# Replace this example UUID with the run_id returned by Silo.
run_id='11111111-1111-4111-8111-111111111111'
silo row get source_audit_runs "$run_id"
```

Before in-depth manual review, scan actual source with `scc --by-file` and
machine-readable output. Adapt this example to installed flags and source
paths; use a separate artifact per run if earlier scan evidence must remain:

```sh
mkdir -p .audit
scc src --by-file --sort complexity --format csv \
  --include-ext ts,tsx,mts,cts,js,jsx --no-min-gen --no-duplicates \
  > ".audit/scc-$run_id.csv"
```

Record the exact executed command, repository-relative artifact, metrics, and
review priorities on the run. If the scan fails, retain the attempted command,
leave `scan_artifact` null, and record the failure in `remaining_work`. Never
invent metrics. CSV supports the audit; Silo owns findings and coverage.

## Record coverage incrementally

Inventory the intended source areas and exported APIs before claiming
coverage. Each review unit has independent implementation and API/TSDoc states:

| State                    | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `unreviewed`             | Check has not started; missing states are read this way too      |
| `partial`                | Some meaningful checks remain                                    |
| `reviewed_no_findings`   | Checked with no findings                                         |
| `reviewed_with_findings` | Checked and findings recorded                                    |
| `excluded`               | Intentionally not checked; record the reason                     |
| `not_applicable`         | API dimension only: no exported API to review; record the reason |

Save a patch such as `coverage-update.json`. This example records a completed
implementation review with API documentation still partly unchecked:

```json
{
  "_expected_revision": 1,
  "coverage": [
    {
      "unit_id": "src/read.ts:read",
      "file_path": "src/read.ts",
      "implementation": "reviewed_no_findings",
      "api": "partial",
      "checks_performed": [
        {
          "kind": "implementation",
          "check": "Read implementation, callers, and error-path tests",
          "result": "No finding supported by the inspected scenarios"
        }
      ],
      "remaining_checks": ["Check exported read error documentation"],
      "priority": "high",
      "reason": "Public entry point used on every load"
    }
  ],
  "remaining_work": [
    {
      "kind": "lead",
      "text": "Compare documented errors with caller-visible failures",
      "file_path": "src/read.ts"
    }
  ]
}
```

```sh
silo row update source_audit_runs "$run_id" --file coverage-update.json
silo query source-audit-next-review --package . --run "$run_id"
```

Use the current revision and preserve other inventoried units: an array update
replaces the entire column. On a revision conflict, reread and reconcile.
Unit IDs must be unique within a run. `checks_performed` items use `kind`,
`check`, and `result`; `remaining_checks` is an array of strings. `reason` is
nullable except when explaining exclusions or a non-applicable API check.

`remaining_work` items have `kind` (`lead`, `blocker`, or `area`), `text`, and
nullable `file_path`. Unsupported evidence leads stay here rather than becoming
findings. `complexity_hotspots` items have `file_path`, nullable numeric
`complexity` and `lines`, `priority` (`high`, `medium`, `low`), and nullable
`reason`. Null metrics mean unknown, not zero. Empty scan arrays mean no metrics
recorded. Metric ordering prioritizes review; it does not prove a defect.

Exclusions remain visible in the queue and never count as reviewed. No report
calculates a repository coverage percentage. Do not claim one without the
complete intended inventory and denominator.

## Persist findings and their assessments

Check tests, callers, and existing documentation before recommending changes.
A finding needs a concrete scenario, source evidence, practical impact, and the
smallest useful improvement. Severity and confidence are independent. Follow
the imported instructions for calibration, performance assumptions, comment
and TSDoc recommendations, and what to skip.

Inspect both contracts before writing:

```sh
silo table show source_audit_findings
silo table show source_audit_observations
silo query source-audit-findings --package .
```

Deduplicate by underlying cause and recommendation, retaining the finding UUID.
Add or update the current finding using [row commands](../guides/work-with-rows.md).
For every evaluated finding, add an observation with its package, run ID,
finding ID, and a copy of these assessment fields:

`title`, `category`, `severity`, `confidence`, `file_path`, `related_symbols`,
`evidence`, `issue`, `impact`, `recommendation`, and nullable `notes`.

Use `silo row add source_audit_observations --file observation.json` for a new
assessment. For an existing observation in the same active run, use a composite
JSON array key in run_id, finding_id order with an optimistic patch:

```sh
# Replace both example IDs with the retained run and finding IDs.
observation_key='["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]'
silo row get source_audit_observations "$observation_key"
```

Do not rewrite that observation during a later run. Update the current finding
and its `last_checked_run_id`, then record a new observation for the later run.
`first_seen_run_id` remains fixed. Reads return JSON columns as JSON text; decode
`related_symbols` into a native array before copying it into a write. Write
native arrays for run JSON columns too.

## Query and render results

All queries require `--package`; package matching is exact. Run-scoped queries
also require `--run`. Unknown or mismatched run IDs yield empty results.

| Query                             | Selection and result                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-audit-runs`               | Optional `--status` (default `all`); newest first by creation instant, then run ID. Includes source state, scope, revision, and integer `remaining_count`.                                                                        |
| `source-audit-findings`           | Current assessments by default. Optional `--run` selects retained observations. Category/severity/confidence default to `all`; file defaults to empty, meaning every file. Ordered by severity, confidence, path, then stable ID. |
| `source-audit-next-review`        | Explicit run's incomplete implementation/API checks, outstanding checks, and exclusions, with matching hotspot priorities/reasons.                                                                                                |
| `source-audit-hotspots`           | Explicit run's recorded metrics and matching coverage. Missing artifact or metrics returns no rows; inspect run scan fields.                                                                                                      |
| `source-audit-needs-verification` | Explicit run's low/medium-confidence observations plus distinct `kind: lead` rows. Lead finding IDs and ratings are null.                                                                                                         |
| `source-audit-summary`            | Explicit run's observation counts by category/severity/confidence, inventory size, implementation/API state counts, and remaining-work kinds.                                                                                     |

Silo types query inputs and returns named SQL result columns; it does not
support authored result-type declarations. JSON result columns remain JSON
text. `source-audit-findings.assessed_run_id` is null for current rows and the
selected run ID for snapshots. Its `first_seen_run_id` and
`last_checked_run_id` always describe the current identity record, even when
assessment details come from an earlier run. Null optional text means no value
was recorded. Query parameters do not accept SQL null; use their documented
`all` or empty-string defaults.

```sh
silo query source-audit-findings --help
silo query source-audit-findings --package . --severity high
silo query source-audit-findings --package . --run "$run_id"
silo query source-audit-hotspots --package . --run "$run_id"
silo query source-audit-needs-verification --package . --run "$run_id"
silo query source-audit-summary --package . --run "$run_id"
silo report refresh source-audit-overview
silo report show source-audit-overview
silo report refresh source-audit-review-queue
silo report refresh source-audit-findings
silo report open source-audit-findings
```

Reports take no package/run arguments. Each has separate package sections,
selecting the latest run by `created_at DESC, run_id DESC` regardless of status:

- `source-audit-overview`: source state, scan evidence, top ten hotspots,
  coverage, remaining work, grouped counts, and top ten recorded assessments.
  It includes narrative themes only when `summary` is stored.
- `source-audit-review-queue`: incomplete checks, exclusions, uncovered
  high-priority hotspots, leads/blockers, findings needing verification, and
  current findings without an observation in the latest run.
- `source-audit-findings`: category-grouped run assessment details with stable
  IDs and evidence, plus a separate list of current findings not recorded as
  checked in that run.

Rendering is synchronous and read-only: no network, shell, source writes, or
synchronization. Stored text is escaped and paths remain plain text, not file
links. Queries are bounded to 500 rows; reports label truncation and intentional
top-ten views. Use narrower query filters for explicit inspection. The viewer
command serves locally in the foreground until interrupted. Reports remain
refreshable Silo records, not repository Markdown snapshots.

Complete a run only after meaningful inventoried source and exported APIs have
been checked, findings deduplicated and calibrated, snapshots reconciled, and
obvious high/medium-value leads evaluated. Otherwise record `in_progress` or
`blocked` and actual remaining work. Derive the final response from Silo's
scope, source state, exclusions, scan evidence, finding IDs, scoped counts, and
remaining uncertainty. Zero findings alone never means complete.
