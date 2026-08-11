import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { exits, SiloError } from './model.js'

/** Repository-local rule for selecting a detached or Git-remote workspace identity. */
export type WorkspaceSelection =
  | { kind: 'auto' }
  | { kind: 'detached' }
  | { kind: 'remote'; name: string }

interface LocalState {
  version: 1
  detached_id: string
  selection: WorkspaceSelection
}

interface WorkspaceMigrationSource {
  identity: string
  origin: string
  databasePath: string
}

const migrationSource = Symbol('workspaceMigrationSource')
type MigratingWorkspace = Workspace & { [migrationSource]?: WorkspaceMigrationSource }

/** Resolved Git identity and local database path used to open a Silo database. */
export interface Workspace {
  root: string
  identity: string
  /** Configured Git origin, or a `detached:<uuid>` marker before an origin exists. */
  origin: string
  databasePath: string
  /** Repository-local selection used to resolve this workspace. */
  selection?: WorkspaceSelection
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeOrigin(origin: string, field = 'remote.origin.url'): string {
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
      'The Git remote contains an unsafe path segment.',
      field,
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
        'The Git remote is not a usable URL.',
        field,
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
      'The Git remote has an unsafe or empty repository path.',
      field,
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

function localStatePath(root: string): string {
  const commonDirectory = git(root, ['rev-parse', '--git-common-dir'])!
  return join(resolve(root, commonDirectory), 'silo.json')
}

function parseLocalState(value: string): LocalState {
  try {
    const state = JSON.parse(value) as Partial<LocalState>
    const selection = state.selection as Partial<WorkspaceSelection> | undefined
    const stateKeys =
      state && typeof state === 'object' && !Array.isArray(state) ? Object.keys(state).sort() : []
    const selectionKeys =
      selection && typeof selection === 'object' && !Array.isArray(selection)
        ? Object.keys(selection).sort()
        : []
    const validSelection =
      ((selection?.kind === 'auto' || selection?.kind === 'detached') &&
        selectionKeys.join(',') === 'kind') ||
      (selection?.kind === 'remote' &&
        typeof selection.name === 'string' &&
        selection.name.length > 0 &&
        selectionKeys.join(',') === 'kind,name')
    if (
      stateKeys.join(',') !== 'detached_id,selection,version' ||
      state.version !== 1 ||
      !state.detached_id ||
      !uuidPattern.test(state.detached_id)
    )
      throw new Error('Expected version 1 and a valid detached UUID.')
    if (!validSelection) throw new Error('Expected an auto, detached, or named remote selection.')
    return state as LocalState
  } catch (error) {
    throw new SiloError(
      exits.workspace,
      'invalid_local_state',
      `The local .git/silo.json state is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function readLocalState(root: string): LocalState {
  const path = localStatePath(root)
  try {
    return parseLocalState(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SiloError) throw error
      throw new SiloError(
        exits.workspace,
        'local_state_unavailable',
        'Silo could not read local repository state from .git/silo.json.',
      )
    }
  }

  const state: LocalState = {
    version: 1,
    detached_id: randomUUID(),
    selection: { kind: 'auto' },
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    try {
      // A hard link installs fully-written initial state without overwriting a concurrent winner.
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } catch {
    throw new SiloError(
      exits.workspace,
      'local_state_unavailable',
      'Silo could not persist local repository state in .git/silo.json.',
    )
  } finally {
    rmSync(temporary, { force: true })
  }
  return parseLocalState(readFileSync(path, 'utf8'))
}

function writeLocalState(root: string, state: LocalState): void {
  const path = localStatePath(root)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch {
    throw new SiloError(
      exits.workspace,
      'local_state_unavailable',
      'Silo could not update local repository state in .git/silo.json.',
    )
  } finally {
    rmSync(temporary, { force: true })
  }
}

function workspaceForIdentity(
  root: string,
  identity: string,
  origin: string,
  selection: WorkspaceSelection,
): Workspace {
  const parts = identity.split('/')
  const leaf = parts.pop()!
  return {
    root,
    origin,
    identity,
    selection,
    databasePath: join(dataRoot(), 'databases', ...parts, `${leaf}.sqlite`),
  }
}

function detachedWorkspace(root: string, state: LocalState): Workspace {
  const uuid = state.detached_id
  return workspaceForIdentity(root, `detached/${uuid}`, `detached:${uuid}`, state.selection)
}

function remoteWorkspace(root: string, state: LocalState, name: string): Workspace {
  const remotes = (git(root, ['remote']) ?? '').split('\n').filter(Boolean)
  if (!remotes.includes(name))
    throw new SiloError(
      exits.workspace,
      'remote_not_found',
      `Git remote ${name} does not exist in this repository.`,
    )
  const origin = git(root, ['config', '--get', `remote.${name}.url`], true)
  if (!origin)
    throw new SiloError(
      exits.workspace,
      'invalid_origin',
      `Git remote ${name} does not have a usable URL.`,
      `remote.${name}.url`,
    )
  return workspaceForIdentity(
    root,
    normalizeOrigin(origin, `remote.${name}.url`),
    origin,
    state.selection,
  )
}

function resolveSelection(
  root: string,
  state: LocalState,
  selection: WorkspaceSelection,
): Workspace {
  if (selection.kind === 'detached') return detachedWorkspace(root, { ...state, selection })
  if (selection.kind === 'remote')
    return remoteWorkspace(root, { ...state, selection }, selection.name)

  const remotes = (git(root, ['remote']) ?? '').split('\n').filter(Boolean)
  if (!remotes.includes('origin')) return detachedWorkspace(root, state)
  const remote = remoteWorkspace(root, state, 'origin')
  const detached = detachedWorkspace(root, state)
  const remoteExists = existsSync(remote.databasePath)
  const detachedExists = existsSync(detached.databasePath)
  if (remoteExists && detachedExists)
    throw new SiloError(
      exits.workspace,
      'workspace_identity_conflict',
      'Both detached and origin databases exist. Use silo switch to select one explicitly.',
    )
  if (!remoteExists && detachedExists)
    Object.defineProperty(remote, migrationSource, {
      value: {
        identity: detached.identity,
        origin: detached.origin,
        databasePath: detached.databasePath,
      },
    })
  return remote
}

export function workspaceMigrationSource(
  workspace: Workspace,
): WorkspaceMigrationSource | undefined {
  return (workspace as MigratingWorkspace)[migrationSource]
}

/**
 * Resolve a Git worktree to its Silo database.
 *
 * @param cwd Directory inside the Git worktree to resolve. Defaults to the current directory.
 * @returns The Git root, workspace identity, origin marker, and local database path.
 * @throws {SiloError} If `cwd` is not a Git worktree, its selected remote is invalid, local state
 * is unavailable, or automatic selection finds conflicting databases.
 * @remarks Repository-local state is stored in `.git/silo.json` under the common Git directory.
 * Auto selection uses `origin` when present and otherwise uses the persisted detached UUID.
 */
export function resolveWorkspace(cwd = process.cwd()): Workspace {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])!
  const state = readLocalState(root)
  return resolveSelection(root, state, state.selection)
}

export function resolveWorkspaceSelection(
  selection: WorkspaceSelection,
  cwd = process.cwd(),
): Workspace {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])!
  return resolveSelection(root, readLocalState(root), selection)
}

export function setWorkspaceSelection(selection: WorkspaceSelection, cwd = process.cwd()): void {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])!
  const state = readLocalState(root)
  writeLocalState(root, { ...state, selection })
}
