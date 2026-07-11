import type { SiloError } from './model.js'

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export function table(headers: string[], rows: unknown[][]): string {
  const lines = [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`)
  return lines.join('\n')
}

export function errorMarkdown(error: SiloError): string {
  return table(
    ['Path', 'Code', 'Message'],
    [[error.path || '`$`', `\`${error.code}\``, error.message]],
  )
}

export function heading(title: string, body: string): string {
  return `# ${title}\n\n${body}\n`
}
