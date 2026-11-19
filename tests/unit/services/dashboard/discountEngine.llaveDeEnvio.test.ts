/**
 * D21 (pizarrón hz:e82938e1:D21) · llave por envío al aplicar un descuento desde la TPV.
 *
 * TPV SOLA -> ÓRDENES: si se pierde la respuesta de aplicar (sin red a media llamada, el transporte reenvía, la caja lo vuelve a
 * tocar), la TPV manda OTRA VEZ la misma llave. Con esa llave el SERVIDOR contesta el envío que ya se hizo y no crea otra fila (antes
 * quedaban dos filas reales: descuento doble). La constancia vive en `IdempotencyRequest`, escrita en la MISMA transacción que la fila,
 * así que sobrevive a que alguien quite la rebaja después (Codex D16 r4 #5). Sin llave, todo como hoy (TPV vieja, POS, panel).
 */
import { DiscountType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { applyDiscountToOrder, applyManualDiscount } from '../../../../src/services/dashboard/discountEngine.service'
import { prismaMock } from '../../../__helpers__/setup'

const cuenta = (extra: Record<string, unknown> = {}) => ({
  id: 'order-123',
  venueId: 'venue-123',
  customerId: null,
  subtotal: new Decimal(100),
  taxAmount: new Decimal(16),
  discountAmount: new Decimal(0),
  tipAmount: new Decimal(0),
  total: new Decimal(116),
  paidAmount: new Decimal(0),
  paymentStatus: 'PENDING',
  items: [],
  orderDiscounts: [],
  ...extra,
})

const delCatalogo = {
  discountId: 'd1',
  name: 'Cliente frecuente',
  type: 'PERCENTAGE' as DiscountType,
  value: 10,
  amount: 10,
  taxReduction: 1.6,
  applicableItems: [],
  isAutomatic: false,
  requiresApproval: false,
}

const reglaDelCatalogo = {
  id: 'd1',
  venueId: 'venue-123',
  name: 'Cliente frecuente',
  description: null,
  type: 'PERCENTAGE',
  value: new Decimal(10),
  scope: 'ORDER',
  targetItemIds: [],
  targetCategoryIds: [],
  targetModifierIds: [],
  targetModifierGroupIds: [],
  customerGroupId: null,
  isAutomatic: false,
  priority: 0,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  minQuantity: null,
  buyQuantity: null,
  getQuantity: null,
  getDiscountPercent: null,
  buyItemIds: [],
  getItemIds: [],
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  requiresApproval: false,
  compReason: null,
  applyBeforeTax: true,
  modifyTaxBasis: true,
  isStackable: false,
  stackPriority: 0,
  active: true,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// La constancia que guardó el primer envío (firma = qué descuento era).
const constancia = (firma: string, orderDiscountId: string, monto: number, expira = Date.now() + 3_600_000) => ({
  id: 'idem-1',
  requestHash: require('crypto').createHash('sha256').update(firma).digest('hex'),
  responseStatus: 200,
  responseBody: { orderDiscountId, amount: monto },
  expiresAt: new Date(expira),
})

// El mock común no trae `IdempotencyRequest`: se agrega aquí, igual que en command-idempotency.test.ts.
;(prismaMock as any).idempotencyRequest = {
  findUnique: jest.fn(),
  create: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-123' }])
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<any>) => callback(prismaMock))
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
})

describe('D21: manual / cortesía con llave de envío', () => {
  it('la primera vez crea la fila y deja la constancia en la MISMA transacción', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuenta() as any)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null)
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1', amount: new Decimal(10) } as any)
    prismaMock.order.update.mockResolvedValue(cuenta() as any)

    const r = await applyManualDiscount(
      'order-123',
      'FIXED_AMOUNT',
      10,
      '$10',
      'sv-1',
      undefined,
      undefined,
      'venue-123',
      false,
      undefined,
      'llave-0001',
    )

    expect(r).toMatchObject({ success: true, orderDiscountId: 'od-1', amount: 10 })
    expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          endpoint: 'POST /tpv/orders/order-123/discounts',
          idempotencyKey: 'llave-0001',
          responseStatus: 200,
          responseBody: { orderDiscountId: 'od-1', amount: 10 },
        }),
      }),
    )
  })

  it('la misma llave otra vez contesta el envío que ya se hizo y no crea otra fila ni toca la cuenta', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuenta({ discountAmount: new Decimal(10), total: new Decimal(106) }) as any)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(constancia('manual:FIXED_AMOUNT:10', 'od-1', 10) as any)

    const r = await applyManualDiscount(
      'order-123',
      'FIXED_AMOUNT',
      10,
      '$10',
      'sv-1',
      undefined,
      undefined,
      'venue-123',
      false,
      undefined,
      'llave-0001',
    )

    expect(r).toEqual({ success: true, orderDiscountId: 'od-1', amount: 10, newOrderTotal: 106, repetida: true })
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('la constancia sobrevive a que alguien quite la rebaja: el reenvío NO la vuelve a aplicar', async () => {
    // La fila ya no existe (otra caja la quitó), pero la constancia sí: el envío ya se había hecho.
    prismaMock.order.findUnique.mockResolvedValue(cuenta() as any)
    prismaMock.orderDiscount.findFirst.mockResolvedValue(null)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(constancia('manual:FIXED_AMOUNT:10', 'od-1', 10) as any)

    const r = await applyManualDiscount(
      'order-123',
      'FIXED_AMOUNT',
      10,
      '$10',
      'sv-1',
      undefined,
      undefined,
      'venue-123',
      false,
      undefined,
      'llave-0001',
    )

    expect(r).toMatchObject({ success: true, orderDiscountId: 'od-1', repetida: true })
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('con la cuenta ya pagada, la misma llave sigue contestando el envío (no «cuenta pagada»)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuenta({ paymentStatus: 'PAID', total: new Decimal(106) }) as any)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(constancia('manual:FIXED_AMOUNT:10', 'od-1', 10) as any)

    const r = await applyManualDiscount(
      'order-123',
      'FIXED_AMOUNT',
      10,
      '$10',
      'sv-1',
      undefined,
      undefined,
      'venue-123',
      false,
      undefined,
      'llave-0001',
    )

    expect(r).toEqual({ success: true, orderDiscountId: 'od-1', amount: 10, newOrderTotal: 106, repetida: true })
  })

  it('la misma llave con OTRO descuento se rechaza en español y no crea nada', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuenta() as any)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(constancia('manual:FIXED_AMOUNT:10', 'od-1', 10) as any)

    const r = await applyManualDiscount(
      'order-123',
      'FIXED_AMOUNT',
      20,
      '$20',
      'sv-1',
      undefined,
      undefined,
      'venue-123',
      false,
      undefined,
      'llave-0001',
    )

    expect(r).toMatchObject({ success: false, error: 'Esa llave ya se usó para otro descuento de esta cuenta.' })
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('una constancia vencida se borra y el envío se atiende como nuevo', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuenta() as any)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(
      constancia('manual:FIXED_AMOUNT:10', 'od-viejo', 10, Date.now() - 1000) as any,
    )
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-2', amount: new Decimal(10) } as any)
    prismaMock.order.update.mockResolvedValue(cuenta() as any)

    const r = await applyManualDiscount(
      'order-123',
      'FIXED_AMOUNT',
      10,
      '$10',
      'sv-1',
      undefined,
      undefined,
      'venue-123',
      false,
      undefined,
      'llave-0001',
    )

    expect(r).toMatchObject({ success: true, orderDiscountId: 'od-2' })
    expect(prismaMock.idempotencyRequest.delete).toHaveBeenCalledWith({ where: { id: 'idem-1' } })
  })

  // Regresión: sin llave, ni se busca ni se guarda constancia (TPV vieja, POS, panel).
  it('sin llave no busca constancia y crea como hoy', async () => {
    prismaMock.order.findUnique.mockResolvedValue(cuenta() as any)
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-2', amount: new Decimal(10) } as any)
    prismaMock.order.update.mockResolvedValue(cuenta() as any)

    const r = await applyManualDiscount('order-123', 'FIXED_AMOUNT', 10, '$10', 'sv-1')

    expect(r.success).toBe(true)
    expect(prismaMock.idempotencyRequest.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
  })
})

describe('D21: descuento del catálogo con llave de envío', () => {
  it('la primera vez crea la fila y deja la constancia', async () => {
    prismaMock.discount.findMany.mockResolvedValue([reglaDelCatalogo] as any)
    prismaMock.order.findUnique.mockResolvedValue(cuenta() as any)
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null)
    prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-c', ...delCatalogo } as any)
    prismaMock.order.update.mockResolvedValue(cuenta() as any)
    prismaMock.discount.update.mockResolvedValue({} as any)

    const r = await applyDiscountToOrder('order-123', delCatalogo, 'sv-1', undefined, undefined, false, 'llave-0002')

    expect(r).toMatchObject({ success: true, orderDiscountId: 'od-c' })
    expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: 'llave-0002', responseBody: { orderDiscountId: 'od-c', amount: 10 } }),
      }),
    )
  })

  it('la misma llave otra vez contesta el envío (antes: «Discount already applied to this order»)', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      cuenta({ discountAmount: new Decimal(10), total: new Decimal(106), orderDiscounts: [{ id: 'od-c', discountId: 'd1' }] }) as any,
    )
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(constancia('catalogo:d1', 'od-c', 10) as any)

    const r = await applyDiscountToOrder('order-123', 'd1', 'sv-1', undefined, 'venue-123', false, 'llave-0002')

    expect(r).toEqual({ success: true, orderDiscountId: 'od-c', amount: 10, newOrderTotal: 106, repetida: true })
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
    expect(prismaMock.discount.update).not.toHaveBeenCalled()
  })
})
