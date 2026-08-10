import {
  CATALOG_IMPORT_CONFIRM_COST_MODEL_VERSION,
  CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT,
  calculateCatalogImportConfirmCapacityV1,
  calculateCatalogImportConfirmCapacityCooperativelyV1,
  markCatalogImportConfirmDeactivationOverflowV1,
  parseCatalogImportConfirmCapacityV1,
  parseCatalogImportConfirmCapacitySqlRowV1,
  requireCatalogImportConfirmCapacityV1,
} from '@/services/master-catalog/catalogImportCapacity.service'
import { stageCatalogImportReferenceProposalsV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'
import type { CatalogReferenceProposal } from '@/services/master-catalog/catalogItem.types'
import type { CatalogImportStagedPayloadV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'

type CreateReferenceProposal = Extract<CatalogReferenceProposal, { operation: 'CREATE' }>

// WHY: These minimal payload builders keep boundary arithmetic readable while
// exercising the same discriminated commands consumed by confirmation.
function retirePayload(index: number): CatalogImportStagedPayloadV1 {
  return {
    schemaVersion: 1,
    command: { operation: 'RETIRE', input: { catalogItemId: `item-${index}`, expectedRevision: 1 } },
    referenceProposals: [],
    venueBindingRequests: [],
  }
}

function createPayload(index: number, referenceProposals: readonly CreateReferenceProposal[] = []): CatalogImportStagedPayloadV1 {
  return {
    schemaVersion: 1,
    command: {
      operation: 'CREATE',
      input: {
        sku: `SKU-${index}`,
        kind: 'RETAIL_PRODUCT',
        name: `Producto ${index}`,
        description: 'Descripción',
        imageUrl: 'https://cdn.example.test/item.png',
        brandId: 'brand-1',
        manufacturerId: 'manufacturer-1',
        familyId: 'family-1',
        presentationLabel: 'Pieza',
        unit: 'UNIT',
        taxRate: '0.1600',
        satProductKey: '50161509',
        satUnitKey: 'H87',
        objetoImp: '02',
        productType: 'REGULAR',
        iepsMode: 'NONE',
        iepsRate: null,
        iepsQuota: null,
        iepsQuotaUnit: null,
        businessTypes: ['RETAIL_STORE'],
        organizationValues: [],
      },
    },
    referenceProposals: stageCatalogImportReferenceProposalsV1(referenceProposals),
    venueBindingRequests: [],
  } as CatalogImportStagedPayloadV1
}

// WHY: UPDATE cost explicitly includes retained rules and CAS tombstones; this
// fixture prevents either collection from silently disappearing from the cap.
function updatePayload(): CatalogImportStagedPayloadV1 {
  const created = createPayload(1)
  if (created.command.operation !== 'CREATE') throw new Error('fixture invariant')
  return {
    ...created,
    command: {
      operation: 'UPDATE',
      input: {
        ...created.command.input,
        catalogItemId: 'item-1',
        expectedRevision: 7,
        organizationValues: [
          { kind: 'SALE_PRICE', amount: '10.00', currency: 'MXN', expectedRuleRevision: 2 },
          { kind: 'PURCHASE_COST', amount: '5.00', currency: 'MXN', expectedRuleRevision: 3 },
        ],
        organizationValueDeactivations: [
          { kind: 'SALE_PRICE', currency: 'USD', expectedRuleRevision: 4 },
          { kind: 'PURCHASE_COST', currency: 'USD', expectedRuleRevision: 5 },
          { kind: 'SALE_PRICE', currency: 'CAD', expectedRuleRevision: 6 },
        ],
      },
    },
  }
}

describe('catalogImportCapacity.service cost model v1', () => {
  it('freezes version, base, CREATE/UPDATE/RETIRE, retained values, tombstones, and unique reference costs', () => {
    const duplicateBrand = { operation: 'CREATE' as const, referenceType: 'BRAND' as const, name: 'Marca Única' }
    const result = calculateCatalogImportConfirmCapacityV1([
      createPayload(1, [
        duplicateBrand,
        { ...duplicateBrand },
        { operation: 'CREATE', referenceType: 'MANUFACTURER', name: 'Fabricante Único' },
        { operation: 'CREATE', referenceType: 'FAMILY', name: 'Familia', parentId: null },
        { operation: 'CREATE', referenceType: 'FAMILY', name: 'Subfamilia', parentId: '@proposal:FAMILY:FAMILIA' },
      ]),
      updatePayload(),
      retirePayload(1),
    ])

    expect(result).toEqual({
      schemaVersion: 1,
      costModelVersion: CATALOG_IMPORT_CONFIRM_COST_MODEL_VERSION,
      measurement: 'EXACT',
      workUnits: 78,
      limit: CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT,
      withinLimit: true,
      breakdown: {
        base: 32,
        referenceProposals: 13,
        createItems: 10,
        updateItems: 17,
        retireItems: 6,
        organizationValues: 2,
        deactivations: 3,
      },
    })
  })

  it.each([
    {
      expected: 11_999,
      payloads: [
        createPayload(0, [{ operation: 'CREATE', referenceType: 'BRAND', name: 'Borde A' }]),
        ...Array.from({ length: 1_193 }, (_, index) => createPayload(index + 1)),
        ...Array.from({ length: 4 }, (_, index) => retirePayload(index)),
      ],
      allowed: true,
    },
    {
      expected: 12_000,
      payloads: [
        createPayload(0, [{ operation: 'CREATE', referenceType: 'FAMILY', name: 'Borde E', parentId: 'family-root' }]),
        ...Array.from({ length: 1_193 }, (_, index) => createPayload(index + 1)),
        ...Array.from({ length: 4 }, (_, index) => retirePayload(index)),
      ],
      allowed: true,
    },
    {
      expected: 12_001,
      payloads: [
        createPayload(0, [
          { operation: 'CREATE', referenceType: 'BRAND', name: 'Borde G' },
          { operation: 'CREATE', referenceType: 'FAMILY', name: 'Borde H', parentId: 'family-root' },
        ]),
        ...Array.from({ length: 1_194 }, (_, index) => createPayload(index + 1)),
        ...Array.from({ length: 2 }, (_, index) => retirePayload(index)),
      ],
      allowed: false,
    },
  ])('enforces the exact $expected work-unit boundary', ({ payloads, expected, allowed }) => {
    const result = calculateCatalogImportConfirmCapacityV1(payloads)

    expect(result.workUnits).toBe(expected)
    expect(result.withinLimit).toBe(allowed)
    if (allowed) expect(() => requireCatalogImportConfirmCapacityV1(payloads)).not.toThrow()
    else {
      expect(() => requireCatalogImportConfirmCapacityV1(payloads)).toThrow(
        expect.objectContaining({ statusCode: 413, code: 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED' }),
      )
    }
  })

  it('deduplicates normalized proposal markers and still counts UPDATE tombstones', () => {
    const payload = updatePayload()
    payload.referenceProposals = stageCatalogImportReferenceProposalsV1([
      { operation: 'CREATE', referenceType: 'BRAND', name: '  Café  ' },
      { operation: 'CREATE', referenceType: 'BRAND', name: 'CAFÉ' },
    ])

    const result = calculateCatalogImportConfirmCapacityV1([payload])

    expect(result.workUnits).toBe(52)
    expect(result.breakdown.referenceProposals).toBe(3)
    expect(result.breakdown.deactivations).toBe(3)
  })

  it('keeps FAMILY root/children and distinct parent identities separate while deduplicating an exact child', () => {
    const result = calculateCatalogImportConfirmCapacityV1([
      createPayload(1, [
        { operation: 'CREATE', referenceType: 'FAMILY', name: 'Nombre compartido', parentId: null },
        { operation: 'CREATE', referenceType: 'FAMILY', name: 'NOMBRE COMPARTIDO', parentId: 'family-parent-a' },
        { operation: 'CREATE', referenceType: 'FAMILY', name: 'Nombre compartido', parentId: 'family-parent-b' },
        { operation: 'CREATE', referenceType: 'FAMILY', name: ' nombre compartido ', parentId: 'family-parent-a' },
      ]),
    ])

    expect(result.breakdown.referenceProposals).toBe(11)
    expect(result.workUnits).toBe(53)
    expect(result.withinLimit).toBe(true)
    // WHY: `withinLimit` is only a resource result, never authorization. The
    // validation owner rejects this globally-duplicate FAMILY name pre-stage.
  })

  it('proves an allowed UPDATE dependency subset stays below 20k and ignores inactive historical prices', () => {
    const payload = updatePayload()
    if (payload.command.operation !== 'UPDATE') throw new Error('fixture invariant')
    payload.command.input.organizationValues = Array.from({ length: 11_950 }, (_, index) => ({
      kind: 'SALE_PRICE',
      amount: '1.00',
      currency: `X${index}`,
      expectedRuleRevision: 1,
    }))
    payload.command.input.organizationValueDeactivations = []
    ;(payload as unknown as Record<string, unknown>).inactiveHistoricalOrganizationValues = 1_000_000

    const result = calculateCatalogImportConfirmCapacityV1([payload])

    expect(result.withinLimit).toBe(true)
    expect(result.workUnits).toBe(11_994)
    expect(result.breakdown.organizationValues + result.breakdown.deactivations).toBeLessThan(20_000)
    expect(result.breakdown.organizationValues).toBe(11_950)
  })

  it('cooperatively checkpoints and clamps attacker-sized overflow to the V1 lower-bound sentinel', async () => {
    const checkpoint = jest.fn().mockResolvedValue(undefined)
    const payload = createPayload(
      1,
      Array.from({ length: 80_000 }, (_, index) => ({
        operation: 'CREATE' as const,
        referenceType: 'BRAND' as const,
        name: `Marca ${index}`,
      })),
    )

    const result = await calculateCatalogImportConfirmCapacityCooperativelyV1([payload], checkpoint)

    expect(result).toEqual(expect.objectContaining({ measurement: 'LOWER_BOUND', workUnits: 12_001, withinLimit: false }))
    expect(result.breakdown.base + result.breakdown.referenceProposals + result.breakdown.createItems).toBe(12_001)
    // WHY: The checkpoint count is also a deterministic max-gap proof: every
    // proposal considered before saturation yields, rather than one 80k loop.
    expect(checkpoint.mock.calls.length).toBeGreaterThan(3_000)
    expect(checkpoint.mock.calls.length).toBeLessThan(80_000)
  })

  it('parses the exact durable DTO and lets callers prohibit lower bounds', () => {
    const exact = calculateCatalogImportConfirmCapacityV1([createPayload(1)])
    const lowerBound = {
      ...exact,
      measurement: 'LOWER_BOUND' as const,
      workUnits: 12_001,
      withinLimit: false,
      breakdown: { ...exact.breakdown, createItems: 11_969 },
    }

    expect(parseCatalogImportConfirmCapacityV1(exact, ['EXACT'])).toEqual(exact)
    expect(() => parseCatalogImportConfirmCapacityV1(lowerBound, ['EXACT'])).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_CAPACITY_INVALID' }),
    )
    expect(parseCatalogImportConfirmCapacityV1(lowerBound, ['LOWER_BOUND'])).toEqual(lowerBound)
  })

  it('attributes an early active-price overflow to lower-bound UPDATE tombstones', () => {
    const exact = calculateCatalogImportConfirmCapacityV1([updatePayload()])

    const result = markCatalogImportConfirmDeactivationOverflowV1(exact)

    expect(result).toEqual(expect.objectContaining({ measurement: 'LOWER_BOUND', workUnits: 12_001, withinLimit: false }))
    expect(result.breakdown.deactivations).toBe(exact.breakdown.deactivations + (12_001 - exact.workUnits))
    expect(result.breakdown.updateItems).toBe(exact.breakdown.updateItems + (12_001 - exact.workUnits))
    expect(parseCatalogImportConfirmCapacityV1(result, ['LOWER_BOUND'])).toEqual(result)
  })

  it('rejects SQL text coercions at the durable boundary while the explicit SQL-row adapter normalizes them', () => {
    const exact = calculateCatalogImportConfirmCapacityV1([createPayload(1)])
    const sqlScalars = {
      ...exact,
      schemaVersion: '1',
      costModelVersion: '1',
      workUnits: String(exact.workUnits),
      limit: '12000',
      withinLimit: 'true',
      breakdown: Object.fromEntries(Object.entries(exact.breakdown).map(([key, value]) => [key, String(value)])),
    }

    // WHY: Durable JSON comes from dependencies and must preserve JSON types;
    // accepting text here would let confirmation bless a noncanonical snapshot.
    expect(() => parseCatalogImportConfirmCapacityV1(sqlScalars)).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_CAPACITY_INVALID' }),
    )
    expect(parseCatalogImportConfirmCapacitySqlRowV1(sqlScalars)).toEqual(exact)
  })
})
