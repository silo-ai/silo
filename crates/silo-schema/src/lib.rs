mod registry;

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::Value;
use silo_core::{
    CheckDefinition, ColumnDefinition, DefaultValue, ForeignKeyDefinition, IndexDefinition,
    LogicalSchema, RelationDefinition, SiloError, TableDefinition, exits,
};

pub use registry::{canonicalize, semantic_storage};

const IDENTIFIER: &str = "^[A-Za-z_][A-Za-z0-9_]*$";
const ACTIONS: &[&str] = &[
    "NO ACTION",
    "RESTRICT",
    "SET NULL",
    "SET DEFAULT",
    "CASCADE",
];

pub fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn validate_identifier(name: &str, path: &str) -> Result<(), SiloError> {
    let valid = name.chars().enumerate().all(|(index, character)| {
        if index == 0 {
            character == '_' || character.is_ascii_alphabetic()
        } else {
            character == '_' || character.is_ascii_alphanumeric()
        }
    });
    if !valid || name.to_lowercase().starts_with("_silo_") {
        return Err(SiloError::new(
            exits::SCHEMA,
            "invalid_identifier",
            "Expected a SQLite identifier outside the reserved _silo_ namespace.",
        )
        .at(path));
    }
    let _ = IDENTIFIER;
    Ok(())
}

fn input_error(path: &str, error: impl std::fmt::Display) -> SiloError {
    SiloError::new(exits::INPUT, "invalid_shape", error.to_string()).at(path)
}

pub fn parse_table(value: Value) -> Result<TableDefinition, SiloError> {
    let table: TableDefinition = serde_json::from_value(value).map_err(|e| input_error("$", e))?;
    validate_table(&table)?;
    Ok(table)
}

pub fn parse_relation(value: Value, path: &str) -> Result<RelationDefinition, SiloError> {
    let relation: RelationDefinition =
        serde_json::from_value(value).map_err(|e| input_error(path, e))?;
    validate_identifier(&relation.from.table, &format!("{path}.from.table"))?;
    validate_identifier(&relation.to.table, &format!("{path}.to.table"))?;
    let Some(name) = relation.from.name.as_deref() else {
        return Err(SiloError::new(
            exits::SCHEMA,
            "invalid_relation",
            "The source relation endpoint requires a name.",
        )
        .at(format!("{path}.from.name")));
    };
    validate_identifier(name, &format!("{path}.from.name"))?;
    for (label, columns) in [
        ("from", &relation.from.columns),
        ("to", &relation.to.columns),
    ] {
        if columns.is_empty() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_relation",
                "Relation endpoint columns must be a non-empty array.",
            )
            .at(format!("{path}.{label}.columns")));
        }
        for (index, column) in columns.iter().enumerate() {
            validate_identifier(column, &format!("{path}.{label}.columns[{index}]"))?;
        }
    }
    if relation.comment.trim().is_empty() {
        return Err(SiloError::new(
            exits::SCHEMA,
            "comment_required",
            "A non-empty relation comment is required.",
        )
        .at(format!("{path}.comment")));
    }
    match (&relation.inverse_name, &relation.inverse_comment) {
        (Some(name), Some(comment)) => {
            validate_identifier(name, &format!("{path}.inverse_name"))?;
            if comment.trim().is_empty() {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "comment_required",
                    "A non-empty inverse relation comment is required.",
                )
                .at(format!("{path}.inverse_comment")));
            }
        }
        (Some(_), None) => {
            return Err(SiloError::new(
                exits::SCHEMA,
                "comment_required",
                "A non-empty inverse relation comment is required when inverse_name is provided.",
            )
            .at(format!("{path}.inverse_comment")));
        }
        (None, Some(_)) => {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_relation",
                "inverse_comment requires inverse_name.",
            )
            .at(format!("{path}.inverse_comment")));
        }
        (None, None) => {}
    }
    Ok(relation)
}

pub fn parse_schema(value: Value) -> Result<LogicalSchema, SiloError> {
    let schema: LogicalSchema = serde_json::from_value(value).map_err(|e| input_error("$", e))?;
    validate_schema(&schema)?;
    Ok(schema)
}

pub fn empty_schema() -> LogicalSchema {
    LogicalSchema {
        format_version: 1,
        registry_version: 1,
        revision: 0,
        tables: Vec::new(),
        relations: None,
        template_imports: None,
        agent_instructions: None,
    }
}

pub fn validate_table(table: &TableDefinition) -> Result<(), SiloError> {
    validate_identifier(&table.name, "$.name")?;
    if table.comment.trim().is_empty() {
        return Err(SiloError::new(
            exits::SCHEMA,
            "comment_required",
            "A non-empty table comment is required.",
        )
        .at("$.comment"));
    }
    if table.columns.is_empty() {
        return Err(SiloError::new(
            exits::SCHEMA,
            "invalid_table",
            "A table requires at least one column.",
        )
        .at("$.columns"));
    }
    let mut names = BTreeSet::new();
    for (index, column) in table.columns.iter().enumerate() {
        let path = format!("$.columns[{index}]");
        validate_identifier(&column.name, &format!("{path}.name"))?;
        if !names.insert(column.name.to_lowercase()) {
            return Err(SiloError::new(
                exits::SCHEMA,
                "duplicate_column",
                "Column names are case-insensitively unique.",
            )
            .at(format!("{path}.name")));
        }
        if column.comment.trim().is_empty() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "comment_required",
                "A non-empty column comment is required.",
            )
            .at(format!("{path}.comment")));
        }
        semantic_storage(&column.semantic_type).ok_or_else(|| {
            SiloError::new(
                exits::SCHEMA,
                "unknown_semantic_type",
                format!("{} is not registered.", column.semantic_type),
            )
            .at(format!("{path}.type"))
        })?;
        if let Some(DefaultValue::Expression(default)) = &column.default
            && default.expression.trim().is_empty()
        {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_default",
                "A default expression cannot be empty.",
            )
            .at(format!("{path}.default.expression")));
        }
        if let Some(DefaultValue::Literal(default)) = &column.default {
            canonicalize(column, &default.literal)
                .map_err(|error| error.at(format!("{path}.default.literal")))?;
        }
        if column.generated.is_some() && column.default.is_some() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "incompatible_features",
                "A generated column cannot have a default.",
            )
            .at(&path));
        }
        if let Some(generated) = &column.generated {
            if generated.expression.trim().is_empty() {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "invalid_generated_column",
                    "A generated column requires an expression.",
                )
                .at(format!("{path}.generated.expression")));
            }
            if !matches!(
                generated.storage.as_deref(),
                None | Some("VIRTUAL") | Some("STORED")
            ) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "invalid_generated_column",
                    "Generated storage must be VIRTUAL or STORED.",
                )
                .at(format!("{path}.generated.storage")));
            }
        }
    }
    for key in table.primary_key.as_deref().unwrap_or_default() {
        if !names.contains(&key.to_lowercase()) {
            return Err(SiloError::new(
                exits::SCHEMA,
                "missing_primary_key_column",
                format!("{key} does not exist on {}.", table.name),
            )
            .at("$.primary_key"));
        }
    }
    for (index, foreign) in table
        .foreign_keys
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        validate_foreign_key_shape(foreign)?;
        for (position, column) in foreign.columns.iter().enumerate() {
            if !names.contains(&column.to_lowercase()) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "missing_column",
                    "Foreign-key column does not exist.",
                )
                .at(format!("$.foreign_keys[{index}].columns[{position}]")));
            }
        }
        validate_identifier(
            &foreign.references.table,
            &format!("$.foreign_keys[{index}].references.table"),
        )?;
        for (position, column) in foreign.references.columns.iter().enumerate() {
            validate_identifier(
                column,
                &format!("$.foreign_keys[{index}].references.columns[{position}]"),
            )?;
        }
    }
    for (index, unique) in table
        .unique_constraints
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if unique.columns.is_empty() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_unique",
                "Unique constraints require columns.",
            )
            .at(format!("$.unique_constraints[{index}].columns")));
        }
        if let Some(name) = &unique.name {
            validate_identifier(name, &format!("$.unique_constraints[{index}].name"))?;
        }
        for (position, column) in unique.columns.iter().enumerate() {
            if !names.contains(&column.to_lowercase()) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "missing_column",
                    "Unique column does not exist.",
                )
                .at(format!("$.unique_constraints[{index}].columns[{position}]")));
            }
        }
    }
    for (index, definition) in table
        .indexes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if let Some(name) = &definition.name {
            validate_identifier(name, &format!("$.indexes[{index}].name"))?;
        }
        if definition.columns.is_empty() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_index",
                "Indexes require columns or expressions.",
            )
            .at(format!("$.indexes[{index}].columns")));
        }
        for (position, part) in definition.columns.iter().enumerate() {
            match (&part.column, &part.expression) {
                (Some(column), None) => {
                    validate_identifier(
                        column,
                        &format!("$.indexes[{index}].columns[{position}].column"),
                    )?;
                    if !names.contains(&column.to_lowercase()) {
                        return Err(SiloError::new(
                            exits::SCHEMA,
                            "missing_column",
                            "Indexed column does not exist.",
                        )
                        .at(format!("$.indexes[{index}].columns[{position}].column")));
                    }
                }
                (None, Some(expression)) if !expression.trim().is_empty() => {}
                (None, None) => {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "invalid_index",
                        "Index part requires column or expression.",
                    )
                    .at(format!("$.indexes[{index}].columns[{position}]")));
                }
                _ => {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "invalid_index",
                        "Index part requires exactly one of column or expression.",
                    )
                    .at(format!("$.indexes[{index}].columns[{position}]")));
                }
            }
            if let Some(collate) = &part.collate {
                validate_identifier(
                    collate,
                    &format!("$.indexes[{index}].columns[{position}].collate"),
                )?;
            }
            if part
                .direction
                .as_deref()
                .is_some_and(|direction| !matches!(direction, "ASC" | "DESC"))
            {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "invalid_index",
                    "Index direction must be ASC or DESC.",
                )
                .at(format!("$.indexes[{index}].columns[{position}].direction")));
            }
        }
    }
    for (index, check) in table
        .checks
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if let Some(name) = &check.name {
            validate_identifier(name, &format!("$.checks[{index}].name"))?;
        }
        if check.expression.trim().is_empty() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_check",
                "Check expression is required.",
            )
            .at(format!("$.checks[{index}].expression")));
        }
    }
    if table.without_rowid == Some(true)
        && table
            .primary_key
            .as_deref()
            .is_none_or(|keys| keys.is_empty())
    {
        return Err(SiloError::new(
            exits::SCHEMA,
            "without_rowid_requires_key",
            "WITHOUT ROWID requires a primary key.",
        )
        .at("$.without_rowid"));
    }
    validate_policies(table)?;
    Ok(())
}

fn validate_foreign_key_shape(foreign: &ForeignKeyDefinition) -> Result<(), SiloError> {
    if foreign.columns.is_empty() || foreign.columns.len() != foreign.references.columns.len() {
        return Err(SiloError::new(
            exits::SCHEMA,
            "invalid_foreign_key",
            "Foreign-key columns and referenced columns must be non-empty and have equal length.",
        )
        .at("$.foreign_keys"));
    }
    for action in [&foreign.on_update, &foreign.on_delete]
        .into_iter()
        .flatten()
    {
        if !ACTIONS.contains(&action.to_uppercase().as_str()) {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_foreign_key_action",
                format!("Unsupported foreign-key action {action}."),
            )
            .at("$.foreign_keys"));
        }
    }
    Ok(())
}

fn validate_policies(table: &TableDefinition) -> Result<(), SiloError> {
    let columns: BTreeMap<_, _> = table
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut seen = BTreeSet::<String>::new();
    for (index, policy) in table
        .policies
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let path = format!("$.policies[{index}]");
        if !seen.insert(policy.kind.clone()) {
            return Err(SiloError::new(
                exits::SCHEMA,
                "duplicate_policy",
                format!("Only one {} policy is allowed per table.", policy.kind),
            )
            .at(&path));
        }
        let allowed: &[&str] = match policy.kind.as_str() {
            "generated_identity" => &["column", "strategy"],
            "timestamps" => &["created_column", "updated_column"],
            "optimistic_revision" => &["column", "initial"],
            "immutable_rows" | "append_only" => &[],
            "immutable_columns" => &["columns"],
            "natural_key_upsert" => &["columns", "update_columns"],
            _ => {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "unknown_policy",
                    format!("{} is not registered.", policy.kind),
                )
                .at(format!("{path}.type")));
            }
        };
        if let Some(unknown) = policy
            .fields
            .keys()
            .find(|key| !allowed.contains(&key.as_str()))
        {
            return Err(SiloError::new(
                exits::SCHEMA,
                "unknown_field",
                format!("Unknown field {unknown}."),
            )
            .at(format!("{path}.{unknown}")));
        }
        let required_column = |key: &str| -> Result<&ColumnDefinition, SiloError> {
            let name = policy.string(key).ok_or_else(|| {
                SiloError::new(
                    exits::SCHEMA,
                    "policy_precondition",
                    format!("Policy requires an existing {key}."),
                )
                .at(format!("{path}.{key}"))
            })?;
            columns.get(name).copied().ok_or_else(|| {
                SiloError::new(
                    exits::SCHEMA,
                    "policy_precondition",
                    format!("Policy requires an existing {key}."),
                )
                .at(format!("{path}.{key}"))
            })
        };
        match policy.kind.as_str() {
            "generated_identity" => {
                let column = required_column("column")?;
                let strategy = policy.string("strategy").ok_or_else(|| {
                    SiloError::new(
                        exits::SCHEMA,
                        "invalid_identity_strategy",
                        "Identity strategy must be integer, uuid, or ulid.",
                    )
                    .at(format!("{path}.strategy"))
                })?;
                if !matches!(strategy, "integer" | "uuid" | "ulid") {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "invalid_identity_strategy",
                        "Identity strategy must be integer, uuid, or ulid.",
                    )
                    .at(format!("{path}.strategy")));
                }
                if strategy == "integer"
                    && (!table
                        .primary_key
                        .as_deref()
                        .is_some_and(|keys| keys.len() == 1 && keys[0] == column.name)
                        || column.semantic_type != "integer")
                {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "policy_precondition",
                        "Integer identity must be the table's single primary key.",
                    )
                    .at(&path));
                }
                if (strategy == "uuid" && column.semantic_type != "text/uuid")
                    || (strategy == "ulid" && column.semantic_type != "text/ulid")
                {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "policy_precondition",
                        format!("{strategy} identity requires its matching semantic type."),
                    )
                    .at(format!("{path}.column")));
                }
            }
            "timestamps" => {
                for key in ["created_column", "updated_column"] {
                    if policy.fields.contains_key(key) && policy.string(key).is_none() {
                        return Err(SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            format!("timestamps {key} must name a column."),
                        )
                        .at(format!("{path}.{key}")));
                    }
                }
                let created = policy.string("created_column");
                let updated = policy.string("updated_column");
                if created.is_none() && updated.is_none() {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "policy_precondition",
                        "timestamps requires a created_column or updated_column.",
                    )
                    .at(&path));
                }
                for (field, name) in [("created_column", created), ("updated_column", updated)] {
                    if let Some(name) = name
                        && columns
                            .get(name)
                            .is_none_or(|column| column.semantic_type != "text/datetime")
                    {
                        return Err(SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            format!("timestamps {field} requires text/datetime."),
                        )
                        .at(format!("{path}.{field}")));
                    }
                }
            }
            "optimistic_revision" => {
                let column = required_column("column")?;
                if !column.semantic_type.starts_with("integer") {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "policy_precondition",
                        "Optimistic revision requires an integer column.",
                    )
                    .at(format!("{path}.column")));
                }
                if let Some(initial) = policy.fields.get("initial") {
                    canonicalize(column, initial)
                        .map_err(|error| error.at(format!("{path}.initial")))?;
                }
            }
            "immutable_columns" => {
                let columns_list = policy
                    .strings("columns")
                    .filter(|columns| !columns.is_empty())
                    .ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            "immutable_columns requires columns.",
                        )
                        .at(format!("{path}.columns"))
                    })?;
                for name in columns_list {
                    if !columns.contains_key(name) {
                        return Err(SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            "Immutable column does not exist.",
                        )
                        .at(format!("{path}.columns")));
                    }
                }
            }
            "natural_key_upsert" => {
                let keys = policy
                    .strings("columns")
                    .filter(|columns| !columns.is_empty())
                    .ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            "natural_key_upsert requires columns.",
                        )
                        .at(format!("{path}.columns"))
                    })?;
                for name in &keys {
                    if !columns.contains_key(name) {
                        return Err(SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            "Natural-key column does not exist.",
                        )
                        .at(format!("{path}.columns")));
                    }
                }
                let updates = if policy.fields.contains_key("update_columns") {
                    policy.strings("update_columns").ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "policy_precondition",
                            "natural_key_upsert update_columns must be an array of column names.",
                        )
                        .at(format!("{path}.update_columns"))
                    })?
                } else {
                    Vec::new()
                };
                if updates.iter().any(|name| !columns.contains_key(name)) {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "policy_precondition",
                        "Natural-key update column does not exist.",
                    )
                    .at(format!("{path}.update_columns")));
                }
                let matches_key = |candidate: &[String]| {
                    candidate.len() == keys.len()
                        && candidate
                            .iter()
                            .zip(&keys)
                            .all(|(left, right)| left == right)
                };
                let primary_key = table.primary_key.as_deref().unwrap_or_default();
                let unique_key = table
                    .unique_constraints
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|unique| matches_key(&unique.columns));
                if !matches_key(primary_key) && !unique_key {
                    return Err(SiloError::new(exits::SCHEMA, "policy_precondition", "Natural-key upsert columns must exactly match a primary key or unique constraint.").at(format!("{path}.columns")));
                }
            }
            "immutable_rows" | "append_only" => {}
            _ => unreachable!("policy kinds were checked above"),
        }
    }
    if seen.contains("append_only") && seen.contains("immutable_rows") {
        return Err(SiloError::new(
            exits::SCHEMA,
            "incompatible_policies",
            "append_only and immutable_rows are redundant and cannot be combined.",
        )
        .at("$.policies"));
    }
    let immutable_or_append_only = seen.contains("append_only") || seen.contains("immutable_rows");
    if immutable_or_append_only
        && (seen.contains("optimistic_revision") || seen.contains("natural_key_upsert"))
    {
        return Err(SiloError::new(
            exits::SCHEMA,
            "incompatible_policies",
            "Immutable and append-only rows cannot use update-oriented policies.",
        )
        .at("$.policies"));
    }
    if immutable_or_append_only
        && table
            .policies
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|policy| policy.kind == "timestamps" && policy.string("updated_column").is_some())
    {
        return Err(SiloError::new(
            exits::SCHEMA,
            "incompatible_policies",
            "An updated timestamp cannot be combined with an immutable or append-only row.",
        )
        .at("$.policies"));
    }
    if let Some(immutable) = table
        .policies
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|policy| policy.kind == "immutable_columns")
    {
        let managed = table
            .policies
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|policy| match policy.kind.as_str() {
                "timestamps" => policy.string("updated_column"),
                "optimistic_revision" => policy.string("column"),
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if immutable
            .strings("columns")
            .is_some_and(|columns| columns.iter().any(|column| managed.contains(column)))
        {
            return Err(SiloError::new(
                exits::SCHEMA,
                "incompatible_policies",
                "CLI-managed update columns cannot also be immutable.",
            )
            .at("$.policies"));
        }
    }
    Ok(())
}

pub fn compile_schema(schema: &LogicalSchema) -> Result<Vec<String>, SiloError> {
    schema
        .tables
        .iter()
        .map(compile_table)
        .collect::<Result<Vec<_>, _>>()
        .map(|groups| groups.into_iter().flatten().collect())
}

pub fn compile_table(table: &TableDefinition) -> Result<Vec<String>, SiloError> {
    validate_table(table)?;
    let integer_identity = table
        .policies
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|policy| {
            policy.kind == "generated_identity" && policy.string("strategy") == Some("integer")
        });
    let mut constraints = Vec::new();
    if let Some(primary_key) = &table.primary_key
        && !primary_key.is_empty()
        && !integer_identity
    {
        constraints.push(format!(
            "PRIMARY KEY ({})",
            primary_key
                .iter()
                .map(|key| quote(key))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for unique in table.unique_constraints.as_deref().unwrap_or_default() {
        constraints.push(format!(
            "{}UNIQUE ({})",
            unique
                .name
                .as_deref()
                .map(|name| format!("CONSTRAINT {} ", quote(name)))
                .unwrap_or_default(),
            unique
                .columns
                .iter()
                .map(|name| quote(name))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for check in table.checks.as_deref().unwrap_or_default() {
        constraints.push(format!(
            "{}CHECK ({})",
            check
                .name
                .as_deref()
                .map(|name| format!("CONSTRAINT {} ", quote(name)))
                .unwrap_or_default(),
            check.expression
        ));
    }
    for foreign in table.foreign_keys.as_deref().unwrap_or_default() {
        let mut sql = format!(
            "FOREIGN KEY ({}) REFERENCES {} ({})",
            foreign
                .columns
                .iter()
                .map(|name| quote(name))
                .collect::<Vec<_>>()
                .join(", "),
            quote(&foreign.references.table),
            foreign
                .references
                .columns
                .iter()
                .map(|name| quote(name))
                .collect::<Vec<_>>()
                .join(", ")
        );
        if let Some(action) = &foreign.on_update {
            sql.push_str(&format!(" ON UPDATE {}", action.to_uppercase()));
        }
        if let Some(action) = &foreign.on_delete {
            sql.push_str(&format!(" ON DELETE {}", action.to_uppercase()));
        }
        if foreign.deferrable == Some(true) {
            sql.push_str(" DEFERRABLE");
            if foreign.initially_deferred == Some(true) {
                sql.push_str(" INITIALLY DEFERRED");
            }
        }
        constraints.push(sql);
    }
    let mut body = table
        .columns
        .iter()
        .map(|column| column_sql(column, table, integer_identity))
        .collect::<Result<Vec<_>, _>>()?;
    body.extend(constraints);
    let mut statements = vec![format!(
        "CREATE TABLE {} (\n  {}\n){};",
        quote(&table.name),
        body.join(",\n  "),
        {
            let options = [
                (table.strict != Some(false)).then_some("STRICT"),
                (table.without_rowid == Some(true)).then_some("WITHOUT ROWID"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            if options.is_empty() {
                String::new()
            } else {
                format!(" {}", options.join(", "))
            }
        }
    )];
    for (index, definition) in table
        .indexes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        statements.push(index_sql(table, definition, index)?);
    }
    statements.extend(compile_policy_triggers(table));
    Ok(statements)
}

pub fn compile_added_column(
    table: &TableDefinition,
    column: &ColumnDefinition,
) -> Result<String, SiloError> {
    let integer_identity = table
        .policies
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|policy| {
            policy.kind == "generated_identity" && policy.string("strategy") == Some("integer")
        });
    column_sql(column, table, integer_identity)
}

fn column_sql(
    column: &ColumnDefinition,
    table: &TableDefinition,
    integer_identity: bool,
) -> Result<String, SiloError> {
    let storage = semantic_storage(&column.semantic_type).expect("validated semantic type");
    let is_integer_identity = integer_identity
        && table
            .policies
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|policy| {
                policy.kind == "generated_identity"
                    && policy.string("column") == Some(column.name.as_str())
                    && policy.string("strategy") == Some("integer")
            });
    let mut pieces = vec![
        quote(&column.name),
        if is_integer_identity {
            "INTEGER".into()
        } else {
            storage.into()
        },
    ];
    if is_integer_identity {
        pieces.push("PRIMARY KEY".into());
    }
    if let Some(collate) = &column.collate {
        validate_identifier(collate, "$.collate")?;
        pieces.push(format!("COLLATE {}", quote(collate)));
    }
    if let Some(generated) = &column.generated {
        pieces.push(format!(
            "GENERATED ALWAYS AS ({}) {}",
            generated.expression,
            generated.storage.as_deref().unwrap_or("VIRTUAL")
        ));
    }
    if column.nullable == Some(false) && !is_integer_identity {
        pieces.push("NOT NULL".into());
    }
    if let Some(default) = &column.default {
        match default {
            DefaultValue::Literal(value) => {
                let value = canonicalize(column, &value.literal)?;
                let literal = if matches!(column.semantic_type.as_str(), "blob" | "blob/bytes") {
                    let bytes = value.as_array().ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "invalid_default",
                            "Blob default must use base64 text.",
                        )
                    })?;
                    let hex = bytes
                        .iter()
                        .map(|byte| {
                            byte.as_u64()
                                .and_then(|byte| u8::try_from(byte).ok())
                                .map(|byte| format!("{byte:02x}"))
                        })
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| {
                            SiloError::new(
                                exits::SCHEMA,
                                "invalid_default",
                                "Blob default contains an invalid byte.",
                            )
                        })?
                        .join("");
                    format!("X'{hex}'")
                } else {
                    sql_literal(&value)?
                };
                pieces.push(format!("DEFAULT {literal}"))
            }
            DefaultValue::Expression(value) => {
                pieces.push(format!("DEFAULT ({})", value.expression))
            }
        }
    }
    if let Some(check) = semantic_check(&column.semantic_type, &quote(&column.name), column) {
        pieces.push(format!("CHECK ({check})"));
    }
    if column.semantic_type == "text/enum"
        && let Some(values) = column
            .type_options
            .as_ref()
            .and_then(|options| options.get("values"))
            .and_then(Value::as_array)
    {
        let values = values
            .iter()
            .map(sql_literal)
            .collect::<Result<Vec<_>, _>>()?;
        pieces.push(format!(
            "CHECK ({} IN ({}))",
            quote(&column.name),
            values.join(", ")
        ));
    }
    Ok(pieces.join(" "))
}

fn index_sql(
    table: &TableDefinition,
    index: &IndexDefinition,
    position: usize,
) -> Result<String, SiloError> {
    let logical_name = index.name.as_deref().unwrap_or("");
    if !logical_name.is_empty() {
        validate_identifier(logical_name, "$.indexes.name")?;
    }
    let name = if logical_name.is_empty() {
        position.to_string()
    } else {
        logical_name.into()
    };
    let physical = format!("_silo_idx_{}_{}_{}", table.name.len(), table.name, name);
    let mut parts = Vec::new();
    for part in &index.columns {
        let mut sql = if let Some(column) = &part.column {
            validate_identifier(column, "$.indexes.columns.column")?;
            quote(column)
        } else if let Some(expression) = &part.expression {
            format!("({expression})")
        } else {
            return Err(SiloError::new(
                exits::SCHEMA,
                "invalid_index",
                "Index part requires column or expression.",
            )
            .at("$.indexes.columns"));
        };
        if let Some(collate) = &part.collate {
            validate_identifier(collate, "$.indexes.columns.collate")?;
            sql.push_str(&format!(" COLLATE {}", quote(collate)));
        }
        if let Some(direction) = &part.direction {
            if !matches!(direction.as_str(), "ASC" | "DESC") {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "invalid_index",
                    "Index direction must be ASC or DESC.",
                ));
            }
            sql.push_str(&format!(" {direction}"));
        }
        parts.push(sql);
    }
    Ok(format!(
        "CREATE {}INDEX {} ON {} ({}){};",
        if index.unique == Some(true) {
            "UNIQUE "
        } else {
            ""
        },
        quote(&physical),
        quote(&table.name),
        parts.join(", "),
        index
            .where_sql()
            .map(|clause| format!(" WHERE {clause}"))
            .unwrap_or_default()
    ))
}

fn compile_policy_triggers(table: &TableDefinition) -> Vec<String> {
    let mut statements = Vec::new();
    for (index, policy) in table
        .policies
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let name = format!("_silo_{}_{}_{}", table.name, policy.kind, index);
        match policy.kind.as_str() {
            "append_only" | "immutable_rows" => {
                for action in ["UPDATE", "DELETE"] {
                    let message = if action == "UPDATE" {
                        "updates"
                    } else {
                        "deletes"
                    };
                    statements.push(format!("CREATE TRIGGER {} BEFORE {} ON {} BEGIN SELECT RAISE(ABORT, '{} forbids {}'); END;", quote(&format!("{name}_{}", action.to_lowercase()),), action, quote(&table.name), policy.kind, message));
                }
            }
            "immutable_columns" => {
                if let Some(columns) = policy.strings("columns") {
                    let changed = columns
                        .into_iter()
                        .map(|column| format!("OLD.{} IS NOT NEW.{}", quote(column), quote(column)))
                        .collect::<Vec<_>>()
                        .join(" OR ");
                    statements.push(format!("CREATE TRIGGER {} BEFORE UPDATE ON {} WHEN {} BEGIN SELECT RAISE(ABORT, 'immutable column changed'); END;", quote(&name), quote(&table.name), changed));
                }
            }
            "timestamps" => {
                if let Some(column) = policy.string("updated_column") {
                    let locator = if table.without_rowid == Some(true) {
                        table
                            .primary_key
                            .as_deref()
                            .unwrap_or_default()
                            .iter()
                            .map(|key| format!("{} = NEW.{}", quote(key), quote(key)))
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    } else {
                        "rowid = NEW.rowid".into()
                    };
                    let column = quote(column);
                    statements.push(format!("CREATE TRIGGER {} AFTER UPDATE ON {} WHEN NEW.{column} IS OLD.{column} BEGIN UPDATE {} SET {column} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE {locator}; END;", quote(&name), quote(&table.name), quote(&table.name)));
                }
            }
            _ => {}
        }
    }
    statements
}

fn sql_literal(value: &Value) -> Result<String, SiloError> {
    match value {
        Value::Null => Ok("NULL".into()),
        Value::Bool(value) => Ok(if *value { "1" } else { "0" }.into()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
        _ => Err(SiloError::new(
            exits::SCHEMA,
            "invalid_default",
            "SQLite defaults must be scalar literal values.",
        )),
    }
}

pub fn validate_schema(schema: &LogicalSchema) -> Result<(), SiloError> {
    if schema.format_version != 1 || schema.registry_version != 1 {
        return Err(SiloError::new(
            exits::SCHEMA,
            "schema_version_unsupported",
            "Unsupported logical schema or semantic registry version.",
        ));
    }
    let mut names = BTreeMap::new();
    for table in &schema.tables {
        validate_table(table)?;
        if names.insert(table.name.to_lowercase(), table).is_some() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "duplicate_table",
                "Table names are case-insensitively unique.",
            )
            .at("$.tables"));
        }
    }
    for table in &schema.tables {
        for foreign in table.foreign_keys.as_deref().unwrap_or_default() {
            let target = names
                .get(&foreign.references.table.to_lowercase())
                .ok_or_else(|| {
                    SiloError::new(
                        exits::SCHEMA,
                        "missing_referenced_table",
                        format!("{} does not exist.", foreign.references.table),
                    )
                    .at("$.tables.foreign_keys")
                })?;
            for column in &foreign.columns {
                if !table
                    .columns
                    .iter()
                    .any(|candidate| candidate.name.eq_ignore_ascii_case(column))
                {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "missing_foreign_key_column",
                        format!("{column} does not exist on {}.", table.name),
                    )
                    .at("$.tables.foreign_keys"));
                }
            }
            if !foreign.references.columns.iter().all(|column| {
                target
                    .columns
                    .iter()
                    .any(|candidate| candidate.name.eq_ignore_ascii_case(column))
            }) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "missing_referenced_column",
                    "A referenced foreign-key column does not exist.",
                )
                .at("$.tables.foreign_keys"));
            }
            let target_keys: Vec<Vec<&str>> =
                std::iter::once(table_name_slice(target.primary_key.as_deref()))
                    .chain(
                        target
                            .unique_constraints
                            .as_deref()
                            .unwrap_or_default()
                            .iter()
                            .map(|unique| unique.columns.iter().map(String::as_str).collect()),
                    )
                    .collect();
            if !target_keys.iter().any(|key| {
                key.len() == foreign.references.columns.len()
                    && key
                        .iter()
                        .zip(&foreign.references.columns)
                        .all(|(a, b)| a == &b.as_str())
            }) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "invalid_foreign_key_target",
                    "Referenced columns must exactly match a primary key or unique constraint.",
                )
                .at("$.tables.foreign_keys"));
            }
        }
    }
    if let Some(relations) = &schema.relations {
        let mut relation_names = BTreeMap::<String, BTreeSet<String>>::new();
        for (index, relation) in relations.iter().enumerate() {
            let path = format!("$.relations[{index}]");
            let value =
                serde_json::to_value(relation).map_err(|error| input_error(&path, error))?;
            let relation = parse_relation(value, &path)?;
            let source = names
                .get(&relation.from.table.to_lowercase())
                .ok_or_else(|| {
                    SiloError::new(
                        exits::SCHEMA,
                        "missing_relation_table",
                        format!("{} does not exist.", relation.from.table),
                    )
                    .at(format!("{path}.from.table"))
                })?;
            let target = names
                .get(&relation.to.table.to_lowercase())
                .ok_or_else(|| {
                    SiloError::new(
                        exits::SCHEMA,
                        "missing_relation_table",
                        format!("{} does not exist.", relation.to.table),
                    )
                    .at(format!("{path}.to.table"))
                })?;
            if !relation.from.columns.iter().all(|column| {
                source
                    .columns
                    .iter()
                    .any(|item| item.name.eq_ignore_ascii_case(column))
            }) || !relation.to.columns.iter().all(|column| {
                target
                    .columns
                    .iter()
                    .any(|item| item.name.eq_ignore_ascii_case(column))
            }) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "missing_relation_column",
                    "A relation endpoint column does not exist.",
                )
                .at(&path));
            }
            let source_name = relation.from.name.as_deref().ok_or_else(|| {
                SiloError::new(
                    exits::SCHEMA,
                    "invalid_relation",
                    "The source relation endpoint requires a name.",
                )
                .at(format!("{path}.from.name"))
            })?;
            for (table_name, relation_name, field) in [
                (&source.name, source_name, format!("{path}.from.name")),
                (
                    &target.name,
                    relation.inverse_name.as_deref().unwrap_or_default(),
                    format!("{path}.inverse_name"),
                ),
            ] {
                if !relation_name.is_empty()
                    && !relation_names
                        .entry(table_name.to_lowercase())
                        .or_default()
                        .insert(relation_name.to_lowercase())
                {
                    return Err(SiloError::new(
                        exits::SCHEMA,
                        "duplicate_relation_name",
                        format!("Relation name {relation_name} is already used on {table_name}."),
                    )
                    .at(field));
                }
            }
            let matching = source
                .foreign_keys
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|foreign| {
                    foreign
                        .references
                        .table
                        .eq_ignore_ascii_case(&relation.to.table)
                        && same_columns(&foreign.columns, &relation.from.columns)
                        && same_columns(&foreign.references.columns, &relation.to.columns)
                })
                .count();
            if matching != 1 {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "relation_missing_foreign_key",
                    "The semantic relation must exactly match one declared foreign key.",
                )
                .at(&path));
            }
        }
    }
    let sql = compile_schema(schema)?.join("\n");
    let connection = Connection::open_in_memory().map_err(sqlite_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(sqlite_error)?;
    connection.execute_batch(&sql).map_err(|error| {
        SiloError::new(exits::SCHEMA, "sqlite_compile_error", error.to_string()).at("$.")
    })?;
    Ok(())
}

fn table_name_slice(columns: Option<&[String]>) -> Vec<&str> {
    columns
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .collect()
}

fn same_columns(left: &[String], right: &[String]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn sqlite_error(error: rusqlite::Error) -> SiloError {
    SiloError::new(exits::IO, "sqlite_error", error.to_string())
}

fn semantic_check(kind: &str, quoted: &str, column: &ColumnDefinition) -> Option<String> {
    let check = match kind {
        "text/uuid" => format!(
            "length({quoted}) = 36 AND {quoted} = lower({quoted}) AND substr({quoted}, 9, 1) = '-' AND substr({quoted}, 14, 1) = '-' AND substr({quoted}, 19, 1) = '-' AND substr({quoted}, 24, 1) = '-' AND {quoted} NOT GLOB '*[^0-9a-f-]*'"
        ),
        "text/ulid" => format!(
            "length({quoted}) = 26 AND {quoted} = upper({quoted}) AND {quoted} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'"
        ),
        "text/datetime" => format!("{quoted} GLOB '????-??-??T*Z'"),
        "integer/boolean" => format!("{quoted} IN (0, 1)"),
        "integer/positive" => format!("{quoted} > 0"),
        "integer/nonnegative" | "integer/duration-ms" => format!("{quoted} >= 0"),
        "integer/port" => format!("{quoted} BETWEEN 0 AND 65535"),
        "real/percentage" => format!("{quoted} BETWEEN 0 AND 1"),
        "text/enum" => return None,
        _ => return None,
    };
    let _ = column;
    Some(check)
}

#[allow(dead_code)]
fn _assert_no_duplicate_checks(_checks: &[CheckDefinition]) {}
