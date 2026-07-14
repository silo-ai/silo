#!/usr/bin/env node
import { binary, runSafely } from 'cmd-ts'
import { app, createSavedQueryCommand, isDirectSavedQueryInvocation, writeCliError } from './cli.js'

try {
  // Management verbs are static, while every other name gets a parser generated from its
  // stored parameter contract so query-specific help and validation remain native cmd-ts behavior.
  const result = isDirectSavedQueryInvocation(process.argv)
    ? await runSafely(createSavedQueryCommand(process.argv[3]!), process.argv.slice(4))
    : await runSafely(binary(app), process.argv)
  if (result._tag === 'error') {
    const { message, into, exitCode } = result.error.config
    const stream = into === 'stdout' ? process.stdout : process.stderr
    stream.write(message.endsWith('\n') ? message : `${message}\n`)
    process.exitCode = exitCode === 1 ? 2 : exitCode
  }
} catch (error) {
  writeCliError(error)
}
