# Perform an idempotent upsert

> Repeat a write safely when the table declares a natural conflict key and allowed update fields.

Confirm that `silo table show dependencies` lists a `natural_key_upsert` policy. Then upsert through that declared key:

```sh
silo row upsert dependencies <<'JSON'
{
  "package": "better-sqlite3",
  "latest_version": "12.4.1"
}
JSON
```

Running the same command again updates only the fields allowed by the policy. If the table has no such policy, use an explicit read followed by insert or update instead.

When no update fields are needed, supply only the complete natural key. Silo performs a no-op and returns the existing persisted row instead of issuing an empty update.
