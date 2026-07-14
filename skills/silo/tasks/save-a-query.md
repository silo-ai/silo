# Save and Run a Typed Query

Use a saved query when agents or humans should repeat one stable read without reconstructing its SQL. Saved queries are durable Silo resources: management mutations synchronize explicitly, while invocation is read-only.

Read `schemas/query-put.schema.json` before constructing an unfamiliar definition. Named parameters are the default and become CLI options. Their SQL placeholders must use the declared `:name` exactly:

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

Save and invoke it:

```sh
silo query put < blocked-work.json
silo query blocked-work --owner alec
```

Use `parameter_style: "positional"` when argument order is naturally obvious. Declare parameters in invocation order and use either one `?` per parameter or every numbered placeholder from `?1` through `?N`. Parameters with defaults must trail required positional parameters.

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

Run `silo query task-history <task-id>` to use the default limit. Run `silo query task-history --help` to inspect the generated arguments, types, defaults, and descriptions.

Saved SQL must contain one read-only statement, return columns, and cannot access Silo or SQLite internal objects. Silo binds values instead of interpolating SQL, canonicalizes every argument through its declared semantic type, and returns at most 500 rows.

Reports may reference the saved query with fixed bindings. Use an object for named parameters or an array for positional parameters:

```json
{
  "name": "blocked_work",
  "saved_query": "blocked-work",
  "parameters": { "owner": "alec" }
}
```

Report refresh resolves the current definition, so later query changes affect every reference. Silo prevents deletion while any report still references the query.

Use `silo query list`, `silo query show <name>`, and `silo query delete <name>` to inspect or remove unreferenced definitions. The names `put`, `list`, `show`, and `delete` are reserved for these management commands.
