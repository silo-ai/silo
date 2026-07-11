# Query with SQL

> Use SQLite-native reads for joins, aggregates, CTEs, windows, and JSON operations without enabling mutation.

Add explicit ordering whenever result order matters:

```sh
silo sql '
  SELECT status, count(*) AS issue_count
  FROM issues
  GROUP BY status
  ORDER BY status
'
```

For longer queries, send SQL through stdin:

```sh
silo sql <<'SQL'
WITH recent AS (
  SELECT * FROM issues ORDER BY created_at DESC LIMIT 10
)
SELECT id, title FROM recent ORDER BY created_at DESC;
SQL
```

The connection is read-only. Use row commands for mutations and remember that exact decimals and semantic versions do not have numerically meaningful lexical ordering.
