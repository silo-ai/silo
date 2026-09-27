use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct SiloError {
    pub exit_code: i32,
    pub code: String,
    pub message: String,
    pub path: String,
}

impl SiloError {
    pub fn new(exit_code: i32, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            exit_code,
            code: code.into(),
            message: message.into(),
            path: String::new(),
        }
    }

    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = path.into();
        self
    }
}

pub mod exits {
    pub const INPUT: i32 = 2;
    pub const WORKSPACE: i32 = 3;
    pub const ABSENT: i32 = 4;
    pub const NOT_FOUND: i32 = 5;
    pub const SCHEMA: i32 = 6;
    pub const CONSTRAINT: i32 = 7;
    pub const REVISION: i32 = 8;
    pub const IO: i32 = 9;
    pub const INTEGRITY: i32 = 10;
}

pub type Literal = Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum DefaultValue {
    Literal(LiteralDefault),
    Expression(ExpressionDefault),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LiteralDefault {
    pub literal: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExpressionDefault {
    pub expression: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnDefinition {
    pub name: String,
    #[serde(rename = "type")]
    pub semantic_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_options: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<DefaultValue>,
    pub comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated: Option<GeneratedColumn>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedColumn {
    pub expression: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ForeignKeyDefinition {
    pub columns: Vec<String>,
    pub references: ForeignKeyTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferrable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initially_deferred: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ForeignKeyTarget {
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndexPart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collate: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndexDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub columns: Vec<IndexPart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "where")]
    pub where_clause: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl IndexDefinition {
    pub fn where_sql(&self) -> Option<&str> {
        self.where_clause.as_deref()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub expression: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PolicyDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub fields: BTreeMap<String, Value>,
}

impl PolicyDefinition {
    pub fn string(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    pub fn strings(&self, key: &str) -> Option<Vec<&str>> {
        self.fields
            .get(key)?
            .as_array()?
            .iter()
            .map(Value::as_str)
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UniqueConstraint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableDefinition {
    pub name: String,
    pub comment: String,
    pub columns: Vec<ColumnDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_key: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_keys: Option<Vec<ForeignKeyDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique_constraints: Option<Vec<UniqueConstraint>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<IndexDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<Vec<CheckDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policies: Option<Vec<PolicyDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub without_rowid: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RelationEndpoint {
    pub table: String,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RelationDefinition {
    pub from: RelationEndpoint,
    pub to: RelationEndpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inverse_name: Option<String>,
    pub comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inverse_comment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateImport {
    pub name: String,
    pub imported_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentInstruction {
    pub source: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LogicalSchema {
    pub format_version: u32,
    pub registry_version: u32,
    pub revision: u64,
    pub tables: Vec<TableDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relations: Option<Vec<RelationDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_imports: Option<Vec<TemplateImport>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_instructions: Option<Vec<AgentInstruction>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseMetadata {
    pub identity: String,
    pub original_origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub format_version: u32,
    pub tool_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SyncState {
    pub database_id: String,
    pub remote_url: String,
    pub base_generation: Option<String>,
    pub base_etag: Option<String>,
    pub conflict_transaction_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PendingTransaction {
    pub sequence: i64,
    pub transaction_id: String,
    pub kind: String,
    pub base_generation: Option<String>,
    pub schema_revision: u64,
    pub operation: Value,
    pub changeset: Vec<u8>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MutationJournalEntry {
    pub sequence: i64,
    pub transaction_id: String,
    pub committed_at: String,
    pub operation: Value,
    pub resource_tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MutationJournalRead {
    pub entries: Vec<MutationJournalEntry>,
    pub oldest_sequence: Option<i64>,
    pub latest_sequence: i64,
    pub next_sequence: i64,
    pub full_refresh_required: bool,
    pub data_version: i64,
    pub unknown_change: bool,
}
