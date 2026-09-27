use std::net::IpAddr;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, NaiveDate};
use serde_json::Value;
use silo_core::{ColumnDefinition, SiloError, exits};

pub fn semantic_storage(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "text" | "text/uuid" | "text/ulid" | "text/slug" | "text/git-oid" | "text/date"
        | "text/time" | "text/datetime" | "text/json" | "text/markdown" | "text/html"
        | "text/url" | "text/uri" | "text/email" | "text/ip" | "text/cidr" | "text/hostname"
        | "text/path" | "text/path-posix" | "text/path-relative" | "text/git-ref"
        | "text/semver" | "text/base64" | "text/hex" | "text/sha256" | "text/sha512"
        | "text/decimal" | "text/enum" => "TEXT",
        "integer"
        | "integer/boolean"
        | "integer/positive"
        | "integer/nonnegative"
        | "integer/port"
        | "integer/unix-seconds"
        | "integer/unix-milliseconds"
        | "integer/duration-ms"
        | "integer/money-minor" => "INTEGER",
        "real" | "real/percentage" => "REAL",
        "blob" | "blob/bytes" => "BLOB",
        "any" => "ANY",
        _ => return None,
    })
}

pub fn canonicalize(column: &ColumnDefinition, value: &Value) -> Result<Value, SiloError> {
    if value.is_null() {
        if column.nullable == Some(false) {
            return Err(invalid(column, "Column is not nullable."));
        }
        return Ok(Value::Null);
    }
    let valid_text = || {
        value.as_str().ok_or_else(|| {
            invalid(
                column,
                format!("{} requires a JSON string.", column.semantic_type),
            )
        })
    };
    let canonical = match column.semantic_type.as_str() {
        "text" | "text/markdown" | "text/html" | "text/path" | "text/path-posix"
        | "text/path-relative" => Value::String(valid_text()?.to_owned()),
        "text/uuid" => {
            let text = valid_text()?;
            if !uuid_valid(text) {
                return Err(invalid(column, "Value is not valid for text/uuid."));
            }
            Value::String(text.to_lowercase())
        }
        "text/ulid" => {
            let text = valid_text()?;
            if text.len() != 26
                || !text
                    .chars()
                    .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c.to_ascii_uppercase()))
            {
                return Err(invalid(column, "Value is not valid for text/ulid."));
            }
            Value::String(text.to_uppercase())
        }
        "text/slug" => {
            let text = valid_text()?;
            if text.is_empty()
                || text.starts_with('-')
                || text.ends_with('-')
                || text.split('-').any(|part| {
                    part.is_empty()
                        || !part
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                })
            {
                return Err(invalid(column, "Value is not valid for text/slug."));
            }
            Value::String(text.to_owned())
        }
        "text/git-oid" => {
            let text = valid_text()?;
            let length = column
                .type_options
                .as_ref()
                .and_then(|map| map.get("length"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if !matches!(length, 0 | 40 | 64)
                || !text.chars().all(|c| c.is_ascii_hexdigit())
                || if length == 0 {
                    !matches!(text.len(), 40 | 64)
                } else {
                    text.len() != length
                }
            {
                return Err(invalid(column, "Value is not valid for text/git-oid."));
            }
            Value::String(text.to_lowercase())
        }
        "text/date" => {
            let text = valid_text()?;
            if NaiveDate::parse_from_str(text, "%Y-%m-%d").is_err() {
                return Err(invalid(column, "Value is not valid for text/date."));
            }
            Value::String(text.to_owned())
        }
        "text/time" => {
            let text = valid_text()?;
            if !valid_time(text) {
                return Err(invalid(column, "Value is not valid for text/time."));
            }
            Value::String(text.to_owned())
        }
        "text/datetime" => {
            let text = valid_text()?;
            let parsed = DateTime::parse_from_rfc3339(text)
                .map_err(|_| invalid(column, "Value is not valid for text/datetime."))?;
            Value::String(
                parsed
                    .to_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        }
        "text/json" => Value::String(
            serde_json::to_string(value)
                .map_err(|_| invalid(column, "Value cannot be represented as JSON."))?,
        ),
        "text/url" => {
            let text = valid_text()?;
            if url::Url::parse(text).is_err()
                || url::Url::parse(text)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                    .is_none()
            {
                return Err(invalid(column, "Value is not valid for text/url."));
            }
            Value::String(text.to_owned())
        }
        "text/uri" => {
            let text = valid_text()?;
            let (scheme, _) = text.split_once(':').unwrap_or(("", ""));
            if scheme.is_empty()
                || !scheme.chars().enumerate().all(|(index, character)| {
                    if index == 0 {
                        character.is_ascii_alphabetic()
                    } else {
                        character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
                    }
                })
            {
                return Err(invalid(column, "Value is not valid for text/uri."));
            }
            Value::String(text.to_owned())
        }
        "text/email" => {
            let text = valid_text()?;
            let (local, domain) = text
                .split_once('@')
                .ok_or_else(|| invalid(column, "Value is not valid for text/email."))?;
            let (domain_before_dot, domain_after_dot) = domain
                .split_once('.')
                .ok_or_else(|| invalid(column, "Value is not valid for text/email."))?;
            if local.is_empty()
                || local.contains('@')
                || domain_before_dot.is_empty()
                || domain_after_dot.is_empty()
                || domain_after_dot.contains('@')
                || text.chars().any(char::is_whitespace)
            {
                return Err(invalid(column, "Value is not valid for text/email."));
            }
            Value::String(text.to_owned())
        }
        "text/ip" => {
            let text = valid_text()?;
            if text.parse::<IpAddr>().is_err() {
                return Err(invalid(column, "Value is not valid for text/ip."));
            }
            Value::String(text.to_owned())
        }
        "text/cidr" => {
            let text = valid_text()?;
            let (address, prefix) = text
                .split_once('/')
                .ok_or_else(|| invalid(column, "Value is not valid for text/cidr."))?;
            let address = address
                .parse::<IpAddr>()
                .map_err(|_| invalid(column, "Value is not valid for text/cidr."))?;
            let bits = prefix
                .parse::<u8>()
                .map_err(|_| invalid(column, "Value is not valid for text/cidr."))?;
            if bits > if address.is_ipv4() { 32 } else { 128 } {
                return Err(invalid(column, "Value is not valid for text/cidr."));
            }
            Value::String(text.to_owned())
        }
        "text/hostname" => {
            let text = valid_text()?;
            if text.len() > 253
                || text.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                        || label.starts_with('-')
                        || label.ends_with('-')
                })
            {
                return Err(invalid(column, "Value is not valid for text/hostname."));
            }
            Value::String(text.to_lowercase())
        }
        "text/git-ref" => {
            let text = valid_text()?;
            if text.contains("..")
                || text.contains("@{")
                || text.ends_with('/')
                || text.ends_with(".lock")
                || text
                    .split('/')
                    .any(|part| part.starts_with('.') || part.is_empty())
                || text.chars().any(|c| {
                    matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\') || c.is_whitespace()
                })
            {
                return Err(invalid(column, "Value is not valid for text/git-ref."));
            }
            Value::String(text.to_owned())
        }
        "text/semver" => {
            let text = valid_text()?;
            if !valid_semver(text) {
                return Err(invalid(column, "Value is not valid for text/semver."));
            }
            Value::String(text.to_owned())
        }
        "text/base64" | "blob" | "blob/bytes" => {
            let text = valid_text()?;
            let decoded = STANDARD
                .decode(text)
                .map_err(|_| invalid(column, "Value is not valid base64."))?;
            if column.semantic_type.starts_with("text/") {
                Value::String(STANDARD.encode(decoded))
            } else {
                Value::Array(
                    decoded
                        .into_iter()
                        .map(|byte| Value::from(byte as u64))
                        .collect(),
                )
            }
        }
        "text/hex" | "text/sha256" | "text/sha512" => {
            let text = valid_text()?;
            let expected = match column.semantic_type.as_str() {
                "text/sha256" => Some(64),
                "text/sha512" => Some(128),
                _ => None,
            };
            if (text.len() % 2 != 0)
                || !text.chars().all(|c| c.is_ascii_hexdigit())
                || expected.is_some_and(|length| text.len() != length)
            {
                return Err(invalid(
                    column,
                    format!("Value is not valid for {}.", column.semantic_type),
                ));
            }
            Value::String(text.to_lowercase())
        }
        "text/decimal" => Value::String(canonical_decimal(valid_text()?, column)?),
        "text/enum" => {
            let text = valid_text()?;
            if !column
                .type_options
                .as_ref()
                .and_then(|map| map.get("values"))
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|item| item == text))
            {
                return Err(invalid(column, "Value is not valid for text/enum."));
            }
            Value::String(text.to_owned())
        }
        "integer/boolean" if value.is_boolean() => Value::from(value.as_bool().unwrap() as i64),
        "integer/boolean" => {
            let number = safe_integer(value)
                .ok_or_else(|| invalid(column, "Value is not valid for integer/boolean."))?;
            if !matches!(number, 0 | 1) {
                return Err(invalid(column, "Value is not valid for integer/boolean."));
            }
            Value::from(number)
        }
        kind if kind.starts_with("integer") => {
            let number = safe_integer(value).ok_or_else(|| {
                invalid(
                    column,
                    format!("Value is not valid for {}.", column.semantic_type),
                )
            })?;
            let okay = match kind {
                "integer/positive" => number > 0,
                "integer/nonnegative" | "integer/duration-ms" => number >= 0,
                "integer/port" => (0..=65535).contains(&number),
                _ => true,
            };
            if !okay {
                return Err(invalid(
                    column,
                    format!("Value is not valid for {}.", column.semantic_type),
                ));
            }
            Value::from(number)
        }
        "real" | "real/percentage" => {
            let number = value
                .as_f64()
                .ok_or_else(|| invalid(column, "real requires a finite JSON number."))?;
            if !number.is_finite()
                || (column.semantic_type == "real/percentage" && !(0.0..=1.0).contains(&number))
            {
                return Err(invalid(
                    column,
                    format!("Value is not valid for {}.", column.semantic_type),
                ));
            }
            Value::from(number)
        }
        "any" => match value {
            Value::String(_) | Value::Number(_) => value.clone(),
            Value::Bool(value) => Value::from(*value as i64),
            _ => {
                return Err(invalid(
                    column,
                    "any accepts only strings, finite numbers, booleans, or null.",
                ));
            }
        },
        kind => {
            return Err(SiloError::new(
                exits::SCHEMA,
                "unknown_semantic_type",
                format!("{kind} is not registered."),
            )
            .at(format!("columns.{}.type", column.name)));
        }
    };
    Ok(canonical)
}

fn invalid(column: &ColumnDefinition, message: impl Into<String>) -> SiloError {
    SiloError::new(exits::SCHEMA, "invalid_semantic_value", message).at(&column.name)
}

fn uuid_valid(text: &str) -> bool {
    let parts: Vec<_> = text.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(parts).all(|(length, part)| {
            part.len() == *length && part.chars().all(|c| c.is_ascii_hexdigit())
        })
        && text
            .as_bytes()
            .get(14)
            .is_some_and(|version| matches!(version.to_ascii_lowercase(), b'1'..=b'8'))
        && text.as_bytes().get(19).is_some_and(|variant| {
            matches!(variant.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        })
}

fn valid_time(text: &str) -> bool {
    let has_z = text.ends_with('Z');
    let value = text.strip_suffix('Z').unwrap_or(text);
    let (value, offset) = if value.len() >= 6
        && value
            .as_bytes()
            .get(value.len() - 6)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
    {
        let start = value.len() - 6;
        if !value.is_char_boundary(start) || has_z {
            return false;
        }
        (&value[..start], Some(&value[start..]))
    } else {
        (value, None)
    };
    if let Some(offset) = offset {
        let bytes = offset.as_bytes();
        if bytes.len() != 6
            || !matches!(bytes[0], b'+' | b'-')
            || bytes[3] != b':'
            || !bytes[1..3].iter().all(u8::is_ascii_digit)
            || !bytes[4..6].iter().all(u8::is_ascii_digit)
        {
            return false;
        }
    }
    let (clock, fraction) = value
        .split_once('.')
        .map_or((value, None), |(clock, fraction)| (clock, Some(fraction)));
    if fraction.is_some_and(|fraction| {
        fraction.is_empty()
            || fraction.len() > 9
            || !fraction.chars().all(|character| character.is_ascii_digit())
    }) {
        return false;
    }
    let parts = clock.split(':').collect::<Vec<_>>();
    parts.len() == 3
        && parts[0].len() == 2
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts[0].parse::<u8>().is_ok_and(|number| number < 24)
        && parts[1].parse::<u8>().is_ok_and(|number| number < 60)
        && parts[2].parse::<u8>().is_ok_and(|number| number < 60)
}

fn safe_integer(value: &Value) -> Option<i64> {
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    value
        .as_i64()
        .filter(|number| number.unsigned_abs() <= MAX_SAFE)
        .or_else(|| {
            value.as_f64().and_then(|number| {
                (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE as f64)
                    .then_some(number as i64)
            })
        })
}

fn valid_semver(text: &str) -> bool {
    let core = text.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.parse::<u64>().is_ok()
                && (part == &"0" || !part.starts_with('0'))
        })
}

fn canonical_decimal(text: &str, column: &ColumnDefinition) -> Result<String, SiloError> {
    let options = column.type_options.as_ref();
    let precision = options
        .and_then(|values| values.get("precision"))
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(column, "text/decimal requires precision and scale."))?
        as usize;
    let scale = options
        .and_then(|values| values.get("scale"))
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(column, "text/decimal requires precision and scale."))?
        as usize;
    if precision == 0 || scale > precision {
        return Err(invalid(
            column,
            "text/decimal requires 0 <= scale <= precision.",
        ));
    }
    let text = text.strip_prefix('+').unwrap_or(text);
    let negative = text.starts_with('-');
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (whole, fractional) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty()
        || !whole.chars().all(|c| c.is_ascii_digit())
        || !fractional.chars().all(|c| c.is_ascii_digit())
        || fractional.len() > scale
    {
        return Err(invalid(
            column,
            "Decimal value exceeds its configured scale or uses an unsupported form.",
        ));
    }
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    if whole.len() + scale > precision {
        return Err(invalid(
            column,
            "Decimal value exceeds its configured precision.",
        ));
    }
    let fractional = format!("{fractional:0<scale$}");
    let sign = if negative && (whole != "0" || fractional.chars().any(|c| c != '0')) {
        "-"
    } else {
        ""
    };
    Ok(if scale == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fractional}")
    })
}
