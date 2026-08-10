export class CatalogWorkbookParseError extends Error {
  readonly statusCode = 400

  constructor(readonly code: string) {
    super('El archivo XLSX de catálogo no es válido.')
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function failWorkbook(code: string): never {
  // WHY: Stable classifications cross the worker boundary without echoing
  // attacker-controlled filenames, worksheet values, SKUs, or prices.
  throw new CatalogWorkbookParseError(code)
}

export type XmlAttribute = { qualifiedName: string; localName: string; namespaceUri: string | null; value: string }
export type XmlElement = {
  qualifiedName: string
  localName: string
  namespaceUri: string | null
  parentLocalName: string | null
  parentNamespaceUri: string | null
  depth: number
  attributes: XmlAttribute[]
  selfClosing: boolean
}

interface XmlVisitor {
  start?(element: XmlElement): void
  end?(qualifiedName: string, localName: string): void
  text?(rawText: string): void
}

const MAX_XML_DEPTH = 256
const MAX_XML_TAG_SOURCE_CHARACTERS = 64 * 1024
const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/'

type NamespaceScope = { parent: NamespaceScope | null; declarations: Map<string, string> }
type OpenXmlElement = {
  qualifiedName: string
  localName: string
  namespaceUri: string | null
  scope: NamespaceScope
}

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

function localName(qualifiedName: string): string {
  const separator = qualifiedName.lastIndexOf(':')
  return separator < 0 ? qualifiedName : qualifiedName.slice(separator + 1)
}

function qualifiedPrefix(qualifiedName: string): string | null {
  const separator = qualifiedName.indexOf(':')
  if (separator < 0) return null
  if (separator === 0 || separator === qualifiedName.length - 1 || separator !== qualifiedName.lastIndexOf(':')) {
    failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
  }
  return qualifiedName.slice(0, separator)
}

function resolveNamespace(scope: NamespaceScope, prefix: string): string | null {
  if (prefix === 'xml') return XML_NAMESPACE_URI
  for (let current: NamespaceScope | null = scope; current; current = current.parent) {
    const value = current.declarations.get(prefix)
    if (value !== undefined) return value || null
  }
  return null
}

function namespaceScope(parent: NamespaceScope | null, attributes: XmlAttribute[]): NamespaceScope {
  const declarations = new Map<string, string>()
  for (const attribute of attributes) {
    const prefix = qualifiedPrefix(attribute.qualifiedName)
    const declared = attribute.qualifiedName === 'xmlns' ? '' : prefix === 'xmlns' ? attribute.localName : null
    if (declared === null) continue
    if (
      declared === 'xmlns' ||
      attribute.value === XMLNS_NAMESPACE_URI ||
      (declared === 'xml' && attribute.value !== XML_NAMESPACE_URI) ||
      (declared !== '' && !attribute.value)
    ) {
      failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    }
    declarations.set(declared, attribute.value)
  }
  return { parent, declarations }
}

function resolveAttributes(attributes: XmlAttribute[], scope: NamespaceScope): XmlAttribute[] {
  const expandedNames = new Set<string>()
  return attributes.map(attribute => {
    const prefix = qualifiedPrefix(attribute.qualifiedName)
    let namespaceUri: string | null = null
    if (attribute.qualifiedName === 'xmlns' || prefix === 'xmlns') namespaceUri = XMLNS_NAMESPACE_URI
    else if (prefix !== null) {
      namespaceUri = resolveNamespace(scope, prefix)
      if (namespaceUri === null) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    }
    const expandedName = `${namespaceUri ?? ''}\u0000${attribute.localName}`
    if (expandedNames.has(expandedName)) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    expandedNames.add(expandedName)
    return { ...attribute, namespaceUri }
  })
}

function isNameStartCharacter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f
}

function isNameCharacter(code: number): boolean {
  return isNameStartCharacter(code) || (code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x2d || code === 0x2e
}

function isSafeQualifiedName(value: string): boolean {
  let atSegmentStart = true
  let sawColon = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x3a) {
      if (atSegmentStart || sawColon || index === value.length - 1) return false
      sawColon = true
      atSegmentStart = true
    } else {
      if (atSegmentStart ? !isNameStartCharacter(code) : !isNameCharacter(code)) return false
      atSegmentStart = false
    }
  }
  return value.length > 0 && !atSegmentStart
}

function isNonCharacter(codePoint: number): boolean {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) === 0xfffe || (codePoint & 0xffff) === 0xffff
}

function assertUnicode(value: string, allowXmlWhitespace: boolean, maxCharacters?: number): number {
  let characters = 0
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index)
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff) || isNonCharacter(codePoint)) {
      failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    }
    if (
      codePoint === 0x061c ||
      (codePoint >= 0x200e && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x206f)
    ) {
      failWorkbook('CATALOG_WORKBOOK_BIDI_FORBIDDEN')
    }
    if ((codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) && !(allowXmlWhitespace && isXmlSpace(codePoint))) {
      failWorkbook('CATALOG_WORKBOOK_CONTROL_CHARACTER_FORBIDDEN')
    }
    characters += 1
    if (maxCharacters !== undefined && characters > maxCharacters) failWorkbook('CATALOG_WORKBOOK_CELL_LIMIT')
    index += codePoint > 0xffff ? 2 : 1
  }
  return characters
}

function startsAsciiInsensitive(source: string, index: number, expected: string): boolean {
  if (index + expected.length > source.length) return false
  for (let offset = 0; offset < expected.length; offset += 1) {
    const actual = source.charCodeAt(index + offset)
    const folded = actual >= 0x41 && actual <= 0x5a ? actual + 0x20 : actual
    if (folded !== expected.charCodeAt(offset)) return false
  }
  return true
}

function containsForbiddenMarkup(xml: string): boolean {
  for (let index = 0; index < xml.length - 2; index += 1) {
    if (xml.charCodeAt(index) !== 0x3c || xml.charCodeAt(index + 1) !== 0x21) continue
    if (
      startsAsciiInsensitive(xml, index, '<!doctype') ||
      startsAsciiInsensitive(xml, index, '<!entity') ||
      startsAsciiInsensitive(xml, index, '<![cdata[')
    ) {
      return true
    }
  }
  return false
}

function assertSafeEntities(xml: string): void {
  let cursor = 0
  while (cursor < xml.length) {
    const entityStart = xml.indexOf('&', cursor)
    if (entityStart < 0) return
    const entityEnd = xml.indexOf(';', entityStart + 1)
    if (entityEnd < 0 || entityEnd - entityStart > 16) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    decodeEntity(xml.slice(entityStart + 1, entityEnd))
    cursor = entityEnd + 1
  }
}

export function assertSafeXmlValue(value: string, maxCharacters?: number): void {
  assertUnicode(value, false, maxCharacters)
}

export function decodeXmlPart(bytes: Buffer): string {
  if (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    failWorkbook('CATALOG_WORKBOOK_XML_ENCODING_INVALID')
  }
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return failWorkbook('CATALOG_WORKBOOK_XML_ENCODING_INVALID')
  }
  assertUnicode(xml, true)
  if (containsForbiddenMarkup(xml)) failWorkbook('CATALOG_WORKBOOK_XML_MARKUP_FORBIDDEN')
  // WHY: Numeric character references can encode forbidden controls,
  // surrogates, noncharacters, or bidi controls using only ASCII bytes. Scan
  // every XML OPC part, including safe-but-ignored metadata parts.
  assertSafeEntities(xml)
  if (startsAsciiInsensitive(xml, 0, '<?xml')) {
    const end = xml.indexOf('?>', 5)
    if (end < 0 || end > 512) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    const encoding = parseAttributes(xml.slice(5, end)).find(item => item.localName === 'encoding')?.value
    if (encoding !== undefined && encoding.toLowerCase() !== 'utf-8') {
      failWorkbook('CATALOG_WORKBOOK_XML_ENCODING_INVALID')
    }
  }
  return xml
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  if (Object.prototype.hasOwnProperty.call(named, entity)) return named[entity]!
  if (entity.charCodeAt(0) !== 0x23) return failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
  const hexadecimal = entity.charCodeAt(1) === 0x78 || entity.charCodeAt(1) === 0x58
  const start = hexadecimal ? 2 : 1
  if (start >= entity.length) return failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
  let value = 0
  for (let index = start; index < entity.length; index += 1) {
    const code = entity.charCodeAt(index)
    let digit = code >= 0x30 && code <= 0x39 ? code - 0x30 : -1
    if (hexadecimal && code >= 0x41 && code <= 0x46) digit = code - 0x41 + 10
    if (hexadecimal && code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10
    if (digit < 0) return failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    value = value * (hexadecimal ? 16 : 10) + digit
    if (value > 0x10ffff) return failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
  }
  if (value >= 0xd800 && value <= 0xdfff) return failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
  const decoded = String.fromCodePoint(value)
  assertUnicode(decoded, false)
  return decoded
}

export function decodeXmlText(raw: string, maxCharacters?: number): string {
  const parts: string[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const entityStart = raw.indexOf('&', cursor)
    if (entityStart < 0) {
      parts.push(raw.slice(cursor))
      break
    }
    parts.push(raw.slice(cursor, entityStart))
    const entityEnd = raw.indexOf(';', entityStart + 1)
    if (entityEnd < 0 || entityEnd - entityStart > 16) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    parts.push(decodeEntity(raw.slice(entityStart + 1, entityEnd)))
    cursor = entityEnd + 1
  }
  const decoded = parts.join('')
  assertUnicode(decoded, false, maxCharacters)
  return decoded
}

function parseAttributes(raw: string): XmlAttribute[] {
  const attributes: XmlAttribute[] = []
  const names = new Set<string>()
  let cursor = 0
  while (cursor < raw.length) {
    while (cursor < raw.length && isXmlSpace(raw.charCodeAt(cursor))) cursor += 1
    if (cursor >= raw.length) break
    const start = cursor
    while (cursor < raw.length && isNameCharacter(raw.charCodeAt(cursor))) cursor += 1
    if (cursor === start || cursor - start > 256) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    const qualifiedName = raw.slice(start, cursor)
    if (!isSafeQualifiedName(qualifiedName)) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    while (cursor < raw.length && isXmlSpace(raw.charCodeAt(cursor))) cursor += 1
    if (raw.charCodeAt(cursor) !== 0x3d) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    cursor += 1
    while (cursor < raw.length && isXmlSpace(raw.charCodeAt(cursor))) cursor += 1
    const quote = raw.charCodeAt(cursor)
    if (quote !== 0x22 && quote !== 0x27) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    const valueStart = ++cursor
    while (cursor < raw.length && raw.charCodeAt(cursor) !== quote) {
      // WHY: XML 1.0 forbids a literal `<` inside AttValue. Letting it pass
      // would make our semantic scanner disagree with conforming XML parsers.
      if (raw.charCodeAt(cursor) === 0x3c) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      cursor += 1
    }
    if (cursor >= raw.length || names.has(qualifiedName)) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    names.add(qualifiedName)
    attributes.push({
      qualifiedName,
      localName: localName(qualifiedName),
      namespaceUri: null,
      value: decodeXmlText(raw.slice(valueStart, cursor)),
    })
    cursor += 1
  }
  return attributes
}

export function xmlAttribute(element: XmlElement, name: string, namespaceUri?: string | null): string | null {
  const matches = element.attributes.filter(
    item => item.localName === name && (namespaceUri === undefined || item.namespaceUri === namespaceUri),
  )
  if (matches.length > 1) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
  return matches[0]?.value ?? null
}

export function scanXml(xml: string, visitor: XmlVisitor): void {
  const stack: OpenXmlElement[] = []
  let cursor = 0
  let roots = 0
  const emitText = (rawText: string): void => {
    if (stack.length === 0) {
      for (let index = 0; index < rawText.length; index += 1) {
        if (!isXmlSpace(rawText.charCodeAt(index))) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      }
    }
    visitor.text?.(rawText)
  }
  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor)
    if (open < 0) {
      if (cursor < xml.length) emitText(xml.slice(cursor))
      cursor = xml.length
      break
    }
    if (open > cursor) emitText(xml.slice(cursor, open))
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4)
      if (end < 0 || xml.indexOf('--', open + 4) !== end) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      cursor = end + 3
      continue
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2)
      if (end < 0 || open !== 0 || !startsAsciiInsensitive(xml, open, '<?xml')) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      cursor = end + 2
      continue
    }
    if (xml.startsWith('<!', open)) failWorkbook('CATALOG_WORKBOOK_XML_MARKUP_FORBIDDEN')
    let end = open + 1
    let quote = 0
    for (; end < xml.length; end += 1) {
      const code = xml.charCodeAt(end)
      if (quote !== 0 && code === quote) quote = 0
      else if (quote === 0 && (code === 0x22 || code === 0x27)) quote = code
      else if (quote === 0 && code === 0x3e) break
    }
    if (end >= xml.length || quote !== 0 || end - open > MAX_XML_TAG_SOURCE_CHARACTERS) {
      failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    }
    let inside = xml.slice(open + 1, end)
    if (inside.startsWith('/')) {
      const endTag = inside.slice(1)
      let nameEnd = 0
      while (nameEnd < endTag.length && isNameCharacter(endTag.charCodeAt(nameEnd))) nameEnd += 1
      const qualifiedName = endTag.slice(0, nameEnd)
      if (!isSafeQualifiedName(qualifiedName)) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      while (nameEnd < endTag.length && isXmlSpace(endTag.charCodeAt(nameEnd))) nameEnd += 1
      // WHY: EndTag permits only XML `S` after Name. ECMAScript trim also
      // consumes NBSP and other characters XML 1.0 does not classify as `S`.
      if (nameEnd !== endTag.length) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      if (stack.pop()?.qualifiedName !== qualifiedName) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
      visitor.end?.(qualifiedName, localName(qualifiedName))
      cursor = end + 1
      continue
    }
    // WHY: EmptyElemTag requires `/>` with no whitespace between slash and
    // close. Looking only at the literal final source character preserves it.
    const selfClosing = inside.endsWith('/')
    if (selfClosing) inside = inside.slice(0, -1)
    let nameEnd = 0
    while (nameEnd < inside.length && isNameCharacter(inside.charCodeAt(nameEnd))) nameEnd += 1
    if (nameEnd === 0 || nameEnd > 256) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    const qualifiedName = inside.slice(0, nameEnd)
    if (!isSafeQualifiedName(qualifiedName)) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    const rawAttributes = parseAttributes(inside.slice(nameEnd))
    const parent = stack[stack.length - 1] ?? null
    const scope = namespaceScope(parent?.scope ?? null, rawAttributes)
    const prefix = qualifiedPrefix(qualifiedName)
    const namespaceUri = resolveNamespace(scope, prefix ?? '')
    if (prefix !== null && namespaceUri === null) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    const element = {
      qualifiedName,
      localName: localName(qualifiedName),
      namespaceUri,
      parentLocalName: parent?.localName ?? null,
      parentNamespaceUri: parent?.namespaceUri ?? null,
      depth: stack.length,
      attributes: resolveAttributes(rawAttributes, scope),
      selfClosing,
    }
    if (stack.length === 0 && ++roots > 1) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    visitor.start?.(element)
    if (!selfClosing) {
      stack.push({ qualifiedName, localName: element.localName, namespaceUri, scope })
      if (stack.length > MAX_XML_DEPTH) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
    }
    cursor = end + 1
  }
  if (stack.length !== 0 || roots !== 1) failWorkbook('CATALOG_WORKBOOK_XML_INVALID')
}
