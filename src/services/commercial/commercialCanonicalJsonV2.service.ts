import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  COMMERCIAL_JSON_TEXT_V2_MAX_BYTES,
  COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH,
  COMMERCIAL_V2_DOMAIN_VALUES,
  CommercialV2Domain,
} from '@/contracts/commercial/commercialContractV2.constants'

export type { CommercialV2Domain } from '@/contracts/commercial/commercialContractV2.constants'

const JSON_PARSE = JSON.parse
const JSON_STRINGIFY = JSON.stringify

function invalidCanonicalJson(): never {
  throw new Error('COMMERCIAL_JCS_V2_INVALID')
}

function withStableCanonicalError<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    return invalidCanonicalJson()
  }
}

function invalidJsonText(): never {
  throw new Error('COMMERCIAL_JSON_TEXT_V2_INVALID')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1)
      if (!(following >= 0xdc00 && following <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function quoteJsonString(value: string): string {
  if (hasLoneSurrogate(value)) invalidCanonicalJson()
  return JSON_STRINGIFY(value)
}

function serializeArray(value: unknown[], active: WeakSet<object>): string {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key === 'symbol')) invalidCanonicalJson()
  for (const key of keys) {
    if (key === 'length') continue
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) invalidCanonicalJson()
  }

  const serialized: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalidCanonicalJson()
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidCanonicalJson()
    serialized.push(serializeCanonicalValue(descriptor.value, active))
  }
  return `[${serialized.join(',')}]`
}

function serializeObject(value: Record<string, unknown>, active: WeakSet<object>): string {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key === 'symbol') || ownKeys.includes('toJSON')) invalidCanonicalJson()

  const keys = ownKeys as string[]
  for (const key of keys) {
    if (hasLoneSurrogate(key)) invalidCanonicalJson()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidCanonicalJson()
  }

  return `{${keys
    .sort(compareUtf16)
    .map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor & { value: unknown }
      return `${quoteJsonString(key)}:${serializeCanonicalValue(descriptor.value, active)}`
    })
    .join(',')}}`
}

function serializeCanonicalValue(value: unknown, active: WeakSet<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return quoteJsonString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidCanonicalJson()
    return JSON_STRINGIFY(value)
  }
  if (typeof value !== 'object') invalidCanonicalJson()
  if (utilTypes.isProxy(value)) invalidCanonicalJson()
  if (!Array.isArray(value) && !isPlainObject(value)) invalidCanonicalJson()
  if (active.has(value)) invalidCanonicalJson()

  active.add(value)
  try {
    return Array.isArray(value) ? serializeArray(value, active) : serializeObject(value, active)
  } finally {
    active.delete(value)
  }
}

export function canonicalJsonV2(value: unknown): string {
  return withStableCanonicalError(() => serializeCanonicalValue(value, new WeakSet()))
}

export function canonicalJsonBytesV2(value: unknown): Buffer {
  return withStableCanonicalError(() => Buffer.from(canonicalJsonV2(value), 'utf8'))
}

export function hashCanonicalJsonV2(domain: CommercialV2Domain, value: unknown): string {
  return withStableCanonicalError(() => {
    if (!COMMERCIAL_V2_DOMAIN_VALUES.includes(domain)) invalidCanonicalJson()
    return createHash('sha256')
      .update(Buffer.concat([Buffer.from(domain, 'ascii'), canonicalJsonBytesV2(value)]))
      .digest('hex')
  })
}

class StrictJsonScanner {
  private index = 0

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.index !== this.text.length) invalidJsonText()
  }

  private scanValue(depth: number): void {
    if (depth > COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH) invalidJsonText()
    const current = this.text[this.index]
    if (current === '"') {
      this.scanString()
      return
    }
    if (current === '{') {
      this.scanObject(depth)
      return
    }
    if (current === '[') {
      this.scanArray(depth)
      return
    }
    if (current === 't') {
      this.scanLiteral('true')
      return
    }
    if (current === 'f') {
      this.scanLiteral('false')
      return
    }
    if (current === 'n') {
      this.scanLiteral('null')
      return
    }
    this.scanNumber()
  }

  private scanObject(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.consume('}')) return

    const keys = new Set<string>()
    while (true) {
      if (this.text[this.index] !== '"') invalidJsonText()
      const key = this.scanString()
      if (keys.has(key)) invalidJsonText()
      keys.add(key)

      this.skipWhitespace()
      if (!this.consume(':')) invalidJsonText()
      this.skipWhitespace()
      this.scanValue(depth + 1)
      this.skipWhitespace()
      if (this.consume('}')) return
      if (!this.consume(',')) invalidJsonText()
      this.skipWhitespace()
    }
  }

  private scanArray(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.consume(']')) return

    while (true) {
      this.scanValue(depth + 1)
      this.skipWhitespace()
      if (this.consume(']')) return
      if (!this.consume(',')) invalidJsonText()
      this.skipWhitespace()
    }
  }

  private scanString(): string {
    const start = this.index
    this.index += 1
    while (this.index < this.text.length) {
      const current = this.text.charCodeAt(this.index)
      if (current === 0x22) {
        this.index += 1
        let decoded: unknown
        try {
          decoded = JSON_PARSE(this.text.slice(start, this.index))
        } catch {
          invalidJsonText()
        }
        if (typeof decoded !== 'string' || hasLoneSurrogate(decoded)) invalidJsonText()
        return decoded
      }
      if (current <= 0x1f) invalidJsonText()
      if (current === 0x5c) {
        this.index += 1
        const escaped = this.text[this.index]
        if (escaped === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalidJsonText()
          this.index += 5
          continue
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalidJsonText()
      }
      this.index += 1
    }
    return invalidJsonText()
  }

  private scanNumber(): void {
    const start = this.index
    if (this.consume('-') && this.index >= this.text.length) invalidJsonText()

    if (this.consume('0')) {
      if (this.isDigit(this.text[this.index])) invalidJsonText()
    } else {
      if (!this.isNonZeroDigit(this.text[this.index])) invalidJsonText()
      while (this.isDigit(this.text[this.index])) this.index += 1
    }

    if (this.consume('.')) {
      if (!this.isDigit(this.text[this.index])) invalidJsonText()
      while (this.isDigit(this.text[this.index])) this.index += 1
    }

    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index += 1
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1
      if (!this.isDigit(this.text[this.index])) invalidJsonText()
      while (this.isDigit(this.text[this.index])) this.index += 1
    }

    if (this.index === start || !Number.isFinite(Number(this.text.slice(start, this.index)))) invalidJsonText()
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) invalidJsonText()
    this.index += literal.length
  }

  private skipWhitespace(): void {
    while (' \t\r\n'.includes(this.text[this.index] ?? '\0')) this.index += 1
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false
    this.index += 1
    return true
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9'
  }

  private isNonZeroDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '1' && value <= '9'
  }
}

export function parseJsonTextV2Strict(text: string): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > COMMERCIAL_JSON_TEXT_V2_MAX_BYTES) invalidJsonText()

  try {
    new StrictJsonScanner(text).scan()
    return JSON_PARSE(text)
  } catch {
    return invalidJsonText()
  }
}
