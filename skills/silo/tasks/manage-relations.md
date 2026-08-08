# Manage semantic relations

> Add domain names and documentation to an existing foreign key without changing SQLite DDL.

Read [the relation request schema](../schemas/relation.schema.json), then add a
relation after both tables and their foreign key already exist:

```sh
silo relation add <<'JSON'
{
  "from": {
    "table": "posts",
    "columns": ["author_id"],
    "name": "author"
  },
  "to": {
    "table": "authors",
    "columns": ["id"]
  },
  "inverse_name": "posts",
  "comment": "Author responsible for this post.",
  "inverse_comment": "Posts authored by this author."
}
JSON
```

The relation must exactly match one foreign key, including the ordered local
and referenced column lists. A bare foreign key remains valid when a domain
name or documentation is not needed. Relations do not declare cardinality or
optionality: Silo derives the source side from local FK nullability and the
inverse side from local uniqueness.

Inspect the result from either direction:

```sh
silo relation show posts author
silo relation list
silo table show authors
```

`relation remove posts author` removes only the semantic metadata. It leaves
the foreign key and its SQLite referential-integrity behavior in place.

Relations can also be included in a template's top-level `relations` array.
Template imports validate all relation endpoints and backing foreign keys
against the complete post-import schema before changing any tables or
metadata.
