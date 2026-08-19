# Run Saved Queries

> Turn a repeated read into a named, typed command that agents and reports can use without copying SQL or interpolating values.

A saved query is a repository-defined read API. Use one when the same SQL
should be available to multiple agents, scripts, or reports. Use `silo sql` for
a one-off investigation.

## Define and run a named query

Assume the `issues` table has `title` values that agents search by prefix. Save
this request as `find-issues.json`:

```json
{
  "name": "find-issues",
  "description": "Issues whose titles start with a supplied prefix.",
  "sql": "SELECT id, title FROM issues WHERE title LIKE :prefix || '%' ORDER BY title",
  "parameters": [
    {
      "name": "prefix",
      "type": "text",
      "description": "Case-sensitive title prefix to search for."
    }
  ]
}
```

Save the definition, then invoke it by its name:

```sh
silo query put --file find-issues.json
silo query find-issues --prefix release
```

The definition and its parameter contract are stored in the local Silo
database. Query execution reads current rows but does not mutate or create
pending synchronization work.

## Choose a parameter style

Named parameters are the default and make each value self-describing. Each
declaration becomes a hyphenated CLI option, while SQL uses the original
underscore name. For example, `minimum_revision` becomes
`--minimum-revision`.

Use positional parameters when order is already conventional, such as one
limit value:

```json
{
  "name": "recent-issues",
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

Invoke it with the required positional values; the default supplies omitted
optional values:

```sh
silo query put --file recent-issues.json
silo query recent-issues
```

Positional SQL may use one anonymous `?` per declaration or every numbered
placeholder from `?1` through `?N`. Do not mix the forms. Once one positional
parameter has a default, every later parameter must also have a default.

## Treat parameters as a typed contract

Each parameter uses a registered [semantic type](../reference/semantic-types.md).
Silo decodes CLI input, validates and canonicalizes it through that type, then
binds the resulting SQLite value. Values are never interpolated into SQL.

A parameter without `default` is required. Run query-specific help to see the
generated interface:

```sh
silo query find-issues --help
```

The query must contain one read-only SQL statement that returns columns. It
cannot read Silo or SQLite internal objects, and results are capped at 500 rows
with truncation marked in the output. Add `ORDER BY` whenever result order
matters.

## Reuse a query in a report

Call a saved query from a report script when its typed read should also serve a
human-facing report:

```js
const issues = silo.query('find-issues', { prefix: 'release' })

return issues.rows.length ? markdown.table(issues) : '_No release issues._'
```

Named parameters use an object; positional parameters use an array in
declaration order. Omit `parameters` only when the saved query has no required
inputs.

Each report refresh resolves the current saved-query definition. Updating its
SQL or parameter contract can therefore change or break the next report
refresh; a failed refresh retains the report's last good rendering. Script
references are dynamic, so Silo does not prevent deletion by scanning report
source.

## Inspect and manage definitions

| Command                    | Result                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `silo query put`           | Creates or atomically replaces a definition.                        |
| `silo query list`          | Lists definitions, parameter styles, and update times.              |
| `silo query show <name>`   | Shows SQL, parameter types, defaults, and descriptions.             |
| `silo query delete <name>` | Permanently deletes a definition not referenced by a legacy report. |
| `silo query <name>`        | Executes the definition through a read-only SQLite boundary.        |

The names `put`, `list`, `show`, and `delete` are reserved so direct query
invocation remains unambiguous.

When synchronization is configured, puts and deletes enter the pending
transaction stream and remain local until `silo push`. Running a saved query
does not mutate or synchronize state.
