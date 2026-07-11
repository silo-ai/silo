# Update with optimistic revision

> Apply a change only when the row still has the revision previously read by the agent.

First read the current row and retain its `revision` value:

```sh
silo row get issues 550e8400-e29b-41d4-a716-446655440000
```

If the row reports revision `3`, submit the expected revision with the changed fields:

```sh
silo row update issues 550e8400-e29b-41d4-a716-446655440000 <<'JSON'
{
  "title": "Document and automate release process",
  "_expected_revision": 3
}
JSON
```

On a revision conflict, reread the row and reconcile the other writer's changes. Never retry blindly with a newer revision.
