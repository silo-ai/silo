use std::{
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, Stdio},
};

use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use silo_core::{LogicalSchema, SiloError, TableDefinition, exits};
use silo_db::{
    ReportDefinition, SavedQueryDefinition, SiloDatabase, StoredReport, StoredSavedQuery,
};
use silo_reports::{
    decode_query_argument, parse_report_definition, parse_saved_query_definition,
    render_markdown_html, render_report, render_stored_report, run_saved_query,
};
use silo_sync::SiloSync;
use silo_workspace::{
    Workspace, WorkspaceSelection, data_root, resolve_workspace, resolve_workspace_selection,
    set_workspace_selection,
};

const SKILL_RESOURCES: &[&str] = &[
    "SKILL.md",
    "tasks/alter-table.md",
    "tasks/create-report.md",
    "tasks/create-table.md",
    "tasks/query-with-sql.md",
    "tasks/save-a-query.md",
    "tasks/synchronize.md",
    "tasks/update-with-revision.md",
    "tasks/upsert-rows.md",
    "tasks/manage-relations.md",
    "schemas/report-put.schema.json",
    "schemas/query-put.schema.json",
    "schemas/relation.schema.json",
    "schemas/row-write.schema.json",
    "schemas/table-alter.schema.json",
    "schemas/table-create.schema.json",
];

#[derive(Parser)]
#[command(
    name = "silo",
    version,
    about = "Git-scoped SQLite workspaces with explicit checkpoint synchronization"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Status,
    Context,
    Switch(SwitchArgs),
    Skill {
        resource: Option<String>,
    },
    Push,
    Pull,
    Database {
        #[command(subcommand)]
        command: DatabaseCommand,
    },
    Template {
        #[command(subcommand)]
        command: TemplateCommand,
    },
    Schema {
        #[command(subcommand)]
        command: SchemaCommand,
    },
    Relation {
        #[command(subcommand)]
        command: RelationCommand,
    },
    Table {
        #[command(subcommand)]
        command: TableCommand,
    },
    Row {
        #[command(subcommand)]
        command: RowCommand,
    },
    Query {
        #[command(subcommand)]
        command: QueryCommand,
    },
    Report {
        #[command(subcommand)]
        command: ReportCommand,
    },
    Sql {
        query: Option<String>,
    },
    Sync {
        #[command(subcommand)]
        command: SyncCommand,
    },
}

#[derive(Args)]
struct SwitchArgs {
    remote: Option<String>,
    #[arg(long, conflicts_with_all = ["auto", "remote"])]
    detach: bool,
    #[arg(long, conflicts_with = "remote")]
    auto: bool,
    #[arg(long)]
    r#move: bool,
}

#[derive(Subcommand)]
enum DatabaseCommand {
    List,
}

#[derive(Subcommand)]
enum TemplateCommand {
    List,
    Show { name: String },
}

#[derive(Subcommand)]
enum SchemaCommand {
    Show,
    Export,
    Ddl,
    Import { template: String },
}

#[derive(Subcommand)]
enum RelationCommand {
    Add(InputArgs),
    List,
    Show { table: String, name: String },
    Remove { table: String, name: String },
}

#[derive(Subcommand)]
enum TableCommand {
    List,
    Show {
        table: String,
    },
    Create(InputArgs),
    Alter {
        table: String,
        #[command(flatten)]
        input: InputArgs,
    },
    Drop {
        table: String,
    },
}

#[derive(Subcommand)]
enum RowCommand {
    Add {
        table: String,
        #[command(flatten)]
        input: InputArgs,
    },
    Upsert {
        table: String,
        #[command(flatten)]
        input: InputArgs,
    },
    Get {
        table: String,
        key: String,
    },
    List {
        table: String,
        #[arg(long, default_value_t = 100)]
        limit: u64,
        #[arg(long, default_value_t = 0)]
        offset: u64,
    },
    Update {
        table: String,
        key: String,
        #[command(flatten)]
        input: InputArgs,
    },
    Delete {
        table: String,
        key: String,
    },
}

#[derive(Args)]
struct InputArgs {
    #[arg(short, long)]
    file: Option<PathBuf>,
}

#[derive(Subcommand)]
enum QueryCommand {
    Put(InputArgs),
    List,
    Show {
        name: String,
    },
    Delete {
        name: String,
    },
    Run {
        name: String,
        #[arg(long)]
        params: Option<String>,
    },
    #[command(external_subcommand)]
    Direct(Vec<OsString>),
}

#[derive(Subcommand)]
enum ReportCommand {
    Validate(InputArgs),
    Put(InputArgs),
    List,
    Show {
        slug: String,
        #[arg(long)]
        definition: bool,
    },
    Refresh {
        slug: String,
    },
    Delete {
        slug: String,
    },
    Open {
        slug: String,
    },
}

#[derive(Subcommand)]
enum SyncCommand {
    Init {
        remote_url: String,
    },
    AdoptRemote {
        remote_url: String,
        confirmed_generation: String,
    },
    ReplaceRemote {
        remote_url: String,
        confirmed_generation: String,
    },
    Status,
    Discard {
        transaction_id: String,
    },
    Pull,
    Push,
    Prune {
        #[arg(long, default_value_t = 7.0)]
        older_than: f64,
        #[arg(long)]
        apply: bool,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("{}", render_error(&error));
        std::process::exit(error.exit_code);
    }
}

async fn run(cli: Cli) -> Result<(), SiloError> {
    match cli.command {
        Command::Status => status(),
        Command::Context => context(),
        Command::Switch(args) => switch_workspace(args),
        Command::Skill { resource } => print_skill(resource.as_deref()),
        Command::Database { command } => match command {
            DatabaseCommand::List => list_databases(),
        },
        Command::Template { command } => match command {
            TemplateCommand::List => list_templates(),
            TemplateCommand::Show { name } => show_template(&name),
        },
        Command::Schema { command } => schema_command(command),
        Command::Relation { command } => relation_command(command),
        Command::Table { command } => table_command(command),
        Command::Row { command } => row_command(command),
        Command::Query { command } => query_command(command),
        Command::Report { command } => report_command(command),
        Command::Sql { query } => run_sql(query.as_deref()),
        Command::Push => sync_command(SyncCommand::Push).await,
        Command::Pull => sync_command(SyncCommand::Pull).await,
        Command::Sync { command } => sync_command(command).await,
    }
}

fn status() -> Result<(), SiloError> {
    let workspace = current_workspace()?;
    let (state, revision) = match SiloDatabase::open(workspace.clone(), false) {
        Ok(database) => ("recognized", Some(database.schema()?.revision)),
        Err(error) if error.code == "database_absent" => ("absent", None),
        Err(error) => return Err(error),
    };
    print_heading(
        "Silo Status",
        &render_workspace_status(&workspace, state, revision),
    );
    Ok(())
}

fn context() -> Result<(), SiloError> {
    let workspace = current_workspace()?;
    match SiloDatabase::open(workspace.clone(), false) {
        Ok(database) => {
            let schema = database.schema()?;
            let queries = database.list_saved_queries()?;
            let body = format!(
                "{}\n\n## Schema\n\n{}\n\n## Saved queries\n\n{}",
                render_workspace_status(&workspace, "recognized", Some(schema.revision)),
                render_schema(&schema),
                render_saved_queries(&queries),
            );
            print_heading("Silo Context", &body);
        }
        Err(error) if error.code == "database_absent" => {
            print_heading(
                "Silo Context",
                &format!(
                    "{}\n\n## Schema\n\n_Database is absent; schema and saved queries are unavailable._",
                    render_workspace_status(&workspace, "absent", None)
                ),
            );
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

fn switch_workspace(args: SwitchArgs) -> Result<(), SiloError> {
    if usize::from(args.remote.is_some()) + usize::from(args.detach) + usize::from(args.auto) != 1 {
        return Err(input_error(
            "invalid_workspace_selection",
            "Provide one Git remote name, --detach, or --auto.",
        ));
    }
    let selection = if let Some(name) = args.remote {
        WorkspaceSelection::Remote { name }
    } else if args.detach {
        WorkspaceSelection::Detached
    } else {
        WorkspaceSelection::Auto
    };
    let target = resolve_workspace_selection(current_dir()?, selection.clone())?;
    let mut moved_from = None;
    if args.r#move {
        let current = current_workspace()?;
        let mut source = current.clone();
        if let Some(migration) = current.migration_source.as_ref() {
            source.identity = migration.identity.clone();
            source.origin = migration.origin.clone();
            source.database_path = migration.database_path.clone();
        }
        if source.database_path.exists() && source.database_path != target.database_path {
            SiloDatabase::move_workspace_database(&source, &target)?;
            moved_from = Some(source.identity);
        }
    }
    set_workspace_selection(current_dir()?, selection.clone())?;
    print_heading(
        "Silo Workspace Selected",
        &markdown_table(
            &["Property", "Value"],
            &[
                vec![
                    "Selection".into(),
                    match selection {
                        WorkspaceSelection::Auto => "auto".into(),
                        WorkspaceSelection::Detached => "detached".into(),
                        WorkspaceSelection::Remote { name } => format!("remote:{name}"),
                    },
                ],
                vec!["Identity".into(), target.identity],
                vec![
                    "Database".into(),
                    target.database_path.display().to_string(),
                ],
                vec!["Moved from".into(), moved_from.unwrap_or_default()],
            ],
        ),
    );
    Ok(())
}

fn print_skill(resource: Option<&str>) -> Result<(), SiloError> {
    let resource = resource.unwrap_or("SKILL.md");
    if !SKILL_RESOURCES.contains(&resource) {
        return Err(input_error(
            "unknown_skill_resource",
            "The requested path is not a published Silo skill resource.",
        ));
    }
    print!(
        "{}",
        skill_content(resource).ok_or_else(|| SiloError::new(
            exits::INTEGRITY,
            "skill_resource_missing",
            "A packaged Silo skill resource is missing."
        ))?
    );
    Ok(())
}

fn skill_content(resource: &str) -> Option<&'static str> {
    Some(match resource {
        "SKILL.md" => include_str!("../../../skills/silo/SKILL.md"),
        "tasks/alter-table.md" => include_str!("../../../skills/silo/tasks/alter-table.md"),
        "tasks/create-report.md" => include_str!("../../../skills/silo/tasks/create-report.md"),
        "tasks/create-table.md" => include_str!("../../../skills/silo/tasks/create-table.md"),
        "tasks/query-with-sql.md" => include_str!("../../../skills/silo/tasks/query-with-sql.md"),
        "tasks/save-a-query.md" => include_str!("../../../skills/silo/tasks/save-a-query.md"),
        "tasks/synchronize.md" => include_str!("../../../skills/silo/tasks/synchronize.md"),
        "tasks/update-with-revision.md" => {
            include_str!("../../../skills/silo/tasks/update-with-revision.md")
        }
        "tasks/upsert-rows.md" => include_str!("../../../skills/silo/tasks/upsert-rows.md"),
        "tasks/manage-relations.md" => {
            include_str!("../../../skills/silo/tasks/manage-relations.md")
        }
        "schemas/report-put.schema.json" => {
            include_str!("../../../skills/silo/schemas/report-put.schema.json")
        }
        "schemas/query-put.schema.json" => {
            include_str!("../../../skills/silo/schemas/query-put.schema.json")
        }
        "schemas/relation.schema.json" => {
            include_str!("../../../skills/silo/schemas/relation.schema.json")
        }
        "schemas/row-write.schema.json" => {
            include_str!("../../../skills/silo/schemas/row-write.schema.json")
        }
        "schemas/table-alter.schema.json" => {
            include_str!("../../../skills/silo/schemas/table-alter.schema.json")
        }
        "schemas/table-create.schema.json" => {
            include_str!("../../../skills/silo/schemas/table-create.schema.json")
        }
        _ => return None,
    })
}

fn list_databases() -> Result<(), SiloError> {
    let root = data_root().join("databases");
    let mut rows = Vec::new();
    if root.exists() {
        collect_databases(&root, &root, &mut rows)?;
    }
    rows.sort_by(|left, right| left[0].cmp(&right[0]));
    print_heading(
        "Databases",
        &if rows.is_empty() {
            "_No databases._".into()
        } else {
            markdown_table(&["Identity", "Path"], &rows)
        },
    );
    Ok(())
}

fn collect_databases(
    root: &Path,
    path: &Path,
    rows: &mut Vec<Vec<String>>,
) -> Result<(), SiloError> {
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let entry_path = entry.path();
        let kind = entry.file_type().map_err(io_error)?;
        if kind.is_dir() {
            collect_databases(root, &entry_path, rows)?;
        } else if kind.is_file() && entry_path.extension().is_some_and(|ext| ext == "sqlite") {
            let identity = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/");
            rows.push(vec![identity, entry_path.display().to_string()]);
        }
    }
    Ok(())
}

fn list_templates() -> Result<(), SiloError> {
    let mut names = vec!["source-audit".to_owned(), "tasks".to_owned()];
    let local = data_root().join("templates");
    if local.is_dir() {
        for entry in fs::read_dir(local).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                if let Some(name) = path.file_stem().and_then(|name| name.to_str()) {
                    names.push(name.to_owned());
                }
            }
        }
    }
    names.sort_unstable();
    names.dedup();
    print_heading(
        "Templates",
        &names
            .iter()
            .map(|name| format!("- `{name}`"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    Ok(())
}

fn show_template(name: &str) -> Result<(), SiloError> {
    let value = read_template(name)?;
    print_heading(
        &format!("Template: {name}"),
        &format!(
            "```json\n{}\n```",
            serde_json::to_string_pretty(&value).map_err(json_error)?
        ),
    );
    Ok(())
}

fn schema_command(command: SchemaCommand) -> Result<(), SiloError> {
    match command {
        SchemaCommand::Show => {
            let database = open_database(false)?;
            let metadata = database.metadata()?;
            print_heading(
                "Schema",
                &format!(
                    "{}\n\n{}",
                    markdown_table(
                        &["Property", "Value"],
                        &[
                            vec!["Identity".into(), metadata.identity],
                            vec![
                                "Database".into(),
                                database.workspace.database_path.display().to_string()
                            ],
                            vec![
                                "Metadata format".into(),
                                metadata.format_version.to_string()
                            ],
                            vec!["Tool version".into(), metadata.tool_version]
                        ]
                    ),
                    render_schema(&database.schema()?)
                ),
            );
        }
        SchemaCommand::Export => {
            let schema = open_database(false)?.schema()?;
            print_heading(
                "Schema Export",
                &format!(
                    "```json\n{}\n```",
                    serde_json::to_string_pretty(&schema).map_err(json_error)?
                ),
            );
        }
        SchemaCommand::Ddl => {
            let database = open_database(false)?;
            let statements = silo_schema::compile_schema(&database.schema()?)?.join("\n\n");
            print_heading("Compiled SQLite DDL", &format!("```sql\n{statements}\n```"));
        }
        SchemaCommand::Import { template } => import_template(&template)?,
    }
    Ok(())
}

fn relation_command(command: RelationCommand) -> Result<(), SiloError> {
    match command {
        RelationCommand::Add(input) => {
            let mut database = open_database(true)?;
            let relation = database.add_relation(read_input(input.file.as_deref())?)?;
            print_heading(
                "Relation Added",
                &markdown_table(
                    &["Source", "Target", "Inverse"],
                    &[vec![
                        format!(
                            "{}.{}",
                            relation.from.table,
                            relation.from.name.as_deref().unwrap_or("")
                        ),
                        relation.to.table.clone(),
                        relation
                            .inverse_name
                            .map(|name| format!("{}.{}", relation.to.table, name))
                            .unwrap_or_default(),
                    ]],
                ),
            );
        }
        RelationCommand::List => {
            let schema = open_database(false)?.schema()?;
            let relations = schema.relations.unwrap_or_default();
            let rows = relations
                .iter()
                .map(|item| {
                    vec![
                        format!(
                            "{}.{}",
                            item.from.table,
                            item.from.name.as_deref().unwrap_or("")
                        ),
                        item.to.table.clone(),
                        item.inverse_name.clone().unwrap_or_default(),
                    ]
                })
                .collect::<Vec<_>>();
            print_heading(
                "Semantic Relations",
                &if rows.is_empty() {
                    "_No semantic relations._".into()
                } else {
                    markdown_table(&["Source", "Target", "Inverse"], &rows)
                },
            );
        }
        RelationCommand::Show { table, name } => {
            let schema = open_database(false)?.schema()?;
            let relation = schema
                .relations
                .unwrap_or_default()
                .into_iter()
                .find(|relation| {
                    relation.from.table.eq_ignore_ascii_case(&table)
                        && relation
                            .from
                            .name
                            .as_deref()
                            .is_some_and(|current| current.eq_ignore_ascii_case(&name))
                })
                .ok_or_else(|| {
                    SiloError::new(
                        exits::NOT_FOUND,
                        "relation_not_found",
                        format!("No relation {table}.{name} exists."),
                    )
                })?;
            print_heading(
                &format!("Relation: {table}.{name}"),
                &format!(
                    "```json\n{}\n```",
                    serde_json::to_string_pretty(&relation).map_err(json_error)?
                ),
            );
        }
        RelationCommand::Remove { table, name } => {
            open_database(true)?.remove_relation(&table, &name)?;
            print_heading(
                "Relation Removed",
                &format!("`{table}.{name}` was removed."),
            );
        }
    }
    Ok(())
}

fn table_command(command: TableCommand) -> Result<(), SiloError> {
    match command {
        TableCommand::List => {
            let schema = open_database(false)?.schema()?;
            let rows = schema
                .tables
                .iter()
                .map(|table| vec![table.name.clone(), table.comment.clone()])
                .collect::<Vec<_>>();
            print_heading(
                "Tables",
                &if rows.is_empty() {
                    "_No tables._".into()
                } else {
                    markdown_table(&["Table", "Comment"], &rows)
                },
            );
        }
        TableCommand::Show { table } => {
            let schema = open_database(false)?.schema()?;
            let definition = find_table(&schema, &table)?.clone();
            print_heading(
                &format!("Table: {table}"),
                &format!(
                    "```json\n{}\n```",
                    serde_json::to_string_pretty(&definition).map_err(json_error)?
                ),
            );
        }
        TableCommand::Create(input) => {
            let value = read_input(input.file.as_deref())?;
            let workspace = current_workspace()?;
            let definition = silo_schema::parse_table(value.clone())?;
            let (_database, definition) = match SiloDatabase::open(workspace.clone(), true) {
                Ok(mut database) => {
                    let definition = database.create_table(value)?;
                    (database, definition)
                }
                Err(error) if error.code == "database_absent" => {
                    let mut schema = silo_schema::empty_schema();
                    schema.tables.push(definition.clone());
                    (
                        SiloDatabase::create_with_schema(workspace, &schema)?,
                        definition,
                    )
                }
                Err(error) => return Err(error),
            };
            print_heading(
                "Table Created",
                &markdown_table(
                    &["Table", "Columns"],
                    &[vec![definition.name, definition.columns.len().to_string()]],
                ),
            );
        }
        TableCommand::Alter { table, input } => {
            let mut database = open_database(true)?;
            let changed = database.alter_table(&table, &read_input(input.file.as_deref())?)?;
            print_heading(
                "Table Altered",
                &markdown_table(
                    &["Table", "Columns", "Indexes"],
                    &[vec![
                        changed.name,
                        changed.columns.len().to_string(),
                        changed.indexes.as_ref().map_or(0, Vec::len).to_string(),
                    ]],
                ),
            );
        }
        TableCommand::Drop { table } => {
            open_database(true)?.drop_table(&table)?;
            print_heading("Table Dropped", &format!("`{table}` was dropped."));
        }
    }
    Ok(())
}

fn row_command(command: RowCommand) -> Result<(), SiloError> {
    match command {
        RowCommand::Add { table, input } => {
            let mut database = open_database(true)?;
            let rows = database.insert_rows(&table, &read_input(input.file.as_deref())?, false)?;
            render_rows("Rows Added", &rows);
        }
        RowCommand::Upsert { table, input } => {
            let mut database = open_database(true)?;
            let rows = database.insert_rows(&table, &read_input(input.file.as_deref())?, true)?;
            render_rows("Rows Upserted", &rows);
        }
        RowCommand::Get { table, key } => {
            let database = open_database(false)?;
            let row = database.get_row(&table, &Value::String(key))?;
            render_rows("Row", &[row]);
        }
        RowCommand::List {
            table,
            limit,
            offset,
        } => {
            let database = open_database(false)?;
            let rows = database.list_rows(&table, limit, offset)?;
            render_rows("Rows", &rows);
        }
        RowCommand::Update { table, key, input } => {
            let mut database = open_database(true)?;
            let changes = database.update_row(
                &table,
                &Value::String(key),
                &read_input(input.file.as_deref())?,
            )?;
            print_heading(
                "Row Updated",
                &markdown_table(&["Changes"], &[vec![changes.to_string()]]),
            );
        }
        RowCommand::Delete { table, key } => {
            let mut database = open_database(true)?;
            let changes = database.delete_row(&table, &Value::String(key))?;
            print_heading(
                "Row Deleted",
                &markdown_table(&["Changes"], &[vec![changes.to_string()]]),
            );
        }
    }
    Ok(())
}

fn query_command(command: QueryCommand) -> Result<(), SiloError> {
    match command {
        QueryCommand::Put(input) => {
            let mut database = open_database(true)?;
            let definition = parse_saved_query_definition(read_input(input.file.as_deref())?)?;
            validate_saved_query(&database, &definition)?;
            let query = database.put_saved_query(&definition)?;
            print_saved_query("Query Saved", &query);
        }
        QueryCommand::List => {
            let queries = open_database(false)?.list_saved_queries()?;
            print_heading("Saved Queries", &render_saved_queries(&queries));
        }
        QueryCommand::Show { name } => {
            let query = open_database(false)?.get_saved_query(&name)?;
            print_saved_query(&format!("Saved Query: {}", query.definition.name), &query);
        }
        QueryCommand::Delete { name } => {
            open_database(true)?.delete_saved_query(&name)?;
            print_heading("Query Deleted", &format!("`{name}` was deleted."));
        }
        QueryCommand::Run { name, params } => {
            let input = match params {
                Some(source) => serde_json::from_str(&source).map_err(json_error)?,
                None => Value::Null,
            };
            let database = open_database(false)?;
            let result = run_saved_query(&database, &name, &input)?;
            render_query_result(&format!("Query Result: {name}"), &result);
        }
        QueryCommand::Direct(args) => {
            let (name, args) = args.split_first().ok_or_else(|| {
                input_error("missing_query_name", "A saved query name is required.")
            })?;
            let name = name.to_str().ok_or_else(|| {
                input_error("invalid_query_name", "Query names must be valid UTF-8.")
            })?;
            let database = open_database(false)?;
            let query = database.get_saved_query(name)?;
            let input = direct_query_parameters(&query.definition, args)?;
            let result = run_saved_query(&database, name, &input)?;
            render_query_result(&format!("Query Result: {name}"), &result);
        }
    }
    Ok(())
}

fn direct_query_parameters(
    definition: &SavedQueryDefinition,
    args: &[OsString],
) -> Result<Value, SiloError> {
    let values = args
        .iter()
        .map(|arg| {
            arg.to_str().ok_or_else(|| {
                input_error(
                    "invalid_query_argument",
                    "Query arguments must be valid UTF-8.",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if definition.parameter_style == "positional" {
        if values.iter().any(|value| value.starts_with("--")) {
            return Err(input_error(
                "invalid_query_argument",
                "Positional saved queries do not accept named options.",
            ));
        }
        let mut decoded = Vec::new();
        for (index, value) in values.iter().enumerate() {
            let parameter = definition.parameters.get(index).ok_or_else(|| {
                input_error(
                    "query_parameter_count",
                    "Too many positional query parameters.",
                )
            })?;
            decoded.push(decode_query_argument(parameter, value)?);
        }
        return Ok(Value::Array(decoded));
    }
    let mut decoded = serde_json::Map::new();
    let mut index = 0;
    while index < values.len() {
        let arg = values[index];
        let Some(option) = arg.strip_prefix("--") else {
            return Err(input_error(
                "invalid_query_argument",
                format!("Expected a --parameter option, got {arg}."),
            ));
        };
        let (name, inline) = option
            .split_once('=')
            .map_or((option, None), |(name, value)| (name, Some(value)));
        let name = name.replace('-', "_");
        let parameter = definition
            .parameters
            .iter()
            .find(|parameter| parameter.name == name)
            .ok_or_else(|| {
                input_error(
                    "unknown_query_parameter",
                    format!("Unknown query parameter {name}."),
                )
            })?;
        let raw = if let Some(value) = inline {
            value
        } else {
            index += 1;
            values.get(index).copied().ok_or_else(|| {
                input_error(
                    "missing_query_parameter",
                    format!("Expected a value after --{name}."),
                )
            })?
        };
        if decoded.contains_key(&name) {
            return Err(input_error(
                "duplicate_query_parameter",
                format!("Query parameter {name} was supplied more than once."),
            ));
        }
        decoded.insert(name, decode_query_argument(parameter, raw)?);
        index += 1;
    }
    Ok(Value::Object(decoded))
}

fn validate_saved_query(
    database: &SiloDatabase,
    definition: &SavedQueryDefinition,
) -> Result<(), SiloError> {
    let parameters = definition
        .parameters
        .iter()
        .map(|parameter| (parameter.name.clone(), Value::Null))
        .collect::<std::collections::BTreeMap<_, _>>();
    if definition.parameter_style == "positional" {
        database.query(
            &definition.sql,
            &vec![Value::Null; definition.parameters.len()],
        )?;
    } else {
        database.query_with_named(&definition.sql, &parameters, &[])?;
    }
    Ok(())
}

fn report_command(command: ReportCommand) -> Result<(), SiloError> {
    match command {
        ReportCommand::Validate(input) => {
            let definition = parse_report_definition(read_input(input.file.as_deref())?)?;
            let database = open_database(false)?;
            let (database, rendered) = render_report(database, &definition);
            drop(database);
            rendered?;
            print_heading(
                "Report Valid",
                &markdown_table(
                    &["Slug", "Title", "Format"],
                    &[vec![
                        definition.slug().into(),
                        definition.title().into(),
                        match definition {
                            ReportDefinition::Scripted { .. } => "Script".into(),
                            ReportDefinition::Legacy { .. } => "Legacy".into(),
                        },
                    ]],
                ),
            );
        }
        ReportCommand::Put(input) => {
            let definition = parse_report_definition(read_input(input.file.as_deref())?)?;
            let database = open_database(true)?;
            let (mut database, rendered) = render_report(database, &definition);
            let rendered = rendered?;
            let report = database.store_report(&definition, &rendered)?;
            print_report_saved("Report Saved", &report);
        }
        ReportCommand::List => {
            let reports = open_database(false)?.list_reports()?;
            let rows = reports
                .iter()
                .map(|report| {
                    vec![
                        report.slug.clone(),
                        report.title.clone(),
                        report.refreshed_at.clone(),
                        report.last_refresh_error.clone().unwrap_or_default(),
                    ]
                })
                .collect::<Vec<_>>();
            print_heading(
                "Reports",
                &if rows.is_empty() {
                    "_No reports._".into()
                } else {
                    markdown_table(&["Slug", "Title", "Refreshed", "Last refresh error"], &rows)
                },
            );
        }
        ReportCommand::Show { slug, definition } => {
            let report = open_database(false)?.get_report(&slug)?;
            if definition {
                print_heading(
                    &format!("Report Definition: {}", report.definition.title()),
                    &format!(
                        "```json\n{}\n```",
                        serde_json::to_string_pretty(&report.definition).map_err(json_error)?
                    ),
                );
            } else {
                let authored =
                    serde_json::to_string_pretty(&report.definition).map_err(json_error)?;
                print_heading(
                    &format!("Report: {}", report.definition.title()),
                    &format!(
                        "{}\n\n## Rendered report\n\n{}\n\n## Authored definition\n\n```json\n{}\n```",
                        markdown_table(
                            &["Property", "Value"],
                            &[
                                vec!["Slug".into(), slug],
                                vec!["Updated".into(), report.updated_at],
                                vec!["Refreshed".into(), report.refreshed_at],
                                vec![
                                    "Last refresh error".into(),
                                    report.last_refresh_error.unwrap_or_default()
                                ]
                            ]
                        ),
                        report.rendered_markdown,
                        authored
                    ),
                );
            }
        }
        ReportCommand::Refresh { slug } => {
            let database = open_database(true)?;
            database.get_report(&slug)?;
            let (mut database, rendered) = render_stored_report(database, &slug);
            match rendered {
                Ok(rendered) => {
                    let report = database.refresh_report(&slug, &rendered)?;
                    print_heading(
                        &format!("Report Refreshed: {}", report.definition.title()),
                        &report.rendered_markdown,
                    );
                }
                Err(error) => {
                    let _ = database.record_report_refresh_error(
                        &slug,
                        &format!("{}: {}", error.code, error.message),
                    );
                    return Err(error);
                }
            }
        }
        ReportCommand::Delete { slug } => {
            open_database(true)?.delete_report(&slug)?;
            print_heading("Report Deleted", &format!("`{slug}` was deleted."));
        }
        ReportCommand::Open { slug } => open_report_viewer(&slug)?,
    }
    Ok(())
}

fn run_sql(query: Option<&str>) -> Result<(), SiloError> {
    let source = match query {
        Some(query) => query.to_owned(),
        None => {
            let mut source = String::new();
            io::stdin().read_to_string(&mut source).map_err(io_error)?;
            source
        }
    };
    if source.trim().is_empty() {
        return Err(input_error(
            "empty_query",
            "Expected a SQL query argument or stdin.",
        ));
    }
    let result = open_database(false)?.query(&source, &[])?;
    render_query_result("Query Result", &result);
    Ok(())
}

async fn sync_command(command: SyncCommand) -> Result<(), SiloError> {
    let workspace = current_workspace()?;
    let sync = SiloSync::new(workspace);
    match command {
        SyncCommand::Init { remote_url } => render_sync_status(sync.initialize(&remote_url).await?),
        SyncCommand::AdoptRemote {
            remote_url,
            confirmed_generation,
        } => {
            let result = sync
                .adopt_remote(&remote_url, &confirmed_generation)
                .await?;
            render_sync_recovery(result);
        }
        SyncCommand::ReplaceRemote {
            remote_url,
            confirmed_generation,
        } => {
            let result = sync
                .replace_remote(&remote_url, &confirmed_generation)
                .await?;
            render_sync_recovery(result);
        }
        SyncCommand::Status => render_sync_status(sync.status().await?),
        SyncCommand::Discard { transaction_id } => {
            render_sync_status(sync.pull(Some(&transaction_id)).await?)
        }
        SyncCommand::Pull => render_sync_status(sync.pull(None).await?),
        SyncCommand::Push => render_sync_status(sync.push().await?),
        SyncCommand::Prune { older_than, apply } => {
            let result = sync.prune(older_than, apply).await?;
            render_prune_result(result);
        }
    }
    Ok(())
}

fn render_sync_status(status: silo_sync::SyncStatus) {
    let rows = vec![
        vec!["State".into(), status.state],
        vec!["Remote".into(), status.remote_url.unwrap_or_default()],
        vec!["Database ID".into(), status.database_id.unwrap_or_default()],
        vec![
            "Local generation".into(),
            status.local_generation.unwrap_or_default(),
        ],
        vec![
            "Remote generation".into(),
            status.remote_generation.unwrap_or_default(),
        ],
        vec![
            "Pending transactions".into(),
            status.pending_transactions.to_string(),
        ],
        vec![
            "Conflict transaction".into(),
            status.conflict_transaction_id.unwrap_or_default(),
        ],
    ];
    print_heading(
        "Synchronization",
        &markdown_table(&["Property", "Value"], &rows),
    );
}

fn render_sync_recovery(result: silo_sync::SyncRecoveryResult) {
    render_sync_status(result.status);
    print_heading("Preserved losing copy", &format!("`{}`", result.preserved));
}

fn render_prune_result(result: silo_sync::SyncPruneResult) {
    let details = markdown_table(
        &["Property", "Value"],
        &[
            vec!["Remote".into(), result.remote_url],
            vec!["Current generation".into(), result.current_generation],
            vec!["Cutoff".into(), result.cutoff],
            vec![
                "Scanned generations".into(),
                result.scanned_generations.to_string(),
            ],
            vec![
                "Eligible generations".into(),
                result.eligible_generations.len().to_string(),
            ],
            vec![
                "Deleted generations".into(),
                result.deleted_generations.len().to_string(),
            ],
        ],
    );
    let heading = if result.dry_run {
        "Synchronization Cleanup Preview"
    } else {
        "Synchronization Cleanup"
    };
    let body = if result.eligible_generations.is_empty() {
        details
    } else {
        format!(
            "{details}\n\n## Eligible Generation IDs\n\n{}",
            result
                .eligible_generations
                .iter()
                .map(|generation| format!("- `{generation}`"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    print_heading(heading, &body);
}

fn import_template(name: &str) -> Result<(), SiloError> {
    let template = read_template(name)?;
    let template_object = template
        .as_object()
        .ok_or_else(|| input_error("invalid_template", "Template must be a JSON object."))?;
    if let Some(unknown) = template_object.keys().find(|key| {
        ![
            "format_version",
            "agent_instructions",
            "tables",
            "relations",
            "queries",
            "reports",
        ]
        .contains(&key.as_str())
    }) {
        return Err(input_error(
            "unknown_template_field",
            format!("Unknown template field {unknown}."),
        ));
    }
    if template_object
        .get("format_version")
        .is_some_and(|value| value != 1)
    {
        return Err(input_error(
            "invalid_template_version",
            "format_version must be 1.",
        ));
    }
    let raw_tables = template_object
        .get("tables")
        .and_then(Value::as_array)
        .ok_or_else(|| input_error("invalid_template", "Template tables must be an array."))?;
    let tables = raw_tables
        .iter()
        .cloned()
        .map(silo_schema::parse_table)
        .collect::<Result<Vec<_>, _>>()?;
    let relations = template_array(template_object, "relations")?
        .iter()
        .enumerate()
        .map(|(index, relation)| {
            silo_schema::parse_relation(relation.clone(), &format!("$.relations[{index}]"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let agent_instructions = match template_object.get("agent_instructions") {
        None => None,
        Some(Value::String(instructions)) if !instructions.trim().is_empty() => {
            Some(instructions.as_str())
        }
        _ => {
            return Err(input_error(
                "invalid_template",
                "agent_instructions must be a non-empty string.",
            ));
        }
    };
    let query_definitions = template_array(template_object, "queries")?
        .iter()
        .cloned()
        .into_iter()
        .map(parse_saved_query_definition)
        .collect::<Result<Vec<_>, _>>()?;
    let report_definitions = template_array(template_object, "reports")?
        .iter()
        .cloned()
        .into_iter()
        .map(parse_report_definition)
        .collect::<Result<Vec<_>, _>>()?;
    let query_names = query_definitions
        .iter()
        .map(|definition| definition.name.clone())
        .collect::<Vec<_>>();
    if query_names
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != query_names.len()
    {
        return Err(input_error(
            "duplicate_template_query",
            "Template query names must be unique.",
        ));
    }
    let report_slugs = report_definitions
        .iter()
        .map(|definition| definition.slug().to_owned())
        .collect::<Vec<_>>();
    if report_slugs
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != report_slugs.len()
    {
        return Err(input_error(
            "duplicate_template_report",
            "Template report slugs must be unique.",
        ));
    }
    let mut schema_value = json!({"format_version": 1, "registry_version": 1, "revision": 0, "tables": tables, "template_imports": [{"name": name, "imported_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}]});
    if !relations.is_empty() {
        schema_value["relations"] = serde_json::to_value(&relations).map_err(json_error)?;
    }
    if let Some(instructions) = agent_instructions {
        schema_value["agent_instructions"] =
            json!([{"source": format!("template:{name}"), "content": instructions}]);
    }
    let initial_schema: LogicalSchema = silo_schema::parse_schema(schema_value)?;
    let workspace = current_workspace()?;
    let mut database = match SiloDatabase::open(workspace.clone(), true) {
        Ok(mut database) => {
            let existing_queries = database
                .list_saved_queries()?
                .into_iter()
                .map(|query| query.name)
                .collect::<std::collections::BTreeSet<_>>();
            if let Some(conflict) = query_names
                .iter()
                .find(|name| existing_queries.contains(*name))
            {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "template_query_conflict",
                    format!("Template query {conflict} already exists."),
                ));
            }
            let existing_reports = database
                .list_reports()?
                .into_iter()
                .map(|report| report.slug)
                .collect::<std::collections::BTreeSet<_>>();
            if let Some(conflict) = report_slugs
                .iter()
                .find(|slug| existing_reports.contains(*slug))
            {
                return Err(SiloError::new(
                    exits::SCHEMA,
                    "template_report_conflict",
                    format!("Template report {conflict} already exists."),
                ));
            }
            database.import_template_schema(
                name,
                tables.clone(),
                relations.clone(),
                agent_instructions,
                &query_names,
                &report_slugs,
            )?;
            database
        }
        Err(error) if error.code == "database_absent" => {
            SiloDatabase::create_with_schema(workspace, &initial_schema)?
        }
        Err(error) => return Err(error),
    };
    for definition in &query_definitions {
        validate_saved_query(&database, &definition)?;
        database.put_saved_query(definition)?;
    }
    let mut report_count = 0;
    for definition in &report_definitions {
        let (next_database, rendered) = render_report(database, definition);
        database = next_database;
        database.store_report(definition, &rendered?)?;
        report_count += 1;
    }
    print_heading(
        "Schema Template Imported",
        &markdown_table(
            &["Template", "Tables", "Queries", "Reports", "Revision"],
            &[vec![
                name.into(),
                tables.len().to_string(),
                query_definitions.len().to_string(),
                report_count.to_string(),
                database.schema()?.revision.to_string(),
            ]],
        ),
    );
    Ok(())
}

fn read_template(name: &str) -> Result<Value, SiloError> {
    if name.is_empty()
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(input_error(
            "invalid_template_name",
            "Template names use letters, digits, hyphens, and underscores.",
        ));
    }
    let local_path = data_root().join("templates").join(format!("{name}.json"));
    if local_path.is_file() {
        let source = fs::read_to_string(local_path).map_err(io_error)?;
        return serde_json::from_str(&source).map_err(json_error);
    }
    let source = match name {
        "tasks" => include_str!("../../../templates/tasks.json"),
        "source-audit" => include_str!("../../../templates/source-audit.json"),
        _ => {
            return Err(SiloError::new(
                exits::NOT_FOUND,
                "template_not_found",
                format!("{name} does not exist."),
            ));
        }
    };
    serde_json::from_str(source).map_err(json_error)
}

fn template_array<'a>(
    template: &'a serde_json::Map<String, Value>,
    name: &str,
) -> Result<&'a [Value], SiloError> {
    match template.get(name) {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        Some(_) => Err(input_error(
            "invalid_template",
            format!("{name} must be an array."),
        )),
    }
}

fn open_report_viewer(slug: &str) -> Result<(), SiloError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(io_error)?;
    let address = listener.local_addr().map_err(io_error)?;
    let url = format!("http://{address}/");
    let database = open_database(false)?;
    let report = database.get_report(slug)?;
    drop(database);
    print_heading(
        "Report Viewer",
        &format!("{url}\n\nThe loopback server remains active until this command is interrupted."),
    );
    open_browser(&url);
    for stream in listener.incoming() {
        let mut stream = stream.map_err(io_error)?;
        let mut request = [0_u8; 4096];
        let bytes = stream.read(&mut request).map_err(io_error)?;
        let request = String::from_utf8_lossy(&request[..bytes]);
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");
        let refreshed = path.starts_with("/refresh");
        let workspace = current_workspace()?;
        let (title, markdown) = if refreshed {
            let database = SiloDatabase::open(workspace, true)?;
            database.get_report(slug)?;
            let (mut database, rendered) = render_stored_report(database, slug);
            match rendered {
                Ok(markdown) => {
                    let report = database.refresh_report(slug, &markdown)?;
                    (
                        report.definition.title().to_owned(),
                        report.rendered_markdown,
                    )
                }
                Err(error) => {
                    let _ = database.record_report_refresh_error(
                        slug,
                        &format!("{}: {}", error.code, error.message),
                    );
                    (
                        report.definition.title().to_owned(),
                        format!("# Refresh failed\n\n{}", error.message),
                    )
                }
            }
        } else {
            let database = SiloDatabase::open(workspace, false)?;
            let report = database.get_report(slug)?;
            (
                report.definition.title().to_owned(),
                report.rendered_markdown,
            )
        };
        let page = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{}</title><style>body{{max-width:960px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif}}pre{{white-space:pre-wrap}}table{{border-collapse:collapse}}td,th{{border:1px solid #aaa;padding:.35rem .6rem}}</style><script>setInterval(()=>fetch('/refresh').then(r=>r.text()).then(html=>{{const doc=new DOMParser().parseFromString(html,'text/html');document.querySelector('main').innerHTML=doc.querySelector('main').innerHTML;}}),5000)</script></head><body><main><h1>{}</h1>{}</main></body></html>",
            escape_html(&title),
            escape_html(&title),
            render_markdown_html(&markdown)
        );
        respond(&mut stream, &page)?;
    }
    Ok(())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let mut command = ProcessCommand::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = ProcessCommand::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = ProcessCommand::new("xdg-open");
    let _ = command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn respond(stream: &mut TcpStream, body: &str) -> Result<(), SiloError> {
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).map_err(io_error)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_rows(title: &str, rows: &[Value]) {
    if rows.is_empty() {
        print_heading(title, "_No rows._");
        return;
    }
    let columns = rows[0]
        .as_object()
        .map(|row| row.keys().map(String::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|row| {
            columns
                .iter()
                .map(|key| row.get(*key).map(value_text).unwrap_or_default())
                .collect()
        })
        .collect::<Vec<Vec<_>>>();
    print_heading(title, &markdown_table(&columns, &data));
}

fn render_query_result(title: &str, result: &silo_db::QueryResult) {
    let table = if result.rows.is_empty() && result.columns.is_empty() {
        "_Query returned no result columns._".into()
    } else {
        markdown_table(
            &result
                .columns
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            &result
                .rows
                .iter()
                .map(|row| row.iter().map(value_text).collect())
                .collect::<Vec<Vec<_>>>(),
        )
    };
    let body = if result.truncated {
        format!("{table}\n\n> Results truncated to 500 rows.")
    } else {
        table
    };
    print_heading(title, &body);
}

fn print_saved_query(title: &str, query: &StoredSavedQuery) {
    print_heading(
        title,
        &format!(
            "{}\n\n## SQL\n\n```sql\n{}\n```\n\n## Definition\n\n```json\n{}\n```",
            markdown_table(
                &["Property", "Value"],
                &[
                    vec!["Name".into(), query.definition.name.clone()],
                    vec!["Description".into(), query.definition.description.clone()],
                    vec![
                        "Parameter style".into(),
                        query.definition.parameter_style.clone()
                    ],
                    vec!["Created".into(), query.created_at.clone()],
                    vec!["Updated".into(), query.updated_at.clone()]
                ]
            ),
            query.definition.sql,
            serde_json::to_string_pretty(&query.definition).unwrap_or_default()
        ),
    );
}

fn print_report_saved(title: &str, report: &StoredReport) {
    print_heading(
        title,
        &markdown_table(
            &["Slug", "Title", "Format", "Refreshed"],
            &[vec![
                report.definition.slug().into(),
                report.definition.title().into(),
                match &report.definition {
                    ReportDefinition::Scripted { .. } => "Script".into(),
                    ReportDefinition::Legacy { queries, .. } => {
                        format!("Legacy ({} queries)", queries.len())
                    }
                },
                report.refreshed_at.clone(),
            ]],
        ),
    );
}

fn render_schema(schema: &LogicalSchema) -> String {
    let summary = markdown_table(
        &["Property", "Value"],
        &[
            vec!["Format".into(), schema.format_version.to_string()],
            vec!["Registry".into(), schema.registry_version.to_string()],
            vec!["Revision".into(), schema.revision.to_string()],
            vec![
                "Templates".into(),
                schema
                    .template_imports
                    .as_ref()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| item.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default(),
            ],
        ],
    );
    let tables = if schema.tables.is_empty() {
        "_No tables._".into()
    } else {
        markdown_table(
            &["Table", "Comment", "Columns"],
            &schema
                .tables
                .iter()
                .map(|table| {
                    vec![
                        table.name.clone(),
                        table.comment.clone(),
                        table.columns.len().to_string(),
                    ]
                })
                .collect::<Vec<_>>(),
        )
    };
    let relations = schema
        .relations
        .as_ref()
        .filter(|items| !items.is_empty())
        .map(|items| {
            markdown_table(
                &["Source", "Target", "Inverse"],
                &items
                    .iter()
                    .map(|item| {
                        vec![
                            format!(
                                "{}.{}",
                                item.from.table,
                                item.from.name.as_deref().unwrap_or("")
                            ),
                            item.to.table.clone(),
                            item.inverse_name.clone().unwrap_or_default(),
                        ]
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or_else(|| "_No semantic relations._".into());
    let instructions = schema
        .agent_instructions
        .as_ref()
        .filter(|items| !items.is_empty())
        .map(|items| {
            items
                .iter()
                .map(|item| format!("### {}\n\n{}", item.source, item.content))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_else(|| "_No agent instructions._".into());
    format!(
        "{summary}\n\n## Agent instructions\n\n{instructions}\n\n## Tables\n\n{tables}\n\n## Semantic relations\n\n{relations}"
    )
}

fn render_saved_queries(queries: &[silo_db::SavedQuerySummary]) -> String {
    if queries.is_empty() {
        return "_No saved queries._".into();
    }
    markdown_table(
        &[
            "Name",
            "Description",
            "Parameter style",
            "Parameters",
            "Updated",
        ],
        &queries
            .iter()
            .map(|query| {
                vec![
                    query.name.clone(),
                    query.description.clone(),
                    query.parameter_style.clone(),
                    query.parameters.to_string(),
                    query.updated_at.clone(),
                ]
            })
            .collect::<Vec<_>>(),
    )
}

fn render_workspace_status(workspace: &Workspace, state: &str, revision: Option<u64>) -> String {
    markdown_table(
        &["Property", "Value"],
        &[
            vec!["Repository".into(), workspace.root.display().to_string()],
            vec!["Identity".into(), workspace.identity.clone()],
            vec!["Origin".into(), workspace.origin.clone()],
            vec![
                "Selection".into(),
                match &workspace.selection {
                    WorkspaceSelection::Auto => "auto".into(),
                    WorkspaceSelection::Detached => "detached".into(),
                    WorkspaceSelection::Remote { name } => format!("remote:{name}"),
                },
            ],
            vec![
                "Database".into(),
                workspace.database_path.display().to_string(),
            ],
            vec!["State".into(), state.into()],
            vec![
                "Schema revision".into(),
                revision.map_or(String::new(), |revision| revision.to_string()),
            ],
        ],
    )
}

fn markdown_table(headers: &[&str], rows: &[Vec<String>]) -> String {
    if headers.is_empty() {
        return String::new();
    }
    let mut output = format!(
        "| {} |\n| {} |",
        headers
            .iter()
            .map(|value| escape_cell(value))
            .collect::<Vec<_>>()
            .join(" | "),
        headers
            .iter()
            .map(|_| "---")
            .collect::<Vec<_>>()
            .join(" | ")
    );
    for row in rows {
        let cells = (0..headers.len())
            .map(|index| {
                row.get(index)
                    .map(|value| escape_cell(value))
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        output.push_str(&format!("\n| {} |", cells.join(" | ")));
    }
    output
}

fn escape_cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace('\r', "")
        .replace('\n', "<br>")
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn find_table<'a>(schema: &'a LogicalSchema, name: &str) -> Result<&'a TableDefinition, SiloError> {
    schema
        .tables
        .iter()
        .find(|table| table.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| {
            SiloError::new(
                exits::NOT_FOUND,
                "table_not_found",
                format!("{name} does not exist."),
            )
        })
}

fn open_database(writable: bool) -> Result<SiloDatabase, SiloError> {
    SiloDatabase::open(current_workspace()?, writable)
}

fn current_workspace() -> Result<Workspace, SiloError> {
    resolve_workspace(current_dir()?)
}

fn current_dir() -> Result<PathBuf, SiloError> {
    std::env::current_dir().map_err(io_error)
}

fn read_input(file: Option<&Path>) -> Result<Value, SiloError> {
    let mut source = String::new();
    match file {
        Some(path) => fs::File::open(path)
            .and_then(|mut file| file.read_to_string(&mut source))
            .map_err(io_error)?,
        None => io::stdin().read_to_string(&mut source).map_err(io_error)?,
    };
    if source.trim().is_empty() {
        return Err(input_error(
            "empty_input",
            "Expected a JSON request on stdin or through --file.",
        ));
    }
    serde_json::from_str(&source)
        .map_err(|error| SiloError::new(exits::INPUT, "invalid_json", error.to_string()))
}

fn print_heading(title: &str, body: &str) {
    println!("# {title}\n\n{body}");
}

fn render_error(error: &SiloError) -> String {
    let path = if error.path.is_empty() {
        String::new()
    } else {
        format!("\n\nPath: `{}`", error.path)
    };
    format!("# Error\n\n{} (`{}`){}", error.message, error.code, path)
}

fn input_error(code: &str, message: impl Into<String>) -> SiloError {
    SiloError::new(exits::INPUT, code, message)
}

fn io_error(error: io::Error) -> SiloError {
    SiloError::new(exits::IO, "io_error", error.to_string())
}

fn json_error(error: serde_json::Error) -> SiloError {
    SiloError::new(exits::INPUT, "invalid_json", error.to_string())
}
