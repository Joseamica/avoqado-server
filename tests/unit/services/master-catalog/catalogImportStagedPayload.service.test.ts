import { BusinessType, CatalogIepsMode, CatalogItemKind, Prisma, ProductType, Unit } from '@prisma/client'
import {
  collectCatalogImportReferenceProposalsV1,
  catalogImportProposalMarkerV1,
  parseCatalogImportBatchV1,
  parseCatalogImportStagedPayloadV1,
  resolveCatalogImportCommandMarkersV1,
  type CatalogImportLineRowV1,
} from '@/services/master-catalog/catalogImportStagedPayload.service'
import * as catalogItemValidation from '@/services/master-catalog/catalogItemValidation.service'
import { projectCatalogImportCanonicalLineV1 } from '@/services/master-catalog/catalogImportMapping.service'
import { expectCatalogImportEventLoopBudgetV1, startCatalogImportEventLoopProbeV1 } from './catalogImportEventLoopTestHarness'

function payload(overrides: Prisma.JsonObject = {}): Prisma.JsonObject {
  return {
    schemaVersion: 1,
    command: {
      operation: 'CREATE',
      input: {
        sku: 'SKU-001',
        kind: CatalogItemKind.RETAIL_PRODUCT,
        name: 'Producto',
        description: 'Descripción',
        imageUrl: 'https://cdn.example.test/item.png',
        brandId: 'brand-1',
        manufacturerId: 'manufacturer-1',
        familyId: 'family-leaf-1',
        presentationLabel: 'Pieza',
        unit: Unit.UNIT,
        taxRate: '0.1600',
        satProductKey: '50161509',
        satUnitKey: 'H87',
        objetoImp: '02',
        productType: ProductType.REGULAR,
        iepsMode: CatalogIepsMode.NONE,
        iepsRate: null,
        iepsQuota: null,
        iepsQuotaUnit: null,
        businessTypes: [BusinessType.RETAIL_STORE],
        organizationValues: [
          { kind: 'SALE_PRICE', amount: '10.00', currency: 'MXN' },
          { kind: 'PURCHASE_COST', amount: '5.00', currency: 'MXN' },
        ],
      },
    },
    referenceProposals: [],
    venueBindingRequests: [],
    ...overrides,
  }
}

function line(value: Prisma.JsonValue): CatalogImportLineRowV1 {
  return {
    id: 'line-1',
    status: 'READY',
    sourceSheet: 'Items',
    sourceRow: 2,
    payload: value,
    errors: null,
    catalogItemId: null,
  }
}

function stagedProposal<
  T extends { operation: 'CREATE'; referenceType: 'BRAND' | 'MANUFACTURER' | 'FAMILY'; name: string; parentId?: string | null },
>(proposal: T) {
  return { ...proposal, capacityMarker: catalogImportProposalMarkerV1(proposal) }
}

describe('catalog import durable staged payload parser', () => {
  it('accepts a complete closed V1 command and rejects malformed nested shapes', () => {
    expect(parseCatalogImportStagedPayloadV1(line(payload()))).toMatchObject({ schemaVersion: 1 })

    const malformed = [
      payload({ referenceProposals: 'corrupt' }),
      payload({ venueBindingRequests: 'corrupt' }),
      payload({
        command: {
          ...(payload().command as Record<string, unknown>),
          input: { ...(payload().command as { input: Record<string, unknown> }).input, brandId: 42 },
        },
      }),
      payload({
        venueBindingRequests: [{ corporateSku: 'SKU-001', venueId: 'venue-1', requestedAction: 'LINK', productId: 42 }],
      }),
    ]
    for (const value of malformed) {
      expect(() => parseCatalogImportStagedPayloadV1(line(value))).toThrow(
        expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
      )
    }
  })

  it('rejects non-canonical mutable fields while preserving the reviewed SKU display', () => {
    const command = payload().command as { operation: 'CREATE'; input: Record<string, unknown> }
    for (const input of [
      { ...command.input, name: '  Producto  ' },
      {
        ...command.input,
        organizationValues: [
          { kind: 'SALE_PRICE', amount: '10.0', currency: 'MXN' },
          { kind: 'PURCHASE_COST', amount: '5.00', currency: 'MXN' },
        ],
      },
      { ...command.input, taxRate: '0.16' },
    ]) {
      expect(() => parseCatalogImportStagedPayloadV1(line(payload({ command: { ...command, input } })))).toThrow(
        expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
      )
    }

    const reviewedSku = ' sku-001 '
    const parsed = parseCatalogImportStagedPayloadV1(
      line(payload({ command: { ...command, input: { ...command.input, sku: reviewedSku } } })),
    )
    // WHY: Task 5 preserves the submitted SKU display while deriving its join
    // identity separately; canonical drift checks must not rewrite display text.
    expect(parsed.command).toMatchObject({ input: { sku: reviewedSku } })
  })

  it('requires a SALE/PURCHASE pair for every staged currency', () => {
    const command = payload().command as { operation: 'CREATE'; input: Record<string, unknown> }
    const organizationValues = [
      { kind: 'SALE_PRICE', amount: '10.00', currency: 'MXN' },
      { kind: 'PURCHASE_COST', amount: '5.00', currency: 'MXN' },
      { kind: 'SALE_PRICE', amount: '2.00', currency: 'USD' },
    ]
    expect(() =>
      parseCatalogImportStagedPayloadV1(line(payload({ command: { ...command, input: { ...command.input, organizationValues } } }))),
    ).toThrow(expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }))
  })

  it('accepts only empty durable findings on a READY Items line', () => {
    expect(parseCatalogImportStagedPayloadV1({ ...line(payload()), errors: [] })).toMatchObject({ schemaVersion: 1 })
    expect(() => parseCatalogImportStagedPayloadV1({ ...line(payload()), errors: [42] })).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
    )
    expect(() => projectCatalogImportCanonicalLineV1({ ...line(payload()), errors: [42] })).toThrow('CATALOG_IMPORT_STAGING_INVALID')
    expect(() =>
      projectCatalogImportCanonicalLineV1({
        ...line(payload()),
        status: 'INVALID',
        errors: [],
      }),
    ).toThrow('CATALOG_IMPORT_STAGING_INVALID')
    expect(() =>
      projectCatalogImportCanonicalLineV1({
        ...line(payload()),
        status: 'INVALID',
        errors: [
          {
            source_sheet: 'Items',
            source_row: 2,
            column: 'name',
            error_code: 'CATALOG_CODE_MUST_BE_TEXT',
            message: 'Corrige el nombre.',
            suggestion: 'Usa texto.',
            leaked: 'durable-secret',
          },
        ],
      }),
    ).toThrow('CATALOG_IMPORT_STAGING_INVALID')
  })

  it('keeps RETIRE identity-only after durable staging', () => {
    const retire = {
      schemaVersion: 1,
      command: { operation: 'RETIRE', input: { catalogItemId: 'catalog-item-1', expectedRevision: 7 } },
      referenceProposals: [],
      venueBindingRequests: [],
    }
    expect(parseCatalogImportStagedPayloadV1({ ...line(retire), catalogItemId: 'catalog-item-1' })).toMatchObject({
      command: { operation: 'RETIRE' },
    })
    for (const extra of [
      { referenceProposals: [stagedProposal({ operation: 'CREATE', referenceType: 'BRAND', name: 'Injected Brand' })] },
      {
        venueBindingRequests: [
          {
            corporateSku: 'SKU-001',
            venueId: 'venue-1',
            requestedAction: 'SKIP',
            productId: null,
            localSku: null,
            categoryId: null,
            initialPrice: null,
            currency: null,
          },
        ],
      },
    ]) {
      expect(() => parseCatalogImportStagedPayloadV1({ ...line({ ...retire, ...extra }), catalogItemId: 'catalog-item-1' })).toThrow(
        expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
      )
    }
  })

  it('rejects unsupported durable batch/hash versions before any writer can run', () => {
    const value = {
      id: 'batch-1',
      organizationId: 'org-1',
      state: 'PREVIEWED',
      schemaVersion: 2,
      requestHash: 'a'.repeat(64),
      requestHashVersion: 2,
      targetHash: 'b'.repeat(64),
      previewTokenHash: 'c'.repeat(64),
      previewExpiresAt: new Date(),
      dependencies: {},
      staffId: 'staff-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(() => parseCatalogImportBatchV1(value)).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_VERSION_UNSUPPORTED' }))
  })

  it.each([
    ['short request hash', { requestHash: 'a'.repeat(63) }],
    ['long target hash', { targetHash: 'b'.repeat(65) }],
    ['uppercase token hash', { previewTokenHash: 'C'.repeat(64) }],
    ['invalid expiry', { previewExpiresAt: new Date(Number.NaN) }],
    ['invalid creation date', { createdAt: new Date(Number.NaN) }],
    ['invalid update date', { updatedAt: new Date(Number.NaN) }],
  ])('rejects %s durable batch corruption before token/DDL work', (_label, overrides) => {
    const value = {
      id: 'batch-1',
      organizationId: 'org-1',
      state: 'PREVIEWED',
      schemaVersion: 1,
      requestHash: 'a'.repeat(64),
      requestHashVersion: 1,
      targetHash: 'b'.repeat(64),
      previewTokenHash: 'c'.repeat(64),
      previewExpiresAt: new Date('2026-08-08T20:30:00.000Z'),
      dependencies: {},
      staffId: 'staff-1',
      createdAt: new Date('2026-08-08T19:00:00.000Z'),
      updatedAt: new Date('2026-08-08T19:00:00.000Z'),
      ...overrides,
    }
    expect(() => parseCatalogImportBatchV1(value)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
    )
  })

  it('rejects a globally unique FAMILY name proposed under different parents', async () => {
    const rootA = { operation: 'CREATE' as const, referenceType: 'FAMILY' as const, name: 'Root A', parentId: null }
    const rootB = { operation: 'CREATE' as const, referenceType: 'FAMILY' as const, name: 'Root B', parentId: null }
    const first = parseCatalogImportStagedPayloadV1(
      line(
        payload({
          referenceProposals: [
            stagedProposal(rootA),
            stagedProposal({
              operation: 'CREATE',
              referenceType: 'FAMILY',
              name: 'Snacks',
              parentId: catalogImportProposalMarkerV1(rootA),
            }),
          ],
        }),
      ),
    )
    const second = parseCatalogImportStagedPayloadV1(
      line(
        payload({
          referenceProposals: [
            stagedProposal(rootB),
            stagedProposal({
              operation: 'CREATE',
              referenceType: 'FAMILY',
              name: 'Snacks',
              parentId: catalogImportProposalMarkerV1(rootB),
            }),
          ],
        }),
      ),
    )
    await expect(collectCatalogImportReferenceProposalsV1([first, second])).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_STAGING_INVALID',
    })
  })

  it('collects the maximum staged proposal envelope without blocking the main thread', async () => {
    const shared = parseCatalogImportStagedPayloadV1(line(payload()))
    const payloads = Array.from({ length: 20_000 }, (_, index) => ({
      ...shared,
      referenceProposals: [
        stagedProposal({ operation: 'CREATE', referenceType: 'BRAND', name: `Brand ${index}` }),
        stagedProposal({ operation: 'CREATE', referenceType: 'MANUFACTURER', name: `Maker ${index}` }),
        stagedProposal({ operation: 'CREATE', referenceType: 'FAMILY', name: `Root ${index}`, parentId: null }),
        stagedProposal({ operation: 'CREATE', referenceType: 'FAMILY', name: `Leaf ${index}`, parentId: null }),
      ],
    }))
    const probe = startCatalogImportEventLoopProbeV1()
    let samples: readonly number[] = []
    try {
      await collectCatalogImportReferenceProposalsV1(payloads)
    } finally {
      samples = probe.stop()
    }
    // WHY: Capacity rejection still has to inspect the bounded staged intent;
    // the pre-lock scan cannot monopolize the HTTP process while doing so.
    expectCatalogImportEventLoopBudgetV1(samples)
  }, 20_000)

  it('resolves only known string markers after the proposal set is materialized', () => {
    const proposal = { operation: 'CREATE' as const, referenceType: 'BRAND' as const, name: 'Marca nueva' }
    const marker = catalogImportProposalMarkerV1(proposal)
    const parsed = parseCatalogImportStagedPayloadV1(
      line(
        payload({
          referenceProposals: [stagedProposal(proposal)],
          command: {
            ...(payload().command as Record<string, unknown>),
            input: {
              ...(payload().command as { input: Record<string, unknown> }).input,
              brandId: marker,
            },
          },
        }),
      ),
    )
    expect(resolveCatalogImportCommandMarkersV1(parsed.command, new Map([[marker, 'brand-1']]))).toMatchObject({
      input: { brandId: 'brand-1' },
    })
  })

  it('rejects a capacity marker that no longer matches the Unicode proposal identity', () => {
    const proposal = stagedProposal({ operation: 'CREATE', referenceType: 'BRAND', name: 'Marca nueva' })
    proposal.capacityMarker += ':tampered'
    expect(() => parseCatalogImportStagedPayloadV1(line(payload({ referenceProposals: [proposal] })))).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
    )
  })

  it('accepts a 256-scalar workbook reference name through the exact proposal marker', () => {
    const length = 256
    const proposal = { operation: 'CREATE' as const, referenceType: 'BRAND' as const, name: 'B'.repeat(length) }
    const marker = catalogImportProposalMarkerV1(proposal)
    const value = payload({
      referenceProposals: [stagedProposal(proposal)],
      command: {
        ...(payload().command as Record<string, unknown>),
        input: { ...(payload().command as { input: Record<string, unknown> }).input, brandId: marker },
      },
    })
    expect(parseCatalogImportStagedPayloadV1(line(value))).toMatchObject({
      command: { input: { brandId: marker } },
    })
  })

  it('preserves workbook-scalar reference, corporate, and local SKU displays through durable parsing', () => {
    const rawCorporateSku = `${' '.repeat(3_840)}${'😀'.repeat(256)}`
    const canonicalCorporateSku = '😀'.repeat(256)
    const localSku = canonicalCorporateSku
    const proposal = { operation: 'CREATE' as const, referenceType: 'BRAND' as const, name: rawCorporateSku }
    const marker = catalogImportProposalMarkerV1(proposal)
    const command = payload().command as { operation: 'CREATE'; input: Record<string, unknown> }
    const parsed = parseCatalogImportStagedPayloadV1(
      line(
        payload({
          referenceProposals: [stagedProposal(proposal)],
          command: { ...command, input: { ...command.input, sku: rawCorporateSku, brandId: marker } },
          venueBindingRequests: [
            {
              corporateSku: canonicalCorporateSku,
              venueId: 'venue-1',
              requestedAction: 'CREATE',
              productId: null,
              localSku,
              categoryId: 'category-1',
              initialPrice: '20.00',
              currency: 'MXN',
            },
          ],
        }),
      ),
    )
    expect(parsed).toMatchObject({
      command: { input: { sku: rawCorporateSku, brandId: marker } },
      referenceProposals: [{ name: rawCorporateSku, capacityMarker: marker }],
      venueBindingRequests: [{ corporateSku: canonicalCorporateSku, localSku }],
    })
  })

  it.each([257, 4_096])('rejects a %i-character reference key before confirmation writers', length => {
    const name = 'B'.repeat(length)
    const proposal = {
      operation: 'CREATE' as const,
      referenceType: 'BRAND' as const,
      name,
      capacityMarker: `@proposal:BRAND:${name}`,
    }
    expect(() => parseCatalogImportStagedPayloadV1(line(payload({ referenceProposals: [proposal] })))).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }),
    )
  })

  it('rejects a corrupt staged SKU beyond the indexable normalized-key budget', () => {
    const command = payload().command as { operation: 'CREATE'; input: Record<string, unknown> }
    expect(() =>
      parseCatalogImportStagedPayloadV1(line(payload({ command: { ...command, input: { ...command.input, sku: 'S'.repeat(257) } } }))),
    ).toThrow(expect.objectContaining({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' }))
  })

  it('rejects oversized nested arrays, workbook text, and Int32-overflow source rows before traversal', () => {
    const longName = 'B'.repeat(4_097)
    const longProposal = {
      operation: 'CREATE',
      referenceType: 'BRAND',
      name: longName,
      capacityMarker: `@proposal:BRAND:${longName}`,
    }
    const invalid = [
      line(
        payload({ referenceProposals: Array.from({ length: 5 }, () => ({ operation: 'CREATE', referenceType: 'BRAND', name: 'Brand' })) }),
      ),
      line(payload({ referenceProposals: [longProposal] })),
      line(payload({ venueBindingRequests: Array.from({ length: 20_001 }, () => ({})) })),
      { ...line(payload()), sourceRow: 2_147_483_648 },
    ]
    for (const value of invalid) {
      expect(() => parseCatalogImportStagedPayloadV1(value)).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID' }))
    }
  })

  it('caps and closes command collections before invoking the Task 5 validator', () => {
    const validator = jest.spyOn(catalogItemValidation, 'validateCatalogItemInput')
    const command = payload().command as { input: Record<string, unknown> }
    const invalidValues = [
      Array.from({ length: 20_001 }, () => null),
      [{ kind: 'SALE_PRICE', amount: '1.00', currency: 'MXN', hidden: true }],
    ]
    for (const organizationValues of invalidValues) {
      expect(() =>
        parseCatalogImportStagedPayloadV1(
          line(
            payload({
              command: { ...(payload().command as Record<string, unknown>), input: { ...command.input, organizationValues } },
            }),
          ),
        ),
      ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID' }))
    }
    expect(() =>
      parseCatalogImportStagedPayloadV1(
        line(
          payload({
            command: {
              ...(payload().command as Record<string, unknown>),
              input: {
                ...command.input,
                businessTypes: Array.from({ length: Object.values(BusinessType).length + 1 }, () => BusinessType.RETAIL_STORE),
              },
            },
          }),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_STAGING_INVALID' }))
    // WHY: Nested caps are checked before Task 5 can map an attacker-sized
    // array; this assertion freezes the ordering, not only the final code.
    expect(validator).not.toHaveBeenCalled()
    validator.mockRestore()
  })
})
