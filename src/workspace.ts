import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { exits, SiloError } from './model.js'

/** Resolved Git identity and local database path used to open a Silo database. */
export interface Workspace {
  root: string
  identity: string
  /** Configured Git origin, or a `detached:<uuid>` marker before an origin exists. */
  origin: string
  databasePath: string
}

const detachedIdentityFile = join('silo', 'identity')
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeOrigin(origin: string): string {
  const value = origin.trim()
  // URL parsers resolve dot segments early, so reject encoded traversal before parsing.
  if (
    value
      .replace(/[?#].*$/, '')
      .split(/[/:]/)
      .some((segment) => {
        try {
          const decoded = decodeURIComponent(segment)
          return decoded === '.' || decoded === '..'
        } catch {
          return true
        }
      })
  )
    throw new SiloError(
      exits.workspace,
      'invalid_origin',
      'The origin remote contains an unsafe path segment.',
      'remote.origin.url',
    )
  let host: string
  let path: string

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value)
  if (scp && !value.includes('://')) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new SiloError(
        exits.workspace,
        'invalid_origin',
        'The origin remote is not a usable URL.',
        'remote.origin.url',
      )
    }
    host = url.hostname
    path = url.pathname
  }

  host = host.toLowerCase()
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const segments = path.split('/')
  if (!host || !path || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new SiloError(
      exits.workspace,
      'invalid_origin',
      'The origin remote has an unsafe or empty repository path.',
      'remote.origin.url',
    )
  }
  return `${host}/${segments.join('/')}`
}

export function dataRoot(): string {
  if (process.env.SILO_DATA_HOME) return join(process.env.SILO_DATA_HOME, 'silo')
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'silo')
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'silo')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'silo')
}

function git(cwd: string, args: string[], optional = false): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (error) {
    if (optional && (error as { status?: number }).status === 1) return undefined
    throw new SiloError(
      exits.workspace,
      'workspace_unresolved',
      'The current directory is not a usable Git worktree.',
    )
  }
}

function detachedIdentity(root: string): { identity: string; origin: string } {
  const commonDirectory = git(root, ['rev-parse', '--git-common-dir'])!
  const path = join(resolve(root, commonDirectory), detachedIdentityFile)

  try {
    mkdirSync(dirname(path), { recursive: true })
    if (!readDetachedIdentity(path)) {
      const uuid = randomUUID()
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, `${uuid}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        try {
          // A hard link installs the fully-written UUID without overwriting a concurrent winner.
          linkSync(temporary, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    const uuid = readDetachedIdentity(path)
    if (!uuid || !uuidPattern.test(uuid))
      throw new SiloError(
        exits.workspace,
        'invalid_detached_identity',
        'The detached Silo identity in Git metadata is not a valid UUID.',
      )
    return { identity: `detached/${uuid}`, origin: `detached:${uuid}` }
  } catch (error) {
    if (error instanceof SiloError) throw error
    throw new SiloError(
      exits.workspace,
      'detached_identity_unavailable',
      'Silo could not persist the detached workspace identity in Git metadata.',
    )
  }
}

function readDetachedIdentity(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Resolve a Git worktree to its Silo database.
 *
 * @param cwd Directory inside the Git worktree to resolve. Defaults to the current directory.
 * @returns The Git root, workspace identity, origin marker, and local database path.
 * @throws {SiloError} If `cwd` is not a Git worktree, its origin is invalid, or a detached
 * identity cannot be persisted in Git metadata.
 * @remarks A worktree without an `origin` uses a UUID stored under the repository's common Git
 * directory. Adding `origin` subsequently selects the normalized origin identity instead.
 */
export function resolveWorkspace(cwd = process.cwd()): Workspace {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])!
  const configuredOrigin = git(root, ['config', '--get', 'remote.origin.url'], true)
  const { identity, origin } = configuredOrigin
    ? { identity: normalizeOrigin(configuredOrigin), origin: configuredOrigin }
    : detachedIdentity(root)
  const parts = identity.split('/')
  const leaf = parts.pop()!
  return {
    root,
    origin,
    identity,
    databasePath: join(dataRoot(), 'databases', ...parts, `${leaf}.sqlite`),
  }
}
