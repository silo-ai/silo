import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SiloDatabase, emptySchema } from '../src/database.js'
import { exits, SiloError, type TableDefinition } from '../src/model.js'
import { parseTable } from '../src/schema.js'
import {
  SiloSync,
  S3SyncRemote,
  type CheckpointTransport,
  type RemoteHead,
  type SyncManifest,
  type SyncRemote,
  type SyncServices,
} from '../src/sync.js'
import type { Workspace } from '../src/workspace.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(name: string): Workspace {
  const root = mkdtempSync(join(tmpdir(), `silo-sync-${name}-`))
  roots.push(root)
  return {
    root,
    identity: 'github.com/acme/payments',
    origin: 'git@github.com:acme/payments.git',
    databasePath: join(root, 'payments.sqlite'),
  }
}

function issues(): TableDefinition {
  return parseTable({
    name: 'issues',
    comment: 'One synchronized issue.',
    columns: [
      { name: 'id', type: 'text/uuid', nullable: false, comment: 'Stable issue identifier.' },
      { name: 'title', type: 'text', nullable: false, comment: 'Issue title.' },
      {
        name: 'revision',
        type: 'integer/nonnegative',
        nullable: false,
        comment: 'Optimistic revision.',
      },
    ],
    primary_key: ['id'],
    policies: [
      { type: 'generated_identity', column: 'id', strategy: 'uuid' },
      { type: 'optimistic_revision', column: 'revision', initial: 1 },
    ],
  })
}

class MemoryRemote implements SyncRemote {
  readonly url = 's3://test-bucket/payments'
  head: RemoteHead | undefined
  private etag = 0

  async readHead(): Promise<RemoteHead | undefined> {
    return this.head ? structuredClone(this.head) : undefined
  }

  async publishHead(manifest: SyncManifest, expectedEtag: string | null): Promise<string> {
    if ((this.head?.etag ?? null) !== expectedEtag)
      throw new SiloError(
        exits.revision,
        'sync_head_changed',
        'Remote HEAD changed during publication; pull and retry.',
      )
    const etag = `"etag-${++this.etag}"`
    this.head = { manifest: structuredClone(manifest), etag }
    return etag
  }

  generationUrl(generation: string): string {
    return `memory://payments/${generation}`
  }
}

class MemoryCheckpoint implements CheckpointTransport {
  private readonly root: string
  private readonly replicas = new Map<string, string>()

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'silo-checkpoints-'))
    roots.push(this.root)
  }

  async check(): Promise<string> {
    return 'v0.5.12-test'
  }

  async publish(databasePath: string, replicaUrl: string): Promise<void> {
    const path = join(this.root, encodeURIComponent(replicaUrl))
    copyFileSync(databasePath, path)
    this.replicas.set(replicaUrl, path)
  }

  async restore(replicaUrl: string, outputPath: string): Promise<void> {
    const source = this.replicas.get(replicaUrl)
    if (!source)
      throw new SiloError(exits.absent, 'checkpoint_absent', 'Checkpoint does not exist.')
    mkdirSync(dirname(outputPath), { recursive: true })
    copyFileSync(source, outputPath)
  }
}

function services(): { services: SyncServices; remote: MemoryRemote } {
  const remote = new MemoryRemote()
  return {
    remote,
    services: { remote: () => remote, checkpoint: new MemoryCheckpoint() },
  }
}

describe('explicit synchronization', () => {
  test('uses conditional S3 writes for the versioned remote head', async () => {
    const manifest: SyncManifest = {
      format_version: 1,
      database_id: 'database-1',
      identity: 'github.com/acme/payments',
      generation: 'generation-1',
      publication_id: 'publication-1',
      parent_generation: null,
      schema_revision: 1,
      database_sha256: 'a'.repeat(64),
      created_at: '2026-07-11T12:00:00.000Z',
    }
    const commands: Array<GetObjectCommand | PutObjectCommand> = []
    const client = {
      async send(command: GetObjectCommand | PutObjectCommand) {
        commands.push(command)
        if (command instanceof GetObjectCommand)
          return {
            ETag: '"etag-1"',
            Body: { transformToString: async () => JSON.stringify(manifest) },
          }
        return { ETag: '"etag-2"' }
      },
    } as unknown as S3Client
    const remote = new S3SyncRemote('s3://test-bucket/team/payments', client)

    expect(await remote.readHead()).toEqual({ manifest, etag: '"etag-1"' })
    await expect(remote.publishHead(manifest, null)).resolves.toBe('"etag-2"')
    await expect(remote.publishHead(manifest, '"etag-1"')).resolves.toBe('"etag-2"')
    expect(commands[0]!.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'team/payments/HEAD',
    })
    expect(commands[1]!.input).toMatchObject({ IfNoneMatch: '*' })
    expect(commands[2]!.input).toMatchObject({ IfMatch: '"etag-1"' })
    expect(remote.generationUrl('generation-2')).toBe(
      's3://test-bucket/team/payments/generations/generation-2',
    )
  })

  test('bootstraps, publishes, and pulls immutable remote generations', async () => {
    const first = workspace('first')
    SiloDatabase.createWithSchema(first, { ...emptySchema(), tables: [issues()] }).close()
    const shared = services()
    const firstSync = new SiloSync(first, shared.services)

    expect((await firstSync.initialize(shared.remote.url)).state).toBe('ahead')
    const activeWriter = SiloDatabase.open(first, true)
    await expect(firstSync.push()).rejects.toMatchObject({ code: 'sync_in_progress' })
    activeWriter.close()
    expect((await firstSync.push()).state).toBe('clean')
    const firstGeneration = shared.remote.head!.manifest.generation
    expect((await firstSync.push()).state).toBe('clean')
    expect(shared.remote.head!.manifest.generation).toBe(firstGeneration)

    const second = workspace('second')
    const secondSync = new SiloSync(second, shared.services)
    expect(existsSync(second.databasePath)).toBe(false)
    expect((await secondSync.initialize(shared.remote.url)).state).toBe('clean')

    const writer = SiloDatabase.open(first, true)
    const [inserted] = writer.addRows('issues', { title: 'Shared issue' })
    writer.close()
    expect((await firstSync.push()).state).toBe('clean')
    expect(shared.remote.head!.manifest.parent_generation).toBe(firstGeneration)
    expect((await secondSync.status()).state).toBe('behind')
    expect((await secondSync.pull()).state).toBe('clean')

    const reader = SiloDatabase.open(second)
    expect(reader.getRow('issues', inserted!.id)).toMatchObject({ title: 'Shared issue' })
    reader.close()
  })

  test('rebases concurrent work and exposes same-row conflicts without overwriting local state', async () => {
    const first = workspace('first')
    SiloDatabase.createWithSchema(first, { ...emptySchema(), tables: [issues()] }).close()
    const shared = services()
    const firstSync = new SiloSync(first, shared.services)
    await firstSync.initialize(shared.remote.url)

    const seed = SiloDatabase.open(first, true)
    const [common] = seed.addRows('issues', { title: 'Common' })
    seed.close()
    await firstSync.push()

    const second = workspace('second')
    const secondSync = new SiloSync(second, shared.services)
    await secondSync.initialize(shared.remote.url)

    const firstWriter = SiloDatabase.open(first, true)
    firstWriter.addRows('issues', { title: 'Only first' })
    firstWriter.close()
    const secondWriter = SiloDatabase.open(second, true)
    secondWriter.addRows('issues', { title: 'Only second' })
    secondWriter.close()
    await firstSync.push()
    expect((await secondSync.push()).state).toBe('clean')
    await firstSync.pull()
    const converged = SiloDatabase.open(first)
    expect(
      converged
        .listRows('issues', 10, 0)
        .map((row) => row.title)
        .sort(),
    ).toEqual(['Common', 'Only first', 'Only second'])
    converged.close()

    const firstEdit = SiloDatabase.open(first, true)
    firstEdit.updateRow('issues', common!.id, { title: 'First wins race', _expected_revision: 1 })
    firstEdit.close()
    const secondEdit = SiloDatabase.open(second, true)
    secondEdit.updateRow('issues', common!.id, { title: 'Second local', _expected_revision: 1 })
    const conflictId = secondEdit.pendingTransactions().at(-1)!.transaction_id
    secondEdit.close()
    await firstSync.push()

    await expect(secondSync.pull()).rejects.toMatchObject({ code: 'sync_changeset_conflict' })
    expect((await secondSync.status()).state).toBe('conflicted')
    const unchanged = SiloDatabase.open(second)
    expect(unchanged.getRow('issues', common!.id)).toMatchObject({ title: 'Second local' })
    unchanged.close()

    expect((await secondSync.pull(conflictId)).state).toBe('clean')
    const resolved = SiloDatabase.open(second)
    expect(resolved.getRow('issues', common!.id)).toMatchObject({ title: 'First wins race' })
    resolved.close()
  })
})
