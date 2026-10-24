// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

// El finalizador de Stripe hace `new Stripe(...)` para leer el cargo; sin connectAccountId ni lo llama (casi todas las
// pruebas). La del tipo del cargo (Codex r1, 19-oct) sí lo necesita.
const retrieveStripePi = jest.fn()
const createStripePi = jest.fn()
const createStripeHosted = jest.fn()
jest.mock('@/services/superadmin/platformSettings.service', () => ({ getVatRateBps: jest.fn().mockResolvedValue(1600) }))
jest.mock('@/services/mercado-pago/connection.service', () => ({
  loadCredentials: jest.fn().mockResolvedValue({ accessToken: 'fixture', publicKey: 'fixture', expiresAt: new Date('2099-01-01') }),
}))
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    paymentIntents: { retrieve: retrieveStripePi, create: createStripePi },
    checkout: { sessions: { create: createStripeHosted } },
  })),
}))

// Mock nanoid before imports
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'abc12345'),
}))

// Mock Blumon E-commerce service
const mockBlumonService = {
  tokenizeCard: jest.fn().mockResolvedValue({
    token: 'tok_test_123',
    maskedPan: '424242******4242',
    cardBrand: 'VISA',
  }),
  authorizePayment: jest.fn().mockResolvedValue({
    transactionId: 'txn_test_123',
    authorizationCode: 'AUTH123',
  }),
}

jest.mock('@/services/sdk/blumon-ecommerce.service', () => ({
  getBlumonEcommerceService: jest.fn(() => mockBlumonService),
}))

// Mock inventory deduction
const mockDeductInventory = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: mockDeductInventory,
}))

// El outbox durable de inventario se mockea para poder observar CON QUÉ cliente
// de transacción nace el vale (el invariante "orden PAID ⟺ posting existe") y
// que el aplicador corra DESPUÉS del commit, nunca dentro.
const mockCreateSalePostingInTx = jest.fn()
const mockApplySalePosting = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => mockCreateSalePostingInTx(...a),
  applySalePosting: (...a: unknown[]) => mockApplySalePosting(...a),
}))

// Lealtad y métricas del cliente: se mockean los DOS servicios compartidos que
// ya usan TPV y el pago manual. Lo que esta suite prueba es el CABLEADO del
// canal (que se disparen, con qué base y contra qué orden), no la aritmética de
// puntos — ésa vive en loyalty.dashboard.service.test.ts y duplicarla aquí
// permitiría que las dos versiones se separen sin que nadie se entere.
const mockEarnPoints = jest.fn()
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: (...a: unknown[]) => mockEarnPoints(...a),
}))

const mockUpdateCustomerMetrics = jest.fn()
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  updateCustomerMetrics: (...a: unknown[]) => mockUpdateCustomerMetrics(...a),
}))

// Fase 3 (A5): la comisión de la liga se encola DENTRO de la transacción del cobro. El resto del módulo queda real.
const mockEnqueuePaymentCommissionInTx = jest.fn()
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: (...a: unknown[]) => mockEnqueuePaymentCommissionInTx(...a),
}))

import { createPaymentLink, updatePaymentLink, getPaymentLinks } from '../../../../src/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

const VENUE = 'venue-123'
const STAFF = 'staff-123'
const DISC = 'cm00000000000000000000001'
const merchants = [{ id: 'merchant-123', chargesEnabled: true, providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } }]
const fila = (o: Record<string, any> = {}) => ({
  id: DISC,
  name: 'Mayo',
  type: 'PERCENTAGE',
  value: new Decimal(15),
  scope: 'ORDER',
  requiresApproval: false,
  isAutomatic: false,
  buyQuantity: null,
  getQuantity: null,
  getDiscountPercent: null,
  buyItemIds: [],
  getItemIds: [],
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  customerGroupId: null,
  active: true,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  ...o,
})
const fixed = (amount: number, discount: any) => ({ title: 'Anticipo', amountType: 'FIXED' as const, amount, purpose: 'PAYMENT' as const, discount })
const MANUAL15 = { mode: 'MANUAL' as const, type: 'PERCENTAGE' as const, value: 15 }
const CAT = { mode: 'CATALOG' as const, discountId: DISC }

beforeEach(() => {
  prismaMock.ecommerceMerchant.findMany.mockResolvedValue(merchants as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.paymentLink.create.mockResolvedValue({ id: 'pl-1', shortCode: 'abc12345' } as any)
})

describe('crear liga con descuento', () => {
  it('descuento del catálogo de otro venue → 404', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(null)
    await expect(createPaymentLink(VENUE, fixed(100, CAT), STAFF)).rejects.toThrow(NotFoundError)
    expect(prismaMock.discount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DISC, venueId: VENUE } }))
  })

  it.each([
    [{ scope: 'ITEM' }, 'Es solo para ciertos productos o categorías'],
    [{ type: 'COMP' }, 'Es una cortesía'],
    [{ requiresApproval: true }, 'Pide autorización de un gerente'],
    [{ isAutomatic: true }, 'Se aplica solo en el POS'],
    [{ buyQuantity: 2 }, 'Es una promoción de tipo 2×1'],
    [{ maxUsesPerCustomer: 1 }, 'Tiene límite por cliente: escríbelo a mano'],
    [{ customerGroupId: 'g1' }, 'Es solo para un grupo de clientes'],
    [{ maxTotalUses: 5 }, 'Tiene límite de usos: escríbelo a mano'],
  ])('incompatible %j → 400 con la razón de esCompatibleConLigas', async (cambio, razon) => {
    prismaMock.discount.findFirst.mockResolvedValue(fila(cambio) as any)
    await expect(createPaymentLink(VENUE, fixed(100, CAT), STAFF)).rejects.toMatchObject({ message: razon, statusCode: 400 })
  })

  it.each([
    [{ active: false }, 'Este descuento está apagado'],
    [{ validFrom: new Date(Date.now() + 86_400_000) }, 'Este descuento aún no empieza'],
    [{ validUntil: new Date(Date.now() - 86_400_000) }, 'Este descuento ya venció'],
  ])('vigencia %j → 400', async (cambio, mensaje) => {
    const f = fila(cambio) as any
    prismaMock.discount.findFirst.mockResolvedValue(f)
    prismaMock.discount.findUnique.mockResolvedValue(f)
    await expect(createPaymentLink(VENUE, fixed(100, CAT), STAFF)).rejects.toMatchObject({ message: mensaje, statusCode: 400 })
    expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
  })

  it('catálogo vigente: guarda la foto con name/type/value del catálogo y discountId', async () => {
    const f = fila() as any
    prismaMock.discount.findFirst.mockResolvedValue(f)
    prismaMock.discount.findUnique.mockResolvedValue(f)
    await createPaymentLink(VENUE, fixed(100, CAT), STAFF)
    const data = (prismaMock.paymentLink.create.mock.calls[0][0] as any).data
    expect(data.discount).toEqual({ v: 1, origen: 'CATALOGO', discountId: DISC, type: 'PERCENTAGE', value: 15, name: 'Mayo' })
    expect(data.discountId).toBe(DISC)
  })

  it('liga fija $100 con −$150 → 400', async () => {
    await expect(
      createPaymentLink(VENUE, fixed(100, { mode: 'MANUAL', type: 'FIXED_AMOUNT', value: 150 }), STAFF),
    ).rejects.toMatchObject({ message: 'El descuento es mayor o igual que el importe de la liga', statusCode: 400 })
  })

  it('importe abierto con −$150 se acepta (se valida al pagar)', async () => {
    await createPaymentLink(
      VENUE,
      { title: 'Abierta', amountType: 'OPEN', purpose: 'PAYMENT', discount: { mode: 'MANUAL', type: 'FIXED_AMOUNT', value: 150 } },
      STAFF,
    )
    expect((prismaMock.paymentLink.create.mock.calls[0][0] as any).data.discount.value).toBe(150)
  })

  it('ITEM con total 1000 y 15 % → guarda la foto manual', async () => {
    prismaMock.product.findMany
      .mockResolvedValueOnce([{ id: 'p1', modifierGroups: [] }] as any) // validateBundleItems
      .mockResolvedValueOnce([{ id: 'p1', price: new Decimal(500) }] as any) // precios para la base
    await createPaymentLink(
      VENUE,
      { title: 'Paquete', amountType: 'FIXED', amount: 1000, purpose: 'ITEM', items: [{ productId: 'p1', quantity: 2 }], discount: MANUAL15 },
      STAFF,
    )
    const data = (prismaMock.paymentLink.create.mock.calls[0][0] as any).data
    expect(data.discount).toEqual({ v: 1, origen: 'MANUAL', type: 'PERCENTAGE', value: 15, name: 'Descuento', discountId: null })
    expect(data.discountId).toBeNull()
  })

  it('sin descuento no escribe nada nuevo', async () => {
    await createPaymentLink(VENUE, { title: 'x', amountType: 'FIXED', amount: 100, purpose: 'PAYMENT' }, STAFF)
    const data = (prismaMock.paymentLink.create.mock.calls[0][0] as any).data
    expect(data.discount).toBeUndefined()
    expect(data.discountId).toBeNull()
  })
})

describe('editar liga con descuento', () => {
  const existing = (o: Record<string, any> = {}) => ({
    id: 'pl-1',
    venueId: VENUE,
    status: 'ACTIVE',
    customerId: null,
    purpose: 'PAYMENT',
    amountType: 'FIXED',
    amount: new Decimal(100),
    isReusable: false,
    discount: null,
    ...o,
  })
  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.paymentLink.update.mockResolvedValue({ id: 'pl-1' } as any)
  })

  it('poner descuento escribe foto y discountId', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(existing() as any)
    await updatePaymentLink(VENUE, 'pl-1', { discount: MANUAL15 })
    const data = (prismaMock.paymentLink.update.mock.calls[0][0] as any).data
    expect(data.discount).toMatchObject({ origen: 'MANUAL', value: 15 })
    expect(data.discountId).toBeNull()
  })

  it('cambiar a uno del catálogo guarda su discountId', async () => {
    const f = fila() as any
    prismaMock.paymentLink.findUnique.mockResolvedValue(existing() as any)
    prismaMock.discount.findFirst.mockResolvedValue(f)
    prismaMock.discount.findUnique.mockResolvedValue(f)
    await updatePaymentLink(VENUE, 'pl-1', { discount: CAT })
    const data = (prismaMock.paymentLink.update.mock.calls[0][0] as any).data
    expect(data.discountId).toBe(DISC)
  })

  it('discount: null limpia discount y discountId', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      existing({ discount: { v: 1, origen: 'MANUAL', discountId: null, type: 'PERCENTAGE', value: 15, name: 'D' } }) as any,
    )
    await updatePaymentLink(VENUE, 'pl-1', { discount: null })
    const data = (prismaMock.paymentLink.update.mock.calls[0][0] as any).data
    expect(data.discountId).toBeNull()
    expect(data.discount).toBeDefined()
    expect(String(data.discount)).toContain('JsonNull')
  })

  it('bajar el importe por debajo del descuento fijo existente → 400', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(
      existing({ discount: { v: 1, origen: 'MANUAL', discountId: null, type: 'FIXED_AMOUNT', value: 80, name: 'D' } }) as any,
    )
    await expect(updatePaymentLink(VENUE, 'pl-1', { amount: 50 })).rejects.toThrow(BadRequestError)
  })

  it('foto conservada ya vencida + cambio de importe → se guarda (la vigencia no bloquea)', async () => {
    const foto = { v: 1, origen: 'CATALOGO', discountId: DISC, type: 'PERCENTAGE', value: 15, name: 'Mayo' }
    prismaMock.paymentLink.findUnique.mockResolvedValue(existing({ discount: foto }) as any)
    prismaMock.discount.findUnique.mockResolvedValue(fila({ validUntil: new Date(Date.now() - 86_400_000) }) as any)
    await updatePaymentLink(VENUE, 'pl-1', { amount: 200 })
    expect(prismaMock.paymentLink.update).toHaveBeenCalled()
  })

  it('foto conservada con compra mínima mayor al nuevo importe → 400 con el mínimo', async () => {
    const foto = { v: 1, origen: 'CATALOGO', discountId: DISC, type: 'PERCENTAGE', value: 15, name: 'Mayo' }
    prismaMock.paymentLink.findUnique.mockResolvedValue(existing({ discount: foto }) as any)
    prismaMock.discount.findUnique.mockResolvedValue(fila({ minPurchaseAmount: new Decimal(500) }) as any)
    await expect(updatePaymentLink(VENUE, 'pl-1', { amount: 200 })).rejects.toMatchObject({
      message: 'Este descuento pide una compra mínima de $500.00',
      statusCode: 400,
    })
  })

  it('liga archivada → 400 aunque traiga descuento', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(existing({ status: 'ARCHIVED' }) as any)
    await expect(updatePaymentLink(VENUE, 'pl-1', { discount: MANUAL15 })).rejects.toThrow(BadRequestError)
  })
})

describe('lista con descuento', () => {
  it('descuento del catálogo ya vencido → discountStatus VENCIDO (una sola consulta de Discount)', async () => {
    const foto = { v: 1, origen: 'CATALOGO', discountId: DISC, type: 'PERCENTAGE', value: 15, name: 'Mayo' }
    prismaMock.paymentLink.findMany.mockResolvedValue([
      { id: 'a', amount: new Decimal(100), discount: foto },
      { id: 'b', amount: new Decimal(100), discount: { ...foto, origen: 'MANUAL', discountId: null } },
      { id: 'c', amount: new Decimal(100), discount: null },
    ] as any)
    prismaMock.paymentLink.count.mockResolvedValue(3)
    prismaMock.discount.findMany.mockResolvedValue([fila({ validUntil: new Date(Date.now() - 86_400_000) })] as any)
    const r = await getPaymentLinks(VENUE)
    expect(r.paymentLinks.map(l => l.discountStatus)).toEqual(['VENCIDO', 'OK', null])
    expect(r.paymentLinks[0].discount).toEqual({ name: 'Mayo', type: 'PERCENTAGE', value: 15, origen: 'CATALOGO' })
    expect(r.paymentLinks[2].discount).toBeNull()
    expect(prismaMock.discount.findMany).toHaveBeenCalledTimes(1)
  })
})
