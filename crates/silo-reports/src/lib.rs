use std::{
    collections::BTreeMap,
    ffi::c_void,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, html};
use quickjs_rusty::Context;
use serde_json::{Map, Value, json};
use silo_core::{ColumnDefinition, SiloError, exits};
use silo_db::{
    QueryResult, ReportDefinition, ReportQueryDefinition, SavedQueryDefinition,
    SavedQueryParameter, SiloDatabase, StoredSavedQuery,
};
use url::Url;

const REPORT_RESULT_LIMIT: usize = 500;
const SCRIPT_MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const SCRIPT_TIME_LIMIT: Duration = Duration::from_secs(5);
const REPORT_SLUG: &str = "abcdefghijklmnopqrstuvwxyz0123456789-";

pub fn parse_saved_query_definition(value: Value) -> Result<SavedQueryDefinition, SiloError> {
    let fields = object(&value, "$", "invalid_shape")?;
    known_fields(
        fields,
        &[
            "name",
            "description",
            "sql",
            "parameter_style",
            "parameters",
        ],
        "$ ",
    )?;
    let name = string_field(fields, "name", "$.name")?;
    if !valid_query_name(name) || ["put", "list", "show", "delete"].contains(&name) {
        return Err(input_error(
            "invalid_query_name",
            "Query names must be lowercase hyphenated names beginning with a letter and cannot use management command names.",
            "$.name",
        ));
    }
    let description = nonempty_string(fields, "description", "$.description")?;
    let sql = nonempty_string(fields, "sql", "$.sql")?;
    let parameter_style = fields
        .get("parameter_style")
        .and_then(Value::as_str)
        .unwrap_or("named");
    if !matches!(parameter_style, "named" | "positional") {
        return Err(input_error(
            "invalid_parameter_style",
            "parameter_style must be named or positional.",
            "$.parameter_style",
        ));
    }
    let raw_parameters = match fields.get("parameters") {
        None => &[][..],
        Some(Value::Array(parameters)) => parameters.as_slice(),
        Some(_) => {
            return Err(input_error(
                "invalid_query_parameters",
                "parameters must be an array.",
                "$.parameters",
            ));
        }
    };
    let mut names = std::collections::BTreeSet::new();
    let mut parameters = Vec::with_capacity(raw_parameters.len());
    for (index, value) in raw_parameters.iter().enumerate() {
        let path = format!("$.parameters[{index}]");
        let item = object(value, &path, "invalid_shape")?;
        known_fields(
            item,
            &["name", "type", "type_options", "description", "default"],
            &path,
        )?;
        let name = string_field(item, "name", &format!("{path}.name"))?;
        if !valid_parameter_name(name) || name == "help" {
            return Err(input_error(
                "invalid_query_parameter_name",
                "Parameter names must begin with a lowercase letter and contain lowercase letters, digits, or underscores.",
                format!("{path}.name"),
            ));
        }
        if !names.insert(name.to_owned()) {
            return Err(input_error(
                "duplicate_query_parameter",
                format!("Duplicate parameter {name}."),
                format!("{path}.name"),
            ));
        }
        let semantic_type = string_field(item, "type", &format!("{path}.type"))?;
        let type_options = match item.get("type_options") {
            None => None,
            Some(Value::Object(options)) => Some(
                options
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
            Some(_) => {
                return Err(input_error(
                    "invalid_query_parameter_options",
                    "type_options must be an object.",
                    format!("{path}.type_options"),
                ));
            }
        };
        let description = nonempty_string(item, "description", &format!("{path}.description"))?;
        let default = item.get("default").cloned();
        let parameter = SavedQueryParameter {
            name: name.to_owned(),
            semantic_type: semantic_type.to_owned(),
            type_options,
            description,
            default,
        };
        let column = parameter_column(&parameter);
        if silo_schema::semantic_storage(&parameter.semantic_type).is_none() {
            return Err(input_error(
                "unknown_semantic_type",
                format!("Unknown semantic type {}.", parameter.semantic_type),
                format!("{path}.type"),
            ));
        }
        if let Some(default) = &parameter.default {
            silo_schema::canonicalize(&column, default)
                .map_err(|error| error.at(format!("{path}.default")))?;
        }
        parameters.push(parameter);
    }
    if parameter_style == "positional" {
        let mut optional_seen = false;
        for (index, parameter) in parameters.iter().enumerate() {
            if parameter.default.is_some() {
                optional_seen = true;
            } else if optional_seen {
                return Err(input_error(
                    "required_parameter_after_default",
                    "Required positional parameters cannot follow parameters with defaults.",
                    format!("$.parameters[{index}]"),
                ));
            }
        }
    }
    Ok(SavedQueryDefinition {
        name: name.to_owned(),
        description,
        sql: sql.to_owned(),
        parameter_style: parameter_style.to_owned(),
        parameters,
    })
}

pub fn parse_report_definition(value: Value) -> Result<ReportDefinition, SiloError> {
    let fields = object(&value, "$", "invalid_shape")?;
    let slug = string_field(fields, "slug", "$.slug")?;
    if slug.is_empty()
        || !slug
            .chars()
            .all(|character| REPORT_SLUG.contains(character))
        || slug.starts_with('-')
        || slug.ends_with('-')
        || slug.contains("--")
        || !slug.as_bytes()[0].is_ascii_lowercase() && !slug.as_bytes()[0].is_ascii_digit()
    {
        return Err(input_error(
            "invalid_report_slug",
            "Expected a lowercase slug containing letters, digits, and single hyphens.",
            "$.slug",
        ));
    }
    let title = nonempty_string(fields, "title", "$.title")?;
    let has_script = fields.contains_key("script");
    let has_legacy = fields.contains_key("markdown") || fields.contains_key("queries");
    if has_script == has_legacy {
        return Err(input_error(
            "invalid_report_source",
            "A report requires either script or the deprecated markdown and queries fields.",
            "$",
        ));
    }
    if has_script {
        known_fields(fields, &["slug", "title", "script"], "$ ")?;
        let script = nonempty_string(fields, "script", "$.script")?;
        return Ok(ReportDefinition::Scripted {
            slug: slug.to_owned(),
            title,
            script: script.to_owned(),
        });
    }
    known_fields(fields, &["slug", "title", "markdown", "queries"], "$ ")?;
    let markdown = nonempty_string(fields, "markdown", "$.markdown")?;
    let raw_queries = fields
        .get("queries")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            input_error(
                "invalid_report_queries",
                "queries must be a non-empty array.",
                "$.queries",
            )
        })?;
    if raw_queries.is_empty() {
        return Err(input_error(
            "invalid_report_queries",
            "queries must contain at least one report query.",
            "$.queries",
        ));
    }
    let mut names = std::collections::BTreeSet::new();
    let mut queries = Vec::new();
    let mut referenced = std::collections::BTreeSet::new();
    for (index, value) in raw_queries.iter().enumerate() {
        let path = format!("$.queries[{index}]");
        let query = object(value, &path, "invalid_shape")?;
        known_fields(
            query,
            &["name", "sql", "saved_query", "parameters", "empty_markdown"],
            &path,
        )?;
        let name = string_field(query, "name", &format!("{path}.name"))?;
        if !valid_report_query_name(name) {
            return Err(input_error(
                "invalid_report_query_name",
                "Query names must start with a lowercase letter and contain lowercase letters, digits, underscores, or hyphens.",
                format!("{path}.name"),
            ));
        }
        if !names.insert(name.to_owned()) {
            return Err(input_error(
                "duplicate_report_query",
                format!("Duplicate query name {name}."),
                format!("{path}.name"),
            ));
        }
        let inline = query.contains_key("sql");
        let saved = query.contains_key("saved_query");
        if inline == saved {
            return Err(input_error(
                "invalid_report_query_source",
                "A report query requires exactly one of sql or saved_query.",
                &path,
            ));
        }
        let empty_markdown = match query.get("empty_markdown") {
            None => None,
            Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
            _ => {
                return Err(input_error(
                    "invalid_empty_markdown",
                    "empty_markdown must be a non-empty Markdown string when supplied.",
                    format!("{path}.empty_markdown"),
                ));
            }
        };
        if inline {
            if query.contains_key("parameters") {
                return Err(input_error(
                    "inline_report_query_parameters",
                    "parameters can only bind a saved_query reference.",
                    format!("{path}.parameters"),
                ));
            }
            let sql = nonempty_string(query, "sql", &format!("{path}.sql"))?;
            queries.push(ReportQueryDefinition::Inline {
                name: name.to_owned(),
                sql: sql.to_owned(),
                empty_markdown,
            });
        } else {
            let saved_query = string_field(query, "saved_query", &format!("{path}.saved_query"))?;
            if !valid_query_name(saved_query)
                || ["put", "list", "show", "delete"].contains(&saved_query)
            {
                return Err(input_error(
                    "invalid_query_name",
                    "Saved query references must use a valid query name.",
                    format!("{path}.saved_query"),
                ));
            }
            let parameters = query.get("parameters").cloned();
            if parameters
                .as_ref()
                .is_some_and(|value| !value.is_array() && !value.is_object())
            {
                return Err(input_error(
                    "invalid_report_query_parameters",
                    "parameters must be an object for named queries or an array for positional queries.",
                    format!("{path}.parameters"),
                ));
            }
            queries.push(ReportQueryDefinition::Saved {
                name: name.to_owned(),
                saved_query: saved_query.to_owned(),
                parameters,
                empty_markdown,
            });
        }
    }
    for (name, _, _, _) in report_slots(&markdown)? {
        if !names.contains(name) {
            return Err(input_error(
                "unknown_report_query",
                format!("The template references unknown query {name}."),
                "$.markdown",
            ));
        }
        referenced.insert(name.to_owned());
    }
    for name in &names {
        if !referenced.contains(name) {
            return Err(input_error(
                "unused_report_query",
                format!("Report query {name} has no template slot."),
                "$.queries",
            ));
        }
    }
    Ok(ReportDefinition::Legacy {
        slug: slug.to_owned(),
        title,
        markdown: markdown.to_owned(),
        queries,
    })
}

pub fn render_report(
    database: SiloDatabase,
    definition: &ReportDefinition,
) -> (SiloDatabase, Result<String, SiloError>) {
    let deadline = Instant::now() + SCRIPT_TIME_LIMIT;
    if let Err(error) = database.begin_read_snapshot_until(deadline) {
        return (database, Err(error));
    }
    let (database, rendered) = match definition {
        ReportDefinition::Scripted { slug, script, .. } => {
            render_script(database, slug, script, deadline)
        }
        ReportDefinition::Legacy {
            markdown, queries, ..
        } => {
            let rendered = render_legacy(&database, markdown, queries);
            (database, rendered)
        }
    };
    let finish = database.finish_read_snapshot(rendered.is_ok());
    let rendered = match (rendered, finish) {
        (Ok(rendered), Ok(())) => Ok(rendered),
        (Err(error), Ok(())) | (_, Err(error)) => Err(error),
    };
    (database, rendered)
}

pub fn render_stored_report(
    database: SiloDatabase,
    slug: &str,
) -> (SiloDatabase, Result<String, SiloError>) {
    match database.get_report(slug) {
        Ok(report) => {
            let definition = report.definition;
            render_report(database, &definition)
        }
        Err(error) => (database, Err(error)),
    }
}

pub fn render_markdown_html(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM;
    let base = Url::parse("http://127.0.0.1/").expect("the report viewer base URL is valid");
    let mut blocked_link_depth = 0;
    let events = Parser::new_ext(markdown, options).map(|event| match event {
        Event::Html(html) | Event::InlineHtml(html) => Event::Text(html),
        Event::Start(Tag::Image { .. }) => Event::Start(Tag::Emphasis),
        Event::End(TagEnd::Image) => Event::End(TagEnd::Emphasis),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            if safe_markdown_link(&base, &dest_url) {
                Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                })
            } else {
                blocked_link_depth += 1;
                Event::Start(Tag::Emphasis)
            }
        }
        Event::End(TagEnd::Link) if blocked_link_depth > 0 => {
            blocked_link_depth -= 1;
            Event::End(TagEnd::Emphasis)
        }
        event => event,
    });
    let mut rendered = String::new();
    html::push_html(&mut rendered, events);
    rendered
}

fn safe_markdown_link(base: &Url, destination: &str) -> bool {
    base.join(destination)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto"))
}

fn render_legacy(
    database: &SiloDatabase,
    markdown: &str,
    queries: &[ReportQueryDefinition],
) -> Result<String, SiloError> {
    let mut rendered = BTreeMap::new();
    for query in queries {
        let (name, result, empty_markdown) = match query {
            ReportQueryDefinition::Inline {
                name,
                sql,
                empty_markdown,
            } => (
                name.as_str(),
                database.query(sql, &[])?,
                empty_markdown.as_deref(),
            ),
            ReportQueryDefinition::Saved {
                name,
                saved_query,
                parameters,
                empty_markdown,
            } => {
                let stored = database.get_saved_query(saved_query)?;
                let result = execute_saved_query(database, &stored, parameters.as_ref())?;
                (name.as_str(), result, empty_markdown.as_deref())
            }
        };
        let output = if result.rows.is_empty() {
            empty_markdown.unwrap_or("_No rows._").to_owned()
        } else {
            markdown_table(&result.columns, &result.rows)
        };
        let output = if result.truncated {
            format!("{output}\n\n> Results truncated to {REPORT_RESULT_LIMIT} rows.")
        } else {
            output
        };
        rendered.insert(name.to_owned(), output);
    }
    let slots = report_slots(markdown)?;
    let mut output = String::new();
    let mut previous = 0;
    for (name, start, end, _) in slots {
        output.push_str(&markdown[previous..start]);
        output.push_str(rendered.get(name).ok_or_else(|| {
            input_error(
                "unknown_report_query",
                format!("The template references unknown query {name}."),
                "$.markdown",
            )
        })?);
        previous = end;
    }
    output.push_str(&markdown[previous..]);
    Ok(output)
}

fn render_script(
    database: SiloDatabase,
    slug: &str,
    script: &str,
    deadline: Instant,
) -> (SiloDatabase, Result<String, SiloError>) {
    let shared = Arc::new(Mutex::new(Some(database)));
    // Declare the deadline before the context so the context drops first on unwind.
    let deadline = ScriptDeadline::new(deadline);
    let context = match Context::builder().memory_limit(SCRIPT_MEMORY_LIMIT).build() {
        Ok(context) => context,
        Err(error) => {
            return recover_database(
                shared,
                Err(input_error(
                    "quickjs_context_failed",
                    error.to_string(),
                    "$.script",
                )),
            );
        }
    };
    context.set_interrupt_handler(Some(interrupt_report_script), deadline.pointer());
    let callback_database = Arc::clone(&shared);
    if let Err(error) = context.add_callback(
        "__silo_call",
        move |payload: String| -> Result<String, String> {
            let request: Value =
                serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            let guard = callback_database
                .lock()
                .map_err(|_| "Report database lock was poisoned.".to_owned())?;
            let database = guard
                .as_ref()
                .ok_or_else(|| "Report database is unavailable.".to_owned())?;
            let result =
                dispatch_report_call(database, request).map_err(|error| error.to_string())?;
            serde_json::to_string(&result).map_err(|error| error.to_string())
        },
    ) {
        drop(context);
        drop(deadline);
        return recover_database(
            shared,
            Err(input_error(
                "quickjs_callback_failed",
                error.to_string(),
                "$.script",
            )),
        );
    }
    let workspace = {
        let guard = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let workspace = &guard.as_ref().expect("database retained").workspace;
        json!({"root": workspace.root, "identity": workspace.identity, "origin": workspace.origin})
    };
    let workspace_json = match serde_json::to_string(&workspace) {
        Ok(value) => value,
        Err(error) => {
            drop(context);
            drop(deadline);
            return recover_database(
                shared,
                Err(input_error(
                    "report_workspace_invalid",
                    error.to_string(),
                    "$.script",
                )),
            );
        }
    };
    let escaped_workspace =
        serde_json::to_string(&workspace_json).unwrap_or_else(|_| "{}".to_owned());
    let source = format!(
        "globalThis.silo = {{ workspace: JSON.parse({escaped_workspace}), sql(sql, parameters) {{ return JSON.parse(__silo_call(JSON.stringify({{method:'sql', sql, parameters}}))); }}, query(name, parameters) {{ return JSON.parse(__silo_call(JSON.stringify({{method:'query', name, parameters}}))); }} }};\n\
         globalThis.markdown = {{ table(result) {{ return __silo_call(JSON.stringify({{method:'markdown.table', result}})); }} }};\n\
         const __render = (function(silo, markdown) {{ 'use strict';\n{script}\n}})(silo, markdown);\n\
         if (__render && typeof __render.then === 'function') throw new Error('Report scripts must return Markdown synchronously.');\n\
         if (typeof __render !== 'string') throw new Error('A report script must return a Markdown string.');\n\
         __render"
    );
    let execution = context.eval_as::<String>(&source).map_err(|error| {
        input_error(
            "report_script_failed",
            error.to_string(),
            format!("$.script ({slug})"),
        )
    });
    drop(context);
    drop(deadline);
    recover_database(shared, execution)
}

struct ScriptDeadline(*mut c_void);

impl ScriptDeadline {
    fn new(deadline: Instant) -> Self {
        Self(Box::into_raw(Box::new(deadline)).cast())
    }

    fn pointer(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for ScriptDeadline {
    fn drop(&mut self) {
        // The QuickJS context is dropped before this allocation so its native callback
        // cannot outlive the deadline it reads.
        unsafe { drop(Box::from_raw(self.0.cast::<Instant>())) };
    }
}

extern "C" fn interrupt_report_script(
    _runtime: *mut quickjs_rusty::q::JSRuntime,
    opaque: *mut c_void,
) -> std::ffi::c_int {
    let deadline = unsafe { &*opaque.cast::<Instant>() };
    i32::from(Instant::now() >= *deadline)
}

fn recover_database(
    shared: Arc<Mutex<Option<SiloDatabase>>>,
    result: Result<String, SiloError>,
) -> (SiloDatabase, Result<String, SiloError>) {
    match Arc::try_unwrap(shared) {
        Ok(mutex) => match mutex.into_inner() {
            Ok(Some(database)) => (database, result),
            _ => unreachable!("report database is retained until the QuickJS context is dropped"),
        },
        Err(_) => unreachable!("report callbacks are dropped with the QuickJS context"),
    }
}

fn dispatch_report_call(database: &SiloDatabase, request: Value) -> Result<Value, SiloError> {
    let object = request.as_object().ok_or_else(|| {
        input_error(
            "invalid_report_call",
            "Silo report calls require an object.",
            "$.script",
        )
    })?;
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            input_error(
                "invalid_report_call",
                "Silo report call method is missing.",
                "$.script",
            )
        })?;
    match method {
        "sql" => {
            let sql = object.get("sql").and_then(Value::as_str).ok_or_else(|| {
                input_error(
                    "invalid_report_sql",
                    "silo.sql requires a SQL string.",
                    "$.script",
                )
            })?;
            let (named, positional) = raw_parameters(object.get("parameters"))?;
            serde_json::to_value(database.query_with_named(sql, &named, &positional)?)
                .map_err(json_error)
        }
        "query" => {
            let name = object.get("name").and_then(Value::as_str).ok_or_else(|| {
                input_error(
                    "invalid_report_query",
                    "silo.query requires a saved query name.",
                    "$.script",
                )
            })?;
            let query = database.get_saved_query(name)?;
            serde_json::to_value(execute_saved_query(
                database,
                &query,
                object.get("parameters"),
            )?)
            .map_err(json_error)
        }
        "markdown.table" => {
            let result: QueryResult =
                serde_json::from_value(object.get("result").cloned().ok_or_else(|| {
                    input_error(
                        "invalid_report_table",
                        "markdown.table requires a query result.",
                        "$.script",
                    )
                })?)
                .map_err(|error| {
                    input_error("invalid_report_table", error.to_string(), "$.script")
                })?;
            Ok(Value::String(markdown_table(&result.columns, &result.rows)))
        }
        _ => Err(input_error(
            "invalid_report_call",
            format!("Unknown Silo report method {method}."),
            "$.script",
        )),
    }
}

fn execute_saved_query(
    database: &SiloDatabase,
    query: &StoredSavedQuery,
    input: Option<&Value>,
) -> Result<QueryResult, SiloError> {
    let definition = &query.definition;
    let mut named = BTreeMap::new();
    let mut positional = Vec::new();
    if definition.parameter_style == "named" {
        let supplied = match input {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(values)) => values.clone(),
            Some(_) => {
                return Err(input_error(
                    "invalid_query_parameters",
                    "Named query parameters must be an object.",
                    "$.parameters",
                ));
            }
        };
        for parameter in &definition.parameters {
            let value = supplied
                .get(&parameter.name)
                .or(parameter.default.as_ref())
                .ok_or_else(|| {
                    input_error(
                        "missing_query_parameter",
                        format!("Missing query parameter {}.", parameter.name),
                        format!("$.parameters.{}", parameter.name),
                    )
                })?;
            named.insert(parameter.name.clone(), bind_semantic(parameter, value)?);
        }
        if let Some(extra) = supplied.keys().find(|key| {
            !definition
                .parameters
                .iter()
                .any(|parameter| parameter.name == **key)
        }) {
            return Err(input_error(
                "unknown_query_parameter",
                format!("Unknown query parameter {extra}."),
                format!("$.parameters.{extra}"),
            ));
        }
    } else {
        let supplied = match input {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(values)) => values.clone(),
            Some(_) => {
                return Err(input_error(
                    "invalid_query_parameters",
                    "Positional query parameters must be an array.",
                    "$.parameters",
                ));
            }
        };
        if supplied.len() > definition.parameters.len() {
            return Err(input_error(
                "query_parameter_count",
                "Too many positional query parameters.",
                "$.parameters",
            ));
        }
        for (index, parameter) in definition.parameters.iter().enumerate() {
            let value = supplied
                .get(index)
                .or(parameter.default.as_ref())
                .ok_or_else(|| {
                    input_error(
                        "missing_query_parameter",
                        format!("Missing query parameter {}.", parameter.name),
                        format!("$.parameters[{index}]"),
                    )
                })?;
            positional.push(bind_semantic(parameter, value)?);
        }
    }
    database.query_with_named(&definition.sql, &named, &positional)
}

pub fn run_saved_query(
    database: &SiloDatabase,
    name: &str,
    input: &Value,
) -> Result<QueryResult, SiloError> {
    let query = database.get_saved_query(name)?;
    execute_saved_query(database, &query, Some(input))
}

pub fn decode_query_argument(
    parameter: &SavedQueryParameter,
    input: &str,
) -> Result<Value, SiloError> {
    let storage = silo_schema::semantic_storage(&parameter.semantic_type).ok_or_else(|| {
        input_error(
            "unknown_semantic_type",
            format!("Unknown semantic type {}.", parameter.semantic_type),
            format!("$.parameters.{}", parameter.name),
        )
    })?;
    let decoded = if parameter.semantic_type == "text/json" {
        serde_json::from_str(input).map_err(|error| {
            input_error(
                "invalid_query_argument",
                error.to_string(),
                format!("$.parameters.{}", parameter.name),
            )
        })?
    } else if parameter.semantic_type == "integer/boolean" && matches!(input, "true" | "false") {
        Value::Bool(input == "true")
    } else if matches!(storage, "INTEGER" | "REAL") {
        serde_json::from_str(input).unwrap_or(Value::String(input.to_owned()))
    } else if storage == "ANY" {
        serde_json::from_str(input).unwrap_or(Value::String(input.to_owned()))
    } else {
        Value::String(input.to_owned())
    };
    bind_semantic(parameter, &decoded)
}

fn bind_semantic(parameter: &SavedQueryParameter, value: &Value) -> Result<Value, SiloError> {
    silo_schema::canonicalize(&parameter_column(parameter), value)
}

fn parameter_column(parameter: &SavedQueryParameter) -> ColumnDefinition {
    ColumnDefinition {
        name: parameter.name.clone(),
        semantic_type: parameter.semantic_type.clone(),
        type_options: parameter.type_options.clone(),
        nullable: Some(false),
        default: None,
        comment: parameter.description.clone(),
        collate: None,
        generated: None,
    }
}

fn raw_parameters(
    value: Option<&Value>,
) -> Result<(BTreeMap<String, Value>, Vec<Value>), SiloError> {
    match value {
        None | Some(Value::Null) => Ok((BTreeMap::new(), Vec::new())),
        Some(Value::Array(values)) => Ok((BTreeMap::new(), values.clone())),
        Some(Value::Object(values)) => Ok((
            values
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
            Vec::new(),
        )),
        Some(_) => Err(input_error(
            "invalid_query_parameters",
            "Query parameters must be an object or array.",
            "$.parameters",
        )),
    }
}

fn markdown_table(columns: &[String], rows: &[Vec<Value>]) -> String {
    if columns.is_empty() {
        return "_Query returned no result columns._".to_owned();
    }
    let header = format!(
        "| {} |",
        columns
            .iter()
            .map(|value| escape_cell(value))
            .collect::<Vec<_>>()
            .join(" | ")
    );
    let rule = format!(
        "| {} |",
        columns
            .iter()
            .map(|_| "---")
            .collect::<Vec<_>>()
            .join(" | ")
    );
    let mut output = format!("{header}\n{rule}");
    for row in rows {
        let mut cells = row.iter().map(display_value).collect::<Vec<_>>();
        cells.resize(columns.len(), String::new());
        cells.truncate(columns.len());
        output.push_str(&format!(
            "\n| {} |",
            cells
                .iter()
                .map(|value| escape_cell(value))
                .collect::<Vec<_>>()
                .join(" | ")
        ));
    }
    output
}

fn display_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn escape_cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace('\r', "")
        .replace('\n', "<br>")
}

fn report_slots(markdown: &str) -> Result<Vec<(&str, usize, usize, usize)>, SiloError> {
    let mut slots = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = markdown[cursor..].find("{{silo-query:") {
        let start = cursor + relative;
        let name_start = start + "{{silo-query:".len();
        let close = markdown[name_start..]
            .find("}}")
            .map(|value| name_start + value);
        let Some(end_name) = close else {
            return Err(input_error(
                "invalid_report_slot",
                "Query slots must use {{silo-query:name}} with a valid query name.",
                "$.markdown",
            ));
        };
        let name = &markdown[name_start..end_name];
        if !valid_report_query_name(name) {
            return Err(input_error(
                "invalid_report_slot",
                "Query slots must use {{silo-query:name}} with a valid query name.",
                "$.markdown",
            ));
        }
        let end = end_name + 2;
        slots.push((name, start, end, 0));
        cursor = end;
    }
    Ok(slots)
}

fn object<'a>(
    value: &'a Value,
    path: &str,
    code: &str,
) -> Result<&'a Map<String, Value>, SiloError> {
    value
        .as_object()
        .ok_or_else(|| input_error(code, "Expected a JSON object.", path))
}

fn known_fields(value: &Map<String, Value>, allowed: &[&str], path: &str) -> Result<(), SiloError> {
    if let Some(key) = value.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(input_error(
            "unknown_field",
            format!("Unknown field {key}."),
            format!("{}.{}", path.trim_end(), key),
        ));
    }
    Ok(())
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<&'a str, SiloError> {
    object
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| input_error("invalid_field", format!("{name} must be a string."), path))
}

fn nonempty_string(
    object: &Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<String, SiloError> {
    let value = string_field(object, name, path)?;
    if value.trim().is_empty() {
        return Err(input_error(
            "empty_field",
            format!("{name} must be non-empty."),
            path,
        ));
    }
    Ok(value.trim().to_owned())
}

fn valid_query_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        && !value.ends_with('-')
        && !value.contains("--")
}

fn valid_parameter_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn valid_report_query_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
        })
}

fn input_error(code: &str, message: impl Into<String>, path: impl Into<String>) -> SiloError {
    SiloError::new(exits::INPUT, code, message).at(path)
}

fn json_error(error: serde_json::Error) -> SiloError {
    SiloError::new(exits::INTEGRITY, "stored_json_invalid", error.to_string())
}
