import { posix } from 'node:path'
import AdmZip from 'adm-zip'
import type { MasterCatalogWorkbookLimits } from './masterCatalogXlsx.worker'
import { CatalogWorkbookParseError, decodeXmlPart, failWorkbook, scanXml, type XmlElement, xmlAttribute } from './masterCatalogXmlSafety'

type Relationship = { id: string; kind: string; targetPath: string }

const RELATIONSHIPS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml'
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const OFFICE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export type PreflightedOoxmlPackage = {
  zip: AdmZip
  workbookPath: string
  sharedStringsPath: string | null
  sheets: Array<{ name: string; path: string }>
}

const ALLOWED_CONTENT_TYPES = new Set([
  'application/xml',
  RELATIONSHIPS_CONTENT_TYPE,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  'application/vnd.openxmlformats-officedocument.theme+xml',
  'application/vnd.openxmlformats-package.core-properties+xml',
  'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  'application/vnd.openxmlformats-officedocument.custom-properties+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
])

const RELATIONSHIP_KINDS = new Map([
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'officeDocument'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'worksheet'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings', 'sharedStrings'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'styles'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', 'theme'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'extendedProperties'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties', 'customProperties'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata', 'sheetMetadata'],
  ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'coreProperties'],
])

const EXPECTED_CONTENT_TYPE = new Map([
  ['officeDocument', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  ['worksheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
  ['sharedStrings', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
  ['styles', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
  ['theme', 'application/vnd.openxmlformats-officedocument.theme+xml'],
  ['extendedProperties', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ['customProperties', 'application/vnd.openxmlformats-officedocument.custom-properties+xml'],
  ['sheetMetadata', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml'],
  ['coreProperties', 'application/vnd.openxmlformats-package.core-properties+xml'],
])

const EXPECTED_XML_ROOT = new Map<string, readonly [string, string]>([
  [RELATIONSHIPS_CONTENT_TYPE, ['Relationships', PACKAGE_RELATIONSHIPS_NAMESPACE]],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', ['workbook', SPREADSHEET_NAMESPACE]],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml', ['worksheet', SPREADSHEET_NAMESPACE]],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml', ['sst', SPREADSHEET_NAMESPACE]],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml', ['styleSheet', SPREADSHEET_NAMESPACE]],
  ['application/vnd.openxmlformats-officedocument.theme+xml', ['theme', 'http://schemas.openxmlformats.org/drawingml/2006/main']],
  [
    'application/vnd.openxmlformats-package.core-properties+xml',
    ['coreProperties', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'],
  ],
  [
    'application/vnd.openxmlformats-officedocument.extended-properties+xml',
    ['Properties', 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'],
  ],
  [
    'application/vnd.openxmlformats-officedocument.custom-properties+xml',
    ['Properties', 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'],
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml', ['metadata', SPREADSHEET_NAMESPACE]],
])

function isElement(
  element: XmlElement,
  localName: string,
  namespaceUri: string,
  depth: number,
  parentLocalName: string | null = null,
): boolean {
  return (
    element.localName === localName &&
    element.namespaceUri === namespaceUri &&
    element.depth === depth &&
    element.parentLocalName === parentLocalName &&
    (depth === 0 || element.parentNamespaceUri === namespaceUri)
  )
}

function assertFormattingWhitespace(rawText: string): void {
  for (let index = 0; index < rawText.length; index += 1) {
    const code = rawText.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
    }
  }
}

function validateKnownXmlRoot(xml: string, contentType: string): void {
  const expected = EXPECTED_XML_ROOT.get(contentType)
  // WHY: `application/xml` is only a permissible orphan Default declaration.
  // An actual part needs a semantic content type with a known root/grammar;
  // otherwise an attacker could hide arbitrary or malformed XML beside data.
  if (!expected) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  let sawRoot = false
  scanXml(xml, {
    start(element) {
      if (element.depth !== 0) return
      if (sawRoot || !isElement(element, expected[0], expected[1], 0)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      sawRoot = true
    },
  })
  if (!sawRoot) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
}

function semanticFailure(value: string): never {
  const folded = value.toLowerCase()
  if (folded.includes('macro') || folded.includes('vba')) failWorkbook('CATALOG_WORKBOOK_MACRO_FORBIDDEN')
  if (folded.includes('external')) failWorkbook('CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN')
  if (folded.includes('encrypt')) failWorkbook('CATALOG_WORKBOOK_ENCRYPTED')
  if (folded.includes('ole') || folded.includes('activex') || folded.includes('control') || folded.includes('vml')) {
    failWorkbook('CATALOG_WORKBOOK_ACTIVE_CONTENT_FORBIDDEN')
  }
  return failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
}

function rejectKnownForbiddenPath(path: string): void {
  const folded = path.toLowerCase()
  if (folded.includes('vbaproject') || folded.includes('/macrosheets/')) failWorkbook('CATALOG_WORKBOOK_MACRO_FORBIDDEN')
  if (folded.includes('/externallinks/')) failWorkbook('CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN')
  if (folded.includes('/activex/') || folded.includes('/ctrlprops/') || folded.includes('/controls/') || folded.includes('/embeddings/')) {
    failWorkbook('CATALOG_WORKBOOK_ACTIVE_CONTENT_FORBIDDEN')
  }
}

function normalizePartName(raw: string, allowRooted: boolean): string {
  const slashName = raw.replace(/\\/gu, '/')
  if (slashName.includes('\u0000') || (!allowRooted && slashName.startsWith('/'))) failWorkbook('CATALOG_WORKBOOK_ZIP_INVALID')
  const unrooted = allowRooted && slashName.startsWith('/') ? slashName.slice(1) : slashName
  let normalized = posix.normalize(unrooted)
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    failWorkbook('CATALOG_WORKBOOK_ZIP_INVALID')
  }
  return normalized
}

function relationshipTargetPath(relationshipPart: string, target: string): string {
  if (target.includes(':') || target.startsWith('//')) failWorkbook('CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN')
  if (target.startsWith('/')) return normalizePartName(target, true)
  const parentDirectory = posix.dirname(posix.dirname(relationshipPart))
  const ownerName = posix.basename(relationshipPart).slice(0, -'.rels'.length)
  const ownerPath = relationshipPart === '_rels/.rels' ? '' : posix.join(parentDirectory, ownerName)
  return normalizePartName(posix.join(posix.dirname(ownerPath), target), false)
}

function workbookRelationshipsPath(workbookPath: string): string {
  return posix.join(posix.dirname(workbookPath), '_rels', `${posix.basename(workbookPath)}.rels`)
}

export function readXmlPart(zip: AdmZip, path: string): string {
  const entry = zip.getEntry(path)
  if (!entry) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  try {
    return decodeXmlPart(entry.getData())
  } catch (error) {
    if (error instanceof CatalogWorkbookParseError) throw error
    return failWorkbook('CATALOG_WORKBOOK_ZIP_INVALID')
  }
}

function parseContentTypes(zip: AdmZip, entryNames: Set<string>): Map<string, string> {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  let sawRoot = false
  scanXml(readXmlPart(zip, '[Content_Types].xml'), {
    start(element) {
      if (element.depth === 0) {
        if (sawRoot || !isElement(element, 'Types', CONTENT_TYPES_NAMESPACE, 0)) {
          failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        }
        sawRoot = true
        return
      }
      if (
        element.depth !== 1 ||
        element.parentLocalName !== 'Types' ||
        element.parentNamespaceUri !== CONTENT_TYPES_NAMESPACE ||
        element.namespaceUri !== CONTENT_TYPES_NAMESPACE
      ) {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
      if (element.localName === 'Default') {
        const extension = xmlAttribute(element, 'Extension', null)?.toLowerCase()
        const contentType = xmlAttribute(element, 'ContentType', null)
        if (!extension || !contentType || defaults.has(extension)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        defaults.set(extension, contentType)
      } else if (element.localName === 'Override') {
        const partName = xmlAttribute(element, 'PartName', null)
        const contentType = xmlAttribute(element, 'ContentType', null)
        if (!partName || !contentType) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        const normalized = normalizePartName(partName, true)
        if (overrides.has(normalized)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        overrides.set(normalized, contentType)
      } else {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
    },
    text: assertFormattingWhitespace,
  })
  if (!sawRoot) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  const resolved = new Map<string, string>()
  for (const name of entryNames) {
    if (name === '[Content_Types].xml') continue
    // WHY: POSIX treats the OPC root relationship part (`_rels/.rels`) as a
    // dotfile with no extension, while `[Content_Types].xml` resolves it via
    // the `rels` Default. Resolve that well-known suffix explicitly.
    const extension = name.toLowerCase().endsWith('.rels') ? 'rels' : posix.extname(name).slice(1).toLowerCase()
    const contentType = overrides.get(name) ?? defaults.get(extension)
    if (!contentType) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) semanticFailure(contentType)
    resolved.set(name, contentType)
  }
  return resolved
}

function parseRelationships(
  zip: AdmZip,
  relationshipPath: string,
  entryNames: Set<string>,
  contentTypes: Map<string, string>,
): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>()
  let sawRoot = false
  scanXml(readXmlPart(zip, relationshipPath), {
    start(element) {
      if (element.depth === 0) {
        if (sawRoot || !isElement(element, 'Relationships', PACKAGE_RELATIONSHIPS_NAMESPACE, 0)) {
          failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        }
        sawRoot = true
        return
      }
      if (!isElement(element, 'Relationship', PACKAGE_RELATIONSHIPS_NAMESPACE, 1, 'Relationships')) {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
      const id = xmlAttribute(element, 'Id', null)
      const type = xmlAttribute(element, 'Type', null)
      const target = xmlAttribute(element, 'Target', null)
      const targetMode = xmlAttribute(element, 'TargetMode', null)
      // WHY: Classify an external target before other relationship-shape
      // errors so even a deliberately incomplete external relationship is a
      // stable external-content rejection.
      if (targetMode !== null && targetMode.toLowerCase() !== 'internal') {
        failWorkbook('CATALOG_WORKBOOK_EXTERNAL_LINK_FORBIDDEN')
      }
      if (!id || !type || !target || relationships.has(id)) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      const kind = RELATIONSHIP_KINDS.get(type)
      if (!kind) semanticFailure(type)
      const targetPath = relationshipTargetPath(relationshipPath, target)
      if (!entryNames.has(targetPath) || contentTypes.get(targetPath) !== EXPECTED_CONTENT_TYPE.get(kind)) {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
      relationships.set(id, { id, kind, targetPath })
    },
    text: assertFormattingWhitespace,
  })
  if (!sawRoot) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  return relationships
}

function parseWorkbookSheets(xml: string, workbookRelationships: Map<string, Relationship>): Array<{ name: string; path: string }> {
  const sheets: Array<{ name: string; path: string }> = []
  let sawRoot = false
  let sawSheets = false
  let definedNameDepth = 0
  scanXml(xml, {
    start(element) {
      if (element.localName === 'f') failWorkbook('CATALOG_WORKBOOK_FORMULA_FORBIDDEN')
      if (element.localName === 'formula' || element.localName === 'formula1' || element.localName === 'formula2') {
        failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      }
      if (element.localName === 'definedName' && !element.selfClosing) definedNameDepth += 1
      if (element.depth === 0) {
        if (sawRoot || !isElement(element, 'workbook', SPREADSHEET_NAMESPACE, 0)) {
          failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        }
        sawRoot = true
        return
      }
      if (isElement(element, 'sheets', SPREADSHEET_NAMESPACE, 1, 'workbook')) {
        if (sawSheets) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
        sawSheets = true
        return
      }
      // WHY: Re-save tools add many non-semantic workbook subtrees. Only a
      // sheet at the exact workbook→sheets→sheet ancestry is authoritative.
      if (!isElement(element, 'sheet', SPREADSHEET_NAMESPACE, 2, 'sheets')) return
      const name = xmlAttribute(element, 'name', null)
      const relationId = xmlAttribute(element, 'id', OFFICE_RELATIONSHIPS_NAMESPACE)
      const relationship = relationId ? workbookRelationships.get(relationId) : undefined
      if (!name || !relationship || relationship.kind !== 'worksheet') failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
      sheets.push({ name, path: relationship.targetPath })
    },
    text(rawText) {
      if (definedNameDepth > 0) {
        // WHY: Empty definedNames emitted by openpyxl are benign, while a
        // definedName body is an executable workbook formula outside imports.
        assertFormattingWhitespace(rawText)
      }
    },
    end(_qualifiedName, name) {
      if (name === 'definedName' && definedNameDepth > 0) definedNameDepth -= 1
    },
  })
  if (!sawRoot || !sawSheets) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  return sheets
}

function inspectZip(buffer: Buffer, limits: MasterCatalogWorkbookLimits): { zip: AdmZip; entryNames: Set<string> } {
  if (buffer.length > limits.maxCompressedBytes) failWorkbook('CATALOG_WORKBOOK_COMPRESSED_LIMIT')
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    failWorkbook('CATALOG_WORKBOOK_MAGIC_INVALID')
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return failWorkbook('CATALOG_WORKBOOK_ZIP_INVALID')
  }
  const entries = zip.getEntries()
  if (entries.length > limits.maxZipEntries) failWorkbook('CATALOG_WORKBOOK_ZIP_ENTRY_LIMIT')
  const comparisonNames = new Set<string>()
  const entryNames = new Set<string>()
  let declaredExpanded = 0
  let compressed = 0
  for (const entry of entries) {
    const name = normalizePartName(entry.entryName, false)
    const comparison = name.normalize('NFC').toLowerCase()
    if (comparisonNames.has(comparison)) failWorkbook('CATALOG_WORKBOOK_ZIP_ENTRY_DUPLICATE')
    comparisonNames.add(comparison)
    rejectKnownForbiddenPath(name)
    if (!entry.isDirectory) entryNames.add(name)
    const encrypted = (entry.header as unknown as { encrypted?: boolean }).encrypted || (entry.header.flags & 1) === 1
    if (encrypted) failWorkbook('CATALOG_WORKBOOK_ENCRYPTED')
    if (entry.isDirectory) continue
    declaredExpanded += entry.header.size
    compressed += entry.header.compressedSize
    if (declaredExpanded > limits.maxExpandedBytes) failWorkbook('CATALOG_WORKBOOK_EXPANDED_LIMIT')
    if (entry.header.size / Math.max(entry.header.compressedSize, 1) > limits.maxCompressionRatio) {
      failWorkbook('CATALOG_WORKBOOK_COMPRESSION_RATIO_LIMIT')
    }
  }
  if (declaredExpanded / Math.max(compressed, 1) > limits.maxCompressionRatio) {
    failWorkbook('CATALOG_WORKBOOK_COMPRESSION_RATIO_LIMIT')
  }
  let actualExpanded = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    let data: Buffer
    try {
      data = entry.getData()
    } catch {
      return failWorkbook('CATALOG_WORKBOOK_ZIP_INVALID')
    }
    // WHY: Central-directory sizes are attacker-controlled hints; the bytes
    // actually returned by decompression are independently capped and matched.
    if (data.length !== entry.header.size) failWorkbook('CATALOG_WORKBOOK_ZIP_INVALID')
    actualExpanded += data.length
    if (actualExpanded > limits.maxExpandedBytes) failWorkbook('CATALOG_WORKBOOK_EXPANDED_LIMIT')
    if (data.length / Math.max(entry.header.compressedSize, 1) > limits.maxCompressionRatio) {
      failWorkbook('CATALOG_WORKBOOK_COMPRESSION_RATIO_LIMIT')
    }
    const name = normalizePartName(entry.entryName, false)
    const lowerName = name.toLowerCase()
    if (lowerName.endsWith('.xml') || lowerName.endsWith('.rels')) decodeXmlPart(data)
  }
  if (!entryNames.has('[Content_Types].xml') || !entryNames.has('_rels/.rels')) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  if ([...entryNames].some(name => name.toLowerCase() === 'encryptioninfo' || name.toLowerCase() === 'encryptedpackage')) {
    failWorkbook('CATALOG_WORKBOOK_ENCRYPTED')
  }
  return { zip, entryNames }
}

export function preflightOoxmlPackage(buffer: Buffer, limits: MasterCatalogWorkbookLimits): PreflightedOoxmlPackage {
  const { zip, entryNames } = inspectZip(buffer, limits)
  const contentTypes = parseContentTypes(zip, entryNames)
  // WHY: An OPC ContentType, not a filename suffix, determines whether a
  // renamed part is XML. Fatal decoding therefore covers every semantically
  // XML part before any optional/unconsumed part can be ignored.
  for (const [partName, contentType] of contentTypes) {
    if (contentType === 'application/xml' || contentType.endsWith('+xml')) {
      validateKnownXmlRoot(readXmlPart(zip, partName), contentType)
    }
  }
  const parsedRelationships = new Map<string, Map<string, Relationship>>()
  for (const relationshipPath of [...entryNames].filter(name => name.toLowerCase().endsWith('.rels'))) {
    if (contentTypes.get(relationshipPath) !== RELATIONSHIPS_CONTENT_TYPE) {
      failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
    }
    parsedRelationships.set(relationshipPath, parseRelationships(zip, relationshipPath, entryNames, contentTypes))
  }
  const rootRelationships = parsedRelationships.get('_rels/.rels')
  const officeDocuments = [...(rootRelationships?.values() ?? [])].filter(item => item.kind === 'officeDocument')
  if (officeDocuments.length !== 1) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  const workbookPath = officeDocuments[0]!.targetPath
  const workbookRels = parsedRelationships.get(workbookRelationshipsPath(workbookPath))
  if (!workbookRels) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  const sheets = parseWorkbookSheets(readXmlPart(zip, workbookPath), workbookRels)
  const sharedStrings = [...workbookRels.values()].filter(item => item.kind === 'sharedStrings')
  if (sharedStrings.length > 1) failWorkbook('CATALOG_WORKBOOK_OOXML_INVALID')
  return { zip, workbookPath, sharedStringsPath: sharedStrings[0]?.targetPath ?? null, sheets }
}
