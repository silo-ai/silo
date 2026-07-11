# Make an additive schema change

> Extend an existing table without invoking an unsupported or destructive table rebuild.

Inspect [the alteration request schema](../schemas/table-alter.schema.json), then add a nullable column and an index:

```sh
silo table alter issues <<'JSON'
{
  "add_columns": [
    {
      "name": "owner",
      "type": "text",
      "nullable": true,
      "comment": "Agent or team currently responsible for the issue; NULL means unassigned."
    }
  ],
  "add_indexes": [
    { "columns": [{ "column": "owner" }] }
  ]
}
JSON
```

Verify the new logical definition with `silo table show issues`. Initial Silo alterations do not rename or drop columns, tighten nullability, change keys or types, or modify policies.
