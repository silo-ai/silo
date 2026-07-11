import { isIP } from 'node:net'
import { exits, SiloError, type ColumnDefinition, type SQLiteStorage } from './model.js'

export interface SemanticType {
  storage: SQLiteStorage
  canonicalize(value: unknown, column: ColumnDefinition): unknown
  check?(quotedColumn: string, column: ColumnDefinition): string
  render?(value: unknown): unknown
}

function fail(column: ColumnDefinition, message: string): never {
  throw new SiloError(exits.schema, 'invalid_semantic_value', message, column.name)
}

const text = (
  validate?: (value: string, column: ColumnDefinition) => boolean,
  normalize?: (value: string, column: ColumnDefinition) => string,
  check?: (quotedColumn: string) => string,
): SemanticType => ({
  storage: 'TEXT',
  canonicalize(value, column) {
    if (typeof value !== 'string') fail(column, `${column.type} requires a JSON string.`)
    if (validate && !validate(value, column)) fail(column, `Value is not valid for ${column.type}.`)
    return normalize ? normalize(value, column) : value
  },
  check: check ? (quotedColumn) => check(quotedColumn) : undefined,
})

const integer = (
  validate?: (value: number) => boolean,
  check?: (q: string) => string,
  render?: (value: unknown) => unknown,
): SemanticType => ({
  storage: 'INTEGER',
  canonicalize(value, column) {
    if (typeof value === 'boolean' && column.type === 'integer/boolean') return value ? 1 : 0
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || (validate && !validate(value)))
      fail(column, `Value is not valid for ${column.type}.`)
    return value
  },
  check: check ? (q) => check(q) : undefined,
  render(value) {
    return render ? render(value) : value
  },
})

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const date = /^\d{4}-\d{2}-\d{2}$/
const time = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const hostname =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function decimal(value: string, column: ColumnDefinition): string {
  const precision = column.type_options?.precision
  const scale = column.type_options?.scale
  if (
    !Number.isInteger(precision) ||
    !Number.isInteger(scale) ||
    (precision as number) <= 0 ||
    (scale as number) < 0 ||
    (scale as number) > (precision as number)
  ) {
    fail(
      column,
      'text/decimal requires integer precision and scale options with 0 <= scale <= precision.',
    )
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match || (match[3]?.length ?? 0) > (scale as number))
    fail(column, 'Decimal value exceeds its configured scale or uses an unsupported form.')
  const digits = match[2]!.replace(/^0+(?=\d)/, '')
  if (digits.length + (scale as number) > (precision as number))
    fail(column, 'Decimal value exceeds its configured precision.')
  return `${match[1] === '+' ? '' : match[1]}${digits}.${(match[3] ?? '').padEnd(scale as number, '0')}`.replace(
    /\.$/,
    '',
  )
}

export const semanticTypes: Record<string, SemanticType> = {
  text: text(),
  integer: integer(),
  real: {
    storage: 'REAL',
    canonicalize(value, column) {
      if (typeof value !== 'number' || !Number.isFinite(value))
        fail(column, 'real requires a finite JSON number.')
      return value
    },
  },
  blob: {
    storage: 'BLOB',
    canonicalize(value, column) {
      if (typeof value !== 'string') fail(column, 'blob requires a base64 JSON string.')
      return Uint8Array.from(Buffer.from(value, 'base64'))
    },
  },
  any: {
    storage: 'ANY',
    canonicalize(value, column) {
      if (typeof value === 'boolean') return value ? 1 : 0
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return value
      fail(column, 'any accepts only JSON strings, finite numbers, booleans, or null.')
    },
  },
  'text/uuid': text(
    (v) => uuid.test(v),
    (v) => v.toLowerCase(),
    (q) =>
      `length(${q}) = 36 AND ${q} = lower(${q}) AND substr(${q}, 9, 1) = '-' AND substr(${q}, 14, 1) = '-' AND substr(${q}, 19, 1) = '-' AND substr(${q}, 24, 1) = '-' AND ${q} NOT GLOB '*[^0-9a-f-]*'`,
  ),
  'text/ulid': text(
    (v) => ulid.test(v),
    (v) => v.toUpperCase(),
    (q) => `length(${q}) = 26 AND ${q} = upper(${q}) AND ${q} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'`,
  ),
  'text/slug': text((v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)),
  'text/git-oid': text(
    (v, c) => new RegExp(`^[0-9a-f]{${c.type_options?.length ?? '40|64'}}$`, 'i').test(v),
    (v) => v.toLowerCase(),
  ),
  'text/date': text((v) => date.test(v) && calendarDate(v)),
  'text/time': text((v) => time.test(v)),
  'text/datetime': text(
    (v) => /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
    (v) => new Date(v).toISOString(),
    (q) => `${q} GLOB '????-??-??T*Z'`,
  ),
  'text/json': {
    storage: 'TEXT',
    canonicalize(value, column) {
      if (value === undefined || typeof value === 'bigint')
        fail(column, 'text/json requires a JSON object, array, string, number, or boolean.')
      try {
        const json = JSON.stringify(value)
        if (json === undefined)
          fail(column, 'text/json requires a JSON object, array, string, number, or boolean.')
        return json
      } catch {
        fail(column, 'Value cannot be represented as JSON.')
      }
    },
  },
  'text/markdown': text(),
  'text/html': text(),
  'text/url': text((v) => {
    try {
      const u = new URL(v)
      return Boolean(u.protocol && u.hostname)
    } catch {
      return false
    }
  }),
  'text/uri': text((v) => /^[a-z][a-z0-9+.-]*:/i.test(v)),
  'text/email': text((v) => email.test(v)),
  'text/ip': text((v) => isIP(v) !== 0),
  'text/cidr': text((v) => {
    const [ip, bits] = v.split('/')
    const family = isIP(ip ?? '')
    return family !== 0 && /^\d+$/.test(bits ?? '') && Number(bits) <= (family === 4 ? 32 : 128)
  }),
  'text/hostname': text(
    (v) => hostname.test(v),
    (v) => v.toLowerCase(),
  ),
  'text/path': text((v) => !v.includes('\0')),
  'text/path-posix': text((v) => !v.includes('\0') && !v.includes('\\')),
  'text/path-relative': text((v) => !v.startsWith('/') && !v.split('/').includes('..')),
  'text/git-ref': text((v) => !/\.\.|[~^:?*[\\\s]|(?:^|\/)\.|\.lock$|\/$/.test(v)),
  'text/semver': text((v) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v),
  ),
  'text/base64': text((v) =>
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v),
  ),
  'text/hex': text(
    (v) => /^(?:[0-9a-f]{2})*$/i.test(v),
    (v) => v.toLowerCase(),
  ),
  'text/sha256': text(
    (v) => /^[0-9a-f]{64}$/i.test(v),
    (v) => v.toLowerCase(),
  ),
  'text/sha512': text(
    (v) => /^[0-9a-f]{128}$/i.test(v),
    (v) => v.toLowerCase(),
  ),
  'text/decimal': text(undefined, decimal),
  'text/enum': text(
    (v, c) =>
      Array.isArray(c.type_options?.values) && (c.type_options.values as unknown[]).includes(v),
  ),
  'integer/boolean': integer(
    (v) => v === 0 || v === 1,
    (q) => `${q} IN (0, 1)`,
    (value) => Boolean(value),
  ),
  'integer/positive': integer(
    (v) => v > 0,
    (q) => `${q} > 0`,
  ),
  'integer/nonnegative': integer(
    (v) => v >= 0,
    (q) => `${q} >= 0`,
  ),
  'integer/port': integer(
    (v) => v >= 0 && v <= 65535,
    (q) => `${q} BETWEEN 0 AND 65535`,
  ),
  'integer/unix-seconds': integer(),
  'integer/unix-milliseconds': integer(),
  'integer/duration-ms': integer(
    (v) => v >= 0,
    (q) => `${q} >= 0`,
  ),
  'integer/money-minor': integer(),
  'real/percentage': {
    storage: 'REAL',
    canonicalize(value, column) {
      if (typeof value !== 'number' || value < 0 || value > 1)
        fail(column, 'real/percentage requires a number from 0 through 1.')
      return value
    },
    check: (q) => `${q} BETWEEN 0 AND 1`,
  },
  'blob/bytes': {
    storage: 'BLOB',
    canonicalize(value, column) {
      if (typeof value !== 'string') fail(column, 'blob/bytes requires base64 input.')
      return Uint8Array.from(Buffer.from(value, 'base64'))
    },
  },
}

export function semantic(column: ColumnDefinition): SemanticType {
  const found = semanticTypes[column.type]
  if (!found)
    throw new SiloError(
      exits.schema,
      'unknown_semantic_type',
      `${column.type} is not registered.`,
      `columns.${column.name}.type`,
    )
  return found
}

export function canonicalize(column: ColumnDefinition, value: unknown): unknown {
  if (value === null) {
    if (column.nullable === false) fail(column, 'Column is not nullable.')
    return null
  }
  return semantic(column).canonicalize(value, column)
}
