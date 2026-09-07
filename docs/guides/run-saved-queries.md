# Run Saved Queries

> Save SQL once and run it by name with checked command-line arguments.

Use a saved query when several agents or reports need the same read. Silo
stores the SQL and its parameter types in the local database. For a one-off
question, use `silo sql` instead.

## Define and run a named query

This example uses the `issues` table and row from
[Getting started](../getting-started.md). It finds titles that start with the
supplied text. Save this definition as `find-issues.json`:

```json
{
  "name": "find-issues",
  "description": "Issues whose titles start with a supplied prefix.",
  "sql": "SELECT id, title FROM issues WHERE title LIKE :prefix || '%' ORDER BY title",
  "parameters": [
    {
      "name": "prefix",
      "type": "text",
      "description": "Title prefix to search for using SQLite LIKE."
    }
  ]
}
```

Save the definition, then invoke it by its name:

```sh
silo query put --file find-issues.json
silo query find-issues --prefix Document
```

The result should include `Document the release process`. The query uses
SQLite `LIKE`: ASCII letters match without regard to case, and `%` and `_` in
the input act as wildcards.

Saving the definition changes the database. Running it only reads current
rows and does not create pending synchronization work.

## Choose a parameter style

Named parameters are the default and make each value self-describing. Each
declaration becomes a hyphenated CLI option, while SQL uses the original
underscore name. For example, `minimum_revision` becomes
`--minimum-revision`.

Use positional parameters when the order is easy to remember, such as a
single row limit. Save this definition as `list-issues.json`:

```json
{
  "name": "list-issues",
  "description": "The first N issues in title order.",
  "parameter_style": "positional",
  "sql": "SELECT id, title FROM issues ORDER BY title LIMIT ?1",
  "parameters": [
    {
      "name": "limit",
      "type": "integer/positive",
      "description": "Maximum number of issues to return.",
      "default": 20
    }
  ]
}
```

Save it and run it without a limit to use the default of 20:

```sh
silo query put --file list-issues.json
silo query list-issues
```

The result contains up to 20 issues in title order. Run
`silo query list-issues 5` to request at most five.

Positional SQL may use one anonymous `?` per declaration or every numbered
placeholder from `?1` through `?N`. Do not mix the forms. Once one positional
parameter has a default, every later parameter must also have a default.

## Treat parameters as a typed contract

Each parameter uses a registered [semantic type](../reference/semantic-types.md).
Silo converts the CLI input to that type, checks it, and binds it as a SQLite
value. It does not build SQL by inserting the value into the query text.

A parameter without `default` is required. Run query-specific help to see the
generated interface:

```sh
silo query find-issues --help
```

Query limits:

- One read-only SQL statement that returns columns
- No access to Silo or SQLite internal objects
- At most 500 result rows, with truncation marked in the output

Add `ORDER BY` when result order matters.

## Reuse a query in a report

After saving `find-issues`, a report script can call it with the same parameter.
This script body returns a Markdown table or an empty-result message:

```js
const issues = silo.query('find-issues', { prefix: 'Document' })

return issues.rows.length ? markdown.table(issues) : '_No matching issues._'
```

Named parameters use an object; positional parameters use an array in
declaration order. Omit `parameters` only when the saved query has no required
inputs.

Each refresh uses the current query definition. Changing or deleting it can
break a report; Silo does not scan scripts to find their query dependencies.
If refresh fails, the last successful rendering stays available. See
[Publish a refreshable report](publish-a-report.md) to save and open a report.

## Inspect and manage definitions

| Command                    | Result                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `silo query put`           | Creates or atomically replaces a definition.                        |
| `silo query list`          | Lists definitions, parameter styles, and update times.              |
| `silo query show <name>`   | Shows SQL, parameter types, defaults, and descriptions.             |
| `silo query delete <name>` | Permanently deletes a definition not referenced by a legacy report. |
| `silo query <name>`        | Runs the saved SQL without changing data.                           |

The names `put`, `list`, `show`, and `delete` are reserved so direct query
invocation remains unambiguous.

When synchronization is configured, saved-query changes remain local until
`silo push`. Running a query does not change or synchronize data.
