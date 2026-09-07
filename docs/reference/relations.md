# Semantic relations

> Give an existing foreign-key relationship a name and explanation that agents can read.

## Why relations are separate from foreign keys

A foreign key requires a referenced row to exist. For example, a post's
`author_id` can refer to an author:

```text
posts.author_id → authors.id
```

A semantic relation gives that connection names and descriptions:

```text
posts.author  = Author responsible for this post.
authors.posts = Posts authored by this author.
```

The foreign key enforces the connection. The relation stores its meaning in
the logical schema for agents and other readers. Use a foreign key alone when
the extra names and descriptions would not help.

The direction and inverse are easier to see in a small model:

```mermaid
erDiagram
  AUTHORS ||--o{ POSTS : "posts / author"
```

In this example, every post requires one author. An author can have any number
of posts, including none. The two names let a reader describe the connection
from either table.

## Relation definition

This example uses posts and authors because the two directions have familiar
names. Start in a workspace without those tables.

Save this as `authors-table.json`:

```json
{
  "name": "authors",
  "comment": "Authors responsible for posts.",
  "columns": [{ "name": "id", "type": "text", "nullable": false, "comment": "Unique author key." }],
  "primary_key": ["id"]
}
```

Save this as `posts-table.json`:

```json
{
  "name": "posts",
  "comment": "Posts with a required author.",
  "columns": [
    { "name": "id", "type": "text", "nullable": false, "comment": "Unique post key." },
    {
      "name": "author_id",
      "type": "text",
      "nullable": false,
      "comment": "Author responsible for the post."
    }
  ],
  "primary_key": ["id"],
  "foreign_keys": [
    { "columns": ["author_id"], "references": { "table": "authors", "columns": ["id"] } }
  ]
}
```

Create the tables in that order:

```sh
silo table create --file authors-table.json
silo table create --file posts-table.json
silo table show posts
```

The post table should show a required `author_id` and its foreign key. Now
save the following relation as `relation.json`:

```json
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
```

Silo stores relations in the logical schema's top-level `relations` array.
The fields above define:

- `from.name`: the name used from the referencing table, here `posts.author`
- `comment`: the required explanation of that direction
- `inverse_name`: an optional name for the other direction, here `authors.posts`
- `inverse_comment`: required when `inverse_name` is supplied

Silo does not invent an inverse name when you omit it.

The endpoint columns and tables must exactly match one declared foreign key:

| Relation field | Matching foreign-key field    |
| -------------- | ----------------------------- |
| `from.table`   | local table containing the FK |
| `from.columns` | ordered local FK columns      |
| `to.table`     | referenced table              |
| `to.columns`   | ordered referenced columns    |

Column order matters. A relation is rejected when it describes an arbitrary
join, points to a different key, or could match more than one declared
foreign key.

## Derived cardinality and optionality

Relations do not persist `one`, `many`, or `optional` fields. Silo derives them
from the columns and constraints:

- Every source row relates to at most one target row, so the source cardinality
  is `one`; this does not make the whole relationship one-to-one.
- The source side is `required` when every local FK column is `NOT NULL` and
  `optional` otherwise.
- The inverse side is `one` when the local FK columns are covered exactly by a
  primary key or unconditional unique key; otherwise it is `many`.

For a composite foreign key, SQLite treats the relationship as absent when
any local key column is `NULL`. Silo therefore reports a composite source as
optional when any local FK column is nullable. The FK's ordered columns still
have to match the relation exactly.

For example:

```text
profiles.author_id NULL UNIQUE → authors.id
```

would give a nullable profile-to-author connection and at most one profile
per author. This is a separate illustration; the setup above does not create
a `profiles` table.

In the created `posts` table, `author_id` is non-null and is not unique. Each
post therefore requires an author, while an author can have many posts.

## Multiple relationships and junction tables

Different foreign keys between the same tables can have different semantic
names:

```text
posts.author_id → authors.id  = posts.author
posts.editor_id → authors.id  = posts.editor
```

Their inverse names must also be distinct when both are declared. Relation
names are unique within a table's semantic-relation namespace, but they are
not currently required to avoid column names.

Do not add a special many-to-many relation for a junction table. Model its
foreign keys normally:

```text
post_categories.post     → posts.id
post_categories.category → categories.id
```

Readers can recognize that pattern, but Silo does not generate joins or a
special many-to-many API from it.

## Commands and inspection

After creating the example tables and saving `relation.json`, add and inspect
the relation:

```sh
silo relation add --file relation.json
silo relation list
silo relation show posts author
```

The result shows `posts.author`, its inverse `authors.posts`, and the derived
relationship counts.

- `silo schema show` lists all relations.
- `silo table show posts` includes its outgoing relations.
- `silo table show authors` includes named inverse relations pointing to it.
- `silo schema export` includes your relation definitions, without the derived
  counts. Silo calculates those from the schema.

To remove this relation, run `silo relation remove posts author`, then
`silo relation list` to verify it is gone. Removing the relation leaves the
foreign key in place.

Templates may include the same top-level `relations` array. Silo validates
their tables, columns, exact backing foreign keys, and name conflicts against
the complete post-import schema before applying the import.

Relations describe real foreign keys. They do not create SQLite objects or
change how SQL works. Write joins explicitly when querying related tables.
