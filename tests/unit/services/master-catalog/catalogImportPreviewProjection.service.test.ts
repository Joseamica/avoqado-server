import { createHash } from 'node:crypto'
import {
  catalogImportPreviewPositionV1,
  decodeCatalogImportPreviewCursorV1,
  encodeCatalogImportPreviewCursorV1,
  normalizeCatalogImportPreviewPageSize,
  projectCatalogImportPreviewItemDetailV1,
  projectCatalogImportPreviewRowV1,
} from '@/services/master-catalog/catalogImportPreviewProjection.service'
import { catalogImportProposalMarkerV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'

const batchId = 'import-batch-1'
const targetHash = 'a'.repeat(64)
const signingKey = 'b'.repeat(64)

function referenceProof(name: string, referenceType: 'BRAND' | 'MANUFACTURER' | 'FAMILY', parentId: string | null = null) {
  const marker = catalogImportProposalMarkerV1({ operation: 'CREATE', referenceType, name, parentId } as never)
  const suffix = referenceType === 'FAMILY' ? `:PARENT:${parentId ?? 'ROOT'}` : ''
  const base = suffix ? marker.slice(0, -suffix.length) : marker
  return {
    proofName: name,
    proofParentId: parentId,
    proofParentName: null,
    proofMarkerBaseHash: createHash('sha256').update(base, 'utf8').digest('hex'),
    proofParentBindingValid: true,
  }
}

describe('catalogImportPreviewProjection.service', () => {
  it('freezes default/max page sizes and rejects amplification inputs', () => {
    expect(normalizeCatalogImportPreviewPageSize(undefined)).toBe(25)
    expect(normalizeCatalogImportPreviewPageSize(50)).toBe(50)
    for (const invalid of [0, 51, 1.5, Number.NaN, '25']) {
      expect(() => normalizeCatalogImportPreviewPageSize(invalid as number)).toThrow(
        expect.objectContaining({ code: 'CATALOG_IMPORT_PAGE_SIZE_INVALID' }),
      )
    }
  })

  it('signs a v1 cursor bound to batch, section, target hash, and stable position', () => {
    const cursor = encodeCatalogImportPreviewCursorV1(
      {
        schemaVersion: 1,
        batchId,
        section: 'ORGANIZATION_VALUES',
        targetHash,
        sourceSheet: 'OrganizationValues',
        sourceRow: 22,
        ordinal: 0,
      },
      signingKey,
    )

    expect(decodeCatalogImportPreviewCursorV1(cursor, { batchId, section: 'ORGANIZATION_VALUES', targetHash }, signingKey)).toEqual({
      sourceSheet: 'OrganizationValues',
      sourceRow: 22,
      ordinal: 0,
    })
  })

  it('fails closed for tampering, another section/batch/hash, or a malformed signing digest', () => {
    const cursor = encodeCatalogImportPreviewCursorV1(
      { schemaVersion: 1, batchId, section: 'ITEMS', targetHash, sourceSheet: 'Items', sourceRow: 2, ordinal: 0 },
      signingKey,
    )
    const [payload, signature] = cursor.split('.')
    const tampered = `${payload?.startsWith('a') ? 'b' : 'a'}${payload?.slice(1)}.${signature}`

    for (const operation of [
      () => decodeCatalogImportPreviewCursorV1(tampered, { batchId, section: 'ITEMS', targetHash }, signingKey),
      () => decodeCatalogImportPreviewCursorV1(cursor, { batchId: 'other', section: 'ITEMS', targetHash }, signingKey),
      () => decodeCatalogImportPreviewCursorV1(cursor, { batchId, section: 'ERRORS', targetHash }, signingKey),
      () => decodeCatalogImportPreviewCursorV1(cursor, { batchId, section: 'ITEMS', targetHash: 'c'.repeat(64) }, signingKey),
      () => decodeCatalogImportPreviewCursorV1(cursor, { batchId, section: 'ITEMS', targetHash }, 'not-a-digest'),
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_CURSOR_INVALID' }))
    }
  })

  it('projects a bounded flat item summary and never reflects raw JSON containers', () => {
    const result = projectCatalogImportPreviewRowV1('ITEMS', {
      sourceSheet: 'Items',
      sourceRow: 2,
      ordinal: 0,
      durableShapeValid: true,
      status: 'READY',
      operation: 'CREATE',
      catalogItemId: null,
      proofCorporateSku: `${' '.repeat(299)}S`,
      name: 'N'.repeat(300),
      itemKind: 'RETAIL_PRODUCT',
      organizationValueCount: 20_000,
      businessTypeCount: 20_000,
      referenceProposalCount: 4,
      venueBindingRequestCount: 20_000,
      errorCount: 0,
      payload: { secret: 'must-not-leak' },
    })

    expect(result).toEqual({
      section: 'ITEMS',
      sourceSheet: 'Items',
      sourceRow: 2,
      ordinal: 0,
      status: 'READY',
      operation: 'CREATE',
      catalogItemId: null,
      corporateSku: 'S',
      name: 'N'.repeat(256),
      itemKind: 'RETAIL_PRODUCT',
      organizationValueCount: 20_000,
      businessTypeCount: 20_000,
      referenceProposalCount: 4,
      venueBindingRequestCount: 20_000,
      errorCount: 0,
      truncatedFields: ['corporateSku', 'name'],
    })
    expect(result).not.toHaveProperty('payload')
  })

  it('truncates bounded excerpts on Unicode code-point boundaries', () => {
    const result = projectCatalogImportPreviewRowV1('ITEMS', {
      sourceSheet: 'Items',
      sourceRow: 2,
      ordinal: 0,
      durableShapeValid: true,
      status: 'READY',
      operation: 'CREATE',
      catalogItemId: null,
      proofCorporateSku: 'SKU-2',
      name: `${'N'.repeat(255)}😀tail`,
      itemKind: 'RETAIL_PRODUCT',
      organizationValueCount: 0,
      businessTypeCount: 0,
      referenceProposalCount: 0,
      venueBindingRequestCount: 0,
      errorCount: 0,
    })

    // WHY: UTF-16 slicing can return a lone surrogate that corrupts JSON/UI;
    // the 256th display code point must remain the complete emoji.
    expect(result.name).toBe(`${'N'.repeat(255)}😀`)
    expect(result.truncatedFields).toContain('name')
  })

  it.each([
    [
      'ORGANIZATION_VALUES' as const,
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 10,
        ordinal: 0,
        durableShapeValid: true,
        action: 'UPSERT',
        proofCorporateSku: 'SKU-3',
        kind: 'SALE_PRICE',
        currency: 'MXN',
        amount: '10.00',
        expectedRuleRevision: 2,
      },
      { action: 'UPSERT', kind: 'SALE_PRICE', currency: 'MXN', amount: '10.00', expectedRuleRevision: 2 },
    ],
    [
      'BUSINESS_TYPES' as const,
      {
        sourceSheet: 'BusinessTypes',
        sourceRow: 40,
        ordinal: 0,
        durableShapeValid: true,
        proofCorporateSku: 'SKU-4',
        businessType: 'RETAIL_STORE',
      },
      { businessType: 'RETAIL_STORE' },
    ],
    [
      'REFERENCE_PROPOSALS' as const,
      {
        sourceSheet: 'Items',
        sourceRow: 5,
        ordinal: 3,
        durableShapeValid: true,
        operation: 'CREATE',
        referenceType: 'FAMILY',
        ...referenceProof('Subfamilia', 'FAMILY', 'family-1'),
      },
      { operation: 'CREATE', referenceType: 'FAMILY', name: 'Subfamilia', parentId: 'family-1' },
    ],
    [
      'VENUE_BINDING_REQUESTS' as const,
      {
        sourceSheet: 'VenueBindingRequests',
        sourceRow: 80,
        ordinal: 0,
        durableShapeValid: true,
        proofCorporateSku: 'SKU-6',
        venueId: 'venue-1',
        requestedAction: 'CREATE',
        productId: null,
        proofLocalSku: 'LOCAL-1',
        categoryId: 'category-1',
        initialPrice: '20.00',
        currency: 'MXN',
      },
      { venueId: 'venue-1', requestedAction: 'CREATE', localSku: 'LOCAL-1', initialPrice: '20.00' },
    ],
    [
      'ERRORS' as const,
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 7,
        ordinal: 1,
        durableShapeValid: true,
        status: 'INVALID',
        column: 'amount',
        errorCode: 'CATALOG_MONEY_INVALID',
        message: 'M'.repeat(600),
        rejectedValue: 'R'.repeat(600),
        suggestion: 'Corrige el monto.',
      },
      { column: 'amount', errorCode: 'CATALOG_MONEY_INVALID', suggestion: 'Corrige el monto.' },
    ],
  ])('projects bounded %s rows through an explicit allowlist', (section, row, expected) => {
    const result = projectCatalogImportPreviewRowV1(section, { status: 'READY', ...row })

    expect(result).toEqual(expect.objectContaining({ section, sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, ...expected }))
    expect(Object.keys(result)).not.toContain('payload')
    if (section === 'ERRORS') {
      expect(result).toEqual(expect.objectContaining({ message: 'M'.repeat(512), rejectedValue: 'R'.repeat(256) }))
      expect(result.truncatedFields).toEqual(['message', 'rejectedValue'])
    }
  })

  it('shows an UPDATE price deactivation at its hash-bound Items coordinate', () => {
    // WHY: A synthesized tombstone is a confirmable mutation even though it
    // has no workbook OrganizationValues row; hiding it would make review lie.
    const result = projectCatalogImportPreviewRowV1('ORGANIZATION_VALUES', {
      sourceSheet: 'Items',
      sourceRow: 9,
      ordinal: 2,
      durableShapeValid: true,
      status: 'READY',
      action: 'DEACTIVATE',
      proofCorporateSku: 'SKU-9',
      kind: 'SALE_PRICE',
      currency: 'MXN',
      amount: null,
      expectedRuleRevision: 7,
    })

    expect(result).toEqual(
      expect.objectContaining({
        section: 'ORGANIZATION_VALUES',
        sourceSheet: 'Items',
        sourceRow: 9,
        ordinal: 2,
        action: 'DEACTIVATE',
        corporateSku: 'SKU-9',
        amount: null,
        expectedRuleRevision: 7,
      }),
    )
  })

  it('rejects an organization-value action that does not match its durable coordinate kind', () => {
    // WHY: A cursor may accept both legal source sheets, but a row may not
    // relabel a workbook UPSERT as a synthesized Items tombstone or vice versa.
    for (const row of [
      { sourceSheet: 'Items', action: 'UPSERT' },
      { sourceSheet: 'OrganizationValues', action: 'DEACTIVATE' },
    ]) {
      expect(() =>
        projectCatalogImportPreviewRowV1('ORGANIZATION_VALUES', {
          ...row,
          sourceRow: 9,
          ordinal: 1,
          durableShapeValid: true,
          status: 'READY',
          proofCorporateSku: 'SKU-9',
          kind: 'SALE_PRICE',
          currency: 'MXN',
          amount: null,
          expectedRuleRevision: 7,
        }),
      ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }))
    }
  })

  it('keeps a legitimate minimal INVALID Items line readable with null scalar excerpts', () => {
    // WHY: FAILED previews preserve structural/duplicate findings as exact
    // `{schemaVersion:1}` payloads; minimal is valid only through the SQL flag.
    const result = projectCatalogImportPreviewRowV1('ITEMS', {
      sourceSheet: 'Items',
      sourceRow: 12,
      ordinal: 0,
      durableShapeValid: true,
      status: 'INVALID',
      operation: null,
      catalogItemId: null,
      proofCorporateSku: null,
      name: null,
      itemKind: null,
      organizationValueCount: 0,
      businessTypeCount: 0,
      referenceProposalCount: 0,
      venueBindingRequestCount: 0,
      errorCount: 2,
    })

    expect(result).toEqual(
      expect.objectContaining({
        sourceSheet: 'Items',
        sourceRow: 12,
        status: 'INVALID',
        operation: null,
        corporateSku: null,
        errorCount: 2,
      }),
    )
  })

  it('projects one bounded scalar-only item detail with counts instead of nested arrays', () => {
    const result = projectCatalogImportPreviewItemDetailV1({
      sourceSheet: 'Items',
      sourceRow: 8,
      ordinal: 0,
      durableShapeValid: true,
      status: 'INVALID',
      operation: 'UPDATE',
      catalogItemId: 'item-8',
      proofCorporateSku: 'SKU-8',
      itemKind: 'RETAIL_PRODUCT',
      name: 'Producto',
      description: 'D'.repeat(700),
      imageUrl: 'https://cdn.example.test/item.png',
      brandId: 'brand-1',
      manufacturerId: 'manufacturer-1',
      familyId: 'family-1',
      presentationLabel: 'Pieza',
      unit: 'UNIT',
      productType: 'REGULAR',
      taxRate: '0.1600',
      satProductKey: '50161509',
      satUnitKey: 'H87',
      objetoImp: '02',
      iepsMode: 'NONE',
      iepsRate: null,
      iepsQuota: null,
      iepsQuotaUnit: null,
      organizationValueCount: 20_000,
      businessTypeCount: 20_000,
      referenceProposalCount: 4,
      venueBindingRequestCount: 20_000,
      errorCount: 20_000,
      payload: { nested: Array(20_000).fill('x') },
    })

    expect(result.description).toBe('D'.repeat(512))
    expect(result.truncatedFields).toEqual(['description'])
    expect(result.counts).toEqual({
      organizationValues: 20_000,
      businessTypes: 20_000,
      referenceProposals: 4,
      venueBindingRequests: 20_000,
      errors: 20_000,
    })
    expect(result).not.toHaveProperty('payload')
    expect(JSON.stringify(result).length).toBeLessThan(4_096)
  })

  it('keeps a READY RETIRE detail valid with identity-only scalars', () => {
    const result = projectCatalogImportPreviewItemDetailV1({
      sourceSheet: 'Items',
      sourceRow: 12,
      ordinal: 0,
      durableShapeValid: true,
      status: 'READY',
      operation: 'RETIRE',
      catalogItemId: 'item-12',
      proofCorporateSku: null,
      itemKind: null,
      name: null,
      description: null,
      imageUrl: null,
      brandId: null,
      manufacturerId: null,
      familyId: null,
      presentationLabel: null,
      unit: null,
      productType: null,
      taxRate: null,
      satProductKey: null,
      satUnitKey: null,
      objetoImp: null,
      iepsMode: null,
      iepsRate: null,
      iepsQuota: null,
      iepsQuotaUnit: null,
      organizationValueCount: 0,
      businessTypeCount: 0,
      referenceProposalCount: 0,
      venueBindingRequestCount: 0,
      errorCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({ operation: 'RETIRE', catalogItemId: 'item-12', corporateSku: null }))
  })

  it('shows an ancillary finding coordinate while keeping its durable line cursor stable', () => {
    const raw = {
      sourceSheet: 'OrganizationValues',
      sourceRow: '50',
      ordinal: 2,
      durableShapeValid: true,
      cursorSourceSheet: 'Items',
      cursorSourceRow: 2,
      status: 'INVALID',
      column: 'amount',
      errorCode: 'CATALOG_MONEY_INVALID',
      message: 'Monto inválido',
      rejectedValue: 'x',
      suggestion: 'Corrige el monto.',
    }

    const projected = projectCatalogImportPreviewRowV1('ERRORS', raw)

    expect(projected).toEqual(expect.objectContaining({ sourceSheet: 'OrganizationValues', sourceRow: 50, ordinal: 2 }))
    expect(catalogImportPreviewPositionV1(raw, 'ERRORS')).toEqual({ sourceSheet: 'Items', sourceRow: 2, ordinal: 2 })
  })

  it('rejects malformed durable coordinates instead of returning ambiguous cursor keys', () => {
    for (const row of [
      { sourceSheet: '', sourceRow: 2, ordinal: 0 },
      { sourceSheet: 'Items', sourceRow: 0, ordinal: 0 },
      { sourceSheet: 'Items', sourceRow: 2, ordinal: -1 },
      { sourceSheet: 'Items', sourceRow: 2.5, ordinal: 0 },
    ]) {
      expect(() => projectCatalogImportPreviewRowV1('ITEMS', row)).toThrow(
        expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }),
      )
    }
  })

  it('rejects a visible row whose closed SQL shape flag is not exactly true', () => {
    // WHY: A malformed nested container must not be projected as an empty or
    // partially-null row even if it races the batch integrity preflight.
    expect(() =>
      projectCatalogImportPreviewRowV1('ITEMS', {
        sourceSheet: 'Items',
        sourceRow: 2,
        ordinal: 0,
        durableShapeValid: false,
        status: 'READY',
        operation: 'CREATE',
        catalogItemId: null,
        proofCorporateSku: 'SKU-2',
        name: 'Producto',
        itemKind: 'RETAIL_PRODUCT',
        organizationValueCount: 0,
        businessTypeCount: 0,
        referenceProposalCount: 0,
        venueBindingRequestCount: 0,
        errorCount: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }))
  })
})
