# Create a refreshable report

Use a report when a human should revisit Markdown generated from current Silo data. Reports contain trusted synchronous JavaScript and the last successful rendering.

Read [the report request schema](../schemas/report-put.schema.json), then save a definition such as `execution-brief.json`:

```json
{
  "slug": "execution-brief",
  "title": "Project execution brief",
  "script": "const states = silo.sql(\n  \"SELECT state, count(*) AS tasks FROM tasks GROUP BY state ORDER BY state\",\n)\n\nreturn [\n  '# Project execution brief',\n  '## Work by lifecycle state',\n  states.rows.length ? markdown.table(states) : '_No tasks._',\n].join('\\n\\n')"
}
```

The script receives these values:

- `silo.workspace` contains the Git workspace root, identity, and origin.
- `silo.sql(sql, parameters?)` runs one bounded read-only SQL statement.
- `silo.query(name, parameters?)` runs a typed saved query.
- `markdown.table(result)` formats a query result.
- `require` loads synchronous Node modules and repository dependencies from the workspace root.

Each query result contains `columns`, `rows`, and `truncated`. Check `rows.length` when an empty result needs custom Markdown. Check `truncated` when readers must know that Silo returned only the first 500 rows. Add `ORDER BY` whenever presentation order matters.

Validate and save the report:

```sh
silo report validate --file execution-brief.json
silo report put --file execution-brief.json
```

Validation runs the script without replacing saved report state or creating pending synchronization work. The script is still trusted code and can cause filesystem, network, or process side effects. It must return a Markdown string synchronously. A promise or any other result fails validation.

Use a saved query when the same typed read also serves CLI callers:

```js
const blocked = silo.query('blocked-work', { state: 'approved' })

return blocked.rows.length
  ? markdown.table(blocked)
  : '_No approved work is waiting on dependencies._'
```

A report resolves the current saved query each time it runs. Updating or deleting that query can break a later refresh. Silo cannot infer dynamic references from JavaScript source.

Inspect or refresh the saved report:

```sh
silo report show execution-brief --definition
silo report show execution-brief
silo report refresh execution-brief
```

Use `--definition` to inspect only the stored script as JSON. A failed refresh records the error and keeps the last successful rendering.

Open the local viewer when the report is ready for a human reader:

```sh
silo report open execution-brief
```

The foreground command serves only on loopback and runs until interrupted. The page refreshes after opening and when it regains focus. Each refresh executes the trusted script.

Definitions containing `markdown` and `queries` remain supported for existing reports but are deprecated. Create new reports with `script`.
