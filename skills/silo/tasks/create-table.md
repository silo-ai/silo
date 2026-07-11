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
    { "name": "title", "type": "text", "nullable": false, "comment": "Short actionable summary." }
  ],
  "primary_key": ["id"],
  "policies": [
    { "type": "generated_identity", "column": "id", "strategy": "uuid" }
  ]
}
JSON
```

Verify the logical contract with `silo table show issues`. The first schema mutation also creates the workspace database.
