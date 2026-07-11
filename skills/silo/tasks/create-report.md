# Create a refreshable report

Use a report when a human should revisit a stable explanation whose factual tables come from current Silo data. Keep changing facts inside query slots; refreshing does not ask an agent to rewrite ordinary Markdown.

Read [the report request schema](../schemas/report-put.schema.json), then define the report and every referenced query:

```json
{
  "slug": "execution-brief",
  "title": "Project execution brief",
  "markdown": "# Project execution brief\n\n## Work by status\n\n{{silo-query:work_by_status}}",
  "queries": [
    {
      "name": "work_by_status",
      "sql": "SELECT status, count(*) AS tasks FROM tasks GROUP BY status ORDER BY tasks DESC",
      "empty_markdown": "_No tasks._"
    }
  ]
}
```

Save and perform the initial refresh atomically:

```sh
silo report put --file execution-brief.json
```

Use `ORDER BY` whenever presentation order matters. Each query must be one read-only statement, every saved query must have a matching `{{silo-query:name}}` slot, and every slot must name a saved query. Failed replacements leave an existing valid report unchanged.

Inspect or refresh the saved report:

```sh
silo report show execution-brief
silo report refresh execution-brief
```

Open the packaged human viewer when the report is ready to hand off:

```sh
silo report open execution-brief
```

The foreground command serves only on loopback and runs until interrupted. The page shows the last successful rendering immediately and refreshes in the background after opening or regaining focus; a refresh error leaves that rendering visible.
