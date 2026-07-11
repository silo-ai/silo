import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exits, SiloError } from './model.js'

export interface Workspace {
  root: string
  identity: string
  origin: string
  databasePath: string
}

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

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new SiloError(
      exits.workspace,
      'workspace_unresolved',
      'The current directory is not a Git worktree with a usable origin remote.',
    )
  }
}

export function resolveWorkspace(cwd = process.cwd()): Workspace {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const origin = git(root, ['config', '--get', 'remote.origin.url'])
  const identity = normalizeOrigin(origin)
  const parts = identity.split('/')
  const leaf = parts.pop()!
  return {
    root,
    origin,
    identity,
    databasePath: join(dataRoot(), 'databases', ...parts, `${leaf}.sqlite`),
  }
}
