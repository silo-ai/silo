# Publish a refreshable report

> Turn database results into a Markdown report you can open in your browser.

A report runs a JavaScript script in QuickJS-NG and saves the Markdown it
returns. For example, an issue report can list work for a human to review.
Opening the report shows its last successful result while a refresh runs.

Scripts can read the local database through SQL or saved queries. The runtime
does not provide Node.js, module loading, filesystem access, or network access.

> [!CAUTION]
> Validating, saving, refreshing, or opening a report executes its script with
> read access to Silo's user tables and workspace metadata. Inspect a script's
> database reads before running a report from another author.

## Define and save a report

This example assumes the `issues` table from [Getting started](../getting-started.md). Save this definition as `issue-brief.json`:

```json
{
  "slug": "issue-brief",
  "title": "Project issue brief",
  "script": "const issues = silo.sql('SELECT id, title FROM issues ORDER BY title')\n\nreturn [\n  '# Project issue brief',\n  issues.rows.length ? markdown.table(issues) : '_No issues._',\n].join('\\n\\n')"
}
```

Validate it, save it, then inspect the result:

```sh
silo report validate --file issue-brief.json
silo report put --file issue-brief.json
silo report show issue-brief
```

The output of `report show` should include your issue in a Markdown table. If
the table is empty, it shows `_No issues._`.

`report validate` runs the candidate without saving it or creating pending
synchronization work. Its read-only SQL and saved-query calls still execute.

`report put` runs the script before replacing the stored definition and rendering. If the script throws or returns an invalid value, an existing report with the same slug remains unchanged.

A script must return a Markdown string synchronously. Do not use top-level
`await` or return a promise. QuickJS-NG has a 64 MiB memory cap and a
five-second execution deadline. SQLite queries use that same deadline. Each
render reads from one SQLite snapshot; Silo saves the result after that read
transaction finishes.

## Use the report script API

Silo evaluates the stored function body with the `silo` and `markdown` objects:

| Name                            | Purpose                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `silo.workspace`                | The Git workspace's `root`, `identity`, and `origin`.                                           |
| `silo.sql(sql, parameters?)`    | Runs one bounded read-only SQL statement. Parameters may be a named object or positional array. |
| `silo.query(name, parameters?)` | Runs a saved query through its typed parameter contract.                                        |
| `markdown.table(result)`        | Renders a query result as a GitHub-flavored Markdown table.                                     |

Both query methods return:

```ts
{
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}
```

Each call returns at most 500 rows. To show a warning when more rows match,
replace `issue-brief.json` with this version, then save it with
`silo report put --file issue-brief.json`:

```json
{
  "slug": "issue-brief",
  "title": "Project issue brief",
  "script": "const issues = silo.sql(\n  \"SELECT id, title FROM issues WHERE title LIKE :prefix || '%' ORDER BY title\",\n  { prefix: 'Document' },\n)\n\nconst body = issues.rows.length ? markdown.table(issues) : '_No matching issues._'\nconst warning = issues.truncated ? '> Results truncated to 500 rows.' : ''\nreturn ['# Project issue brief', body, warning].filter(Boolean).join('\\n\\n')"
}
```

This version lists titles beginning with `Document`. With fewer than 501
matches, it shows no truncation warning.

`silo.sql` is read-only and cannot access Silo's internal tables. The QuickJS
context exposes no Node APIs, filesystem, network, or module loader.

## Reuse a saved query

After defining `find-issues` in [Run saved queries](run-saved-queries.md), you
can use this script body to reuse it:

```js
const issues = silo.query('find-issues', { prefix: 'Document' })

return [
  '# Project issue brief',
  issues.rows.length ? markdown.table(issues) : '_No matching issues._',
].join('\n\n')
```

Each run uses the current saved-query definition. Updating or deleting that
query can break the next refresh; Silo does not scan scripts to find their
dependencies. A failed refresh keeps the last successful result.

## Migrate a report that used Node.js

The Rust CLI preserves report definitions and saved renderings. Scripts that
use `require()`, Node APIs, or package dependencies cannot run in QuickJS-NG.
Rewrite those scripts using `silo.sql`, `silo.query`, and ordinary JavaScript
before refreshing them. A failed refresh keeps the last successful rendering.

## Inspect the definition and rendering

To inspect or save the script without its rendered output:

```sh
silo report show issue-brief --definition
```

The definition view shows `slug`, `title`, and `script` in a fenced JSON block.
To reuse it as a `--file` input, copy the JSON without the heading or code fences.
Show the last successful result and script together with:

```sh
silo report show issue-brief
```

## Open the local viewer

Start the packaged viewer from the associated Git repository:

```sh
silo report open issue-brief
```

The command starts a local server and opens your browser. The page displays
the last successful result, then refreshes. It refreshes again whenever the
page regains focus. The diagram shows what happens when refresh succeeds or fails:

```mermaid
sequenceDiagram
  participant Browser
  participant Viewer as Local viewer
  participant Script as Trusted report script
  participant Silo as Local database
  Browser->>Viewer: Open report
  Viewer-->>Browser: Last successful Markdown
  Browser->>Viewer: Refresh on load or focus
  Viewer->>Script: Execute stored JavaScript
  Script->>Silo: Run declared reads
  alt Script returns Markdown
    Viewer->>Silo: Store new rendering
    Viewer-->>Browser: Replace report and freshness state
  else Script throws
    Viewer->>Silo: Keep last good rendering
    Viewer-->>Browser: Show stale result and error
  end
```

The viewer displays GitHub-flavored Markdown. Raw HTML is shown as text, image
syntax displays its alt text, and unsafe link schemes are disabled. The report
script runs in the local Silo process. This viewer is for local use; it does
not provide remote hosting or an authentication system.

Interrupt the CLI command to stop the server.

## Refresh or manage reports from the CLI

| Command                                | Result                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| `silo report validate`                 | Runs a candidate without saving report state.                  |
| `silo report list`                     | Lists reports and their latest refresh state.                  |
| `silo report show <slug>`              | Shows the last successful rendering and stored script.         |
| `silo report show <slug> --definition` | Shows the definition in a fenced JSON block.                   |
| `silo report refresh <slug>`           | Reruns the script and atomically stores a successful result.   |
| `silo report put`                      | Creates or replaces a definition and performs its initial run. |
| `silo report open <slug>`              | Starts the local viewer and refreshes on page load and focus.  |
| `silo report delete <slug>`            | Permanently deletes the definition and rendering.              |

If a refresh fails, Silo records the error and attempt time while retaining the previous rendering. Fix the script, its dependencies, or its source data. Use `report put` for a changed script and `report refresh` when the stored script can succeed without replacement.

> [!WARNING]
> `silo report delete` is permanent. Save the definition first if you may need
> it again, for example with `silo report show issue-brief --definition > issue-brief-backup.md`.

## Existing Markdown and query reports

Silo still reads, refreshes, synchronizes, and replaces legacy definitions that contain `markdown` and `queries`. That format is deprecated. New reports and bundled templates should use `script`.

A legacy report keeps its existing behavior, including fixed saved-query
bindings, query provenance, query slots, and automatic table formatting.
Replacing it with a scripted definition removes its stored query rows after the
new script runs successfully.

## Share reports through explicit synchronization

Report changes remain local until `silo push`. Another machine receives them
through `silo pull`. This includes:

- Scripts
- Saved Markdown results
- Refresh status
- Deletions

Pulling a report stores code but does not execute it. Validating, putting, refreshing, or opening it does.

> [!IMPORTANT]
> Opening or refocusing the viewer refreshes the report. In a synchronized Silo, a successful refresh updates report metadata and creates pending local work. Check `silo sync status` and push when the new snapshot should be shared.

Changes to different reports can be combined. Changes to the same report may
conflict. Preserve the script you need, follow the recovery steps in [Synchronize a database](synchronize.md#recover-from-a-conflict), then put or refresh the reconciled report.

For failures and stale viewer states, continue with [Troubleshooting](../troubleshooting.md#a-report-cannot-be-saved-or-refreshed).
