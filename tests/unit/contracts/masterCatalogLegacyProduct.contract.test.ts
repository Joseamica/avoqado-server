import express from 'express'
import request from 'supertest'
import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'
import * as dashboardProductController from '@/controllers/dashboard/product.dashboard.controller'
import * as mobileProductController from '@/controllers/mobile/product.mobile.controller'
import * as tpvMenuController from '@/controllers/tpv/menu.tpv.controller'
import { globalErrorHandler } from '@/app'
import dashboardFixture from '../../contracts/master-catalog/product-dashboard-legacy.fixture.json'
import mobileFixture from '../../contracts/master-catalog/product-mobile-legacy.fixture.json'
import tpvFixture from '../../contracts/master-catalog/product-tpv-legacy.fixture.json'
import identifierFixture from '../../contracts/master-catalog/identifier-normalization-v1.json'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn().mockResolvedValue(undefined),
  assertLegacyCatalogProductUpdateGovernance: jest.fn().mockResolvedValue(undefined),
  assertLegacyProductReferencesForVenue: jest.fn().mockResolvedValue(undefined),
  resolveLegacyCatalogActor: jest.fn((staffId: string, impersonating: boolean) => ({
    type: 'HUMAN',
    staffId,
    impersonating,
  })),
}))

const correlationId = '<correlation-id>'
const actorId = '<actor-id>'
const venueId = '<venue-id>'
const productId = '<product-id>'
const categoryId = '<category-id>'
const forbiddenH1Keys = new Set([
  'createdById',
  'identifiers',
  'identifier',
  'catalogProduct',
  'catalogProductId',
  'masterCatalogProduct',
  'masterCatalogProductId',
  'effectivePrice',
  'effectivePricing',
  'priceContext',
  'organization',
  'organizationId',
])

const legacyProductReturn = {
  id: productId,
  createdById: '<internal-actor-id>',
  venueId,
  name: 'Café americano',
  description: null,
  sku: 'LEGACY-001',
  gtin: null,
  categoryId,
  price: new Decimal('42.50'),
  cost: null,
  taxRate: new Decimal('0.1600'),
  type: 'FOOD',
  imageUrl: null,
  displayOrder: 3,
  featured: false,
  tags: [],
  allergens: [],
  calories: null,
  prepTime: null,
  cookingNotes: null,
  isAlcoholic: false,
  kitchenName: null,
  abbreviation: null,
  duration: null,
  durationMinutes: null,
  maxParticipants: null,
  layoutConfig: null,
  trackInventory: false,
  inventoryMethod: null,
  unit: null,
  soldByWeight: false,
  active: true,
  availableFrom: null,
  availableUntil: null,
  deletedAt: null,
  deletedBy: null,
  externalId: null,
  externalData: null,
  originSystem: 'AVOQADO',
  syncStatus: 'NOT_REQUIRED',
  lastSyncAt: null,
  satProductKey: null,
  satUnitKey: null,
  objetoImp: '02',
  printStationId: null,
  creditCost: null,
  upfrontPolicy: 'inherit',
  isDemo: false,
  upsellEnabled: false,
  category: { id: categoryId, venueId, name: 'Bebidas', color: null, active: true, displayOrder: 1 },
  inventory: null,
  modifierGroups: [],
  recipe: null,
}

const legacyWriterReturn = {
  id: productId,
  createdById: '<internal-actor-id>',
  venueId,
  name: 'Café americano',
  sku: 'LEGACY-001',
  price: new Decimal('42.50'),
  categoryId,
  description: null,
  gtin: null,
  category: { id: categoryId, venueId, name: 'Bebidas', color: null, active: true, displayOrder: 1 },
  modifierGroups: [],
}

const legacyMobileProductReturn = {
  id: productId,
  createdById: '<internal-actor-id>',
  venueId,
  name: 'Café americano',
  description: null,
  sku: 'LEGACY-001',
  gtin: null,
  categoryId,
  price: new Decimal('42.50'),
  cost: null,
  taxRate: new Decimal('0.1600'),
  type: 'FOOD',
  imageUrl: null,
  displayOrder: 3,
  featured: false,
  tags: [],
  allergens: [],
  trackInventory: false,
  inventoryMethod: null,
  unit: null,
  soldByWeight: false,
  active: true,
  category: { id: categoryId, venueId, name: 'Bebidas', color: null, active: true, displayOrder: 1 },
  inventory: null,
  modifierGroups: [],
  recipe: null,
}

const dashboardProductQuery = {
  where: { venueId, deletedAt: null },
  include: {
    category: true,
    inventory: true,
    modifierGroups: {
      include: { group: { include: { modifiers: { where: { active: true } } } } },
      orderBy: { displayOrder: 'asc' },
    },
    recipe: {
      include: {
        lines: {
          include: {
            rawMaterial: {
              select: {
                id: true,
                name: true,
                sku: true,
                unit: true,
                currentStock: true,
                minimumStock: true,
                avgCostPerUnit: true,
                active: true,
              },
            },
          },
        },
      },
    },
  },
  orderBy: { displayOrder: 'asc' },
}

const mobileProductQuery = {
  where: { venueId, active: true, deletedAt: null },
  include: {
    category: true,
    inventory: true,
    modifierGroups: {
      include: { group: { include: { modifiers: { where: { active: true } } } } },
      orderBy: { displayOrder: 'asc' },
    },
    recipe: {
      include: {
        lines: { include: { rawMaterial: { select: { id: true, name: true, currentStock: true, unit: true } } } },
      },
    },
  },
  orderBy: [{ category: { displayOrder: 'asc' } }, { displayOrder: 'asc' }, { name: 'asc' }],
}

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const makeApp = () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).correlationId = correlationId
    // WHY: these real controllers require authenticated provenance; the contract
    // freezes only their legacy response envelope, never an unauthenticated call.
    ;(req as any).authContext = { userId: actorId, isImpersonating: false }
    next()
  })
  return app
}

const expectNoH1Fields = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(expectNoH1Fields)
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, nested] of Object.entries(value)) {
    expect(forbiddenH1Keys.has(key)).toBe(false)
    expectNoH1Fields(nested)
  }
}

const expectNoUnexpectedPrismaAccess = () => {
  const allowedModels = new Set(['product', 'activityLog'])
  for (const [modelName, model] of Object.entries(prismaMock)) {
    if (allowedModels.has(modelName) || !model || typeof model !== 'object') continue
    for (const operation of Object.values(model as Record<string, unknown>)) {
      if (typeof operation === 'function' && jest.isMockFunction(operation)) {
        expect(operation).not.toHaveBeenCalled()
      }
    }
  }
  for (const operation of ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']) {
    const query = prismaMock[operation]
    if (typeof query === 'function' && jest.isMockFunction(query)) expect(query).not.toHaveBeenCalled()
  }
}

beforeEach(() => jest.clearAllMocks())

describe('H1A legacy Product contracts', () => {
  it('freezes dashboard list/detail and drives the real create/update writer boundary without H1 relations or organization access', async () => {
    prismaMock.product.findMany.mockResolvedValue([legacyProductReturn])
    prismaMock.product.findFirst
      .mockResolvedValueOnce(legacyProductReturn)
      .mockResolvedValueOnce({ displayOrder: 3 })
      .mockResolvedValueOnce({
        ...legacyProductReturn,
        price: new Decimal('40'),
      })
    prismaMock.product.create.mockResolvedValue(legacyWriterReturn)
    prismaMock.product.update.mockResolvedValue(legacyWriterReturn)

    const app = makeApp()
    app.get('/venues/:venueId/products', dashboardProductController.getProductsHandler)
    app.get('/venues/:venueId/products/:productId', dashboardProductController.getProductHandler)
    app.post('/venues/:venueId/products', dashboardProductController.createProductHandler)
    app.put('/venues/:venueId/products/:productId', dashboardProductController.updateProductHandler)
    app.use(globalErrorHandler)

    const list = await request(app).get(`/venues/${venueId}/products`)
    const detail = await request(app).get(`/venues/${venueId}/products/${productId}`)
    const created = await request(app)
      .post(`/venues/${venueId}/products`)
      .send({ name: 'Café americano', sku: 'LEGACY-001', price: 42.5, type: 'FOOD', categoryId })
    const updated = await request(app).put(`/venues/${venueId}/products/${productId}`).send({ name: 'Café americano' })

    expect(list.status).toBe(dashboardFixture.list.status)
    expect(list.body).toEqual(dashboardFixture.list.body)
    expect(detail.status).toBe(dashboardFixture.detail.status)
    expect(detail.body).toEqual(dashboardFixture.detail.body)
    expect(created.status).toBe(dashboardFixture.create.status)
    expect(created.body).toEqual(dashboardFixture.create.body)
    expect(updated.status).toBe(dashboardFixture.update.status)
    expect(updated.body).toEqual(dashboardFixture.update.body)
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(dashboardProductQuery)
    expect(prismaMock.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Café americano',
        description: undefined,
        price: 42.5,
        type: 'FOOD',
        imageUrl: undefined,
        sku: 'LEGACY-001',
        gtin: undefined,
        categoryId,
        printStationId: null,
        venueId,
        createdById: actorId,
        displayOrder: 4,
        active: true,
        isAlcoholic: false,
        kitchenName: undefined,
        abbreviation: undefined,
        duration: undefined,
        soldByWeight: false,
        eventDate: undefined,
        eventTime: undefined,
        eventEndTime: undefined,
        eventCapacity: undefined,
        eventLocation: undefined,
        downloadUrl: undefined,
        downloadLimit: undefined,
        fileSize: undefined,
        suggestedAmounts: undefined,
        allowCustomAmount: true,
        donationCause: undefined,
        allowCreditRedemption: true,
        requireCreditForBooking: false,
        durationMinutes: undefined,
        modifierGroups: undefined,
      },
      include: { category: true, modifierGroups: { include: { group: true } } },
    })
    expect(prismaMock.product.update).toHaveBeenCalledWith({
      where: { id: productId },
      data: { name: 'Café americano' },
      include: { category: true, modifierGroups: { include: { group: true } } },
    })

    for (const response of [list.body, detail.body, created.body, updated.body]) {
      expect(response.data).not.toHaveProperty('createdById')
      expectNoH1Fields(response)
    }
    expectNoUnexpectedPrismaAccess()
  })

  it('freezes the dashboard not-found envelope through the actual global error handler', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null)
    const app = makeApp()
    app.get('/venues/:venueId/products/:productId', dashboardProductController.getProductHandler)
    app.use(globalErrorHandler)

    const response = await request(app).get(`/venues/${venueId}/products/${productId}`)

    expect(response.status).toBe(dashboardFixture.notFound.status)
    expect(response.body).toEqual(dashboardFixture.notFound.body)
    expectNoUnexpectedPrismaAccess()
  })

  it('freezes mobile list, create, update, and validation-error envelopes with exact legacy Prisma query shapes', async () => {
    prismaMock.product.findMany.mockResolvedValue([legacyMobileProductReturn])
    prismaMock.product.create.mockResolvedValue(legacyMobileProductReturn)
    prismaMock.product.findFirst.mockResolvedValue({ id: productId })
    prismaMock.product.update.mockResolvedValue(legacyMobileProductReturn)

    const app = makeApp()
    app.get('/venues/:venueId/products', mobileProductController.listProducts)
    app.post('/venues/:venueId/products', mobileProductController.createProduct)
    app.put('/venues/:venueId/products/:productId', mobileProductController.updateProduct)
    app.use(globalErrorHandler)

    const list = await request(app).get(`/venues/${venueId}/products`)
    const created = await request(app).post(`/venues/${venueId}/products`).send({ name: 'Café americano', categoryId, price: '42.5' })
    const updated = await request(app).put(`/venues/${venueId}/products/${productId}`).send({ name: 'Café americano' })
    const validationError = await request(app).post(`/venues/${venueId}/products`).send({ name: '   ' })

    expect(list.status).toBe(mobileFixture.list.status)
    expect(list.body).toEqual(mobileFixture.list.body)
    expect(created.status).toBe(mobileFixture.create.status)
    expect(created.body).toEqual(mobileFixture.create.body)
    expect(updated.status).toBe(mobileFixture.update.status)
    expect(updated.body).toEqual(mobileFixture.update.body)
    expect(validationError.status).toBe(mobileFixture.validationError.status)
    expect(validationError.body).toEqual(mobileFixture.validationError.body)
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(mobileProductQuery)
    expectNoH1Fields(list.body)
    expectNoH1Fields(created.body)
    expectNoH1Fields(updated.body)
    for (const response of [list.body, created.body, updated.body]) expect(response.data).not.toHaveProperty('createdById')
    expectNoUnexpectedPrismaAccess()
  })

  it('proves TPV is byte-compatible with the dashboard contract and covers its declared 500 error envelope', async () => {
    expect(tpvFixture.list).toEqual(dashboardFixture.list)
    expect(tpvMenuController.getProducts).toBe(dashboardProductController.getProductsHandler)
    prismaMock.product.findMany.mockResolvedValueOnce([legacyProductReturn]).mockRejectedValueOnce(new Error('database unavailable'))

    const app = makeApp()
    app.get('/venues/:venueId/products', tpvMenuController.getProducts)
    app.use(globalErrorHandler)

    const success = await request(app).get(`/venues/${venueId}/products`)
    const failure = await request(app).get(`/venues/${venueId}/products`)

    expect(success.status).toBe(tpvFixture.list.status)
    expect(success.body).toEqual(tpvFixture.list.body)
    expect(failure.status).toBe(tpvFixture.error.status)
    expect(failure.body).toEqual(tpvFixture.error.body)
    expect(prismaMock.product.findMany.mock.calls[0][0]).toEqual(dashboardProductQuery)
    expect(prismaMock.product.findMany.mock.calls[1][0]).toEqual(dashboardProductQuery)
    expectNoH1Fields(success.body)
    expectNoUnexpectedPrismaAccess()
    expect(tpvFixture.detail).toBeNull()
    expect(tpvFixture.create).toBeNull()
    expect(tpvFixture.update).toBeNull()
  })

  it('freezes v1 corporate-SKU normalization vectors without applying an H1 normalizer', () => {
    expect(jsonRoundTrip(identifierFixture)).toEqual({
      version: 'v1',
      scope: 'corporate-sku',
      rules: {
        unicodeNormalization: 'NFKC',
        trim: 'peripheral-whitespace-only',
        case: 'locale-neutral-uppercase',
        preserveLeadingZeroes: true,
        preserveInternalSpaces: true,
        preserveHyphens: true,
      },
      vectors: [
        { input: '  sku-001  ', normalized: 'SKU-001' },
        { input: '００１-ab', normalized: '001-AB' },
        { input: '  001 ab-c  ', normalized: '001 AB-C' },
        { input: 'i-ı-ß', normalized: 'I-I-SS' },
        { input: '  000  A-B  ', normalized: '000  A-B' },
      ],
    })
  })
})
