# Create a table

> Define a durable entity with comments, semantic types, keys, and policies before writing rows.

Inspect [the table request schema](../schemas/table-create.schema.json), then create an `issues` table:

```sh
silo table create <<'JSON'
{
  "name": "issues",
  "comment": "One actionable repository issue; read before planning work.",
  "columns": [
    { "name": "id", "type": "text/uuid", "nullable": false, "comment": "Stable generated issue identifier." },
    { "name": "title", "type": "text", "nullable": false, "comment": "Short actionable summary." },
    { "name": "context", "type": "text/json", "nullable": false, "comment": "Structured labels and routing context." }
  ],
  "primary_key": ["id"],
  "policies": [
    { "type": "generated_identity", "column": "id", "strategy": "uuid" }
  ]
}
JSON
```

The first schema mutation also creates the workspace database. Add a row with native JSON rather than a serialized JSON string:

```sh
silo row add issues <<'JSON'
{
  "title": "Document release process",
  "context": { "labels": ["docs", "release"] }
}
JSON
```

The output includes the generated UUID and canonical persisted values. Verify the logical contract with `silo table show issues`.
