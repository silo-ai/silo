#!/usr/bin/env node
import { binary, runSafely } from 'cmd-ts'
import { app } from './cli.js'

const result = await runSafely(binary(app), process.argv)
if (result._tag === 'error') {
  const { message, into, exitCode } = result.error.config
  const stream = into === 'stdout' ? process.stdout : process.stderr
  stream.write(message.endsWith('\n') ? message : `${message}\n`)
  process.exitCode = exitCode === 1 ? 2 : exitCode
}
