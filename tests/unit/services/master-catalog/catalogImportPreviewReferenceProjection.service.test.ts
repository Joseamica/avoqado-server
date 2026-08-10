import { createHash } from 'node:crypto'
import { projectCatalogImportPreviewRowV1 } from '@/services/master-catalog/catalogImportPreviewProjection.service'
import { catalogImportProposalMarkerV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'

function referenceProof(name: string, referenceType: 'BRAND' | 'FAMILY', parentId: string | null = null) {
  const marker = catalogImportProposalMarkerV1({ operation: 'CREATE', referenceType, name, parentId } as never)
  const suffix = referenceType === 'FAMILY' ? `:PARENT:${parentId ?? 'ROOT'}` : ''
  const base = suffix ? marker.slice(0, -suffix.length) : marker
  const rootPrefix = '@proposal:FAMILY:'
  const rootSuffix = ':PARENT:ROOT'
  const proofParentName =
    parentId?.startsWith(rootPrefix) && parentId.endsWith(rootSuffix) ? parentId.slice(rootPrefix.length, -rootSuffix.length) : null
  return {
    proofName: name,
    proofParentId: parentId,
    proofParentName,
    proofMarkerBaseHash: createHash('sha256').update(base, 'utf8').digest('hex'),
    proofParentBindingValid: true,
  }
}

function invalidReferenceProof(name: string) {
  // WHY: Overflow REDs carry the exact marker-base digest so they fail only on
  // the indexed/raw envelope, never accidentally because of a proof mismatch.
  const normalizedName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase()
  return {
    proofName: name,
    proofParentId: null,
    proofParentName: null,
    proofMarkerBaseHash: createHash('sha256').update(`@proposal:BRAND:${normalizedName}`, 'utf8').digest('hex'),
    proofParentBindingValid: true,
  }
}

describe('catalogImport preview reference proof projection', () => {
  function row(proof: Record<string, unknown>, referenceType: 'BRAND' | 'FAMILY' = 'BRAND') {
    return {
      sourceSheet: 'Items',
      sourceRow: 20,
      ordinal: 1,
      durableShapeValid: true,
      status: 'READY',
      operation: 'CREATE',
      referenceType,
      ...proof,
    }
  }

  it('accepts the exact 256-scalar normalized-key boundary without exposing its durable proof', () => {
    const name = 'N'.repeat(256)
    const result = projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', {
      ...row(referenceProof(name, 'BRAND')),
    })

    expect(result.name).toBe(name)
    expect(result.truncatedFields).toEqual([])
    expect(result).not.toHaveProperty('proofName')
    expect(result).not.toHaveProperty('proofMarkerBaseHash')
    expect(result).not.toHaveProperty('proofParentId')
  })

  it('accepts a 4096-character raw display whose normalized key stays short', () => {
    const name = `A${' '.repeat(4_094)}B`
    const result = projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', row(referenceProof(name, 'BRAND')))

    expect(name).toHaveLength(4_096)
    expect(result.name).toBe('A B')
    expect(result.truncatedFields).toEqual(['name'])
  })

  it('returns the canonical identity when a long raw display is significant only in its middle', () => {
    const name = `${' '.repeat(2_047)}Marca${' '.repeat(2_044)}`
    const result = projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', row(referenceProof(name, 'BRAND')))

    expect(Array.from(name)).toHaveLength(4_096)
    expect(result.name).toBe('MARCA')
    expect(result.truncatedFields).toEqual(['name'])
  })

  it('accepts exactly 1024 UTF-8 bytes in the normalized key', () => {
    const name = '😀'.repeat(256)
    const result = projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', row(referenceProof(name, 'BRAND')))

    expect(Buffer.byteLength(result.name as string, 'utf8')).toBe(1_024)
    expect(Array.from(result.name as string)).toHaveLength(256)
  })

  it('accepts 4096 raw Unicode scalars whose normalized key remains at its byte boundary', () => {
    const name = `${'\u3000'.repeat(3_840)}${'😀'.repeat(256)}`
    const result = projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', row(referenceProof(name, 'BRAND')))

    expect(Array.from(name)).toHaveLength(4_096)
    expect((result.name as string).trim()).toContain('😀')
  })

  it.each([
    ['257 normalized scalars', 'N'.repeat(257)],
    ['more than 1024 normalized UTF-8 bytes', `${'😀'.repeat(256)}A`],
    ['a 4096-character raw display whose normalized key overflows', 'N'.repeat(4_096)],
    ['the 4096-character raw display envelope', `A${' '.repeat(4_095)}B`],
  ])('rejects %s', (_label, name) => {
    expect(() => projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', row(invalidReferenceProof(name)))).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }),
    )
  })

  it('keeps a FAMILY proposal readable with the longest valid root marker while exposing only its excerpt', () => {
    const parentId = catalogImportProposalMarkerV1({
      operation: 'CREATE',
      referenceType: 'FAMILY',
      name: 'P'.repeat(256),
      parentId: null,
    } as never)
    const result = projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', {
      ...row(referenceProof('Hija', 'FAMILY', parentId), 'FAMILY'),
      sourceRow: 21,
      ordinal: 2,
    })

    expect(Array.from(result.parentId as string)).toHaveLength(256)
    expect(result.parentId).toMatch(/^@proposal:FAMILY:/u)
    expect(result.parentId).toMatch(/ROOT$/u)
    expect(result.truncatedFields).toEqual(['parentId'])
  })

  it('rejects malformed and syntactically valid but nonexistent FAMILY marker parents', () => {
    const validRoot = catalogImportProposalMarkerV1({
      operation: 'CREATE',
      referenceType: 'FAMILY',
      name: 'Root',
      parentId: null,
    } as never)
    const malformed = row(referenceProof('Child', 'FAMILY', '@proposal:evil'), 'FAMILY')
    const nonexistent = {
      ...row(referenceProof('Child', 'FAMILY', validRoot), 'FAMILY'),
      proofParentBindingValid: false,
    }

    for (const candidate of [malformed, nonexistent]) {
      expect(() => projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', candidate)).toThrow(
        expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }),
      )
    }
  })
})
