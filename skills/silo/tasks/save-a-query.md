# Save and Run a Typed Query

Use a saved query when agents or humans should repeat one stable read without reconstructing its SQL. Saved queries are durable Silo resources: management mutations synchronize explicitly, while invocation is read-only.

Read `schemas/query-put.schema.json` before constructing an unfamiliar definition. Named parameters are the default and become CLI options. Their SQL placeholders must use the declared `:name` exactly:

```json
{
  "name": "blocked-work",
  "description": "Tasks waiting on an incomplete dependency for one lifecycle state.",
  "sql": "SELECT task.id, task.title, task.state, task.priority, task.rank, dependency.title AS dependency, dependency.state AS dependency_state FROM task_dependencies AS edge JOIN tasks AS task ON task.id = edge.task_id JOIN tasks AS dependency ON dependency.id = edge.depends_on_task_id WHERE task.state = :state AND dependency.state <> 'completed' ORDER BY CASE task.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, task.rank, task.updated_at, task.id, dependency.id",
  "parameters": [
    {
      "name": "state",
      "type": "text/enum",
      "type_options": {
        "values": ["proposed", "approved", "in_progress", "completed", "rejected", "canceled"]
      },
      "description": "Task lifecycle state to inspect."
    }
  ]
}
```

Save and invoke it:

```sh
silo query put < blocked-work.json
silo query blocked-work --state approved
```

Use `parameter_style: "positional"` when argument order is naturally obvious. Declare parameters in invocation order and use either one `?` per parameter or every numbered placeholder from `?1` through `?N`. Parameters with defaults must trail required positional parameters.

```json
{
  "name": "task-history",
  "description": "Recent execution attempts for one task.",
  "parameter_style": "positional",
  "sql": "SELECT session_id, outcome, started_at, ended_at FROM task_sessions WHERE task_id = ?1 ORDER BY started_at DESC LIMIT ?2",
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

Set `TASK_ID` to the UUID from the task row, then run `silo query task-history "$TASK_ID"` to use the default limit. Run `silo query task-history --help` to inspect the generated arguments, types, defaults, and descriptions.

Saved SQL must contain one read-only statement, return columns, and cannot access Silo or SQLite internal objects. Silo binds values instead of interpolating SQL, canonicalizes every argument through its declared semantic type, and returns at most 500 rows.

Reports may reference the saved query with fixed bindings. Use an object for named parameters or an array for positional parameters:

```json
{
  "name": "blocked_work",
  "saved_query": "blocked-work",
  "parameters": { "state": "approved" }
}
```

Report refresh resolves the current definition, so later query changes affect every reference. Silo prevents deletion while any report still references the query.

Use `silo query list`, `silo query show <name>`, and `silo query delete <name>` to inspect or remove unreferenced definitions. The names `put`, `list`, `show`, and `delete` are reserved for these management commands.
