# Run Saved Queries

> Turn repeated repository reads into typed commands whose SQL and parameter contract travel with the Silo.

## Choose a parameter style

Use named parameters when a reader benefits from seeing what each value means:

```json
{
  "name": "blocked-work",
  "description": "Blocked tasks for one owner, ordered by their last update.",
  "sql": "SELECT title, updated_at FROM tasks WHERE status = 'blocked' AND owner = :owner ORDER BY updated_at",
  "parameters": [
    {
      "name": "owner",
      "type": "text",
      "description": "Canonical owner identifier."
    }
  ]
}
```

Named style is the default. Each declaration becomes a hyphenated CLI option, while SQL uses the original underscore name:

```sh
silo query put --file blocked-work.json
silo query blocked-work --owner alec
```

Use positional parameters when their order is already conventional, such as an entity identifier followed by an optional limit:

```json
{
  "name": "task-history",
  "description": "Recent events for one task.",
  "parameter_style": "positional",
  "sql": "SELECT occurred_at, summary FROM task_events WHERE task_id = ?1 ORDER BY occurred_at DESC LIMIT ?2",
  "parameters": [
    {
      "name": "task_id",
      "type": "text/uuid",
      "description": "Stable task identifier."
    },
    {
      "name": "limit",
      "type": "integer/positive",
      "description": "Maximum events to return.",
      "default": 20
    }
  ]
}
```

Invoke it with the required identifier; the trailing default supplies the limit:

```sh
silo query task-history 550e8400-e29b-41d4-a716-446655440000
```

Positional SQL may use one anonymous `?` per declaration or every numbered placeholder from `?1` through `?N`. Do not mix the forms. Once one positional parameter has a default, every later parameter must also have a default.

## Treat parameters as a typed contract

Each parameter uses a registered [semantic type](../reference/semantic-types.md). Silo decodes CLI input, validates and canonicalizes it through that type, then binds the resulting SQLite value. Values are never interpolated into SQL.

A parameter without `default` is required. For named queries, defaults may appear anywhere. Run query-specific help to see the generated interface:

```sh
silo query blocked-work --help
```

Parameter names use lowercase letters, digits, and underscores. Named SQL references them as `:name`; their CLI options replace underscores with hyphens, so `minimum_revision` becomes `--minimum-revision`.

## Reuse a query in reports

A report can bind fixed parameters to the same saved query used by CLI callers:

```json
{
  "name": "blocked_work",
  "saved_query": "blocked-work",
  "parameters": {
    "owner": "alec"
  }
}
```

Named parameters use an object; positional parameters use an array in declaration order. Omit `parameters` only when every input has a default or the query declares no parameters.

Each report refresh resolves the current saved-query definition. Updating its SQL or parameter contract therefore affects every referencing report on its next refresh; a failed refresh retains the report's last good rendering. Silo prevents deletion while any report still references the query.

## Inspect and manage definitions

Use the management verb that matches the intended change:

| Command                    | Result                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `silo query put`           | Creates or atomically replaces a definition.                 |
| `silo query list`          | Lists definitions, parameter styles, and update times.       |
| `silo query show <name>`   | Shows SQL, parameter types, defaults, and descriptions.      |
| `silo query delete <name>` | Permanently deletes an unreferenced definition.              |
| `silo query <name>`        | Executes the definition through a read-only SQLite boundary. |

The names `put`, `list`, `show`, and `delete` are reserved so direct invocation remains unambiguous.

Saved SQL must contain one read-only statement, return result columns, and cannot read Silo or SQLite internal objects. Results are capped at 500 rows and mark truncation explicitly. Add `ORDER BY` whenever output order matters.

When synchronization is configured, puts and deletes enter the pending transaction stream and remain local until `silo push`. Executing a saved query does not mutate or synchronize state.
