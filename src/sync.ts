import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { SiloDatabase } from './database.js'
import { acquireFileLock } from './lock.js'
import { exits, SiloError, type PendingTransaction } from './model.js'
import type { Workspace } from './workspace.js'

const exec = promisify(execFile)

export interface SyncManifest {
  format_version: 1
  database_id: string
  identity: string
  generation: string
  publication_id: string
  parent_generation: string | null
  schema_revision: number
  database_sha256: string
  created_at: string
}

export interface RemoteHead {
  manifest: SyncManifest
  etag: string
}

export interface SyncRemote {
  readonly url: string
  readHead(): Promise<RemoteHead | undefined>
  publishHead(manifest: SyncManifest, expectedEtag: string | null): Promise<string>
  generationUrl(generation: string): string
  listGenerations(): Promise<SyncGeneration[]>
  deleteGeneration(generation: string): Promise<number>
}

export interface SyncGeneration {
  generation: string
  last_modified: Date
}

export interface SyncPruneResult {
  remote_url: string
  current_generation: string
  cutoff: string
  scanned_generations: number
  eligible_generations: string[]
  deleted_generations: string[]
  dry_run: boolean
}

export interface CheckpointTransport {
  check(): Promise<string>
  publish(databasePath: string, replicaUrl: string): Promise<void>
  restore(replicaUrl: string, outputPath: string): Promise<void>
}

export interface SyncServices {
  remote(url: string): SyncRemote
  checkpoint: CheckpointTransport
}

export type SyncStatusName =
  | 'unconfigured'
  | 'clean'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'conflicted'

export interface SyncStatus {
  state: SyncStatusName
  remote_url: string | null
  database_id: string | null
  local_generation: string | null
  remote_generation: string | null
  pending_transactions: number
  conflict_transaction_id: string | null
}

export interface SyncRecoveryResult {
  status: SyncStatus
  preserved: string
}

function parseRemoteUrl(value: string): { bucket: string; prefix: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SiloError(exits.input, 'invalid_sync_remote', 'Expected an s3://bucket/prefix URL.')
  }
  const prefix = url.pathname.replace(/^\/+|\/+$/g, '')
  if (url.protocol !== 's3:' || !url.hostname || !prefix || url.search || url.hash)
    throw new SiloError(exits.input, 'invalid_sync_remote', 'Expected an s3://bucket/prefix URL.')
  return { bucket: url.hostname, prefix }
}

function parseManifest(value: string): SyncManifest {
  try {
    const manifest = JSON.parse(value) as Partial<SyncManifest>
    if (
      manifest.format_version !== 1 ||
      typeof manifest.database_id !== 'string' ||
      typeof manifest.identity !== 'string' ||
      typeof manifest.generation !== 'string' ||
      typeof manifest.publication_id !== 'string' ||
      (manifest.parent_generation !== null && typeof manifest.parent_generation !== 'string') ||
      !Number.isSafeInteger(manifest.schema_revision) ||
      typeof manifest.database_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.database_sha256) ||
      typeof manifest.created_at !== 'string'
    )
      throw new Error('required fields are missing or invalid')
    return manifest as SyncManifest
  } catch (error) {
    throw new SiloError(
      exits.integrity,
      'sync_manifest_invalid',
      `Remote HEAD is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export class S3SyncRemote implements SyncRemote {
  readonly url: string
  private readonly bucket: string
  private readonly prefix: string
  private readonly client: S3Client

  constructor(url: string, client?: S3Client) {
    this.url = url
    const parsed = parseRemoteUrl(url)
    this.bucket = parsed.bucket
    this.prefix = parsed.prefix
    const endpoint = process.env.AWS_ENDPOINT_URL_S3
    this.client =
      client ??
      new S3Client({
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      })
  }

  private get headKey(): string {
    return `${this.prefix}/HEAD`
  }

  async readHead(): Promise<RemoteHead | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.headKey }),
      )
      if (!response.Body || !response.ETag)
        throw new SiloError(
          exits.integrity,
          'sync_manifest_incomplete',
          'Remote HEAD has no body or entity tag.',
        )
      return {
        manifest: parseManifest(await response.Body.transformToString()),
        etag: response.ETag,
      }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') return undefined
      if (error instanceof SiloError) throw error
      throw new SiloError(
        exits.io,
        'sync_remote_read_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async publishHead(manifest: SyncManifest, expectedEtag: string | null): Promise<string> {
    const input: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: this.headKey,
      Body: `${JSON.stringify(manifest)}\n`,
      ContentType: 'application/json',
      ...(expectedEtag === null ? { IfNoneMatch: '*' } : { IfMatch: expectedEtag }),
    }
    // Immutable generations are harmless to race; this conditional pointer update is the
    // sole publication point that prevents one successful push from erasing another.
    try {
      const response = await this.client.send(new PutObjectCommand(input))
      if (!response.ETag)
        throw new SiloError(
          exits.io,
          'sync_head_etag_missing',
          'Object storage did not return an entity tag for HEAD.',
        )
      return response.ETag
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (status === 409 || status === 412)
        throw new SiloError(
          exits.revision,
          'sync_head_changed',
          'Remote HEAD changed during publication; pull and retry.',
        )
      if (error instanceof SiloError) throw error
      throw new SiloError(
        exits.io,
        'sync_remote_write_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  generationUrl(generation: string): string {
    return `s3://${this.bucket}/${this.prefix}/generations/${generation}`
  }

  async listGenerations(): Promise<SyncGeneration[]> {
    const prefix = `${this.prefix}/generations/`
    const generations = new Map<string, Date>()
    let continuationToken: string | undefined
    try {
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        for (const object of response.Contents ?? []) {
          const remainder = object.Key?.slice(prefix.length)
          const generation = remainder?.split('/', 1)[0]
          if (!generation || !object.LastModified) continue
          const previous = generations.get(generation)
          if (!previous || object.LastModified > previous)
            generations.set(generation, object.LastModified)
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
      return [...generations].map(([generation, last_modified]) => ({
        generation,
        last_modified,
      }))
    } catch (error) {
      throw new SiloError(
        exits.io,
        'sync_generations_list_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async deleteGeneration(generation: string): Promise<number> {
    const prefix = `${this.prefix}/generations/${generation}/`
    const objects: Array<{ Key: string }> = []
    let continuationToken: string | undefined
    try {
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        objects.push(
          ...(response.Contents ?? []).flatMap((object) =>
            object.Key ? [{ Key: object.Key }] : [],
          ),
        )
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
      for (let offset = 0; offset < objects.length; offset += 1000) {
        const batch = objects.slice(offset, offset + 1000)
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch, Quiet: true },
          }),
        )
        if (result.Errors?.length)
          throw new Error(
            result.Errors.map(
              (item) =>
                `${item.Key ?? 'unknown key'}: ${item.Message ?? item.Code ?? 'delete failed'}`,
            ).join('; '),
          )
      }
      return objects.length
    } catch (error) {
      throw new SiloError(
        exits.io,
        'sync_generation_delete_failed',
        `Generation ${generation}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export class LitestreamCheckpoint implements CheckpointTransport {
  private readonly executable: string

  constructor(executable = process.env.LITESTREAM_PATH ?? 'litestream') {
    this.executable = executable
  }

  async check(): Promise<string> {
    try {
      const { stdout, stderr } = await exec(this.executable, ['version'])
      const output = `${stdout} ${stderr}`.trim()
      const version = /v?(\d+)\.(\d+)\.(\d+)/.exec(output)
      const parts = version?.slice(1).map(Number)
      const supported =
        parts && (parts[0]! > 0 || parts[1]! > 5 || (parts[1] === 5 && parts[2]! >= 12))
      if (!supported)
        throw new SiloError(
          exits.io,
          'litestream_incompatible',
          `Litestream 0.5.12 or newer is required; found ${output || 'an unknown version'}.`,
        )
      return version![0]
    } catch (error) {
      if (error instanceof SiloError) throw error
      throw new SiloError(
        exits.io,
        'litestream_unavailable',
        'Litestream 0.5.12 or newer is required on PATH or through LITESTREAM_PATH.',
      )
    }
  }

  async publish(databasePath: string, replicaUrl: string): Promise<void> {
    await this.check()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable, ['replicate', databasePath, replicaUrl], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-16_384)
      })
      let requestedStop = false
      const stop = setTimeout(() => {
        requestedStop = true
        child.kill('SIGINT')
      }, 1500)
      child.once('error', (error) => {
        clearTimeout(stop)
        reject(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(stop)
        if (code === 0 || (requestedStop && signal === 'SIGINT')) resolve()
        else
          reject(
            new SiloError(
              exits.io,
              'litestream_publish_failed',
              stderr.trim() || `Litestream exited with status ${code ?? signal}.`,
            ),
          )
      })
    })
  }

  async restore(replicaUrl: string, outputPath: string): Promise<void> {
    await this.check()
    removeDatabase(outputPath)
    try {
      await exec(this.executable, ['restore', '-json', '-o', outputPath, replicaUrl])
    } catch (error) {
      throw new SiloError(
        exits.io,
        'litestream_restore_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

const defaultServices: SyncServices = {
  remote: (url) => new S3SyncRemote(url),
  checkpoint: new LitestreamCheckpoint(),
}

function temporaryPath(workspace: Workspace, label: string): string {
  return `${workspace.databasePath}.${label}.${randomUUID()}.sqlite`
}

function removeDatabase(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal', '-txid'])
    rmSync(`${path}${suffix}`, { force: true })
}

function hashDatabase(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function validateHead(workspace: Workspace, head: RemoteHead, databaseId?: string): void {
  if (head.manifest.identity !== workspace.identity)
    throw new SiloError(
      exits.integrity,
      'sync_identity_mismatch',
      'Remote HEAD belongs to a different Git workspace identity.',
    )
  if (databaseId && head.manifest.database_id !== databaseId)
    throw new SiloError(
      exits.integrity,
      'sync_database_mismatch',
      'Remote HEAD belongs to a different Silo database.',
    )
}

function installDatabase(source: string, destination: string): void {
  removeDatabase(`${destination}.previous`)
  for (const suffix of ['-wal', '-shm', '-journal'])
    rmSync(`${destination}${suffix}`, { force: true })
  try {
    renameSync(source, destination)
  } catch {
    const previous = `${destination}.previous`
    if (existsSync(destination)) renameSync(destination, previous)
    try {
      renameSync(source, destination)
      removeDatabase(previous)
    } catch (error) {
      if (existsSync(previous) && !existsSync(destination)) renameSync(previous, destination)
      throw error
    }
  }
}

async function withSyncLock<T>(workspace: Workspace, handler: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(workspace.databasePath), { recursive: true })
  const path = `${workspace.databasePath}.sync-lock`
  const release = acquireFileLock(path, 'Another synchronization operation is running.')
  try {
    if (existsSync(`${workspace.databasePath}.write-lock`))
      throw new SiloError(exits.io, 'sync_in_progress', 'Another writer is using this database.')
    return await handler()
  } finally {
    release()
  }
}

export class SiloSync {
  private readonly workspace: Workspace
  private readonly services: SyncServices

  constructor(workspace: Workspace, services: SyncServices = defaultServices) {
    this.workspace = workspace
    this.services = services
  }

  async initialize(remoteUrl: string): Promise<SyncStatus> {
    return withSyncLock(this.workspace, async () => {
      await this.services.checkpoint.check()
      const remote = this.services.remote(remoteUrl)
      const head = await remote.readHead()
      if (head) validateHead(this.workspace, head)

      if (!existsSync(this.workspace.databasePath)) {
        if (!head)
          throw new SiloError(
            exits.absent,
            'sync_database_absent',
            'Neither a local database nor a remote HEAD exists.',
          )
        const restored = temporaryPath(this.workspace, 'bootstrap')
        try {
          await this.restoreAndVerify(remote, head, restored)
          installDatabase(restored, this.workspace.databasePath)
          const database = SiloDatabase.open(this.workspace, true, true)
          try {
            database.markSynchronized(head.manifest.generation, head.etag)
          } finally {
            database.close()
          }
        } finally {
          removeDatabase(restored)
        }
      } else {
        const database = SiloDatabase.open(this.workspace, true, true)
        try {
          const state = database.getSyncState()
          if (head && !state)
            throw new SiloError(
              exits.revision,
              'sync_local_diverged',
              `A local database and remote generation ${head.manifest.generation} both exist. Choose an explicit sync recovery workflow.`,
            )
          const configured = database.configureSync(remoteUrl, head?.manifest.database_id)
          if (head) validateHead(this.workspace, head, configured.database_id)
        } finally {
          database.close()
        }
      }
      return this.status()
    })
  }

  async adoptRemote(remoteUrl: string, confirmedGeneration: string): Promise<SyncRecoveryResult> {
    return withSyncLock(this.workspace, async () => {
      await this.services.checkpoint.check()
      if (!existsSync(this.workspace.databasePath))
        throw new SiloError(
          exits.absent,
          'sync_local_absent',
          'A local database is required to use the adopt-remote recovery workflow.',
        )
      const local = SiloDatabase.open(this.workspace, true, true)
      try {
        if (local.getSyncState())
          throw new SiloError(
            exits.workspace,
            'sync_already_configured',
            'The local database is already configured for synchronization.',
          )
      } finally {
        local.close()
      }
      const remote = this.services.remote(remoteUrl)
      const head = await remote.readHead()
      if (!head)
        throw new SiloError(exits.absent, 'sync_remote_absent', 'Remote HEAD does not exist.')
      validateHead(this.workspace, head)
      this.confirmRecovery(head, confirmedGeneration)

      const restored = temporaryPath(this.workspace, 'adopt')
      const preserved = `${this.workspace.databasePath}.recovery-local-${randomUUID()}.sqlite`
      try {
        await this.restoreAndVerify(remote, head, restored)
        const original = SiloDatabase.open(this.workspace, true, true)
        try {
          await original.backupRecovery(preserved)
        } finally {
          original.close()
        }
        installDatabase(restored, this.workspace.databasePath)
        const adopted = SiloDatabase.open(this.workspace, true, true)
        try {
          adopted.markSynchronized(head.manifest.generation, head.etag)
        } finally {
          adopted.close()
        }
      } finally {
        removeDatabase(restored)
      }
      return { status: await this.status(), preserved }
    })
  }

  async replaceRemote(remoteUrl: string, confirmedGeneration: string): Promise<SyncRecoveryResult> {
    return withSyncLock(this.workspace, async () => {
      await this.services.checkpoint.check()
      if (!existsSync(this.workspace.databasePath))
        throw new SiloError(
          exits.absent,
          'sync_local_absent',
          'A local database is required to use the replace-remote recovery workflow.',
        )
      const remote = this.services.remote(remoteUrl)
      const head = await remote.readHead()
      if (!head)
        throw new SiloError(exits.absent, 'sync_remote_absent', 'Remote HEAD does not exist.')
      validateHead(this.workspace, head)
      this.confirmRecovery(head, confirmedGeneration)

      const candidate = temporaryPath(this.workspace, 'replace')
      const local = SiloDatabase.open(this.workspace, true, true)
      try {
        if (local.getSyncState())
          throw new SiloError(
            exits.workspace,
            'sync_already_configured',
            'The local database is already configured for synchronization.',
          )
        await local.backupRecovery(candidate)
      } finally {
        local.close()
      }
      try {
        const configured = SiloDatabase.open(
          { ...this.workspace, databasePath: candidate },
          true,
          true,
        )
        try {
          configured.configureSync(remoteUrl, head.manifest.database_id)
        } finally {
          configured.close()
        }
        await this.publishDatabase(candidate, remote, head)
        installDatabase(candidate, this.workspace.databasePath)
      } finally {
        removeDatabase(candidate)
      }
      return {
        status: await this.status(),
        preserved: remote.generationUrl(head.manifest.generation),
      }
    })
  }

  private confirmRecovery(head: RemoteHead, confirmedGeneration: string): void {
    if (confirmedGeneration !== head.manifest.generation)
      throw new SiloError(
        exits.revision,
        'sync_recovery_confirmation_mismatch',
        `Confirmation must equal current remote generation ${head.manifest.generation}.`,
      )
  }

  async status(): Promise<SyncStatus> {
    if (!existsSync(this.workspace.databasePath))
      return {
        state: 'unconfigured',
        remote_url: null,
        database_id: null,
        local_generation: null,
        remote_generation: null,
        pending_transactions: 0,
        conflict_transaction_id: null,
      }
    const database = SiloDatabase.open(this.workspace)
    let state
    let pending: PendingTransaction[]
    try {
      state = database.getSyncState()
      pending = database.pendingTransactions()
    } finally {
      database.close()
    }
    if (!state)
      return {
        state: 'unconfigured',
        remote_url: null,
        database_id: null,
        local_generation: null,
        remote_generation: null,
        pending_transactions: 0,
        conflict_transaction_id: null,
      }
    const head = await this.services.remote(state.remote_url).readHead()
    if (head) validateHead(this.workspace, head, state.database_id)
    const remoteGeneration = head?.manifest.generation ?? null
    let status: SyncStatusName
    if (state.conflict_transaction_id) status = 'conflicted'
    else if (!head) status = 'ahead'
    else if (state.base_generation === remoteGeneration) status = pending.length ? 'ahead' : 'clean'
    else if (pending.length) status = 'diverged'
    else status = 'behind'
    return {
      state: status,
      remote_url: state.remote_url,
      database_id: state.database_id,
      local_generation: state.base_generation,
      remote_generation: remoteGeneration,
      pending_transactions: pending.length,
      conflict_transaction_id: state.conflict_transaction_id,
    }
  }

  async pull(discardTransactionId?: string): Promise<SyncStatus> {
    return withSyncLock(this.workspace, async () => {
      await this.pullUnlocked(discardTransactionId)
      return this.status()
    })
  }

  private async pullUnlocked(discardTransactionId?: string): Promise<void> {
    await this.services.checkpoint.check()
    const local = SiloDatabase.open(this.workspace, true, true)
    let state
    let pending: PendingTransaction[]
    try {
      state = local.getSyncState()
      if (!state)
        throw new SiloError(
          exits.workspace,
          'sync_not_configured',
          'Synchronization is not configured.',
        )
      pending = local.pendingTransactions()
      if (
        discardTransactionId &&
        !pending.some((item) => item.transaction_id === discardTransactionId)
      )
        throw new SiloError(
          exits.notFound,
          'sync_transaction_not_found',
          `${discardTransactionId} is not a pending transaction.`,
        )
    } finally {
      local.close()
    }
    const remote = this.services.remote(state.remote_url)
    const head = await remote.readHead()
    if (!head)
      throw new SiloError(exits.absent, 'sync_remote_absent', 'Remote HEAD does not exist.')
    validateHead(this.workspace, head, state.database_id)
    if (state.base_generation === head.manifest.generation && !discardTransactionId) return

    const restored = temporaryPath(this.workspace, 'pull')
    try {
      await this.restoreAndVerify(remote, head, restored)
      const rebased = SiloDatabase.open({ ...this.workspace, databasePath: restored }, true, true)
      let conflict: string | undefined
      try {
        conflict = rebased.rebasePending(
          pending,
          head.manifest.generation,
          head.etag,
          discardTransactionId,
        )
      } finally {
        rebased.close()
      }
      if (conflict) {
        const original = SiloDatabase.open(this.workspace, true, true)
        try {
          original.setSyncConflict(conflict)
        } finally {
          original.close()
        }
        const operation = pending.find((item) => item.transaction_id === conflict)?.operation
        const context = [
          String(operation?.command ?? 'unknown operation'),
          operation?.table ? `table ${String(operation.table)}` : '',
          operation?.key !== undefined ? `key ${JSON.stringify(operation.key)}` : '',
        ]
          .filter(Boolean)
          .join(', ')
        throw new SiloError(
          exits.revision,
          'sync_changeset_conflict',
          `Transaction ${conflict} (${context}) conflicts with remote generation ${head.manifest.generation}.`,
        )
      }
      installDatabase(restored, this.workspace.databasePath)
    } finally {
      removeDatabase(restored)
    }
  }

  async push(): Promise<SyncStatus> {
    return withSyncLock(this.workspace, async () => {
      await this.services.checkpoint.check()
      const database = SiloDatabase.open(this.workspace, true, true)
      let state
      let pendingCount: number
      try {
        state = database.getSyncState()
        pendingCount = database.pendingTransactions().length
      } finally {
        database.close()
      }
      if (!state)
        throw new SiloError(
          exits.workspace,
          'sync_not_configured',
          'Synchronization is not configured.',
        )
      const remote = this.services.remote(state.remote_url)
      let head = await remote.readHead()
      if (head) validateHead(this.workspace, head, state.database_id)
      if (!head && state.base_generation)
        throw new SiloError(
          exits.integrity,
          'sync_remote_head_missing',
          'Remote HEAD disappeared after this database was synchronized.',
        )
      if (head && state.base_generation === head.manifest.generation && !pendingCount)
        return this.status()
      if (head && state.base_generation !== head.manifest.generation) {
        await this.pullUnlocked()
        const refreshed = SiloDatabase.open(this.workspace)
        try {
          state = refreshed.getSyncState()!
        } finally {
          refreshed.close()
        }
        head = await remote.readHead()
        if (head) validateHead(this.workspace, head, state.database_id)
      }

      await this.publishDatabase(this.workspace.databasePath, remote, head)
      return this.status()
    })
  }

  async prune(olderThanDays = 7, apply = false, now = new Date()): Promise<SyncPruneResult> {
    return withSyncLock(this.workspace, async () => {
      const database = SiloDatabase.open(this.workspace)
      let state
      try {
        state = database.getSyncState()
      } finally {
        database.close()
      }
      if (!state)
        throw new SiloError(
          exits.workspace,
          'sync_not_configured',
          'Synchronization is not configured.',
        )
      const remote = this.services.remote(state.remote_url)
      const head = await remote.readHead()
      if (!head)
        throw new SiloError(exits.absent, 'sync_remote_absent', 'Remote HEAD does not exist.')
      validateHead(this.workspace, head, state.database_id)
      const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000)
      const generations = await remote.listGenerations()
      const eligible = generations
        .filter(
          (item) =>
            item.generation !== head.manifest.generation &&
            item.last_modified.getTime() <= cutoff.getTime(),
        )
        .map((item) => item.generation)
        .sort()
      const deleted: string[] = []
      if (apply && eligible.length) {
        // A generation created by a conforming publisher is fresh and cannot pass the grace
        // boundary. Rechecking the conditional pointer therefore protects both a publication
        // already in flight and an operator-driven HEAD rollback before destructive work.
        for (const generation of eligible) {
          const current = await remote.readHead()
          if (!current || current.etag !== head.etag)
            throw new SiloError(
              exits.revision,
              'sync_head_changed',
              deleted.length
                ? `Remote HEAD changed during cleanup after ${deleted.length} generation(s) were deleted; remaining generations were preserved.`
                : 'Remote HEAD changed during cleanup; no generations were deleted.',
            )
          validateHead(this.workspace, current, state.database_id)
          if (generation === current.manifest.generation) continue
          await remote.deleteGeneration(generation)
          deleted.push(generation)
        }
      }
      return {
        remote_url: state.remote_url,
        current_generation: head.manifest.generation,
        cutoff: cutoff.toISOString(),
        scanned_generations: generations.length,
        eligible_generations: eligible,
        deleted_generations: deleted,
        dry_run: !apply,
      }
    })
  }

  private async publishDatabase(
    databasePath: string,
    remote: SyncRemote,
    head: RemoteHead | undefined,
  ): Promise<void> {
    let database = SiloDatabase.open({ ...this.workspace, databasePath }, true, true)
    const state = database.getSyncState()!
    const publicationId = randomUUID()
    const generation = randomUUID()
    const candidate = temporaryPath(this.workspace, 'publish')
    const verified = temporaryPath(this.workspace, 'verify')
    try {
      await database.backupCanonical(candidate, generation)
      const manifest: SyncManifest = {
        format_version: 1,
        database_id: state.database_id,
        identity: this.workspace.identity,
        generation,
        publication_id: publicationId,
        parent_generation: head?.manifest.generation ?? null,
        schema_revision: database.getSchema().revision,
        database_sha256: hashDatabase(candidate),
        created_at: new Date().toISOString(),
      }
      database.close()
      await this.services.checkpoint.publish(candidate, remote.generationUrl(generation))
      await this.services.checkpoint.restore(remote.generationUrl(generation), verified)
      if (hashDatabase(verified) !== manifest.database_sha256)
        throw new SiloError(
          exits.integrity,
          'sync_checkpoint_hash_mismatch',
          'The restored checkpoint does not match the published database.',
        )
      const verification = SiloDatabase.open(
        { ...this.workspace, databasePath: verified },
        false,
        true,
      )
      try {
        if (verification.getSchema().revision !== manifest.schema_revision)
          throw new SiloError(
            exits.integrity,
            'sync_checkpoint_schema_mismatch',
            'The published checkpoint schema does not match its manifest.',
          )
        const integrity = verification.query('PRAGMA integrity_check')
        if (integrity.rows.length !== 1 || integrity.rows[0]?.[0] !== 'ok')
          throw new SiloError(
            exits.integrity,
            'integrity_check_failed',
            'The published checkpoint failed SQLite integrity checking.',
          )
      } finally {
        verification.close()
      }

      let etag: string
      try {
        etag = await remote.publishHead(manifest, head?.etag ?? null)
      } catch (error) {
        if (!(error instanceof SiloError) || error.code !== 'sync_head_changed') throw error
        const current = await remote.readHead()
        if (!current || current.manifest.publication_id !== publicationId) throw error
        etag = current.etag
      }
      const updated = SiloDatabase.open({ ...this.workspace, databasePath }, true, true)
      try {
        updated.markSynchronized(generation, etag)
      } finally {
        updated.close()
      }
    } finally {
      try {
        database.close()
      } catch {}
      removeDatabase(candidate)
      removeDatabase(verified)
    }
  }

  private async restoreAndVerify(
    remote: SyncRemote,
    head: RemoteHead,
    outputPath: string,
  ): Promise<void> {
    await this.services.checkpoint.restore(
      remote.generationUrl(head.manifest.generation),
      outputPath,
    )
    if (hashDatabase(outputPath) !== head.manifest.database_sha256)
      throw new SiloError(
        exits.integrity,
        'sync_checkpoint_hash_mismatch',
        'The restored checkpoint does not match remote HEAD.',
      )
    const database = SiloDatabase.open({ ...this.workspace, databasePath: outputPath })
    try {
      const state = database.getSyncState()
      if (!state || state.database_id !== head.manifest.database_id)
        throw new SiloError(
          exits.integrity,
          'sync_checkpoint_identity_mismatch',
          'The restored checkpoint does not match remote HEAD.',
        )
      if (database.getSchema().revision !== head.manifest.schema_revision)
        throw new SiloError(
          exits.integrity,
          'sync_checkpoint_schema_mismatch',
          'The restored checkpoint schema does not match remote HEAD.',
        )
      const integrity = database.query('PRAGMA integrity_check')
      if (integrity.rows.length !== 1 || integrity.rows[0]?.[0] !== 'ok')
        throw new SiloError(
          exits.integrity,
          'integrity_check_failed',
          'The restored checkpoint failed SQLite integrity checking.',
        )
    } finally {
      database.close()
    }
  }
}
