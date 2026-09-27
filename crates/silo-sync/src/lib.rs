use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use aws_config::BehaviorVersion;
use aws_sdk_s3::{
    Client,
    primitives::ByteStream,
    types::{Delete, ObjectIdentifier},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use silo_core::{SiloError, exits};
use silo_db::SiloDatabase;
use silo_workspace::Workspace;
use tokio::{io::AsyncReadExt, process::Command as TokioCommand, time::timeout};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SyncManifest {
    pub format_version: u32,
    pub database_id: String,
    pub identity: String,
    pub generation: String,
    pub publication_id: String,
    pub parent_generation: Option<String>,
    pub schema_revision: u64,
    pub database_sha256: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct RemoteHead {
    pub manifest: SyncManifest,
    pub etag: String,
}

#[derive(Clone, Debug)]
pub struct SyncGeneration {
    pub generation: String,
    pub last_modified: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SyncStatus {
    pub state: String,
    pub remote_url: Option<String>,
    pub database_id: Option<String>,
    pub local_generation: Option<String>,
    pub remote_generation: Option<String>,
    pub pending_transactions: usize,
    pub conflict_transaction_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SyncPruneResult {
    pub remote_url: String,
    pub current_generation: String,
    pub cutoff: String,
    pub scanned_generations: usize,
    pub eligible_generations: Vec<String>,
    pub deleted_generations: Vec<String>,
    pub dry_run: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SyncRecoveryResult {
    pub status: SyncStatus,
    pub preserved: String,
}

pub fn parse_manifest(value: &str) -> Result<SyncManifest, SiloError> {
    let manifest: SyncManifest = serde_json::from_str(value).map_err(|error| {
        SiloError::new(
            exits::INTEGRITY,
            "sync_manifest_invalid",
            format!("Remote HEAD is invalid: {error}"),
        )
    })?;
    if manifest.format_version != 1
        || manifest.database_id.is_empty()
        || manifest.identity.is_empty()
        || manifest.generation.is_empty()
        || manifest.publication_id.is_empty()
        || manifest.database_sha256.len() != 64
        || !manifest
            .database_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
    {
        return Err(SiloError::new(
            exits::INTEGRITY,
            "sync_manifest_invalid",
            "Remote HEAD is invalid: required fields are missing or malformed.",
        ));
    }
    Ok(manifest)
}

#[derive(Clone, Debug)]
struct S3Location {
    bucket: String,
    prefix: String,
}

impl S3Location {
    fn parse(value: &str) -> Result<Self, SiloError> {
        let url = url::Url::parse(value).map_err(|_| invalid_remote())?;
        let prefix = url.path().trim_matches('/');
        if url.scheme() != "s3"
            || url.host_str().is_none_or(str::is_empty)
            || prefix.is_empty()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid_remote());
        }
        Ok(Self {
            bucket: url.host_str().unwrap_or_default().to_owned(),
            prefix: prefix.to_owned(),
        })
    }

    fn generation_url(&self, generation: &str) -> String {
        format!(
            "s3://{}/{}/generations/{generation}",
            self.bucket, self.prefix
        )
    }
}

fn invalid_remote() -> SiloError {
    SiloError::new(
        exits::INPUT,
        "invalid_sync_remote",
        "Expected an s3://bucket/prefix URL.",
    )
}

struct S3SyncRemote {
    location: S3Location,
    client: Client,
}

impl S3SyncRemote {
    async fn new(url: &str) -> Result<Self, SiloError> {
        let location = S3Location::parse(url)?;
        let shared = aws_config::load_defaults(BehaviorVersion::latest()).await;
        let endpoint = std::env::var("AWS_ENDPOINT_URL_S3").ok();
        let mut builder =
            aws_sdk_s3::config::Builder::from(&shared).force_path_style(endpoint.is_some());
        if let Some(endpoint) = endpoint {
            builder = builder.endpoint_url(endpoint);
        }
        Ok(Self {
            location,
            client: Client::from_conf(builder.build()),
        })
    }

    fn head_key(&self) -> String {
        format!("{}/HEAD", self.location.prefix)
    }

    async fn read_head(&self) -> Result<Option<RemoteHead>, SiloError> {
        match self
            .client
            .get_object()
            .bucket(&self.location.bucket)
            .key(self.head_key())
            .send()
            .await
        {
            Ok(response) => {
                let etag = response.e_tag().map(str::to_owned).ok_or_else(|| {
                    SiloError::new(
                        exits::INTEGRITY,
                        "sync_manifest_incomplete",
                        "Remote HEAD has no entity tag.",
                    )
                })?;
                let body =
                    response.body.collect().await.map_err(|error| {
                        sync_error("sync_remote_read_failed", error.to_string())
                    })?;
                let text = String::from_utf8(body.into_bytes().to_vec()).map_err(|error| {
                    SiloError::new(
                        exits::INTEGRITY,
                        "sync_manifest_invalid",
                        format!("Remote HEAD is not UTF-8: {error}"),
                    )
                })?;
                Ok(Some(RemoteHead {
                    manifest: parse_manifest(&text)?,
                    etag,
                }))
            }
            Err(error)
                if error.to_string().contains("NoSuchKey") || error.to_string().contains("404") =>
            {
                Ok(None)
            }
            Err(error) => Err(sync_error("sync_remote_read_failed", error.to_string())),
        }
    }

    async fn publish_head(
        &self,
        manifest: &SyncManifest,
        expected_etag: Option<&str>,
    ) -> Result<String, SiloError> {
        let body = format!("{}\n", serde_json::to_string(manifest).map_err(json_error)?);
        let mut request = self
            .client
            .put_object()
            .bucket(&self.location.bucket)
            .key(self.head_key())
            .content_type("application/json")
            .body(ByteStream::from(body.into_bytes()));
        request = if let Some(etag) = expected_etag {
            request.if_match(etag)
        } else {
            request.if_none_match("*")
        };
        let response = request.send().await.map_err(|error| {
            let text = error.to_string();
            if text.contains("PreconditionFailed")
                || text.contains("ConditionalRequestConflict")
                || text.contains("412")
                || text.contains("409")
            {
                SiloError::new(
                    exits::REVISION,
                    "sync_head_changed",
                    "Remote HEAD changed during publication; pull and retry.",
                )
            } else {
                sync_error("sync_remote_write_failed", text)
            }
        })?;
        response.e_tag().map(str::to_owned).ok_or_else(|| {
            SiloError::new(
                exits::IO,
                "sync_head_etag_missing",
                "Object storage did not return an entity tag for HEAD.",
            )
        })
    }

    async fn list_generations(&self) -> Result<Vec<SyncGeneration>, SiloError> {
        let prefix = format!("{}/generations/", self.location.prefix);
        let mut token = None;
        let mut generations = BTreeMap::<String, DateTime<Utc>>::new();
        loop {
            let response = self
                .client
                .list_objects_v2()
                .bucket(&self.location.bucket)
                .prefix(&prefix)
                .set_continuation_token(token)
                .send()
                .await
                .map_err(|error| sync_error("sync_generations_list_failed", error.to_string()))?;
            for object in response.contents() {
                let Some(key) = object.key() else { continue };
                let Some(generation) = key
                    .strip_prefix(&prefix)
                    .and_then(|key| key.split('/').next())
                else {
                    continue;
                };
                let Some(modified) = object.last_modified() else {
                    continue;
                };
                let Some(last_modified) =
                    DateTime::from_timestamp(modified.secs(), modified.subsec_nanos())
                else {
                    continue;
                };
                let entry = generations
                    .entry(generation.to_owned())
                    .or_insert(last_modified);
                if last_modified > *entry {
                    *entry = last_modified;
                }
            }
            token = response.next_continuation_token().map(str::to_owned);
            if token.is_none() {
                break;
            }
        }
        Ok(generations
            .into_iter()
            .map(|(generation, last_modified)| SyncGeneration {
                generation,
                last_modified,
            })
            .collect())
    }

    async fn delete_generation(&self, generation: &str) -> Result<usize, SiloError> {
        let prefix = format!("{}/generations/{generation}/", self.location.prefix);
        let mut token = None;
        let mut keys = Vec::new();
        loop {
            let response = self
                .client
                .list_objects_v2()
                .bucket(&self.location.bucket)
                .prefix(&prefix)
                .set_continuation_token(token)
                .send()
                .await
                .map_err(|error| sync_error("sync_generation_delete_failed", error.to_string()))?;
            keys.extend(
                response
                    .contents()
                    .iter()
                    .filter_map(|object| object.key().map(str::to_owned)),
            );
            token = response.next_continuation_token().map(str::to_owned);
            if token.is_none() {
                break;
            }
        }
        let count = keys.len();
        for chunk in keys.chunks(1000) {
            let objects = chunk
                .iter()
                .map(|key| {
                    ObjectIdentifier::builder()
                        .key(key)
                        .build()
                        .expect("object key is set")
                })
                .collect();
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .expect("delete objects are set");
            let response = self
                .client
                .delete_objects()
                .bucket(&self.location.bucket)
                .delete(delete)
                .send()
                .await
                .map_err(|error| sync_error("sync_generation_delete_failed", error.to_string()))?;
            if !response.errors().is_empty() {
                let details = response
                    .errors()
                    .iter()
                    .map(|item| {
                        format!(
                            "{}: {}",
                            item.key().unwrap_or("unknown key"),
                            item.message().unwrap_or("delete failed")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(sync_error("sync_generation_delete_failed", details));
            }
        }
        Ok(count)
    }
}

struct LitestreamCheckpoint {
    executable: PathBuf,
}

impl LitestreamCheckpoint {
    fn new() -> Self {
        Self {
            executable: std::env::var_os("LITESTREAM_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("litestream")),
        }
    }

    fn check(&self) -> Result<String, SiloError> {
        let output = Command::new(&self.executable)
            .arg("version")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| {
                SiloError::new(
                    exits::IO,
                    "litestream_unavailable",
                    "Litestream 0.5.12 or newer is required on PATH or through LITESTREAM_PATH.",
                )
            })?;
        let text = format!(
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let version = version_tuple(&text).ok_or_else(|| {
            SiloError::new(
                exits::IO,
                "litestream_incompatible",
                format!(
                    "Litestream 0.5.12 or newer is required; found {}.",
                    text.trim()
                ),
            )
        })?;
        if version < (0, 5, 12) {
            return Err(SiloError::new(
                exits::IO,
                "litestream_incompatible",
                format!(
                    "Litestream 0.5.12 or newer is required; found {}.",
                    text.trim()
                ),
            ));
        }
        Ok(format!("{}.{}.{}", version.0, version.1, version.2))
    }

    async fn publish(&self, database_path: &Path, replica_url: &str) -> Result<(), SiloError> {
        self.check()?;
        let mut child = TokioCommand::new(&self.executable)
            .arg("replicate")
            .arg(database_path)
            .arg(replica_url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| sync_error("litestream_publish_failed", error.to_string()))?;
        let stderr = child.stderr.take();
        let output = match timeout(Duration::from_millis(1500), child.wait()).await {
            Ok(status) => status
                .map_err(|error| sync_error("litestream_publish_failed", error.to_string()))?,
            Err(_) => {
                if let Some(pid) = child.id() {
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(pid as i32, libc::SIGINT);
                    }
                    #[cfg(windows)]
                    child.kill().await.map_err(|error| {
                        sync_error("litestream_publish_failed", error.to_string())
                    })?;
                }
                child
                    .wait()
                    .await
                    .map_err(|error| sync_error("litestream_publish_failed", error.to_string()))?
            }
        };
        let error_text = if let Some(mut stderr) = stderr {
            let mut buffer = Vec::new();
            let _ = stderr.read_to_end(&mut buffer).await;
            String::from_utf8_lossy(&buffer)
                .chars()
                .rev()
                .take(16_384)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        } else {
            String::new()
        };
        if output.success() {
            Ok(())
        } else {
            Err(sync_error(
                "litestream_publish_failed",
                if error_text.trim().is_empty() {
                    format!("Litestream exited with status {output}.")
                } else {
                    error_text.trim().to_owned()
                },
            ))
        }
    }

    async fn restore(&self, replica_url: &str, output_path: &Path) -> Result<(), SiloError> {
        self.check()?;
        remove_database(output_path);
        let output = TokioCommand::new(&self.executable)
            .args(["restore", "-json", "-o"])
            .arg(output_path)
            .arg(replica_url)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| sync_error("litestream_restore_failed", error.to_string()))?;
        if !output.status.success() {
            return Err(sync_error(
                "litestream_restore_failed",
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        Ok(())
    }
}

fn version_tuple(text: &str) -> Option<(u64, u64, u64)> {
    let marker = text.find(|character: char| character.is_ascii_digit())?;
    let version = text[marker..]
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .next()?;
    let mut parts = version.split('.').map(str::parse::<u64>);
    Some((
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    ))
}

pub struct SiloSync {
    workspace: Workspace,
    checkpoint: LitestreamCheckpoint,
}

impl SiloSync {
    pub fn new(workspace: Workspace) -> Self {
        Self {
            workspace,
            checkpoint: LitestreamCheckpoint::new(),
        }
    }

    pub async fn initialize(&self, remote_url: &str) -> Result<SyncStatus, SiloError> {
        let _lock = SiloDatabase::acquire_sync_lock(&self.workspace)?;
        self.checkpoint.check()?;
        let remote = S3SyncRemote::new(remote_url).await?;
        let head = remote.read_head().await?;
        if let Some(head) = &head {
            validate_head(&self.workspace, head, None)?;
        }
        if !self.workspace.database_path.exists() {
            let Some(head) = head else {
                return Err(SiloError::new(
                    exits::ABSENT,
                    "sync_database_absent",
                    "Neither a local database nor a remote HEAD exists.",
                ));
            };
            let restored = temporary_path(&self.workspace, "bootstrap");
            let result = async {
                self.restore_and_verify(&remote, &head, &restored).await?;
                install_database(&restored, &self.workspace.database_path)?;
                let mut database =
                    SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
                database.mark_synchronized(&head.manifest.generation, &head.etag)?;
                Ok::<(), SiloError>(())
            }
            .await;
            remove_database(&restored);
            result?;
        } else {
            let mut database =
                SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
            let state = database.get_sync_state()?;
            if head.is_some() && state.is_none() {
                return Err(SiloError::new(
                    exits::REVISION,
                    "sync_local_diverged",
                    format!(
                        "A local database and remote generation {} both exist. Choose an explicit sync recovery workflow.",
                        head.as_ref()
                            .map(|head| head.manifest.generation.as_str())
                            .unwrap_or_default()
                    ),
                ));
            }
            let configured = database.configure_sync(
                remote_url,
                head.as_ref().map(|head| head.manifest.database_id.as_str()),
            )?;
            if let Some(head) = &head {
                validate_head(&self.workspace, head, Some(&configured.database_id))?;
            }
        }
        self.status().await
    }

    pub async fn adopt_remote(
        &self,
        remote_url: &str,
        confirmed_generation: &str,
    ) -> Result<SyncRecoveryResult, SiloError> {
        let _lock = SiloDatabase::acquire_sync_lock(&self.workspace)?;
        self.checkpoint.check()?;
        if !self.workspace.database_path.exists() {
            return Err(SiloError::new(
                exits::ABSENT,
                "sync_local_absent",
                "A local database is required to use the adopt-remote recovery workflow.",
            ));
        }
        let local = SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
        if local.get_sync_state()?.is_some() {
            return Err(SiloError::new(
                exits::WORKSPACE,
                "sync_already_configured",
                "The local database is already configured for synchronization.",
            ));
        }
        drop(local);
        let remote = S3SyncRemote::new(remote_url).await?;
        let head = remote.read_head().await?.ok_or_else(|| {
            SiloError::new(
                exits::ABSENT,
                "sync_remote_absent",
                "Remote HEAD does not exist.",
            )
        })?;
        validate_head(&self.workspace, &head, None)?;
        confirm_recovery(&head, confirmed_generation)?;

        let restored = temporary_path(&self.workspace, "adopt");
        let mut preserved = self.workspace.database_path.as_os_str().to_owned();
        preserved.push(format!(".recovery-local-{}.sqlite", Uuid::new_v4()));
        let preserved = PathBuf::from(preserved);
        let result = async {
            self.restore_and_verify(&remote, &head, &restored).await?;
            let local = SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
            local.backup_recovery(&preserved)?;
            drop(local);
            install_database(&restored, &self.workspace.database_path)?;
            let mut adopted =
                SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
            adopted.mark_synchronized(&head.manifest.generation, &head.etag)?;
            Ok::<(), SiloError>(())
        }
        .await;
        remove_database(&restored);
        result?;
        Ok(SyncRecoveryResult {
            status: self.status().await?,
            preserved: preserved.to_string_lossy().into_owned(),
        })
    }

    pub async fn replace_remote(
        &self,
        remote_url: &str,
        confirmed_generation: &str,
    ) -> Result<SyncRecoveryResult, SiloError> {
        let _lock = SiloDatabase::acquire_sync_lock(&self.workspace)?;
        self.checkpoint.check()?;
        if !self.workspace.database_path.exists() {
            return Err(SiloError::new(
                exits::ABSENT,
                "sync_local_absent",
                "A local database is required to use the replace-remote recovery workflow.",
            ));
        }
        let remote = S3SyncRemote::new(remote_url).await?;
        let head = remote.read_head().await?.ok_or_else(|| {
            SiloError::new(
                exits::ABSENT,
                "sync_remote_absent",
                "Remote HEAD does not exist.",
            )
        })?;
        validate_head(&self.workspace, &head, None)?;
        confirm_recovery(&head, confirmed_generation)?;

        let candidate = temporary_path(&self.workspace, "replace");
        let local = SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
        if local.get_sync_state()?.is_some() {
            return Err(SiloError::new(
                exits::WORKSPACE,
                "sync_already_configured",
                "The local database is already configured for synchronization.",
            ));
        }
        local.backup_recovery(&candidate)?;
        drop(local);
        let mut configured = SiloDatabase::open_with_sync_lock(
            workspace_at_path(&self.workspace, &candidate),
            true,
            true,
        )?;
        configured.configure_sync(remote_url, Some(&head.manifest.database_id))?;
        drop(configured);
        let result = self
            .publish_database(&candidate, &remote, Some(&head))
            .await
            .and_then(|_| install_database(&candidate, &self.workspace.database_path));
        remove_database(&candidate);
        result?;
        Ok(SyncRecoveryResult {
            status: self.status().await?,
            preserved: remote.location.generation_url(&head.manifest.generation),
        })
    }

    pub async fn status(&self) -> Result<SyncStatus, SiloError> {
        if !self.workspace.database_path.exists() {
            return Ok(unconfigured_status());
        }
        let database = SiloDatabase::open(self.workspace.clone(), false)?;
        let state = database.get_sync_state()?;
        let pending = database.pending_transactions()?.len();
        drop(database);
        let Some(state) = state else {
            return Ok(unconfigured_status());
        };
        let remote = S3SyncRemote::new(&state.remote_url).await?;
        let head = remote.read_head().await?;
        if let Some(head) = &head {
            validate_head(&self.workspace, head, Some(&state.database_id))?;
        }
        let remote_generation = head.map(|head| head.manifest.generation);
        let status = if state.conflict_transaction_id.is_some() {
            "conflicted"
        } else if remote_generation.is_none() {
            "ahead"
        } else if state.base_generation == remote_generation {
            if pending > 0 { "ahead" } else { "clean" }
        } else if pending > 0 {
            "diverged"
        } else {
            "behind"
        };
        Ok(SyncStatus {
            state: status.to_owned(),
            remote_url: Some(state.remote_url),
            database_id: Some(state.database_id),
            local_generation: state.base_generation,
            remote_generation,
            pending_transactions: pending,
            conflict_transaction_id: state.conflict_transaction_id,
        })
    }

    pub async fn pull(
        &self,
        discard_transaction_id: Option<&str>,
    ) -> Result<SyncStatus, SiloError> {
        let _lock = SiloDatabase::acquire_sync_lock(&self.workspace)?;
        self.pull_unlocked(discard_transaction_id).await?;
        self.status().await
    }

    async fn pull_unlocked(&self, discard_transaction_id: Option<&str>) -> Result<(), SiloError> {
        self.checkpoint.check()?;
        let database = SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
        let state = database.get_sync_state()?.ok_or_else(|| {
            SiloError::new(
                exits::WORKSPACE,
                "sync_not_configured",
                "Synchronization is not configured.",
            )
        })?;
        let pending = database.pending_transactions()?;
        if let Some(id) = discard_transaction_id
            && !pending.iter().any(|item| item.transaction_id == id)
        {
            return Err(SiloError::new(
                exits::NOT_FOUND,
                "sync_transaction_not_found",
                format!("{id} is not a pending transaction."),
            ));
        }
        drop(database);
        let remote = S3SyncRemote::new(&state.remote_url).await?;
        let head = remote.read_head().await?.ok_or_else(|| {
            SiloError::new(
                exits::ABSENT,
                "sync_remote_absent",
                "Remote HEAD does not exist.",
            )
        })?;
        validate_head(&self.workspace, &head, Some(&state.database_id))?;
        if state.base_generation.as_deref() == Some(head.manifest.generation.as_str())
            && discard_transaction_id.is_none()
        {
            return Ok(());
        }
        let restored = temporary_path(&self.workspace, "pull");
        let result = async {
            self.restore_and_verify(&remote, &head, &restored).await?;
            let mut rebased = SiloDatabase::open_with_sync_lock(
                workspace_at_path(&self.workspace, &restored),
                true,
                true,
            )?;
            let conflict = rebased.rebase_pending(
                &pending,
                &head.manifest.generation,
                &head.etag,
                discard_transaction_id,
            )?;
            drop(rebased);
            if let Some(conflict) = conflict {
                let mut local =
                    SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
                local.set_sync_conflict(&conflict)?;
                return Err(SiloError::new(
                    exits::REVISION,
                    "sync_changeset_conflict",
                    format!(
                        "Transaction {conflict} conflicts with remote generation {}.",
                        head.manifest.generation
                    ),
                ));
            }
            install_database(&restored, &self.workspace.database_path)
        }
        .await;
        remove_database(&restored);
        result
    }

    pub async fn push(&self) -> Result<SyncStatus, SiloError> {
        let _lock = SiloDatabase::acquire_sync_lock(&self.workspace)?;
        self.checkpoint.check()?;
        let database = SiloDatabase::open_with_sync_lock(self.workspace.clone(), true, true)?;
        let state = database.get_sync_state()?.ok_or_else(|| {
            SiloError::new(
                exits::WORKSPACE,
                "sync_not_configured",
                "Synchronization is not configured.",
            )
        })?;
        let pending_count = database.pending_transactions()?.len();
        drop(database);
        let remote = S3SyncRemote::new(&state.remote_url).await?;
        let mut head = remote.read_head().await?;
        if let Some(head) = &head {
            validate_head(&self.workspace, head, Some(&state.database_id))?;
        }
        if head.is_none() && state.base_generation.is_some() {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "sync_remote_head_missing",
                "Remote HEAD disappeared after this database was synchronized.",
            ));
        }
        if head.as_ref().is_some_and(|head| {
            state.base_generation.as_deref() == Some(head.manifest.generation.as_str())
                && pending_count == 0
        }) {
            return self.status().await;
        }
        if head.as_ref().is_some_and(|head| {
            state.base_generation.as_deref() != Some(head.manifest.generation.as_str())
        }) {
            self.pull_unlocked(None).await?;
            let database = SiloDatabase::open_with_sync_lock(self.workspace.clone(), false, true)?;
            let state = database.get_sync_state()?.ok_or_else(|| {
                SiloError::new(
                    exits::INTEGRITY,
                    "sync_metadata_missing",
                    "Synchronization metadata is missing.",
                )
            })?;
            drop(database);
            head = remote.read_head().await?;
            if let Some(head) = &head {
                validate_head(&self.workspace, head, Some(&state.database_id))?;
            }
        }
        self.publish_database(&self.workspace.database_path, &remote, head.as_ref())
            .await?;
        self.status().await
    }

    async fn publish_database(
        &self,
        database_path: &Path,
        remote: &S3SyncRemote,
        head: Option<&RemoteHead>,
    ) -> Result<(), SiloError> {
        let database = SiloDatabase::open_with_sync_lock(
            workspace_at_path(&self.workspace, database_path),
            true,
            true,
        )?;
        let state = database.get_sync_state()?.ok_or_else(|| {
            SiloError::new(
                exits::WORKSPACE,
                "sync_not_configured",
                "Synchronization is not configured.",
            )
        })?;
        let schema_revision = database.schema()?.revision;
        let generation = Uuid::new_v4().to_string();
        let publication_id = Uuid::new_v4().to_string();
        let candidate = temporary_path(&self.workspace, "publish");
        let verified = temporary_path(&self.workspace, "verify");
        let manifest = database
            .backup_canonical(&candidate, &generation)
            .and_then(|_| {
                Ok(SyncManifest {
                    format_version: 1,
                    database_id: state.database_id.clone(),
                    identity: self.workspace.identity.clone(),
                    generation: generation.clone(),
                    publication_id: publication_id.clone(),
                    parent_generation: head.map(|head| head.manifest.generation.clone()),
                    schema_revision,
                    database_sha256: hash_database(&candidate)?,
                    created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                })
            });
        drop(database);
        let result = match manifest {
            Err(error) => Err(error),
            Ok(manifest) => {
                async {
                    self.checkpoint
                        .publish(&candidate, &remote.location.generation_url(&generation))
                        .await?;
                    self.checkpoint
                        .restore(&remote.location.generation_url(&generation), &verified)
                        .await?;
                    if hash_database(&verified)? != manifest.database_sha256 {
                        return Err(SiloError::new(
                            exits::INTEGRITY,
                            "sync_checkpoint_hash_mismatch",
                            "The restored checkpoint does not match the published database.",
                        ));
                    }
                    verify_checkpoint(&self.workspace, &verified, &manifest)?;
                    let etag = match remote
                        .publish_head(&manifest, head.map(|head| head.etag.as_str()))
                        .await
                    {
                        Ok(etag) => etag,
                        Err(error) if error.code == "sync_head_changed" => {
                            let current = remote.read_head().await?;
                            if current.as_ref().is_none_or(|current| {
                                current.manifest.publication_id != publication_id
                            }) {
                                return Err(error);
                            }
                            current.map(|current| current.etag).ok_or(error)?
                        }
                        Err(error) => return Err(error),
                    };
                    let mut updated = SiloDatabase::open_with_sync_lock(
                        workspace_at_path(&self.workspace, database_path),
                        true,
                        true,
                    )?;
                    updated.mark_synchronized(&generation, &etag)?;
                    Ok::<(), SiloError>(())
                }
                .await
            }
        };
        remove_database(&candidate);
        remove_database(&verified);
        result
    }

    async fn restore_and_verify(
        &self,
        remote: &S3SyncRemote,
        head: &RemoteHead,
        output: &Path,
    ) -> Result<(), SiloError> {
        self.checkpoint
            .restore(
                &remote.location.generation_url(&head.manifest.generation),
                output,
            )
            .await?;
        if hash_database(output)? != head.manifest.database_sha256 {
            return Err(SiloError::new(
                exits::INTEGRITY,
                "sync_checkpoint_hash_mismatch",
                "The restored checkpoint does not match remote HEAD.",
            ));
        }
        verify_checkpoint(&self.workspace, output, &head.manifest)
    }

    pub async fn prune(
        &self,
        older_than_days: f64,
        apply: bool,
    ) -> Result<SyncPruneResult, SiloError> {
        if !older_than_days.is_finite() || older_than_days <= 0.0 {
            return Err(SiloError::new(
                exits::INPUT,
                "invalid_prune_period",
                "older-than must be a positive number of days.",
            ));
        }
        let _lock = SiloDatabase::acquire_sync_lock(&self.workspace)?;
        let database = SiloDatabase::open(self.workspace.clone(), false)?;
        let state = database.get_sync_state()?.ok_or_else(|| {
            SiloError::new(
                exits::WORKSPACE,
                "sync_not_configured",
                "Synchronization is not configured.",
            )
        })?;
        drop(database);
        let remote = S3SyncRemote::new(&state.remote_url).await?;
        let head = remote.read_head().await?.ok_or_else(|| {
            SiloError::new(
                exits::ABSENT,
                "sync_remote_absent",
                "Remote HEAD does not exist.",
            )
        })?;
        validate_head(&self.workspace, &head, Some(&state.database_id))?;
        let cutoff = Utc::now()
            - chrono::Duration::milliseconds(
                (older_than_days * 86_400_000.0).min(i64::MAX as f64) as i64
            );
        let generations = remote.list_generations().await?;
        let mut eligible = generations
            .iter()
            .filter(|item| {
                item.generation != head.manifest.generation && item.last_modified <= cutoff
            })
            .map(|item| item.generation.clone())
            .collect::<Vec<_>>();
        eligible.sort();
        let mut deleted = Vec::new();
        if apply {
            for generation in &eligible {
                let current = remote.read_head().await?;
                if current
                    .as_ref()
                    .is_none_or(|current| current.etag != head.etag)
                {
                    return Err(SiloError::new(
                        exits::REVISION,
                        "sync_head_changed",
                        if deleted.is_empty() {
                            "Remote HEAD changed during cleanup; no generations were deleted."
                                .to_owned()
                        } else {
                            format!(
                                "Remote HEAD changed during cleanup after {} generation(s) were deleted; remaining generations were preserved.",
                                deleted.len()
                            )
                        },
                    ));
                }
                remote.delete_generation(generation).await?;
                deleted.push(generation.clone());
            }
        }
        Ok(SyncPruneResult {
            remote_url: state.remote_url,
            current_generation: head.manifest.generation,
            cutoff: cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            scanned_generations: generations.len(),
            eligible_generations: eligible,
            deleted_generations: deleted,
            dry_run: !apply,
        })
    }
}

fn unconfigured_status() -> SyncStatus {
    SyncStatus {
        state: "unconfigured".into(),
        remote_url: None,
        database_id: None,
        local_generation: None,
        remote_generation: None,
        pending_transactions: 0,
        conflict_transaction_id: None,
    }
}

fn validate_head(
    workspace: &Workspace,
    head: &RemoteHead,
    database_id: Option<&str>,
) -> Result<(), SiloError> {
    if head.manifest.identity != workspace.identity {
        return Err(SiloError::new(
            exits::INTEGRITY,
            "sync_identity_mismatch",
            "Remote HEAD belongs to a different Git workspace identity.",
        ));
    }
    if database_id.is_some_and(|database_id| database_id != head.manifest.database_id) {
        return Err(SiloError::new(
            exits::INTEGRITY,
            "sync_database_mismatch",
            "Remote HEAD belongs to a different Silo database.",
        ));
    }
    Ok(())
}

fn confirm_recovery(head: &RemoteHead, confirmed_generation: &str) -> Result<(), SiloError> {
    if confirmed_generation != head.manifest.generation {
        return Err(SiloError::new(
            exits::REVISION,
            "sync_recovery_confirmation_mismatch",
            format!(
                "Confirmation must equal current remote generation {}.",
                head.manifest.generation
            ),
        ));
    }
    Ok(())
}

fn verify_checkpoint(
    workspace: &Workspace,
    path: &Path,
    manifest: &SyncManifest,
) -> Result<(), SiloError> {
    let database =
        SiloDatabase::open_with_sync_lock(workspace_at_path(workspace, path), false, true)?;
    let sync = database.get_sync_state()?;
    if sync
        .as_ref()
        .is_none_or(|sync| sync.database_id != manifest.database_id)
    {
        return Err(SiloError::new(
            exits::INTEGRITY,
            "sync_checkpoint_identity_mismatch",
            "The restored checkpoint does not match remote HEAD.",
        ));
    }
    if database.schema()?.revision != manifest.schema_revision {
        return Err(SiloError::new(
            exits::INTEGRITY,
            "sync_checkpoint_schema_mismatch",
            "The restored checkpoint schema does not match its manifest.",
        ));
    }
    database.verify()
}

fn workspace_at_path(workspace: &Workspace, path: &Path) -> Workspace {
    let mut workspace = workspace.clone();
    workspace.database_path = path.to_path_buf();
    workspace
}

fn temporary_path(workspace: &Workspace, label: &str) -> PathBuf {
    let mut path = workspace.database_path.as_os_str().to_owned();
    path.push(format!(".{label}.{}.sqlite", Uuid::new_v4()));
    path.into()
}

fn remove_database(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal", "-txid"] {
        let mut candidate = path.as_os_str().to_owned();
        candidate.push(suffix);
        let _ = fs::remove_file(candidate);
    }
}

fn install_database(source: &Path, destination: &Path) -> Result<(), SiloError> {
    let mut previous = destination.as_os_str().to_owned();
    previous.push(".previous");
    let previous = PathBuf::from(previous);
    remove_database(&previous);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = destination.as_os_str().to_owned();
        sidecar.push(suffix);
        let _ = fs::remove_file(sidecar);
    }
    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }
    if destination.exists() {
        fs::rename(destination, &previous).map_err(io_error)?;
    }
    match fs::rename(source, destination) {
        Ok(()) => {
            remove_database(&previous);
            Ok(())
        }
        Err(error) => {
            if previous.exists() && !destination.exists() {
                let _ = fs::rename(&previous, destination);
            }
            Err(io_error(error))
        }
    }
}

fn hash_database(path: &Path) -> Result<String, SiloError> {
    let bytes = fs::read(path).map_err(io_error)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn sync_error(code: &str, message: impl Into<String>) -> SiloError {
    SiloError::new(exits::IO, code, message)
}

fn io_error(error: std::io::Error) -> SiloError {
    SiloError::new(exits::IO, "sync_file_error", error.to_string())
}

fn json_error(error: serde_json::Error) -> SiloError {
    SiloError::new(exits::INTEGRITY, "sync_manifest_invalid", error.to_string())
}
