# Semantic Types

> Choose a column type and check which inputs it accepts.

A semantic type tells Silo how to check a value and store it in SQLite. For
example, `text/datetime` accepts a timestamp with a time zone and converts it
to UTC. `text/enum` accepts only the strings listed in the column definition.

Each type uses one SQLite storage class: `TEXT`, `INTEGER`, `REAL`, `BLOB`, or
`ANY`. Some types also add SQLite constraints or format values for row output.

Use this page to choose a type or understand a rejected value. Column examples
below belong in a table definition's `columns` array. See
[Design a schema](../guides/design-a-schema.md) for a complete table.

Use the column comment to explain what the value means. For example, say which
currency an amount uses and whether `null` means “unknown” or “not applicable.”

## Choose a type quickly

| Value you need              | Type to consider                                   |
| --------------------------- | -------------------------------------------------- |
| Unstructured text           | `text`                                             |
| Native JSON object or array | `text/json`                                        |
| Timestamp with a time zone  | `text/datetime`                                    |
| Calendar date               | `text/date`                                        |
| UUID or ULID identity       | `text/uuid` or `text/ulid`                         |
| Exact amount                | `integer/money-minor` or configured `text/decimal` |
| Boolean flag                | `integer/boolean`                                  |
| Fraction from 0 to 1        | `real/percentage`                                  |
| Arbitrary SQLite scalar     | `any`                                              |

## Null, defaults, and canonical values

JSON `null` becomes SQL `NULL` only when the column is nullable. Non-nullable
columns reject it. Literal defaults go through the same checks and conversion as values in a
write request.

For example, this default is stored as a UTC instant rather than preserving its
input offset:

```json
{
  "name": "observed_at",
  "type": "text/datetime",
  "nullable": false,
  "default": { "literal": "2026-07-11T09:30:00-04:00" },
  "comment": "UTC instant represented by this observation."
}
```

The example default becomes `2026-07-11T13:30:00.000Z`.

## Base storage types

| Type      | Accepted JSON value                                | Stored behavior                                                                      |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `text`    | String                                             | Stores the string unchanged.                                                         |
| `integer` | Safe integer                                       | Stores the integer unchanged.                                                        |
| `real`    | Finite number                                      | Stores the number unchanged.                                                         |
| `blob`    | Base64 string                                      | Decodes and stores bytes.                                                            |
| `any`     | String, finite number, boolean, or nullable `null` | Stores a SQLite scalar; booleans become `0` or `1`. Objects and arrays are rejected. |

## Text types

| Type                 | Accepted form                                                                 | Normalization or options                                                     |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `text/uuid`          | UUID with a version digit from 1 through 8 and RFC variant bits               | Lowercase.                                                                   |
| `text/ulid`          | 26-character ULID                                                             | Uppercase.                                                                   |
| `text/slug`          | Lowercase letters and digits separated by single hyphens                      | None.                                                                        |
| `text/git-oid`       | Hexadecimal object ID                                                         | Lowercase; set `type_options.length` explicitly to 40 or 64.                 |
| `text/date`          | Valid `YYYY-MM-DD` calendar date                                              | Rejects rollover dates such as `2025-02-30`.                                 |
| `text/time`          | `HH:MM:SS`, optional fractional seconds, optional `Z` or numeric offset       | None.                                                                        |
| `text/datetime`      | ISO-like instant with `Z` or numeric offset                                   | Converts to a UTC ISO string.                                                |
| `text/json`          | JSON object, array, string, finite number, or boolean                         | Stores compact JSON text.                                                    |
| `text/markdown`      | String                                                                        | No content transformation.                                                   |
| `text/html`          | String                                                                        | No content transformation.                                                   |
| `text/url`           | URL with a protocol and hostname                                              | None.                                                                        |
| `text/uri`           | String beginning with a URI scheme                                            | None.                                                                        |
| `text/email`         | Basic local-part, `@`, and dotted-domain form                                 | None.                                                                        |
| `text/ip`            | IPv4 or IPv6 address                                                          | None.                                                                        |
| `text/cidr`          | IP address plus valid prefix length                                           | None.                                                                        |
| `text/hostname`      | DNS-style hostname up to 253 characters                                       | Lowercase.                                                                   |
| `text/path`          | String without a null byte                                                    | Platform-neutral validation only.                                            |
| `text/path-posix`    | String without a null byte or backslash                                       | None.                                                                        |
| `text/path-relative` | String that does not start with `/` or contain a slash-separated `..` segment | None.                                                                        |
| `text/git-ref`       | String excluding Git's forbidden ref patterns                                 | None.                                                                        |
| `text/semver`        | Semantic version with optional prerelease and build suffixes                  | None.                                                                        |
| `text/base64`        | Valid padded base64 text                                                      | Stores text rather than decoded bytes.                                       |
| `text/hex`           | Even-length hexadecimal text                                                  | Lowercase.                                                                   |
| `text/sha256`        | 64 hexadecimal characters                                                     | Lowercase.                                                                   |
| `text/sha512`        | 128 hexadecimal characters                                                    | Lowercase.                                                                   |
| `text/decimal`       | Signed decimal string without exponent notation                               | Requires integer `precision` and `scale`; pads fractional digits to `scale`. |
| `text/enum`          | One configured string                                                         | Requires `type_options.values`.                                              |

### Git object IDs

Set `type_options.length` explicitly for `text/git-oid`. The current default
validator rejects ordinary Git hashes when the option is omitted.

For a SHA-1 repository, this column accepts a 40-character hexadecimal ID and
stores it in lowercase:

```json
{
  "name": "commit_id",
  "type": "text/git-oid",
  "type_options": { "length": 40 },
  "nullable": false,
  "comment": "Git commit containing the change."
}
```

Use `64` for a SHA-256 repository.

### Exact decimals

Configure an exact decimal with six total digits and two fractional digits:

```json
{
  "name": "amount",
  "type": "text/decimal",
  "type_options": { "precision": 6, "scale": 2 },
  "nullable": false,
  "comment": "Exact transaction amount in account currency."
}
```

An input of `"12.5"` is stored as `"12.50"`; exponent notation and values
exceeding the configured precision or scale are rejected.

### Allowed strings

Use an enum when only a known set of strings is valid:

```json
{
  "name": "state",
  "type": "text/enum",
  "type_options": { "values": ["open", "closed"] },
  "nullable": false,
  "comment": "Whether the issue still needs work."
}
```

The column accepts `"open"` and `"closed"`. It rejects other strings and `null`.

## Integer, real, and blob types

| Type                        | Accepted form                      | Additional behavior                               |
| --------------------------- | ---------------------------------- | ------------------------------------------------- |
| `integer/boolean`           | JSON boolean or integer `0` or `1` | Stores `0` or `1`; row output renders a boolean.  |
| `integer/positive`          | Safe integer greater than zero     | Adds a physical check.                            |
| `integer/nonnegative`       | Safe integer zero or greater       | Adds a physical check.                            |
| `integer/port`              | Safe integer from 0 through 65535  | Adds a physical check.                            |
| `integer/unix-seconds`      | Safe integer                       | Unit meaning is documented, not range-limited.    |
| `integer/unix-milliseconds` | Safe integer                       | Unit meaning is documented, not range-limited.    |
| `integer/duration-ms`       | Nonnegative safe integer           | Adds a physical check.                            |
| `integer/money-minor`       | Safe integer                       | Unit meaning is documented by the column comment. |
| `real/percentage`           | Finite number from 0 through 1     | Adds a physical check.                            |
| `blob/bytes`                | Base64 JSON string                 | Decodes and stores bytes.                         |

`real/percentage` uses fractions: `0.25` means 25%; `25` is rejected. For
`integer/money-minor`, document the unit, such as cents, in the column comment.
The type does not choose a currency for you.

Text validation checks form, not whether a resource exists or is safe to use.
For example, `text/url` does not fetch the URL, and `text/path-relative` does
not make a path safe for every operating system. `text/html` stores its input
without sanitizing it.
