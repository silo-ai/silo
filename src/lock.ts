import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { exits, SiloError } from './model.js'

function ownerIsAlive(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireFileLock(path: string, message: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor: number
    try {
      descriptor = openSync(path, 'wx')
    } catch {
      if (attempt === 0 && !ownerIsAlive(path)) {
        rmSync(path, { force: true })
        continue
      }
      throw new SiloError(exits.io, 'sync_in_progress', message)
    }
    try {
      writeFileSync(descriptor, String(process.pid))
    } finally {
      closeSync(descriptor)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      rmSync(path, { force: true })
    }
  }
  throw new SiloError(exits.io, 'sync_in_progress', message)
}
