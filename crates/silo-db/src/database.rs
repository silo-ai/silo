use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    path::Path,
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
    hooks::{AuthAction, Authorization},
    params,
    session::Session,
    types::{Value as SqlValue, ValueRef},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use silo_core::{
    DatabaseMetadata, LogicalSchema, MutationJournalEntry, MutationJournalRead, PendingTransaction,
    SiloError, SyncState, exits,
};
use silo_schema::{
    canonicalize, compile_added_column, compile_schema, compile_table, parse_relation, parse_table,
    quote, semantic_storage, validate_schema,
};
use silo_workspace::Workspace;
use uuid::Uuid;

pub const FORMAT_VERSION: u32 = 4;
pub const MUTATION_JOURNAL_RETENTION: i64 = 1_000;
pub const MUTATION_JOURNAL_READ_LIMIT: i64 = 100;
const TOOL_VERSION: &str = env!("CARGO_PKG_VERSION");
const QUERY_RESULT_LIMIT: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
}

struct WriterLock {
    writer: File,
    _sync_reader: Option<File>,
}

impl WriterLock {
    fn acquire(database_path: &Path, guard_sync: bool) -> Result<Self, SiloError> {
        let sync_reader = if guard_sync {
            let path = append_suffix(database_path, ".sync-lock");
            let file = open_lock_file(&path)?;
            file.try_lock_shared().map_err(|_| {
                SiloError::new(
                    exits::IO,
                    "sync_in_progress",
                    "A synchronization operation is already using this database.",
                )
            })?;
            Some(file)
        } else {
            None
        };
        let lock_path = database_path.with_extension("sqlite.write-lock");
        let lock = open_lock_file(&lock_path)?;
        lock.try_lock_exclusive().map_err(|_| {
            SiloError::new(
                exits::IO,
                "writer_locked",
                "Another writer or synchronization operation is using this database.",
            )
        })?;
        Ok(Self {
            writer: lock,
            _sync_reader: sync_reader,
        })
    }
}

pub struct SyncOperationLock(File);

impl Drop for SyncOperationLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = self.writer.unlock();
        if let Some(sync_reader) = &self._sync_reader {
            let _ = sync_reader.unlock();
        }
    }
}

fn open_lock_file(path: &Path) -> Result<File, SiloError> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_error)
}

pub struct SiloDatabase {
    pub workspace: Workspace,
    connection: Connection,
    writable: bool,
    _writer_lock: Option<WriterLock>,
    observed_data_version: i64,
    observed_journal_sequence: i64,
}

impl SiloDatabase {
    pub fn open(workspace: Workspace, writable: bool) -> Result<Self, SiloError> {
        Self::open_with_sync_lock(workspace, writable, false)
    }

    pub fn open_with_sync_lock(
        workspace: Workspace,
        writable: bool,
        allow_sync_lock: bool,
    ) -> Result<Self, SiloError> {
        if !workspace.database_path.exists() {
            return Err(SiloError::new(
                exits::ABSENT,
                "database_absent",
                "No Silo database exists for this workspace.",
            ));
        }
        let lock = if writable {
            Some(WriterLock::acquire(
                &workspace.database_path,
                !allow_sync_lock,
            )?)
        } else {
            None
        };
        let flags = if writable {
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
        };
        let connection =
            Connection::open_with_flags(&workspace.database_path, flags).map_err(sqlite_error)?;
        let mut database = Self {
            workspace,
            connection,
            writable,
            _writer_lock: lock,
            observed_data_version: 0,
            observed_journal_sequence: 0,
        };
        // Check the workspace identity before a writable open is allowed to migrate the file.
        // A path mismatch must never cause another workspace's database to be modified.
        let identity: Option<String> = database
            .connection
            .query_row(
                "SELECT value FROM _silo_meta WHERE key = 'identity'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unrecognized_database_error())?;
        if identity.as_deref() != Some(database.workspace.identity.as_str()) {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "identity_mismatch",
                "Database identity does not match the current Git workspace identity.",
            ));
        }
        configure(&database.connection, writable)?;
        if writable {
            database.migrate()?;
        }
        let metadata = database.metadata()?;
        if metadata.identity != database.workspace.identity {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "identity_mismatch",
                "Database identity does not match the current Git workspace identity.",
            ));
        }
        let schema = database.schema()?;
        validate_schema(&schema)?;
        database.verify_physical(&schema)?;
        database.observed_data_version = data_version(&database.connection)?;
        database.observed_journal_sequence = journal_bounds(&database.connection)?.1;
        Ok(database)
    }

    pub fn acquire_sync_lock(workspace: &Workspace) -> Result<SyncOperationLock, SiloError> {
        if let Some(parent) = workspace.database_path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let sync_path = append_suffix(&workspace.database_path, ".sync-lock");
        let file = open_lock_file(&sync_path)?;
        file.try_lock_exclusive().map_err(|_| {
            SiloError::new(
                exits::IO,
                "sync_in_progress",
                "Another synchronization operation is running.",
            )
        })?;
        let sync_lock = SyncOperationLock(file);
        // Close the race with a writer that passed the synchronization-lock check first.
        let _writer_guard = WriterLock::acquire(&workspace.database_path, false).map_err(|_| {
            SiloError::new(
                exits::IO,
                "sync_in_progress",
                "Another writer is using this database.",
            )
        })?;
        Ok(sync_lock)
    }

    pub fn create_with_schema(
        workspace: Workspace,
        schema: &LogicalSchema,
    ) -> Result<Self, SiloError> {
        validate_schema(schema)?;
        if workspace.database_path.exists() {
            return Err(SiloError::new(
                exits::SCHEMA,
                "database_exists",
                "A database already exists for this workspace identity.",
            ));
        }
        if let Some(parent) = workspace.database_path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let lock = WriterLock::acquire(&workspace.database_path, true)?;
        let reservation = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&workspace.database_path)
            .map_err(io_error)?;
        drop(reservation);
        let database_path = workspace.database_path.clone();
        let result = (|| {
            let connection = Connection::open(&workspace.database_path).map_err(sqlite_error)?;
            configure(&connection, true)?;
            let mut database = Self {
                workspace,
                connection,
                writable: true,
                _writer_lock: Some(lock),
                observed_data_version: 0,
                observed_journal_sequence: 0,
            };
            database.initialize(schema)?;
            database.verify_physical(schema)?;
            database.observed_data_version = data_version(&database.connection)?;
            database.observed_journal_sequence = journal_bounds(&database.connection)?.1;
            Ok(database)
        })();
        if result.is_err() {
            remove_database_files(&database_path);
        }
        result
    }

    pub fn metadata(&self) -> Result<DatabaseMetadata, SiloError> {
        let mut statement = self
            .connection
            .prepare("SELECT key, value FROM _silo_meta ORDER BY key")
            .map_err(unrecognized_database)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(unrecognized_database)?;
        let values: BTreeMap<_, _> = rows.filter_map(Result::ok).collect();
        let identity = values
            .get("identity")
            .cloned()
            .ok_or_else(unrecognized_database_error)?;
        let format_version = values
            .get("format_version")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(unrecognized_database_error)?;
        if format_version != FORMAT_VERSION {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "incompatible_database",
                format!("Database format {format_version} is not supported."),
            ));
        }
        Ok(DatabaseMetadata {
            identity,
            original_origin: values.get("original_origin").cloned().unwrap_or_default(),
            created_at: values.get("created_at").cloned().unwrap_or_default(),
            updated_at: values.get("updated_at").cloned().unwrap_or_default(),
            format_version,
            tool_version: values.get("tool_version").cloned().unwrap_or_default(),
        })
    }

    pub fn schema(&self) -> Result<LogicalSchema, SiloError> {
        let value: String = self
            .connection
            .query_row(
                "SELECT schema_json FROM _silo_schema WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| {
                SiloError::new(
                    exits::INTEGRITY,
                    "schema_metadata_invalid",
                    error.to_string(),
                )
            })?;
        let schema: LogicalSchema = serde_json::from_str(&value).map_err(|error| {
            SiloError::new(
                exits::INTEGRITY,
                "schema_metadata_invalid",
                error.to_string(),
            )
        })?;
        Ok(schema)
    }

    pub fn query(&self, sql: &str, bindings: &[Value]) -> Result<QueryResult, SiloError> {
        let mut connection = Connection::open_with_flags(
            &self.workspace.database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sqlite_error)?;
        configure(&connection, false)?;
        install_read_only_authorizer(&mut connection)?;
        let sql_values = bindings
            .iter()
            .map(json_to_sql)
            .collect::<Result<Vec<_>, _>>()?;
        let mut statement = connection.prepare(sql).map_err(sqlite_error)?;
        if !statement.readonly() {
            return Err(SiloError::new(
                exits::INPUT,
                "read_only_query_required",
                "Only read-only SQL statements are supported.",
            ));
        }
        if statement.column_count() == 0 {
            return Err(SiloError::new(
                exits::INPUT,
                "query_required",
                "Expected a query that returns columns.",
            ));
        }
        let columns = statement
            .column_names()
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        let mut rows = statement
            .query(rusqlite::params_from_iter(sql_values.iter()))
            .map_err(sqlite_error)?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(sqlite_error)? {
            if result.len() == QUERY_RESULT_LIMIT {
                return Ok(QueryResult {
                    columns,
                    rows: result,
                    truncated: true,
                });
            }
            let mut values = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                values.push(sql_to_json(row.get_ref(index).map_err(sqlite_error)?));
            }
            result.push(values);
        }
        Ok(QueryResult {
            columns,
            rows: result,
            truncated: false,
        })
    }

    pub fn insert_rows(
        &mut self,
        table_name: &str,
        input: &Value,
        upsert: bool,
    ) -> Result<Vec<Value>, SiloError> {
        let schema = self.schema()?;
        let table = find_table(&schema, table_name)?;
        let source_rows = match input {
            Value::Array(rows) => rows.clone(),
            value => vec![value.clone()],
        };
        if source_rows.is_empty() {
            return Err(input_error("At least one row is required."));
        }
        let operation = serde_json::json!({
            "command": if upsert { "row.upsert" } else { "row.add" },
            "table": table.name,
            "keys": table.primary_key.as_deref().map(|keys| source_rows.iter().map(|row| {
                Value::Array(keys.iter().map(|key| row.get(key).cloned().unwrap_or(Value::Null)).collect())
            }).collect::<Vec<_>>()).unwrap_or_default(),
        });
        self.record_mutation(operation, |connection| {
            let mut results = Vec::with_capacity(source_rows.len());
            for source in &source_rows {
                let object = source
                    .as_object()
                    .ok_or_else(|| input_error("Each row must be an object."))?;
                let row = prepare_row(&table, object, true)?;
                let natural_keys = if upsert {
                    let policy = find_policy(&table, "natural_key_upsert").ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "upsert_not_declared",
                            "The table has no natural_key_upsert policy.",
                        )
                    })?;
                    let keys = policy
                        .strings("columns")
                        .ok_or_else(|| {
                            SiloError::new(
                                exits::SCHEMA,
                                "invalid_upsert_policy",
                                "natural_key_upsert requires columns.",
                            )
                        })?
                        .into_iter()
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    if keys.iter().any(|key| !row.contains_key(key)) {
                        return Err(SiloError::new(
                            exits::INPUT,
                            "upsert_key_required",
                            "Every natural-key upsert column must be provided.",
                        ));
                    }
                    let allowed = policy
                        .strings("update_columns")
                        .map(|columns| columns.into_iter().map(str::to_owned).collect::<Vec<_>>())
                        .unwrap_or_else(|| {
                            object
                                .keys()
                                .filter(|key| !keys.contains(key))
                                .cloned()
                                .collect()
                        });
                    let updates = allowed
                        .iter()
                        .filter(|column| row.contains_key(*column))
                        .cloned()
                        .collect::<Vec<_>>();
                    insert_statement(connection, &table, &row, Some((&keys, &updates)))?;
                    Some(keys)
                } else {
                    insert_statement(connection, &table, &row, None)?;
                    None
                };
                let fetched = if let Some(keys) = natural_keys {
                    let values = keys
                        .iter()
                        .map(|key| {
                            row.get(key).cloned().ok_or_else(|| {
                                SiloError::new(
                                    exits::INPUT,
                                    "upsert_key_required",
                                    "Every natural-key upsert column must be provided.",
                                )
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    select_row(connection, &table, &keys, &values)?
                } else if table.without_rowid.unwrap_or(false) {
                    let keys = table.primary_key.as_deref().unwrap_or_default();
                    if keys.is_empty() {
                        return Err(SiloError::new(
                            exits::INTEGRITY,
                            "persisted_row_unresolved",
                            "The inserted row cannot be located without a primary key.",
                        ));
                    }
                    let values = keys
                        .iter()
                        .map(|key| {
                            row.get(key).cloned().ok_or_else(|| {
                                SiloError::new(
                                    exits::INTEGRITY,
                                    "persisted_row_unresolved",
                                    "The inserted row cannot be located after mutation.",
                                )
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    select_row(connection, &table, keys, &values)?
                } else {
                    select_rowid(connection, &table, connection.last_insert_rowid())?
                };
                results.push(fetched.ok_or_else(|| {
                    SiloError::new(
                        exits::INTEGRITY,
                        "persisted_row_unresolved",
                        "The persisted row could not be located after mutation.",
                    )
                })?);
            }
            Ok(results)
        })
    }

    pub fn get_row(&self, table_name: &str, key: &Value) -> Result<Value, SiloError> {
        let schema = self.schema()?;
        let table = find_table(&schema, table_name)?;
        let (columns, values) = key_values(&table, key)?;
        select_row(&self.connection, &table, &columns, &values)?.ok_or_else(|| {
            SiloError::new(
                exits::NOT_FOUND,
                "row_not_found",
                "No row matches the supplied key.",
            )
        })
    }

    pub fn list_rows(
        &self,
        table_name: &str,
        limit: u64,
        offset: u64,
    ) -> Result<Vec<Value>, SiloError> {
        let schema = self.schema()?;
        let table = find_table(&schema, table_name)?;
        let order = if let Some(keys) = table.primary_key.as_deref().filter(|keys| !keys.is_empty())
        {
            format!(
                " ORDER BY {}",
                keys.iter()
                    .map(|key| quote(key))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else if !table.without_rowid.unwrap_or(false) {
            " ORDER BY rowid".to_owned()
        } else {
            String::new()
        };
        let sql = format!(
            "SELECT * FROM {}{order} LIMIT ?1 OFFSET ?2",
            quote(&table.name)
        );
        let mut statement = self.connection.prepare(&sql).map_err(sqlite_error)?;
        let rows = statement
            .query_map(
                params![
                    limit.min(i64::MAX as u64) as i64,
                    offset.min(i64::MAX as u64) as i64
                ],
                |row| read_row(row, &table),
            )
            .map_err(sqlite_error)?;
        rows.map(|row| row.map_err(sqlite_error)).collect()
    }

    pub fn update_row(
        &mut self,
        table_name: &str,
        key: &Value,
        input: &Value,
    ) -> Result<u64, SiloError> {
        let schema = self.schema()?;
        let table = find_table(&schema, table_name)?;
        let sync_enabled = self.get_sync_state()?.is_some();
        let object = input
            .as_object()
            .ok_or_else(|| input_error("Expected a row object."))?;
        let mut raw = object.clone();
        let expected_revision = raw.remove("_expected_revision");
        let operation =
            serde_json::json!({ "command": "row.update", "table": table.name, "key": key });
        self.record_mutation(operation, |connection| {
            let mut row = prepare_row(&table, &raw, false)?;
            if sync_enabled
                && table
                    .primary_key
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|column| raw.contains_key(column))
            {
                return Err(SiloError::new(
                    exits::INPUT,
                    "sync_primary_key_immutable",
                    "Synchronized primary-key values cannot be updated.",
                ));
            }
            let (mut keys, mut values) = key_values(&table, key)?;
            if let Some(policy) = find_policy(&table, "timestamps")
                && let Some(column) = policy.string("updated_column")
            {
                let previous: Option<String> = connection
                    .query_row(
                        &format!(
                            "SELECT {} FROM {} WHERE {}",
                            quote(column),
                            quote(&table.name),
                            where_clause(&keys)
                        ),
                        rusqlite::params_from_iter(values.iter()),
                        |result| result.get(0),
                    )
                    .optional()
                    .map_err(sqlite_error)?;
                row.insert(column.to_owned(), later_timestamp(previous.as_deref())?);
            }
            if let Some(policy) = find_policy(&table, "optimistic_revision") {
                let column = policy.string("column").ok_or_else(|| {
                    SiloError::new(
                        exits::SCHEMA,
                        "invalid_revision_policy",
                        "optimistic_revision requires a column.",
                    )
                })?;
                let expected = expected_revision
                    .as_ref()
                    .and_then(Value::as_i64)
                    .ok_or_else(|| {
                        SiloError::new(
                            exits::INPUT,
                            "expected_revision_required",
                            "_expected_revision is required for this table.",
                        )
                    })?;
                keys.push(column.to_owned());
                values.push(SqlValue::Integer(expected));
                row.insert(column.to_owned(), SqlValue::Integer(expected + 1));
            }
            if row.is_empty() {
                return Err(SiloError::new(
                    exits::INPUT,
                    "empty_update",
                    "At least one field must be updated.",
                ));
            }
            let assignments = row
                .keys()
                .map(|column| format!("{} = ?", quote(column)))
                .collect::<Vec<_>>()
                .join(", ");
            let mut bindings = row.values().cloned().collect::<Vec<_>>();
            bindings.extend(values);
            let sql = format!(
                "UPDATE {} SET {assignments} WHERE {}",
                quote(&table.name),
                where_clause(&keys)
            );
            let changed = connection
                .execute(&sql, rusqlite::params_from_iter(bindings.iter()))
                .map_err(sqlite_error)?;
            if changed == 0 {
                let revision = find_policy(&table, "optimistic_revision").is_some();
                return Err(SiloError::new(
                    if revision {
                        exits::REVISION
                    } else {
                        exits::NOT_FOUND
                    },
                    if revision {
                        "revision_conflict"
                    } else {
                        "row_not_found"
                    },
                    if revision {
                        "The row revision did not match."
                    } else {
                        "No row matches the supplied key."
                    },
                ));
            }
            Ok(changed as u64)
        })
    }

    pub fn delete_row(&mut self, table_name: &str, key: &Value) -> Result<u64, SiloError> {
        let schema = self.schema()?;
        let table = find_table(&schema, table_name)?;
        let operation =
            serde_json::json!({ "command": "row.delete", "table": table.name, "key": key });
        self.record_mutation(operation, |connection| {
            let (keys, values) = key_values(&table, key)?;
            let sql = format!(
                "DELETE FROM {} WHERE {}",
                quote(&table.name),
                where_clause(&keys)
            );
            let changed = connection
                .execute(&sql, rusqlite::params_from_iter(values.iter()))
                .map_err(sqlite_error)?;
            if changed == 0 {
                return Err(SiloError::new(
                    exits::NOT_FOUND,
                    "row_not_found",
                    "No row matches the supplied key.",
                ));
            }
            Ok(changed as u64)
        })
    }

    pub fn create_table(&mut self, input: Value) -> Result<silo_core::TableDefinition, SiloError> {
        self.ensure_writable()?;
        let table = parse_table(input)?;
        let current = self.schema()?;
        if current
            .tables
            .iter()
            .any(|candidate| candidate.name.eq_ignore_ascii_case(&table.name))
        {
            return Err(SiloError::new(
                exits::SCHEMA,
                "table_exists",
                format!("{} already exists.", table.name),
            )
            .at("$.name"));
        }
        let mut proposed = current.clone();
        proposed.revision += 1;
        proposed.tables.push(table.clone());
        let sync = self.prepare_schema_mutation(&proposed)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        for ddl in silo_schema::compile_table(&table)? {
            tx.execute_batch(&ddl).map_err(|error| {
                SiloError::new(exits::SCHEMA, "sqlite_compile_error", error.to_string())
            })?;
        }
        self.replace_schema(&tx, &proposed)?;
        self.verify_physical(&proposed)?;
        self.record_schema_mutation(
            &tx,
            serde_json::json!({ "command": "table.create", "table": table.name }),
            sync,
            current.revision,
            proposed.revision,
        )?;
        tx.commit().map_err(sqlite_error)?;
        Ok(table)
    }

    pub fn drop_table(&mut self, name: &str) -> Result<(), SiloError> {
        self.ensure_writable()?;
        let current = self.schema()?;
        let existing = current
            .tables
            .iter()
            .find(|table| table.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                SiloError::new(
                    exits::NOT_FOUND,
                    "table_not_found",
                    format!("{name} does not exist."),
                )
            })?;
        let mut proposed = current.clone();
        proposed.revision += 1;
        proposed.tables.retain(|table| table.name != existing.name);
        let sync = self.prepare_schema_mutation(&proposed)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        tx.execute_batch(&format!("DROP TABLE {}", quote(&existing.name)))
            .map_err(sqlite_error)?;
        self.replace_schema(&tx, &proposed)?;
        self.verify_physical(&proposed)?;
        self.record_schema_mutation(
            &tx,
            serde_json::json!({ "command": "table.drop", "table": existing.name }),
            sync,
            current.revision,
            proposed.revision,
        )?;
        tx.commit().map_err(sqlite_error)
    }

    pub fn alter_table(
        &mut self,
        name: &str,
        input: &Value,
    ) -> Result<silo_core::TableDefinition, SiloError> {
        self.ensure_writable()?;
        let request = input
            .as_object()
            .ok_or_else(|| input_error("Expected an alter request object."))?;
        if let Some(unknown) = request
            .keys()
            .find(|key| !matches!(key.as_str(), "add_columns" | "add_indexes"))
        {
            return Err(SiloError::new(
                exits::INPUT,
                "unknown_field",
                format!("Unknown field {unknown}."),
            )
            .at(format!("$.{unknown}")));
        }
        let added_columns = request
            .get("add_columns")
            .map(|value| {
                value
                    .as_array()
                    .cloned()
                    .ok_or_else(|| input_error("add_columns must be an array."))
            })
            .transpose()?
            .unwrap_or_default();
        let added_indexes = request
            .get("add_indexes")
            .map(|value| {
                value
                    .as_array()
                    .cloned()
                    .ok_or_else(|| input_error("add_indexes must be an array."))
            })
            .transpose()?
            .unwrap_or_default();
        if added_columns.is_empty() && added_indexes.is_empty() {
            return Err(input_error("Add at least one column or index."));
        }

        let mut schema = self.schema()?;
        let position = schema
            .tables
            .iter()
            .position(|table| table.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                SiloError::new(
                    exits::NOT_FOUND,
                    "table_not_found",
                    format!("{name} does not exist."),
                )
            })?;
        let current = schema.tables[position].clone();
        let mut candidate_value = serde_json::to_value(&current).map_err(json_error)?;
        let candidate_object = candidate_value
            .as_object_mut()
            .expect("table serializes as an object");
        let mut columns = candidate_object
            .get("columns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        columns.extend(added_columns.iter().cloned());
        candidate_object.insert("columns".into(), Value::Array(columns));
        let mut indexes = candidate_object
            .get("indexes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        indexes.extend(added_indexes);
        candidate_object.insert("indexes".into(), Value::Array(indexes));
        let candidate = parse_table(candidate_value)?;
        for (index, _) in added_columns.iter().enumerate() {
            let column = &candidate.columns[current.columns.len() + index];
            if column.generated.is_some()
                || (column.nullable == Some(false) && column.default.is_none())
            {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "unsupported_alter",
                    "Added columns must be nullable or have a compatible constant default, and cannot be generated.",
                ));
            }
            if matches!(column.default, Some(silo_core::DefaultValue::Expression(_))) {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "unsupported_alter",
                    "Added-column defaults must be JSON literals in the initial release.",
                ));
            }
        }
        schema.revision += 1;
        schema.tables[position] = candidate.clone();
        validate_schema(&schema)?;
        let sync = self.prepare_schema_mutation(&schema)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        for column in candidate.columns.iter().skip(current.columns.len()) {
            let statement = format!(
                "ALTER TABLE {} ADD COLUMN {}",
                quote(&current.name),
                compile_added_column(&candidate, column)?
            );
            tx.execute_batch(&statement).map_err(|error| {
                SiloError::new(exits::SCHEMA, "sqlite_compile_error", error.to_string())
            })?;
        }
        let compiled = compile_table(&candidate)?;
        let index_statements = compiled
            .iter()
            .filter(|statement| {
                statement.starts_with("CREATE INDEX ")
                    || statement.starts_with("CREATE UNIQUE INDEX ")
            })
            .skip(current.indexes.as_deref().unwrap_or_default().len());
        for statement in index_statements {
            tx.execute_batch(statement).map_err(|error| {
                SiloError::new(exits::SCHEMA, "sqlite_compile_error", error.to_string())
            })?;
        }
        self.replace_schema(&tx, &schema)?;
        self.verify_physical(&schema)?;
        self.record_schema_mutation(
            &tx,
            serde_json::json!({ "command": "table.alter", "table": current.name }),
            sync,
            schema.revision - 1,
            schema.revision,
        )?;
        tx.commit().map_err(sqlite_error)?;
        Ok(candidate)
    }

    pub fn add_relation(
        &mut self,
        input: Value,
    ) -> Result<silo_core::RelationDefinition, SiloError> {
        self.ensure_writable()?;
        let relation = parse_relation(input, "$")?;
        let current = self.schema()?;
        let mut proposed = current.clone();
        proposed.revision += 1;
        proposed
            .relations
            .get_or_insert_with(Vec::new)
            .push(relation.clone());
        validate_schema(&proposed)?;
        let sync = self.prepare_schema_mutation(&proposed)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        self.replace_schema(&tx, &proposed)?;
        self.verify_physical(&proposed)?;
        self.record_schema_mutation(&tx, serde_json::json!({ "command": "relation.add", "from_table": relation.from.table, "name": relation.from.name, "to_table": relation.to.table }), sync, current.revision, proposed.revision)?;
        tx.commit().map_err(sqlite_error)?;
        Ok(relation)
    }

    pub fn remove_relation(&mut self, table_name: &str, name: &str) -> Result<(), SiloError> {
        self.ensure_writable()?;
        let current = self.schema()?;
        let relation = current
            .relations
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|relation| {
                relation.from.table.eq_ignore_ascii_case(table_name)
                    && relation
                        .from
                        .name
                        .as_deref()
                        .is_some_and(|relation_name| relation_name.eq_ignore_ascii_case(name))
            })
            .cloned()
            .ok_or_else(|| {
                SiloError::new(
                    exits::NOT_FOUND,
                    "relation_not_found",
                    format!("{table_name}.{name} does not exist."),
                )
            })?;
        let mut proposed = current.clone();
        proposed.revision += 1;
        let remaining = proposed
            .relations
            .take()
            .unwrap_or_default()
            .into_iter()
            .filter(|candidate| {
                !(candidate
                    .from
                    .table
                    .eq_ignore_ascii_case(&relation.from.table)
                    && candidate.from.name == relation.from.name
                    && candidate.to.table.eq_ignore_ascii_case(&relation.to.table))
            })
            .collect::<Vec<_>>();
        proposed.relations = (!remaining.is_empty()).then_some(remaining);
        validate_schema(&proposed)?;
        let sync = self.prepare_schema_mutation(&proposed)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        self.replace_schema(&tx, &proposed)?;
        self.verify_physical(&proposed)?;
        self.record_schema_mutation(&tx, serde_json::json!({ "command": "relation.remove", "from_table": relation.from.table, "name": relation.from.name, "to_table": relation.to.table }), sync, current.revision, proposed.revision)?;
        tx.commit().map_err(sqlite_error)
    }

    fn prepare_schema_mutation(
        &self,
        proposed: &LogicalSchema,
    ) -> Result<Option<SyncState>, SiloError> {
        let sync = self.get_sync_state()?;
        if let Some(sync) = &sync {
            if let Some(conflict) = &sync.conflict_transaction_id {
                return Err(SiloError::new(
                    exits::REVISION,
                    "sync_conflict_unresolved",
                    format!("Resolve synchronized transaction {conflict} before changing schema."),
                ));
            }
            if !self.pending_transactions()?.is_empty() {
                return Err(SiloError::new(
                    exits::REVISION,
                    "sync_schema_requires_clean_base",
                    "Push or discard pending transactions before changing synchronized schema.",
                ));
            }
            validate_synchronized_schema(proposed)?;
        }
        Ok(sync)
    }

    fn replace_schema(&self, tx: &Connection, schema: &LogicalSchema) -> Result<(), SiloError> {
        tx.execute(
            "UPDATE _silo_schema SET schema_json = ?1 WHERE id = 1",
            [serde_json::to_string(schema).map_err(json_error)?],
        )
        .map_err(sqlite_error)?;
        tx.execute(
            "UPDATE _silo_meta SET value = ?1 WHERE key = 'updated_at'",
            [now()],
        )
        .map_err(sqlite_error)?;
        Ok(())
    }

    fn record_schema_mutation(
        &self,
        tx: &Connection,
        mut operation: Value,
        sync: Option<SyncState>,
        before_revision: u64,
        after_revision: u64,
    ) -> Result<(), SiloError> {
        let object = operation.as_object_mut().ok_or_else(|| {
            SiloError::new(
                exits::INTEGRITY,
                "operation_metadata_invalid",
                "Schema mutation metadata must be an object.",
            )
        })?;
        object.insert("before_revision".into(), Value::from(before_revision));
        object.insert("after_revision".into(), Value::from(after_revision));
        let transaction_id = Uuid::new_v4().to_string();
        let timestamp = now();
        tx.execute(
            "INSERT INTO _silo_journal (transaction_id, committed_at, operation_json, resource_tags_json) VALUES (?1, ?2, ?3, '[\"*\"]')",
            params![transaction_id, timestamp, serde_json::to_string(&operation).map_err(json_error)?],
        ).map_err(sqlite_error)?;
        tx.execute("DELETE FROM _silo_journal WHERE sequence <= (SELECT coalesce(max(sequence), 0) - ?1 FROM _silo_journal)", [MUTATION_JOURNAL_RETENTION]).map_err(sqlite_error)?;
        if let Some(sync) = sync {
            tx.execute(
                "INSERT INTO _silo_outbox (transaction_id, kind, base_generation, schema_revision, operation_json, changeset, created_at) VALUES (?1, 'schema', ?2, ?3, ?4, X'', ?5)",
                params![transaction_id, sync.base_generation, after_revision as i64, serde_json::to_string(&operation).map_err(json_error)?, timestamp],
            ).map_err(sqlite_error)?;
        }
        Ok(())
    }

    pub fn get_sync_state(&self) -> Result<Option<SyncState>, SiloError> {
        if !table_exists(&self.connection, "_silo_sync")? {
            return Ok(None);
        }
        self.connection.query_row(
            "SELECT database_id, remote_url, base_generation, base_etag, conflict_transaction_id FROM _silo_sync WHERE id = 1",
            [],
            |row| Ok(SyncState {
                database_id: row.get(0)?, remote_url: row.get(1)?, base_generation: row.get(2)?, base_etag: row.get(3)?, conflict_transaction_id: row.get(4)?,
            }),
        ).optional().map_err(sqlite_error)
    }

    pub fn configure_sync(
        &mut self,
        remote_url: &str,
        database_id: Option<&str>,
    ) -> Result<SyncState, SiloError> {
        self.ensure_writable()?;
        if let Some(state) = self.get_sync_state()? {
            if state.remote_url != remote_url {
                return Err(SiloError::new(
                    exits::WORKSPACE,
                    "sync_already_configured",
                    format!(
                        "This database is already synchronized with {}.",
                        state.remote_url
                    ),
                ));
            }
            return Ok(state);
        }
        validate_synchronized_schema(&self.schema()?)?;
        let id = database_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(sqlite_error)?;
        tx.execute_batch("CREATE TABLE _silo_sync (id INTEGER PRIMARY KEY CHECK (id = 1), database_id TEXT NOT NULL UNIQUE, remote_url TEXT NOT NULL, base_generation TEXT, base_etag TEXT, conflict_transaction_id TEXT) STRICT; CREATE TABLE _silo_outbox (sequence INTEGER PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('data', 'schema')), base_generation TEXT, schema_revision INTEGER NOT NULL, operation_json TEXT NOT NULL CHECK (json_valid(operation_json)), changeset BLOB NOT NULL, created_at TEXT NOT NULL) STRICT;").map_err(sqlite_error)?;
        tx.execute(
            "INSERT INTO _silo_sync (id, database_id, remote_url) VALUES (1, ?1, ?2)",
            params![id, remote_url],
        )
        .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)?;
        self.get_sync_state()?.ok_or_else(|| {
            SiloError::new(
                exits::INTEGRITY,
                "sync_state_missing",
                "Synchronization state was not created.",
            )
        })
    }

    pub fn pending_transactions(&self) -> Result<Vec<PendingTransaction>, SiloError> {
        if !table_exists(&self.connection, "_silo_outbox")? {
            return Ok(Vec::new());
        }
        let mut statement = self.connection.prepare("SELECT sequence, transaction_id, kind, base_generation, schema_revision, operation_json, changeset, created_at FROM _silo_outbox ORDER BY sequence").map_err(sqlite_error)?;
        statement
            .query_map([], |row| {
                let operation: String = row.get(5)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    operation,
                    row.get::<_, Vec<u8>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(sqlite_error)?
            .map(|row| {
                let (
                    sequence,
                    transaction_id,
                    kind,
                    base_generation,
                    schema_revision,
                    operation,
                    changeset,
                    created_at,
                ) = row.map_err(sqlite_error)?;
                Ok(PendingTransaction {
                    sequence,
                    transaction_id,
                    kind,
                    base_generation,
                    schema_revision: schema_revision as u64,
                    operation: serde_json::from_str(&operation).map_err(|e| {
                        SiloError::new(exits::INTEGRITY, "outbox_operation_invalid", e.to_string())
                    })?,
                    changeset,
                    created_at,
                })
            })
            .collect()
    }

    pub fn mark_synchronized(&mut self, generation: &str, etag: &str) -> Result<(), SiloError> {
        self.ensure_writable()?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        tx.execute("UPDATE _silo_sync SET base_generation = ?1, base_etag = ?2, conflict_transaction_id = NULL WHERE id = 1", params![generation, etag]).map_err(sqlite_error)?;
        tx.execute("DELETE FROM _silo_outbox", [])
            .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)
    }

    pub fn set_sync_conflict(&mut self, transaction_id: &str) -> Result<(), SiloError> {
        self.ensure_writable()?;
        let changed = self
            .connection
            .execute(
                "UPDATE _silo_sync SET conflict_transaction_id = ?1 WHERE id = 1",
                [transaction_id],
            )
            .map_err(sqlite_error)?;
        if changed == 0 {
            return Err(SiloError::new(
                exits::WORKSPACE,
                "sync_not_configured",
                "Synchronization is not configured.",
            ));
        }
        Ok(())
    }

    pub fn rebase_pending(
        &mut self,
        pending: &[PendingTransaction],
        generation: &str,
        etag: &str,
        discard_transaction_id: Option<&str>,
    ) -> Result<Option<String>, SiloError> {
        self.ensure_writable()?;
        let schema_revision = self.schema()?.revision;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        tx.execute("DELETE FROM _silo_outbox", [])
            .map_err(sqlite_error)?;
        tx.execute(
            "UPDATE _silo_sync SET base_generation = ?1, base_etag = ?2, conflict_transaction_id = NULL WHERE id = 1",
            params![generation, etag],
        )
        .map_err(sqlite_error)?;
        for item in pending {
            if Some(item.transaction_id.as_str()) == discard_transaction_id {
                continue;
            }
            if item.kind != "data" || item.schema_revision != schema_revision {
                tx.rollback().map_err(sqlite_error)?;
                return Ok(Some(item.transaction_id.clone()));
            }
            let mut changeset = std::io::Cursor::new(&item.changeset);
            if tx
                .apply_strm(&mut changeset, None::<fn(&str) -> bool>, |_, _| {
                    rusqlite::session::ConflictAction::SQLITE_CHANGESET_ABORT
                })
                .is_err()
            {
                tx.rollback().map_err(sqlite_error)?;
                return Ok(Some(item.transaction_id.clone()));
            }
            tx.execute(
                "INSERT INTO _silo_outbox (sequence, transaction_id, kind, base_generation, schema_revision, operation_json, changeset, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![item.sequence, item.transaction_id, item.kind, generation, item.schema_revision as i64, serde_json::to_string(&item.operation).map_err(json_error)?, item.changeset, item.created_at],
            )
            .map_err(sqlite_error)?;
        }
        tx.commit().map_err(sqlite_error)?;
        Ok(None)
    }

    pub fn backup_recovery(&self, destination: &Path) -> Result<(), SiloError> {
        self.backup(destination)
    }

    pub fn backup_canonical(&self, destination: &Path, generation: &str) -> Result<(), SiloError> {
        self.ensure_writable()?;
        self.backup(destination)?;
        let connection = Connection::open(destination).map_err(sqlite_error)?;
        configure(&connection, true)?;
        let tx = Transaction::new_unchecked(&connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        tx.execute("DELETE FROM _silo_outbox", [])
            .map_err(sqlite_error)?;
        tx.execute(
            "UPDATE _silo_sync SET base_generation = ?1, base_etag = NULL, conflict_transaction_id = NULL WHERE id = 1",
            [generation],
        )
        .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)
    }

    fn backup(&self, destination: &Path) -> Result<(), SiloError> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        self.connection
            .backup("main", destination, None)
            .map_err(sqlite_error)
    }

    pub fn record_mutation<F, T>(&mut self, operation: Value, mutate: F) -> Result<T, SiloError>
    where
        F: FnOnce(&Connection) -> Result<T, SiloError>,
    {
        self.ensure_writable()?;
        if !operation.is_object() {
            return Err(SiloError::new(
                exits::INPUT,
                "operation_metadata_invalid",
                "Mutation context must be a JSON object.",
            ));
        }
        let sync = self.get_sync_state()?;
        let transaction_id = Uuid::new_v4().to_string();
        let timestamp = now();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        let mut session = if sync.is_some() {
            let mut session = Session::new(&self.connection).map_err(sqlite_error)?;
            session.table_filter(Some(|table: &str| !table.starts_with("_silo_")));
            Some(session)
        } else {
            None
        };
        let result = mutate(&self.connection)?;
        let changeset = if let Some(session) = &mut session {
            let mut buffer = Vec::new();
            session.changeset_strm(&mut buffer).map_err(sqlite_error)?;
            buffer
        } else {
            Vec::new()
        };
        let tags = resource_tags(&operation);
        tx.execute(
            "INSERT INTO _silo_journal (transaction_id, committed_at, operation_json, resource_tags_json) VALUES (?1, ?2, ?3, ?4)",
            params![transaction_id, timestamp, serde_json::to_string(&operation).map_err(json_error)?, serde_json::to_string(&tags).map_err(json_error)?],
        ).map_err(sqlite_error)?;
        tx.execute("DELETE FROM _silo_journal WHERE sequence <= (SELECT coalesce(max(sequence), 0) - ?1 FROM _silo_journal)", [MUTATION_JOURNAL_RETENTION]).map_err(sqlite_error)?;
        if let Some(sync) = sync
            && !changeset.is_empty()
        {
            let revision = self.schema()?.revision;
            tx.execute("INSERT INTO _silo_outbox (transaction_id, kind, base_generation, schema_revision, operation_json, changeset, created_at) VALUES (?1, 'data', ?2, ?3, ?4, ?5, ?6)", params![transaction_id, sync.base_generation, revision as i64, serde_json::to_string(&operation).map_err(json_error)?, changeset, timestamp]).map_err(sqlite_error)?;
        }
        tx.commit().map_err(sqlite_error)?;
        self.observed_journal_sequence = journal_bounds(&self.connection)?.1;
        Ok(result)
    }

    pub fn read_mutation_journal(
        &mut self,
        after_sequence: i64,
        limit: i64,
    ) -> Result<MutationJournalRead, SiloError> {
        if after_sequence < 0 || after_sequence > i64::MAX - 1 {
            return Err(SiloError::new(
                exits::INPUT,
                "invalid_journal_cursor",
                "The journal cursor must be a non-negative integer.",
            ));
        }
        if limit <= 0 {
            return Err(SiloError::new(
                exits::INPUT,
                "invalid_journal_limit",
                "The journal limit must be a positive integer.",
            ));
        }
        let (oldest, latest) = journal_bounds(&self.connection)?;
        let version = data_version(&self.connection)?;
        let delta = latest - self.observed_journal_sequence;
        let data_delta = version - self.observed_data_version;
        let unknown_change =
            version != self.observed_data_version && (data_delta <= 0 || data_delta != delta);
        let full_refresh_required = !table_exists(&self.connection, "_silo_journal")?
            || oldest.is_some_and(|oldest| after_sequence < oldest - 1);
        let max = limit.min(MUTATION_JOURNAL_READ_LIMIT);
        let mut entries = Vec::new();
        if !full_refresh_required {
            let mut statement = self.connection.prepare("SELECT sequence, transaction_id, committed_at, operation_json, resource_tags_json FROM _silo_journal WHERE sequence > ?1 ORDER BY sequence LIMIT ?2").map_err(sqlite_error)?;
            for row in statement
                .query_map(params![after_sequence, max], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(sqlite_error)?
            {
                let (sequence, transaction_id, committed_at, operation, tags) =
                    row.map_err(sqlite_error)?;
                entries.push(MutationJournalEntry {
                    sequence,
                    transaction_id,
                    committed_at,
                    operation: serde_json::from_str(&operation).map_err(|e| {
                        SiloError::new(exits::INTEGRITY, "journal_entry_invalid", e.to_string())
                    })?,
                    resource_tags: serde_json::from_str(&tags).map_err(|e| {
                        SiloError::new(exits::INTEGRITY, "journal_entry_invalid", e.to_string())
                    })?,
                });
            }
        }
        let next_sequence = entries.last().map_or(latest, |entry| entry.sequence);
        self.observed_data_version = version;
        self.observed_journal_sequence = latest;
        Ok(MutationJournalRead {
            entries,
            oldest_sequence: oldest,
            latest_sequence: latest,
            next_sequence,
            full_refresh_required,
            data_version: version,
            unknown_change,
        })
    }

    pub fn verify(&self) -> Result<(), SiloError> {
        let schema = self.schema()?;
        validate_schema(&schema)?;
        self.verify_physical(&schema)?;
        let check: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(sqlite_error)?;
        if check != "ok" {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "integrity_check_failed",
                check,
            ));
        }
        Ok(())
    }

    fn initialize(&mut self, schema: &LogicalSchema) -> Result<(), SiloError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        create_catalog(&tx)?;
        let timestamp = now();
        let meta = [
            ("format_version", FORMAT_VERSION.to_string()),
            ("registry_version", schema.registry_version.to_string()),
            ("tool_version", TOOL_VERSION.to_owned()),
            ("identity", self.workspace.identity.clone()),
            ("original_origin", self.workspace.origin.clone()),
            ("created_at", timestamp.clone()),
            ("updated_at", timestamp),
        ];
        for (key, value) in meta {
            tx.execute(
                "INSERT INTO _silo_meta (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(sqlite_error)?;
        }
        tx.execute(
            "INSERT INTO _silo_schema (id, schema_json) VALUES (1, ?1)",
            [serde_json::to_string(schema).map_err(json_error)?],
        )
        .map_err(sqlite_error)?;
        for ddl in compile_schema(schema)? {
            tx.execute_batch(&ddl).map_err(|error| {
                SiloError::new(exits::SCHEMA, "sqlite_compile_error", error.to_string())
            })?;
        }
        let operation = serde_json::json!({
            "command": "schema.create",
            "tables": schema.tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(),
        });
        tx.execute(
            "INSERT INTO _silo_journal (transaction_id, committed_at, operation_json, resource_tags_json) VALUES (?1, ?2, ?3, '[\"*\"]')",
            params![Uuid::new_v4().to_string(), now(), serde_json::to_string(&operation).map_err(json_error)?],
        ).map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)
    }

    fn migrate(&mut self) -> Result<(), SiloError> {
        let version: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM _silo_meta WHERE key = 'format_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unrecognized_database_error())?;
        let Some(version) = version else {
            return Err(unrecognized_database_error());
        };
        let version = version
            .parse::<u32>()
            .map_err(|_| unrecognized_database_error())?;
        if !(1..=FORMAT_VERSION).contains(&version) {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "incompatible_database",
                format!("Database format {version} is not supported."),
            ));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        create_catalog(&tx)?;
        ensure_report_query_columns(&tx)?;
        ensure_query_parameter_column(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO _silo_meta (key, value) VALUES ('format_version', ?1)",
            [FORMAT_VERSION.to_string()],
        )
        .map_err(sqlite_error)?;
        tx.execute(
            "UPDATE _silo_meta SET value = ?1 WHERE key = 'format_version'",
            [FORMAT_VERSION.to_string()],
        )
        .map_err(sqlite_error)?;
        if table_exists(&tx, "_silo_journal")? {
            ensure_journal(&tx)?;
        }
        tx.commit().map_err(sqlite_error)
    }

    fn verify_physical(&self, schema: &LogicalSchema) -> Result<(), SiloError> {
        let expected = Connection::open_in_memory().map_err(sqlite_error)?;
        expected
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(sqlite_error)?;
        for ddl in compile_schema(schema)? {
            expected.execute_batch(&ddl).map_err(|e| {
                SiloError::new(exits::SCHEMA, "sqlite_compile_error", e.to_string())
            })?;
        }
        let actual = physical_fingerprint(&self.connection, schema)?;
        let expected = physical_fingerprint(&expected, schema)?;
        if actual != expected {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "physical_schema_mismatch",
                "Physical tables, indexes, or triggers do not match authoritative schema metadata.",
            ));
        }
        Ok(())
    }

    fn ensure_writable(&self) -> Result<(), SiloError> {
        if !self.writable {
            Err(SiloError::new(
                exits::IO,
                "read_only_database",
                "This database was opened read-only.",
            ))
        } else {
            Ok(())
        }
    }
}

fn configure(connection: &Connection, writable: bool) -> Result<(), SiloError> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sqlite_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(sqlite_error)?;
    if writable {
        let _: String = connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(sqlite_error)?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(sqlite_error)?;
    } else {
        connection
            .pragma_update(None, "query_only", "ON")
            .map_err(sqlite_error)?;
    }
    Ok(())
}

fn create_catalog(connection: &Connection) -> Result<(), SiloError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS _silo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS _silo_schema (id INTEGER PRIMARY KEY CHECK (id = 1), schema_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS _silo_reports (slug TEXT PRIMARY KEY, title TEXT NOT NULL, template_markdown TEXT NOT NULL, rendered_markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, refreshed_at TEXT NOT NULL, last_refresh_attempt_at TEXT NOT NULL, last_refresh_error TEXT) STRICT; CREATE TABLE IF NOT EXISTS _silo_saved_queries (name TEXT PRIMARY KEY, description TEXT NOT NULL, sql TEXT NOT NULL, parameter_style TEXT NOT NULL DEFAULT 'named' CHECK (parameter_style IN ('named', 'positional')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS _silo_report_queries (report_slug TEXT NOT NULL REFERENCES _silo_reports(slug) ON DELETE CASCADE, name TEXT NOT NULL, sql TEXT, saved_query_name TEXT REFERENCES _silo_saved_queries(name), parameters_json TEXT, empty_markdown TEXT, position INTEGER NOT NULL CHECK (position >= 0), PRIMARY KEY (report_slug, name), UNIQUE (report_slug, position), CHECK ((sql IS NOT NULL AND saved_query_name IS NULL AND parameters_json IS NULL) OR (sql IS NULL AND saved_query_name IS NOT NULL))) STRICT; CREATE TABLE IF NOT EXISTS _silo_saved_query_parameters (query_name TEXT NOT NULL REFERENCES _silo_saved_queries(name) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, type_options_json TEXT, description TEXT NOT NULL, has_default INTEGER NOT NULL CHECK (has_default IN (0, 1)), default_json TEXT, position INTEGER NOT NULL CHECK (position >= 0), PRIMARY KEY (query_name, name), UNIQUE (query_name, position), CHECK ((has_default = 0 AND default_json IS NULL) OR has_default = 1)) STRICT; CREATE TABLE IF NOT EXISTS _silo_journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT NOT NULL UNIQUE, committed_at TEXT NOT NULL, operation_json TEXT NOT NULL CHECK (json_valid(operation_json) AND json_type(operation_json) = 'object'), resource_tags_json TEXT NOT NULL CHECK (json_valid(resource_tags_json) AND json_type(resource_tags_json) = 'array')) STRICT;").map_err(sqlite_error)
}

fn ensure_report_query_columns(connection: &Connection) -> Result<(), SiloError> {
    if !table_exists(connection, "_silo_report_queries")? {
        return Ok(());
    }
    let columns = table_columns(connection, "_silo_report_queries")?;
    if columns.contains("saved_query_name") {
        return Ok(());
    }
    connection.execute_batch("ALTER TABLE _silo_report_queries RENAME TO _silo_report_queries_legacy; CREATE TABLE _silo_report_queries (report_slug TEXT NOT NULL REFERENCES _silo_reports(slug) ON DELETE CASCADE, name TEXT NOT NULL, sql TEXT, saved_query_name TEXT REFERENCES _silo_saved_queries(name), parameters_json TEXT, empty_markdown TEXT, position INTEGER NOT NULL CHECK (position >= 0), PRIMARY KEY (report_slug, name), UNIQUE (report_slug, position), CHECK ((sql IS NOT NULL AND saved_query_name IS NULL AND parameters_json IS NULL) OR (sql IS NULL AND saved_query_name IS NOT NULL))) STRICT; INSERT INTO _silo_report_queries (report_slug, name, sql, empty_markdown, position) SELECT report_slug, name, sql, empty_markdown, position FROM _silo_report_queries_legacy; DROP TABLE _silo_report_queries_legacy;").map_err(sqlite_error)
}

fn ensure_query_parameter_column(connection: &Connection) -> Result<(), SiloError> {
    if !table_exists(connection, "_silo_saved_queries")? {
        return Ok(());
    }
    let columns = table_columns(connection, "_silo_saved_queries")?;
    if !columns.contains("parameter_style") {
        connection.execute("ALTER TABLE _silo_saved_queries ADD COLUMN parameter_style TEXT NOT NULL DEFAULT 'named' CHECK (parameter_style IN ('named', 'positional'))", []).map_err(sqlite_error)?;
    }
    Ok(())
}

fn ensure_journal(connection: &Connection) -> Result<(), SiloError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS _silo_journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT NOT NULL UNIQUE, committed_at TEXT NOT NULL, operation_json TEXT NOT NULL CHECK (json_valid(operation_json) AND json_type(operation_json) = 'object'), resource_tags_json TEXT NOT NULL CHECK (json_valid(resource_tags_json) AND json_type(resource_tags_json) = 'array')) STRICT;").map_err(sqlite_error)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, SiloError> {
    connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(sqlite_error)
}

fn table_columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>, SiloError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", quote(table)))
        .map_err(sqlite_error)?;
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?
        .collect::<Result<_, _>>()
        .map_err(sqlite_error)
}

fn physical_fingerprint(
    connection: &Connection,
    schema: &LogicalSchema,
) -> Result<Vec<String>, SiloError> {
    let tables: BTreeSet<_> = schema
        .tables
        .iter()
        .map(|table| table.name.to_lowercase())
        .collect();
    let mut statement = connection.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(sqlite_error)?;
    let mut result = Vec::new();
    for row in rows {
        let (kind, name, table, sql) = row.map_err(sqlite_error)?;
        if tables.contains(&table.to_lowercase()) {
            result.push(format!(
                "{}:{}:{}:{}",
                kind,
                name.to_lowercase(),
                table.to_lowercase(),
                normalize_ddl(&sql)
            ));
        }
    }
    Ok(result)
}

pub fn normalize_ddl(sql: &str) -> String {
    let mut tokens = Vec::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        if character == '-' && chars.get(index + 1) == Some(&'-') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            index = (index + 2).min(chars.len());
            continue;
        }
        if matches!(character, '\'' | '"' | '`' | '[') {
            let close = if character == '[' { ']' } else { character };
            let mut token = String::new();
            token.push(character);
            index += 1;
            while index < chars.len() {
                let current = chars[index];
                token.push(current);
                index += 1;
                if current == close {
                    if close != ']' && chars.get(index) == Some(&close) {
                        token.push(close);
                        index += 1;
                        continue;
                    }
                    break;
                }
            }
            tokens.push(token);
            continue;
        }
        if character.is_ascii_alphanumeric() || character == '_' || character == '$' {
            let start = index;
            index += 1;
            while index < chars.len()
                && (chars[index].is_ascii_alphanumeric()
                    || chars[index] == '_'
                    || chars[index] == '$')
            {
                index += 1;
            }
            tokens.push(
                chars[start..index]
                    .iter()
                    .collect::<String>()
                    .to_lowercase(),
            );
            continue;
        }
        tokens.push(character.to_string());
        index += 1;
    }
    tokens.join(" ")
}

fn install_read_only_authorizer(connection: &mut Connection) -> Result<(), SiloError> {
    connection
        .authorizer(Some(
            |context: rusqlite::hooks::AuthContext<'_>| match context.action {
                AuthAction::Read { table_name, .. } if table_name.starts_with("_silo_") => {
                    Authorization::Deny
                }
                AuthAction::Pragma { .. }
                | AuthAction::Attach { .. }
                | AuthAction::Detach { .. } => Authorization::Deny,
                AuthAction::Unknown { .. } => Authorization::Deny,
                _ => Authorization::Allow,
            },
        ))
        .map_err(sqlite_error)
}

fn validate_synchronized_schema(schema: &LogicalSchema) -> Result<(), SiloError> {
    for table in &schema.tables {
        let Some(primary_key) = table.primary_key.as_deref().filter(|keys| !keys.is_empty()) else {
            return Err(SiloError::new(
                exits::SCHEMA,
                "sync_primary_key_required",
                format!(
                    "Synchronized table {} must declare a primary key.",
                    table.name
                ),
            ));
        };
        for key in primary_key {
            if table
                .columns
                .iter()
                .find(|column| column.name.eq_ignore_ascii_case(key))
                .is_none_or(|column| column.nullable != Some(false))
            {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "sync_primary_key_nullable",
                    format!(
                        "Synchronized primary key {}.{} must be non-nullable.",
                        table.name, key
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn journal_bounds(connection: &Connection) -> Result<(Option<i64>, i64), SiloError> {
    if !table_exists(connection, "_silo_journal")? {
        return Ok((None, 0));
    }
    connection
        .query_row(
            "SELECT min(sequence), coalesce(max(sequence), 0) FROM _silo_journal",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sqlite_error)
}

fn data_version(connection: &Connection) -> Result<i64, SiloError> {
    connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(sqlite_error)
}

fn resource_tags(operation: &Value) -> Vec<String> {
    if let Some(tables) = operation.get("tables").and_then(Value::as_array) {
        let tags: BTreeSet<_> = tables
            .iter()
            .filter_map(Value::as_str)
            .map(|name| format!("table:{name}"))
            .collect();
        if !tags.is_empty() {
            return tags.into_iter().collect();
        }
    }
    let command = operation
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (prefix, field) = if command.starts_with("row.") {
        ("table:", "table")
    } else if command.starts_with("query.") {
        ("query:", "query")
    } else if command.starts_with("report.") {
        ("report:", "report")
    } else {
        return vec!["*".into()];
    };
    operation
        .get(field)
        .and_then(Value::as_str)
        .map(|value| vec![format!("{prefix}{value}")])
        .unwrap_or_else(|| vec!["*".into()])
}

fn json_to_sql(value: &Value) -> Result<SqlValue, SiloError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .ok_or_else(|| {
                SiloError::new(
                    exits::INPUT,
                    "unsupported_sqlite_value",
                    "The value cannot be bound to SQLite.",
                )
            })?,
        Value::String(value) => SqlValue::Text(value.clone()),
        _ => {
            return Err(SiloError::new(
                exits::INPUT,
                "unsupported_sqlite_value",
                "Only scalar JSON values can be bound to SQLite.",
            ));
        }
    })
}

fn find_table<'a>(
    schema: &'a LogicalSchema,
    name: &str,
) -> Result<&'a silo_core::TableDefinition, SiloError> {
    schema
        .tables
        .iter()
        .find(|table| table.name == name)
        .ok_or_else(|| {
            SiloError::new(
                exits::SCHEMA,
                "table_not_found",
                format!("Table {name} is not defined."),
            )
        })
}

fn find_policy<'a>(
    table: &'a silo_core::TableDefinition,
    kind: &str,
) -> Option<&'a silo_core::PolicyDefinition> {
    table
        .policies
        .as_deref()?
        .iter()
        .find(|policy| policy.kind == kind)
}

fn input_error(message: &str) -> SiloError {
    SiloError::new(exits::INPUT, "invalid_shape", message)
}

fn prepare_row(
    table: &silo_core::TableDefinition,
    raw: &serde_json::Map<String, Value>,
    insert: bool,
) -> Result<BTreeMap<String, SqlValue>, SiloError> {
    let mut row = BTreeMap::new();
    for (name, value) in raw {
        let column = table
            .columns
            .iter()
            .find(|column| column.name == *name)
            .ok_or_else(|| {
                SiloError::new(
                    exits::INPUT,
                    "unknown_field",
                    format!("Unknown field {name}."),
                )
                .at(format!("$.{name}"))
            })?;
        if column.generated.is_some() {
            return Err(SiloError::new(
                exits::INPUT,
                "generated_column_input",
                format!("Generated column {name} cannot be written directly."),
            )
            .at(format!("$.{name}")));
        }
        let canonical = canonicalize(column, value)?;
        row.insert(name.clone(), column_to_sql(column, canonical)?);
    }
    if insert {
        if let Some(policy) = find_policy(table, "generated_identity")
            && policy.string("strategy") != Some("integer")
        {
            let column_name = policy.string("column").ok_or_else(|| {
                SiloError::new(
                    exits::SCHEMA,
                    "invalid_identity_policy",
                    "generated_identity requires a column.",
                )
            })?;
            if !row.contains_key(column_name) {
                let strategy = policy.string("strategy").unwrap_or_default();
                let value = match strategy {
                    "uuid" => Uuid::new_v4().to_string(),
                    "ulid" => new_ulid(),
                    _ => {
                        return Err(SiloError::new(
                            exits::SCHEMA,
                            "invalid_identity_strategy",
                            "Generated identity strategy must be uuid, ulid, or integer.",
                        ));
                    }
                };
                let column = table
                    .columns
                    .iter()
                    .find(|column| column.name == column_name)
                    .ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "invalid_identity_policy",
                            "generated_identity column is missing.",
                        )
                    })?;
                row.insert(
                    column_name.to_owned(),
                    column_to_sql(column, Value::String(value))?,
                );
            }
        }
        if let Some(policy) = find_policy(table, "timestamps") {
            let timestamp = now();
            for key in [
                policy.string("created_column"),
                policy.string("updated_column"),
            ] {
                if let Some(key) = key
                    && !row.contains_key(key)
                {
                    let column = table
                        .columns
                        .iter()
                        .find(|column| column.name == key)
                        .ok_or_else(|| {
                            SiloError::new(
                                exits::SCHEMA,
                                "invalid_timestamp_policy",
                                "Timestamp policy column is missing.",
                            )
                        })?;
                    row.insert(
                        key.to_owned(),
                        column_to_sql(column, Value::String(timestamp.clone()))?,
                    );
                }
            }
        }
        if let Some(policy) = find_policy(table, "optimistic_revision") {
            let column_name = policy.string("column").ok_or_else(|| {
                SiloError::new(
                    exits::SCHEMA,
                    "invalid_revision_policy",
                    "optimistic_revision requires a column.",
                )
            })?;
            if !row.contains_key(column_name) {
                let initial = policy
                    .fields
                    .get("initial")
                    .cloned()
                    .unwrap_or(Value::from(1));
                let column = table
                    .columns
                    .iter()
                    .find(|column| column.name == column_name)
                    .ok_or_else(|| {
                        SiloError::new(
                            exits::SCHEMA,
                            "invalid_revision_policy",
                            "optimistic_revision column is missing.",
                        )
                    })?;
                row.insert(column_name.to_owned(), column_to_sql(column, initial)?);
            }
        }
    }
    Ok(row)
}

fn column_to_sql(
    column: &silo_core::ColumnDefinition,
    value: Value,
) -> Result<SqlValue, SiloError> {
    if matches!(column.semantic_type.as_str(), "blob" | "blob/bytes") {
        let bytes = value
            .as_array()
            .ok_or_else(|| {
                SiloError::new(
                    exits::INPUT,
                    "unsupported_sqlite_value",
                    "Blob values must be base64 strings.",
                )
            })?
            .iter()
            .map(|byte| {
                byte.as_u64()
                    .and_then(|byte| u8::try_from(byte).ok())
                    .ok_or_else(|| {
                        SiloError::new(
                            exits::INPUT,
                            "unsupported_sqlite_value",
                            "Blob values must contain bytes from 0 through 255.",
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(SqlValue::Blob(bytes));
    }
    json_to_sql(&value)
}

fn insert_statement(
    connection: &Connection,
    table: &silo_core::TableDefinition,
    row: &BTreeMap<String, SqlValue>,
    upsert: Option<(&[String], &[String])>,
) -> Result<(), SiloError> {
    let (columns, values) = if row.is_empty() {
        (String::new(), String::new())
    } else {
        let columns = row
            .keys()
            .map(|column| quote(column))
            .collect::<Vec<_>>()
            .join(", ");
        let values = (1..=row.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        (format!(" ({columns})"), format!(" VALUES ({values})"))
    };
    let mut sql = if row.is_empty() {
        format!("INSERT INTO {} DEFAULT VALUES", quote(&table.name))
    } else {
        format!("INSERT INTO {}{columns}{values}", quote(&table.name))
    };
    if let Some((keys, updates)) = upsert {
        let keys = keys
            .iter()
            .map(|key| quote(key))
            .collect::<Vec<_>>()
            .join(", ");
        if updates.is_empty() {
            sql.push_str(&format!(" ON CONFLICT ({keys}) DO NOTHING"));
        } else {
            let updates = updates
                .iter()
                .map(|column| format!("{} = excluded.{}", quote(column), quote(column)))
                .collect::<Vec<_>>()
                .join(", ");
            sql.push_str(&format!(" ON CONFLICT ({keys}) DO UPDATE SET {updates}"));
        }
    }
    connection
        .execute(&sql, rusqlite::params_from_iter(row.values()))
        .map_err(sqlite_error)?;
    Ok(())
}

fn key_values(
    table: &silo_core::TableDefinition,
    key: &Value,
) -> Result<(Vec<String>, Vec<SqlValue>), SiloError> {
    let keys = table
        .primary_key
        .as_deref()
        .filter(|keys| !keys.is_empty())
        .map(<[String]>::to_vec)
        .or_else(|| {
            find_policy(table, "generated_identity")
                .and_then(|policy| policy.string("column"))
                .map(|column| vec![column.to_owned()])
        })
        .ok_or_else(|| {
            SiloError::new(
                exits::SCHEMA,
                "primary_key_required",
                "Row-by-key operations require a primary key or generated identity.",
            )
        })?;
    let decoded;
    let values = if keys.len() == 1 {
        if let Value::Array(values) = key {
            if values.len() != 1 {
                return Err(SiloError::new(
                    exits::INPUT,
                    "invalid_key",
                    "Expected 1 key value.",
                ));
            }
            values.as_slice()
        } else {
            std::slice::from_ref(key)
        }
    } else if let Value::Array(values) = key {
        values.as_slice()
    } else if let Value::String(text) = key {
        decoded = serde_json::from_str::<Value>(text).map_err(|_| {
            SiloError::new(
                exits::INPUT,
                "invalid_key",
                format!("Expected {} key values.", keys.len()),
            )
        })?;
        decoded.as_array().map(Vec::as_slice).ok_or_else(|| {
            SiloError::new(
                exits::INPUT,
                "invalid_key",
                format!("Expected {} key values.", keys.len()),
            )
        })?
    } else {
        return Err(SiloError::new(
            exits::INPUT,
            "invalid_key",
            format!("Expected {} key values.", keys.len()),
        ));
    };
    if values.len() != keys.len() {
        return Err(SiloError::new(
            exits::INPUT,
            "invalid_key",
            format!("Expected {} key values.", keys.len()),
        ));
    }
    let bound = keys
        .iter()
        .zip(values)
        .map(|(key, value)| {
            let column = table
                .columns
                .iter()
                .find(|column| column.name == *key)
                .ok_or_else(|| {
                    SiloError::new(
                        exits::SCHEMA,
                        "invalid_primary_key",
                        format!("Column {key} is not defined."),
                    )
                })?;
            let decoded = if let Value::String(text) = value {
                let parse_json = semantic_storage(&column.semantic_type) != Some("TEXT")
                    || column.semantic_type == "text/json"
                    || (text.starts_with('"') && text.ends_with('"'));
                if parse_json {
                    serde_json::from_str::<Value>(text).unwrap_or_else(|_| value.clone())
                } else {
                    value.clone()
                }
            } else {
                value.clone()
            };
            column_to_sql(column, canonicalize(column, &decoded)?)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((keys, bound))
}

fn where_clause(keys: &[String]) -> String {
    keys.iter()
        .enumerate()
        .map(|(index, key)| format!("{} = ?{}", quote(key), index + 1))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn select_row(
    connection: &Connection,
    table: &silo_core::TableDefinition,
    keys: &[String],
    values: &[SqlValue],
) -> Result<Option<Value>, SiloError> {
    let sql = format!(
        "SELECT * FROM {} WHERE {}",
        quote(&table.name),
        where_clause(keys)
    );
    connection
        .query_row(&sql, rusqlite::params_from_iter(values.iter()), |row| {
            read_row(row, table)
        })
        .optional()
        .map_err(sqlite_error)
}

fn select_rowid(
    connection: &Connection,
    table: &silo_core::TableDefinition,
    rowid: i64,
) -> Result<Option<Value>, SiloError> {
    let sql = format!("SELECT * FROM {} WHERE rowid = ?1", quote(&table.name));
    connection
        .query_row(&sql, [rowid], |row| read_row(row, table))
        .optional()
        .map_err(sqlite_error)
}

fn read_row(
    row: &rusqlite::Row<'_>,
    table: &silo_core::TableDefinition,
) -> rusqlite::Result<Value> {
    let mut output = serde_json::Map::new();
    for (index, column) in table.columns.iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Blob(bytes)
                if matches!(column.semantic_type.as_str(), "blob" | "blob/bytes") =>
            {
                Value::String(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    bytes,
                ))
            }
            value => sql_to_json(value),
        };
        output.insert(column.name.clone(), value);
    }
    Ok(Value::Object(output))
}

fn later_timestamp(previous: Option<&str>) -> Result<SqlValue, SiloError> {
    let current = Utc::now();
    let next = previous
        .and_then(|previous| chrono::DateTime::parse_from_rfc3339(previous).ok())
        .map(|previous| {
            let prior = previous.with_timezone(&Utc);
            if prior >= current {
                prior + chrono::Duration::milliseconds(1)
            } else {
                current
            }
        })
        .unwrap_or(current);
    Ok(SqlValue::Text(
        next.to_rfc3339_opts(SecondsFormat::Millis, true),
    ))
}

fn new_ulid() -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let time = Utc::now().timestamp_millis().max(0) as u64;
    let mut timestamp = [b'0'; 10];
    let mut value = time;
    for index in (0..10).rev() {
        timestamp[index] = ALPHABET[(value & 31) as usize];
        value >>= 5;
    }
    let random = Uuid::new_v4();
    let bytes = random.as_bytes();
    let mut output = String::from_utf8(timestamp.to_vec()).expect("ULID alphabet is ASCII");
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in bytes.iter().take(10) {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 && output.len() < 26 {
            bits -= 5;
            output.push(ALPHABET[((accumulator >> bits) & 31) as usize] as char);
        }
    }
    output
}

fn sql_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::String(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            value,
        )),
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn sqlite_error(error: rusqlite::Error) -> SiloError {
    let (exit_code, code) = match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            (exits::CONSTRAINT, "sqlite_constraint")
        }
        _ => (exits::IO, "sqlite_error"),
    };
    SiloError::new(exit_code, code, error.to_string())
}

fn unrecognized_database(error: rusqlite::Error) -> SiloError {
    SiloError::new(exits::INTEGRITY, "unrecognized_database", error.to_string())
}

fn unrecognized_database_error() -> SiloError {
    SiloError::new(
        exits::INTEGRITY,
        "unrecognized_database",
        "The file is not a recognized Silo database.",
    )
}

fn json_error(error: serde_json::Error) -> SiloError {
    SiloError::new(exits::INTEGRITY, "metadata_json_invalid", error.to_string())
}

fn io_error(error: std::io::Error) -> SiloError {
    SiloError::new(exits::IO, "database_io", error.to_string())
}

fn remove_database_files(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut candidate = path.as_os_str().to_owned();
        candidate.push(suffix);
        let _ = fs::remove_file(candidate);
    }
}

fn append_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    value.into()
}
