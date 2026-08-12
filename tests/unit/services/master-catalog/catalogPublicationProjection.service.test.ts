import { BusinessType, CatalogItemKind, ProductType, Unit, VenueOperationalRole } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { projectCatalogPublicationTarget } from '@/services/master-catalog/catalogPublicationProjection.service'

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    organizationId: 'org-1',
    sku: 'CORP-1',
    kind: CatalogItemKind.RETAIL_PRODUCT,
    status: 'ACTIVE',
    revision: 7,
    name: 'Nombre corporativo',
    description: 'Descripción corporativa',
    imageUrl: 'https://example.test/item.png',
    brandId: 'brand-1',
    manufacturerId: 'maker-1',
    familyId: 'family-1',
    presentationLabel: 'Caja',
    unit: Unit.PIECE,
    taxRate: new Decimal('0.1600'),
    satProductKey: '50192100',
    satUnitKey: 'H87',
    objetoImp: '02',
    productType: ProductType.REGULAR,
    iepsMode: 'NONE',
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
    createdById: 'staff-creator',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedById: 'staff-updater',
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
    family: { parentId: 'family-parent' },
    prices: [
      {
        kind: 'SALE_PRICE',
        scope: 'ORGANIZATION',
        amount: new Decimal('20.00'),
        currency: 'MXN',
        active: true,
        revision: 2,
      },
      {
        kind: 'PURCHASE_COST',
        scope: 'ORGANIZATION',
        amount: new Decimal('12.50'),
        currency: 'MXN',
        active: true,
        revision: 3,
      },
    ],
    ...overrides,
  }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    venueId: 'venue-1',
    name: 'Nombre local',
    description: 'Descripción anterior',
    imageUrl: null,
    type: ProductType.REGULAR,
    cost: new Decimal('10.00'),
    taxRate: new Decimal('0.1600'),
    satProductKey: null,
    satUnitKey: null,
    objetoImp: '02',
    unit: Unit.PIECE,
    categoryId: 'category-local',
    price: new Decimal('99.00'),
    active: false,
    updatedAt: new Date('2026-08-03T00:00:00.000Z'),
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'CATALOG_FIELDS_PUBLISH' as const,
    organizationId: 'org-1',
    venue: {
      id: 'venue-1',
      organizationId: 'org-1',
      currency: 'MXN',
      businessType: BusinessType.RETAIL_STORE,
      operationalRole: VenueOperationalRole.STORE,
    },
    item: item(),
    product: product(),
    binding: {
      id: 'binding-1',
      revision: 4,
      managedFieldMask: ['cost', 'description', 'imageUrl', 'name', 'objetoImp', 'satProductKey', 'satUnitKey', 'taxRate', 'type', 'unit'],
      lastPublishedCatalogRevision: 5,
      lastPublishedManagedSnapshot: {
        cost: '10.00',
        description: 'Descripción anterior',
        imageUrl: null,
        name: 'Nombre anterior',
        objetoImp: '02',
        satProductKey: null,
        satUnitKey: null,
        taxRate: '0.1600',
        type: ProductType.REGULAR,
        unit: Unit.PIECE,
      },
      lastPublishedManagedHash: 'a'.repeat(64),
    },
    profiles: [],
    readiness: { state: 'READY', findings: [], dependencies: {} },
    ...overrides,
  }
}

describe('catalogPublicationProjection.service', () => {
  it('changes target authority when an applicable profile changes even if both outcomes remain publishable', () => {
    const profile = {
      id: 'profile-1',
      profileVersion: 3,
      updatedAt: new Date('2026-08-09T10:00:00.000Z'),
      active: true,
      businessType: BusinessType.RETAIL_STORE,
      operationalRole: VenueOperationalRole.STORE,
      rulesSchemaVersion: 1,
      requiredFields: ['name'],
      additionalRules: {},
    }
    const first = projectCatalogPublicationTarget(input({ profiles: [profile] }) as never)
    const second = projectCatalogPublicationTarget(input({ profiles: [{ ...profile, requiredFields: ['description'] }] }) as never)

    expect(first.status).toBe(second.status)
    expect(first.canonicalTargetHash).not.toBe(second.canonicalTargetHash)
  })

  it('projects exactly the ordered retail managed mask and every corporate value', () => {
    const result = projectCatalogPublicationTarget(input() as never)

    expect(result.fieldMask).toEqual([
      'cost',
      'description',
      'imageUrl',
      'name',
      'objetoImp',
      'satProductKey',
      'satUnitKey',
      'taxRate',
      'type',
      'unit',
    ])
    expect(result.proposed).toEqual({
      cost: '12.50',
      description: 'Descripción corporativa',
      imageUrl: 'https://example.test/item.png',
      name: 'Nombre corporativo',
      objetoImp: '02',
      satProductKey: '50192100',
      satUnitKey: 'H87',
      taxRate: '0.1600',
      type: ProductType.REGULAR,
      unit: Unit.PIECE,
    })
    expect(result.status).toBe('LOCAL_DIVERGENCE')
    expect(result.fields.find(field => field.field === 'name')).toMatchObject({ diverged: true, changed: true })
  })

  it('omits corporate cost for prepared dishes and requires READY Recipe dependencies', () => {
    const prepared = input({
      item: item({ kind: CatalogItemKind.PREPARED_DISH, prices: [] }),
      binding: {
        ...input().binding,
        managedFieldMask: input().binding.managedFieldMask.slice(1),
        lastPublishedManagedSnapshot: null,
      },
      readiness: { state: 'STALE', findings: [{ code: 'RECIPE_COST_STALE' }], dependencies: {} },
    })

    const result = projectCatalogPublicationTarget(prepared as never)

    expect(result.fieldMask).not.toContain('cost')
    expect(result.proposed).not.toHaveProperty('cost')
    expect(result).toMatchObject({ status: 'RECIPE_COST_STALE', diagnosticCode: 'CATALOG_RECIPE_NOT_READY' })
  })

  it('requires an ACTIVE ORGANIZATION purchase cost in the exact Venue currency for retail', () => {
    const result = projectCatalogPublicationTarget(input({ item: item({ prices: [{ ...item().prices[0], currency: 'USD' }] }) }) as never)

    expect(result).toMatchObject({ status: 'INVALID', diagnosticCode: 'CATALOG_PURCHASE_COST_MISSING' })
    expect(result.fields.map(field => field.field)).toEqual(result.fieldMask)
  })

  it('ignores unrelated Product drift in status and target hash', () => {
    const baseline = projectCatalogPublicationTarget(
      input({ product: product({ name: 'Nombre anterior', description: 'Descripción anterior' }) }) as never,
    )
    const unrelated = projectCatalogPublicationTarget(
      input({
        product: product({
          name: 'Nombre anterior',
          description: 'Descripción anterior',
          categoryId: 'otra-categoría',
          price: new Decimal('200.00'),
          active: true,
          updatedAt: new Date('2026-08-09T00:00:00.000Z'),
        }),
      }) as never,
    )

    expect(unrelated.canonicalTargetHash).toBe(baseline.canonicalTargetHash)
    expect(unrelated.status).toBe(baseline.status)
  })

  it.each([
    [
      'unknown required field',
      { rulesSchemaVersion: 1, requiredFields: ['futureField'], additionalRules: null },
      'CATALOG_PROFILE_REQUIRED_FIELD_UNSUPPORTED',
    ],
    [
      'future rules version',
      { rulesSchemaVersion: 2, requiredFields: [], additionalRules: null },
      'CATALOG_PROFILE_RULES_VERSION_UNSUPPORTED',
    ],
    [
      'non-empty additional rules',
      { rulesSchemaVersion: 1, requiredFields: [], additionalRules: { minLength: 3 } },
      'CATALOG_PROFILE_ADDITIONAL_RULE_UNSUPPORTED',
    ],
  ])('fails closed with a bounded INVALID diagnostic for %s', (_label, profile, diagnosticCode) => {
    const result = projectCatalogPublicationTarget(
      input({
        profiles: [
          {
            id: 'profile-1',
            active: true,
            businessType: BusinessType.RETAIL_STORE,
            operationalRole: null,
            ...profile,
          },
        ],
      }) as never,
    )

    expect(result).toMatchObject({ status: 'INVALID', diagnosticCode })
    expect(result.diagnostic?.length).toBeLessThanOrEqual(256)
  })

  it('does not let an unsupported profile outside the target scope block publication', () => {
    const result = projectCatalogPublicationTarget(
      input({
        profiles: [
          {
            id: 'profile-other',
            active: true,
            businessType: BusinessType.RESTAURANT,
            operationalRole: null,
            rulesSchemaVersion: 99,
            requiredFields: ['futureField'],
            additionalRules: { future: true },
          },
        ],
      }) as never,
    )

    expect(result.status).not.toBe('INVALID')
  })

  it('enforces the non-relaxable Task 6 baseline even when no profile rows exist', () => {
    const result = projectCatalogPublicationTarget(input({ item: item({ imageUrl: '' }), profiles: [] }) as never)

    expect(result).toMatchObject({
      status: 'INVALID',
      diagnosticCode: 'CATALOG_PROFILE_REQUIRED_FIELD_MISSING',
    })
  })
})
