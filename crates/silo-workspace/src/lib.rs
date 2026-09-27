use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use silo_core::{SiloError, exits};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceSelection {
    Auto,
    Detached,
    Remote { name: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LocalState {
    version: u32,
    detached_id: String,
    selection: WorkspaceSelection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMigrationSource {
    pub identity: String,
    pub origin: String,
    pub database_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Workspace {
    pub root: PathBuf,
    pub identity: String,
    pub origin: String,
    pub database_path: PathBuf,
    pub selection: WorkspaceSelection,
    pub migration_source: Option<WorkspaceMigrationSource>,
}

pub fn data_root() -> PathBuf {
    if let Some(path) = env::var_os("SILO_DATA_HOME") {
        return PathBuf::from(path).join("silo");
    }
    if cfg!(target_os = "macos") {
        return home_dir().join("Library/Application Support/silo");
    }
    if cfg!(target_os = "windows") {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData/Local"))
            .join("silo");
    }
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/share"))
        .join("silo")
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn workspace_error(code: &str, message: impl Into<String>) -> SiloError {
    SiloError::new(exits::WORKSPACE, code, message)
}

fn git(root: &Path, args: &[&str], optional: bool) -> Result<Option<String>, SiloError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| workspace_error("workspace_unresolved", "Git could not be started."))?;
    if !output.status.success() {
        if optional && output.status.code() == Some(1) {
            return Ok(None);
        }
        return Err(workspace_error(
            "workspace_unresolved",
            "The current directory is not a usable Git worktree.",
        ));
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    ))
}

fn local_state_path(root: &Path) -> Result<PathBuf, SiloError> {
    let common = git(root, &["rev-parse", "--git-common-dir"], false)?
        .expect("successful git command has output");
    let path = PathBuf::from(common);
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
    .join("silo.json"))
}

fn parse_state(path: &Path, bytes: &[u8]) -> Result<LocalState, SiloError> {
    let state: LocalState = serde_json::from_slice(bytes).map_err(|error| {
        workspace_error(
            "invalid_local_state",
            format!("The local {} state is invalid: {error}", path.display()),
        )
    })?;
    if state.version != 1 || Uuid::parse_str(&state.detached_id).is_err() {
        return Err(workspace_error(
            "invalid_local_state",
            "The local .git/silo.json state requires version 1 and a detached UUID.",
        ));
    }
    if let WorkspaceSelection::Remote { name } = &state.selection
        && name.is_empty()
    {
        return Err(workspace_error(
            "invalid_local_state",
            "A remote selection requires a non-empty name.",
        ));
    }
    Ok(state)
}

fn read_state(root: &Path) -> Result<LocalState, SiloError> {
    let path = local_state_path(root)?;
    match fs::File::open(&path) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(|_| {
                workspace_error(
                    "local_state_unavailable",
                    "Silo could not read local repository state from .git/silo.json.",
                )
            })?;
            parse_state(&path, &bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let state = LocalState {
                version: 1,
                detached_id: Uuid::new_v4().to_string(),
                selection: WorkspaceSelection::Auto,
            };
            install_initial_state(&path, &state)?;
            let bytes = fs::read(&path).map_err(|_| {
                workspace_error(
                    "local_state_unavailable",
                    "Silo could not persist local repository state in .git/silo.json.",
                )
            })?;
            parse_state(&path, &bytes)
        }
        Err(_) => Err(workspace_error(
            "local_state_unavailable",
            "Silo could not read local repository state from .git/silo.json.",
        )),
    }
}

fn write_state(root: &Path, state: &LocalState) -> Result<(), SiloError> {
    let path = local_state_path(root)?;
    let temporary = temporary_path(&path);
    let result = (|| {
        let mut file = private_file(&temporary)?;
        serde_json::to_writer_pretty(&mut file, state).map_err(io_state_error)?;
        file.write_all(b"\n").map_err(io_state_error)?;
        file.sync_all().map_err(io_state_error)?;
        fs::rename(&temporary, &path).map_err(io_state_error)?;
        set_private(&path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn install_initial_state(path: &Path, state: &LocalState) -> Result<(), SiloError> {
    let temporary = temporary_path(path);
    let result = (|| {
        let mut file = private_file(&temporary)?;
        serde_json::to_writer_pretty(&mut file, state).map_err(io_state_error)?;
        file.write_all(b"\n").map_err(io_state_error)?;
        file.sync_all().map_err(io_state_error)?;
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(io_state_error(error)),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let suffix = Uuid::new_v4();
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!("{file_name}.{}.tmp", suffix))
}

fn private_file(path: &Path) -> Result<fs::File, SiloError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_state_error)
}

fn set_private(path: &Path) -> Result<(), SiloError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).map_err(io_state_error)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions).map_err(io_state_error)?;
    }
    Ok(())
}

fn io_state_error(error: impl std::fmt::Display) -> SiloError {
    workspace_error("local_state_unavailable", error.to_string())
}

pub fn normalize_origin(origin: &str, field: &str) -> Result<String, SiloError> {
    let value = origin.trim();
    let before_query = value.split(['?', '#']).next().unwrap_or(value);
    for segment in before_query.split(['/', ':']) {
        let decoded = percent_decode(segment).map_err(|_| {
            workspace_error(
                "invalid_origin",
                "The Git remote contains an unsafe path segment.",
            )
            .at(field)
        })?;
        if decoded == "." || decoded == ".." {
            return Err(workspace_error(
                "invalid_origin",
                "The Git remote contains an unsafe path segment.",
            )
            .at(field));
        }
    }
    let (host, path) = if !value.contains("://") {
        if let Some((host, path)) = value.rsplit_once(':') {
            let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
            (host.to_owned(), path.to_owned())
        } else {
            return Err(
                workspace_error("invalid_origin", "The Git remote is not a usable URL.").at(field),
            );
        }
    } else {
        let url = url::Url::parse(value).map_err(|_| {
            workspace_error("invalid_origin", "The Git remote is not a usable URL.").at(field)
        })?;
        (
            url.host_str().unwrap_or_default().to_owned(),
            url.path().to_owned(),
        )
    };
    let host = host.to_lowercase();
    let path = path.trim_matches('/').trim_end_matches(".git");
    let segments: Vec<_> = path.split('/').collect();
    if host.is_empty()
        || path.is_empty()
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(workspace_error(
            "invalid_origin",
            "The Git remote has an unsafe or empty repository path.",
        )
        .at(field));
    }
    Ok(format!("{host}/{}", segments.join("/")))
}

fn percent_decode(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let pair = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            decoded.push(u8::from_str_radix(pair, 16).map_err(|_| ())?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn workspace_for_identity(
    root: &Path,
    identity: &str,
    origin: String,
    selection: WorkspaceSelection,
) -> Workspace {
    let mut parts = identity.split('/').collect::<Vec<_>>();
    let leaf = parts.pop().unwrap_or(identity);
    let database_path = parts
        .iter()
        .fold(data_root().join("databases"), |path, part| path.join(part))
        .join(format!("{leaf}.sqlite"));
    Workspace {
        root: root.to_path_buf(),
        identity: identity.to_owned(),
        origin,
        database_path,
        selection,
        migration_source: None,
    }
}

fn detached_workspace(root: &Path, state: &LocalState, selection: WorkspaceSelection) -> Workspace {
    workspace_for_identity(
        root,
        &format!("detached/{}", state.detached_id),
        format!("detached:{}", state.detached_id),
        selection,
    )
}

fn remote_names(root: &Path) -> Result<Vec<String>, SiloError> {
    Ok(git(root, &["remote"], false)?
        .unwrap_or_default()
        .lines()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect())
}

fn remote_workspace(
    root: &Path,
    state: &LocalState,
    name: &str,
    selection: WorkspaceSelection,
) -> Result<Workspace, SiloError> {
    if !remote_names(root)?.iter().any(|remote| remote == name) {
        return Err(workspace_error(
            "remote_not_found",
            format!("Git remote {name} does not exist in this repository."),
        ));
    }
    let origin = git(
        root,
        &["config", "--get", &format!("remote.{name}.url")],
        true,
    )?
    .filter(|url| !url.is_empty())
    .ok_or_else(|| {
        workspace_error(
            "invalid_origin",
            format!("Git remote {name} does not have a usable URL."),
        )
        .at(format!("remote.{name}.url"))
    })?;
    let identity = normalize_origin(&origin, &format!("remote.{name}.url"))?;
    let mut workspace = workspace_for_identity(root, &identity, origin, selection);
    if let WorkspaceSelection::Auto = state.selection {
        let detached = detached_workspace(root, state, WorkspaceSelection::Auto);
        let remote_exists = workspace.database_path.exists();
        let detached_exists = detached.database_path.exists();
        if remote_exists && detached_exists {
            return Err(workspace_error(
                "workspace_identity_conflict",
                "Both detached and origin databases exist. Use silo switch to select one explicitly.",
            ));
        }
        if !remote_exists && detached_exists {
            workspace.migration_source = Some(WorkspaceMigrationSource {
                identity: detached.identity,
                origin: detached.origin,
                database_path: detached.database_path,
            });
        }
    }
    Ok(workspace)
}

fn resolve_selection(
    root: &Path,
    state: &LocalState,
    selection: WorkspaceSelection,
) -> Result<Workspace, SiloError> {
    match selection.clone() {
        WorkspaceSelection::Detached => Ok(detached_workspace(root, state, selection)),
        WorkspaceSelection::Remote { name } => remote_workspace(root, state, &name, selection),
        WorkspaceSelection::Auto => {
            if !remote_names(root)?.iter().any(|remote| remote == "origin") {
                return Ok(detached_workspace(root, state, selection));
            }
            remote_workspace(root, state, "origin", selection)
        }
    }
}

pub fn resolve_workspace(cwd: impl AsRef<Path>) -> Result<Workspace, SiloError> {
    let cwd = cwd.as_ref();
    let root = git(cwd, &["rev-parse", "--show-toplevel"], false)?
        .expect("successful git command has output");
    let root = PathBuf::from(root);
    let state = read_state(&root)?;
    resolve_selection(&root, &state, state.selection.clone())
}

pub fn resolve_workspace_selection(
    cwd: impl AsRef<Path>,
    selection: WorkspaceSelection,
) -> Result<Workspace, SiloError> {
    let cwd = cwd.as_ref();
    let root = PathBuf::from(
        git(cwd, &["rev-parse", "--show-toplevel"], false)?
            .expect("successful git command has output"),
    );
    let state = read_state(&root)?;
    resolve_selection(&root, &state, selection)
}

pub fn set_workspace_selection(
    cwd: impl AsRef<Path>,
    selection: WorkspaceSelection,
) -> Result<(), SiloError> {
    let cwd = cwd.as_ref();
    let root = PathBuf::from(
        git(cwd, &["rev-parse", "--show-toplevel"], false)?
            .expect("successful git command has output"),
    );
    let mut state = read_state(&root)?;
    state.selection = selection;
    write_state(&root, &state)
}

pub fn workspace_data_key(identity: &str) -> String {
    hex::encode(Sha256::digest(identity.as_bytes()))
}
