# Semantic Types

> Select the narrowest type whose accepted JSON values and normalization rules match the domain; this page covers the built-in registry in Silo 0.1.

All columns use one of SQLite's `TEXT`, `INTEGER`, `REAL`, `BLOB`, or `ANY` storage classes. Semantic types add input validation, canonicalization, output rendering, or physical checks. JSON `null` becomes SQL `NULL` only when the column is nullable.

## Base types

| Type      | Input                                  | Behavior                                                                                  |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `text`    | JSON string                            | Stores the string unchanged.                                                              |
| `integer` | Safe JSON integer                      | Stores the integer unchanged.                                                             |
| `real`    | Finite JSON number                     | Stores the number unchanged.                                                              |
| `blob`    | Base64 JSON string                     | Decodes and stores bytes.                                                                 |
| `any`     | JSON string, finite number, or boolean | Stores SQLite scalar values; booleans become `0` or `1`. Objects and arrays are rejected. |

## Text types

| Type                 | Accepted form                                                           | Normalization or options                                                     |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `text/uuid`          | RFC-style UUID with a supported version nibble                          | Lowercase.                                                                   |
| `text/ulid`          | 26-character ULID                                                       | Uppercase.                                                                   |
| `text/slug`          | Lowercase letters and digits separated by single hyphens                | None.                                                                        |
| `text/git-oid`       | Hexadecimal object ID                                                   | Lowercase; `type_options.length` defaults to 40 or 64.                       |
| `text/date`          | Valid `YYYY-MM-DD` calendar date                                        | Rejects rollover dates such as `2025-02-30`.                                 |
| `text/time`          | `HH:MM:SS`, optional fractional seconds, optional `Z` or numeric offset | None.                                                                        |
| `text/datetime`      | ISO-like instant with `Z` or numeric offset                             | Converts to a UTC ISO string.                                                |
| `text/json`          | JSON object, array, string, finite number, or boolean                   | Stores compact JSON text.                                                    |
| `text/markdown`      | JSON string                                                             | No content transformation.                                                   |
| `text/html`          | JSON string                                                             | No content transformation.                                                   |
| `text/url`           | URL with a protocol and hostname                                        | None.                                                                        |
| `text/uri`           | String beginning with a URI scheme                                      | None.                                                                        |
| `text/email`         | Basic local-part, `@`, and dotted-domain form                           | None.                                                                        |
| `text/ip`            | IPv4 or IPv6 address                                                    | None.                                                                        |
| `text/cidr`          | IP address plus valid prefix length                                     | None.                                                                        |
| `text/hostname`      | DNS-style hostname up to 253 characters                                 | Lowercase.                                                                   |
| `text/path`          | String without a null byte                                              | Platform-neutral validation only.                                            |
| `text/path-posix`    | String without a null byte or backslash                                 | None.                                                                        |
| `text/path-relative` | Non-absolute path with no `..` segment                                  | None.                                                                        |
| `text/git-ref`       | String excluding Git's forbidden ref patterns                           | None.                                                                        |
| `text/semver`        | Semantic version with optional prerelease and build suffixes            | None.                                                                        |
| `text/base64`        | Valid padded base64 text                                                | Stores text rather than decoded bytes.                                       |
| `text/hex`           | Even-length hexadecimal text                                            | Lowercase.                                                                   |
| `text/sha256`        | 64 hexadecimal characters                                               | Lowercase.                                                                   |
| `text/sha512`        | 128 hexadecimal characters                                              | Lowercase.                                                                   |
| `text/decimal`       | Signed decimal string without exponent notation                         | Requires integer `precision` and `scale`; pads fractional digits to `scale`. |
| `text/enum`          | One of the configured strings                                           | Requires `type_options.values`.                                              |

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

An input of `"12.5"` is stored as `"12.50"`; exponent notation and values exceeding the configured precision or scale are rejected.

## Integer, real, and blob types

| Type                        | Accepted form                      | Behavior                                          |
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

Literal defaults pass through the same semantic validation and canonicalization as row input. This request therefore stores the default as the canonical UTC instant rather than preserving its input offset:

```json
{
  "name": "observed_at",
  "type": "text/datetime",
  "nullable": false,
  "default": { "literal": "2026-07-11T09:30:00-04:00" },
  "comment": "UTC instant represented by this observation."
}
```
