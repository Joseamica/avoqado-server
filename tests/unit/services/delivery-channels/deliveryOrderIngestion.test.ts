import { OrderSource, OrderType, OriginSystem, PaymentMethod, PaymentSource, TransactionStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { socketManager } from '../../../../src/communication/sockets/managers/socketManager'
import { SocketEventType } from '../../../../src/communication/sockets/types'
import { ingestDeliveryOrder } from '../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service'
import { dispatchOrderStatus } from '../../../../src/services/delivery-channels/core/statusDispatcher.service'
import { NormalizedDeliveryOrder } from '../../../../src/services/delivery-channels/core/types'

jest.mock('../../../../src/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('../../../../src/services/delivery-channels/core/statusDispatcher.service', () => ({
  dispatchOrderStatus: jest.fn(),
}))

const link: any = { id: 'link1', venueId: 'venue1', provider: 'DELIVERECT', orderAcceptanceMode: 'AUTO' }

const baseNormalized: NormalizedDeliveryOrder = {
  externalId: 'UE-1',
  displayId: 'A1',
  source: OrderSource.UBER_EATS,
  items: [{ plu: 'TACO', name: 'Taco', quantity: 2, unitPrice: 45, modifiers: [] }],
  subtotal: 90,
  taxAmount: 14.4,
  discountAmount: 0,
  tipAmount: 10,
  serviceChargeAmount: 0,
  deliveryFeeAmount: 0,
  total: 114.4,
  // Fix C4 (audit, spec §10.1.2): orderIsAlreadyPaid vive en el payload crudo del
  // proveedor (normalized.raw), no en un campo tipado de NormalizedDeliveryOrder —
  // ver el comentario en ingestDeliveryOrder. `true` = caso normal (agregadores casi
  // siempre cobran al cliente); los tests de Fix C4 abajo cubren false/ausente.
  raw: { any: 'payload', orderIsAlreadyPaid: true },
  placedAt: new Date('2026-07-18T12:00:00.000Z'),
}

function makeNormalized(overrides: Partial<NormalizedDeliveryOrder> = {}): NormalizedDeliveryOrder {
  return { ...baseNormalized, ...overrides }
}

const existingOrderRow = {
  id: 'order1',
  externalId: 'UE-1',
  orderNumber: 'A1',
  status: 'CONFIRMED',
  paymentStatus: 'PAID',
  source: OrderSource.UBER_EATS,
}

describe('ingestDeliveryOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma))
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'venue1', organizationId: 'org1', feeValue: 0.029 })
    // No existing order by default (fresh ingest)
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'prod1', sku: 'TACO', name: 'Taco' })
    ;(prisma.order.upsert as jest.Mock).mockResolvedValue(existingOrderRow)
    ;(prisma.orderItem.create as jest.Mock).mockResolvedValue({ id: 'item1' })
    ;(prisma.payment.count as jest.Mock).mockResolvedValue(0)
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'pay1', amount: 114.4 })
    ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({ id: 'alloc1' })
    // Placeholder category already exists by default (find-or-create path tested separately)
    ;(prisma.menuCategory.findUnique as jest.Mock).mockResolvedValue({ id: 'cat-placeholder', slug: 'delivery-desconocido' })
    ;(prisma.menuCategory.create as jest.Mock).mockResolvedValue({ id: 'cat-placeholder', slug: 'delivery-desconocido' })
    ;(prisma.product.create as jest.Mock).mockResolvedValue({ id: 'prod-placeholder' })
    ;(dispatchOrderStatus as jest.Mock).mockResolvedValue(undefined)
  })

  // ============================================================
  // 1. Crea Order tipo DELIVERY con los campos del canal
  // ============================================================
  it('crea un Order type DELIVERY con source del canal, originSystem DELIVERY_PLATFORM, externalId y posRawData', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_externalId: { venueId: 'venue1', externalId: 'UE-1' } },
        create: expect.objectContaining({
          externalId: 'UE-1',
          orderNumber: 'A1',
          source: OrderSource.UBER_EATS,
          originSystem: OriginSystem.DELIVERY_PLATFORM,
          type: OrderType.DELIVERY,
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          kitchenStatus: 'PENDING',
          posRawData: { any: 'payload', orderIsAlreadyPaid: true },
          createdAt: baseNormalized.placedAt,
        }),
      }),
    )

    const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
    expect(callArg.create.subtotal.toString()).toBe('90')
    expect(callArg.create.taxAmount.toString()).toBe('14.4')
    expect(callArg.create.total.toString()).toBe('114.4')
  })

  it('lanza si el venue del channel link no existe', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue(null)

    await expect(ingestDeliveryOrder(makeNormalized(), link)).rejects.toThrow('Venue venue1 del channel link no existe')
  })

  // ============================================================
  // 2. OrderItems con productId resuelto por sku
  // ============================================================
  it('crea OrderItems resolviendo productId por sku (Product venueId_sku)', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.product.findUnique).toHaveBeenCalledWith({ where: { venueId_sku: { venueId: 'venue1', sku: 'TACO' } } })
    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order1',
          productId: 'prod1',
          productName: 'Taco',
          productSku: 'TACO',
          quantity: 2,
          externalId: 'UE-1-TACO-0',
        }),
      }),
    )
  })

  it('OrderItem.total = unitPrice * quantity para items SIN modifiers (regresión)', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    const callArg = (prisma.orderItem.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.unitPrice.toString()).toBe('45')
    expect(callArg.data.total.toString()).toBe('90')
    expect(callArg.data.taxAmount.toString()).toBe('0')
  })

  it('OrderItem.total incluye el modifier × cantidad del padre y sum(líneas) == Order.subtotal (Fix C4, spec §10.1.4)', async () => {
    const normalized = makeNormalized({
      items: [
        {
          plu: 'TACO',
          name: 'Taco',
          quantity: 2,
          unitPrice: 45,
          modifiers: [{ plu: 'MOD-QUESO', name: 'Extra queso', quantity: 1, unitPrice: 10 }],
        },
        { plu: 'REFRESCO', name: 'Refresco', quantity: 1, unitPrice: 30, modifiers: [] },
      ],
      // 2×45 + (1×10 modifier × 2 cantidad del taco) + 30 = 140 — el modifier aplica a
      // CADA taco (Deliverect: cantidad_modificador × cantidad_producto), no una sola vez.
      subtotal: 140,
    })
    ;(prisma.product.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'prod1', sku: 'TACO', name: 'Taco' })
      .mockResolvedValueOnce({ id: 'prod2', sku: 'REFRESCO', name: 'Refresco' })

    await ingestDeliveryOrder(normalized, link)

    const totals = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => Number(c[0].data.total))
    expect(totals).toEqual([110, 30]) // línea Taco: 2×45 + (10×1×2) = 110, NO 100
    expect(totals.reduce((a: number, b: number) => a + b, 0)).toBe(normalized.subtotal)
  })

  // ============================================================
  // 3b. Modifiers visibles en cocina vía notes (v1 — sin OrderItemModifier rows)
  // ============================================================
  it('los modifiers aparecen en notes con formato "+ Nx Nombre" unidos con " | "', async () => {
    const normalized = makeNormalized({
      items: [
        {
          plu: 'TACO',
          name: 'Taco',
          quantity: 2,
          unitPrice: 45,
          modifiers: [
            { plu: 'MOD-QUESO', name: 'Extra queso', quantity: 1, unitPrice: 10 },
            { plu: 'MOD-SALSA', name: 'Salsa verde', quantity: 2, unitPrice: 0 },
          ],
        },
      ],
    })

    await ingestDeliveryOrder(normalized, link)

    const callArg = (prisma.orderItem.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.notes).toBe('+ 1x Extra queso | + 2x Salsa verde')
  })

  it('item con notes propio + modifiers: el notes propio va primero', async () => {
    const normalized = makeNormalized({
      items: [
        {
          plu: 'TACO',
          name: 'Taco',
          quantity: 2,
          unitPrice: 45,
          modifiers: [{ plu: 'MOD-QUESO', name: 'Extra queso', quantity: 1, unitPrice: 10 }],
          notes: 'Sin cebolla',
        },
      ],
    })

    await ingestDeliveryOrder(normalized, link)

    const callArg = (prisma.orderItem.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.notes).toBe('Sin cebolla | + 1x Extra queso')
  })

  it('item sin modifiers ni notes → notes queda undefined (regresión)', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    const callArg = (prisma.orderItem.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.notes).toBeUndefined()
  })

  it('crea un OrderItem por cada item normalizado', async () => {
    const normalized = makeNormalized({
      items: [
        { plu: 'TACO', name: 'Taco', quantity: 2, unitPrice: 45, modifiers: [] },
        { plu: 'REFRESCO', name: 'Refresco', quantity: 1, unitPrice: 20, modifiers: [] },
      ],
    })
    ;(prisma.product.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'prod1', sku: 'TACO', name: 'Taco' })
      .mockResolvedValueOnce({ id: 'prod2', sku: 'REFRESCO', name: 'Refresco' })

    await ingestDeliveryOrder(normalized, link)

    expect(prisma.orderItem.create).toHaveBeenCalledTimes(2)
  })

  // ============================================================
  // 3. Placeholder si el PLU no existe (find-or-create categoría delivery-desconocido)
  // ============================================================
  it('crea producto placeholder + categoría delivery-desconocido si el PLU no existe', async () => {
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.menuCategory.findUnique as jest.Mock).mockResolvedValue(null)

    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.menuCategory.findUnique).toHaveBeenCalledWith({
      where: { venueId_slug: { venueId: 'venue1', slug: 'delivery-desconocido' } },
    })
    expect(prisma.menuCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueId: 'venue1', slug: 'delivery-desconocido', active: false }),
      }),
    )
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueId: 'venue1', sku: 'TACO', name: 'Taco', categoryId: 'cat-placeholder', active: false }),
      }),
    )
    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: 'prod-placeholder' }) }),
    )
  })

  it('no vuelve a crear la categoría placeholder si ya existe (find-or-create)', async () => {
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValue(null)
    // menuCategory.findUnique ya resuelve a la categoría existente (default del beforeEach)

    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.menuCategory.create).not.toHaveBeenCalled()
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: 'cat-placeholder' }) }),
    )
  })

  // ============================================================
  // 4. Payment externo con todos los campos del brief
  // ============================================================
  it('crea un Payment externo con todos los campos (fee 0, processor del link, externalSource del canal)', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          method: PaymentMethod.OTHER,
          source: PaymentSource.DELIVERY_PLATFORM,
          externalSource: OrderSource.UBER_EATS,
          status: TransactionStatus.COMPLETED,
          processor: 'deliverect',
          originSystem: OriginSystem.DELIVERY_PLATFORM,
          externalId: 'UE-1-platform',
          posRawData: { any: 'payload', orderIsAlreadyPaid: true },
        }),
      }),
    )

    const callArg = (prisma.payment.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.amount.toString()).toBe('114.4')
    expect(callArg.data.tipAmount.toString()).toBe('10')
    expect(callArg.data.feePercentage.toString()).toBe('0')
    expect(callArg.data.feeAmount.toString()).toBe('0')
    expect(callArg.data.netAmount.toString()).toBe('114.4')
    expect(callArg.data.order).toEqual({ connect: { id: 'order1' } })
    expect(callArg.data.venue).toEqual({ connect: { id: 'venue1' } })
  })

  // ============================================================
  // 5. PaymentAllocation
  // ============================================================
  it('crea PaymentAllocation ligado al payment y a la orden por el monto completo', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.paymentAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 114.4,
          payment: { connect: { id: 'pay1' } },
          order: { connect: { id: 'order1' } },
        }),
      }),
    )
  })

  // ============================================================
  // 6. Idempotencia: orden existente → update, no duplica payments
  // ============================================================
  it('idempotencia: si la orden ya existe, hace update (no crea items/payment/allocation) y devuelve created:false', async () => {
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(existingOrderRow)

    const result = await ingestDeliveryOrder(makeNormalized(), link)

    expect(result.created).toBe(false)
    expect(prisma.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ posRawData: { any: 'payload', orderIsAlreadyPaid: true } }),
      }),
    )
    expect(prisma.orderItem.create).not.toHaveBeenCalled()
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.paymentAllocation.create).not.toHaveBeenCalled()
  })

  it('no duplica payments si ya existen pagos para la orden (carrera entre webhooks concurrentes)', async () => {
    ;(prisma.payment.count as jest.Mock).mockResolvedValue(1)

    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.paymentAllocation.create).not.toHaveBeenCalled()
    // La orden sigue siendo "nueva" → los items sí se procesan
    expect(prisma.orderItem.create).toHaveBeenCalled()
  })

  // ============================================================
  // 7. Socket post-tx con shape de posSync
  // ============================================================
  it('emite socket ORDER_CREATED después de la tx con el shape de posSync (incl. eventType)', async () => {
    const result = await ingestDeliveryOrder(makeNormalized(), link)

    expect(result.created).toBe(true)
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'venue1',
      SocketEventType.ORDER_CREATED,
      expect.objectContaining({
        orderId: 'order1',
        orderNumber: 'A1',
        venueId: 'venue1',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        source: OrderSource.UBER_EATS,
        externalId: 'UE-1',
        eventType: 'created',
        timestamp: expect.any(String),
      }),
    )
  })

  it('emite socket ORDER_UPDATED con eventType "updated" si la orden ya existía', async () => {
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(existingOrderRow)

    await ingestDeliveryOrder(makeNormalized(), link)

    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      'venue1',
      SocketEventType.ORDER_UPDATED,
      expect.objectContaining({ eventType: 'updated' }),
    )
  })

  // ============================================================
  // 8. Fallo de socket NO tumba la ingesta
  // ============================================================
  it('si el socket falla, la ingesta NO lanza y devuelve la orden igual (no fatal)', async () => {
    ;(socketManager.broadcastToVenue as jest.Mock).mockImplementation(() => {
      throw new Error('socket down')
    })

    await expect(ingestDeliveryOrder(makeNormalized(), link)).resolves.toEqual(
      expect.objectContaining({ created: true, order: expect.objectContaining({ id: 'order1' }) }),
    )
  })

  // ============================================================
  // 9. REGRESIÓN: fee siempre 0, nunca lee venue.feeValue
  // ============================================================
  it('REGRESIÓN: el fee es siempre 0 y NUNCA usa venue.feeValue (Avoqado no procesó el dinero)', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'venue1', organizationId: 'org1', feeValue: 0.5 })

    await ingestDeliveryOrder(makeNormalized(), link)

    const callArg = (prisma.payment.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.feePercentage.toString()).toBe('0')
    expect(callArg.data.feeAmount.toString()).toBe('0')
    expect(callArg.data.netAmount.toString()).toBe(callArg.data.amount.toString())
  })

  // ============================================================
  // 10. C1 (CRITICAL): PLU duplicado en el mismo pedido NO debe perder el pedido
  // ============================================================
  it('C1: mismo PLU en 2 líneas → 2 OrderItems con externalIds DISTINTOS (nunca choca @@unique([orderId, externalId]))', async () => {
    const normalized = makeNormalized({
      items: [
        { plu: 'TACO', name: 'Taco', quantity: 1, unitPrice: 45, modifiers: [] },
        {
          plu: 'TACO',
          name: 'Taco (extra queso)',
          quantity: 1,
          unitPrice: 45,
          modifiers: [{ plu: 'MOD-QUESO', name: 'Extra queso', quantity: 1, unitPrice: 10 }],
        },
      ],
      subtotal: 100, // 45 + (45+10)
    })

    await ingestDeliveryOrder(normalized, link)

    expect(prisma.orderItem.create).toHaveBeenCalledTimes(2)
    const externalIds = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data.externalId)
    expect(new Set(externalIds).size).toBe(2) // distintos — jamás el mismo `${externalId}-${plu}` para ambas líneas
    expect(externalIds).toEqual(['UE-1-TACO-0', 'UE-1-TACO-1'])

    const totals = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => Number(c[0].data.total))
    expect(totals.reduce((a: number, b: number) => a + b, 0)).toBe(normalized.subtotal)
  })

  it('C1: 2 items SIN PLU con nombres distintos → 2 placeholders con skus determinísticos DISTINTOS (nunca Date.now())', async () => {
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValue(null) // ningún PLU/sku existe en catálogo
    ;(prisma.product.create as jest.Mock).mockResolvedValueOnce({ id: 'prod-agua' }).mockResolvedValueOnce({ id: 'prod-coca' })
    const normalized = makeNormalized({
      items: [
        { plu: '', name: 'Agua mineral', quantity: 1, unitPrice: 20, modifiers: [] },
        { plu: '', name: 'Coca cola', quantity: 1, unitPrice: 25, modifiers: [] },
      ],
      subtotal: 45,
    })

    await ingestDeliveryOrder(normalized, link)

    const findSkus = (prisma.product.findUnique as jest.Mock).mock.calls.map((c: any[]) => c[0].where.venueId_sku.sku)
    expect(findSkus).toEqual(['delivery-unknown-agua-mineral', 'delivery-unknown-coca-cola'])
    expect(new Set(findSkus).size).toBe(2)

    const createSkus = (prisma.product.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data.sku)
    expect(createSkus).toEqual(['delivery-unknown-agua-mineral', 'delivery-unknown-coca-cola'])

    const productSkus = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data.productSku)
    expect(productSkus).toEqual(['delivery-unknown-agua-mineral', 'delivery-unknown-coca-cola'])
  })

  it('C1: item SIN PLU repetido en 2 pedidos distintos → el placeholder se REUSA (findUnique hit, create llamado 1 vez)', async () => {
    const placeholderProduct = { id: 'prod-agua-reused' }
    // Pedido 1: no existe todavía → se crea
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.product.create as jest.Mock).mockResolvedValueOnce(placeholderProduct)
    const order1 = makeNormalized({
      externalId: 'UE-1',
      items: [{ plu: '', name: 'Agua mineral', quantity: 1, unitPrice: 20, modifiers: [] }],
    })
    await ingestDeliveryOrder(order1, link)

    // Pedido 2: mismo nombre sin PLU → el sku determinístico coincide → findUnique lo encuentra, NO crea de nuevo
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValueOnce(placeholderProduct)
    ;(prisma.order.upsert as jest.Mock).mockResolvedValueOnce({ ...existingOrderRow, id: 'order2', externalId: 'UE-2' })
    const order2 = makeNormalized({
      externalId: 'UE-2',
      items: [{ plu: '', name: 'Agua mineral', quantity: 1, unitPrice: 20, modifiers: [] }],
    })
    await ingestDeliveryOrder(order2, link)

    expect(prisma.product.create).toHaveBeenCalledTimes(1) // NO se crea un placeholder nuevo por pedido
    const orderItemCalls = (prisma.orderItem.create as jest.Mock).mock.calls
    expect(orderItemCalls[0][0].data.productId).toBe('prod-agua-reused')
    expect(orderItemCalls[1][0].data.productId).toBe('prod-agua-reused')

    // La reutilización solo es real si ambos pedidos consultan la MISMA sku determinística
    // (si el fallback fuera `delivery-${Date.now()}`, la segunda búsqueda usaría otra key
    // y jamás encontraría el placeholder del pedido 1 en la DB real).
    const findSkus = (prisma.product.findUnique as jest.Mock).mock.calls.map((c: any[]) => c[0].where.venueId_sku.sku)
    expect(findSkus[0]).toBe(findSkus[1])
    expect(findSkus[0]).toBe('delivery-unknown-agua-mineral')
  })

  // ============================================================
  // 11. I2 (IMPORTANT): modo AUTO dispara el accept al canal tras ingesta exitosa
  // ============================================================
  it('I2: link AUTO + orden nueva (created:true) → dispatchOrderStatus llamado con (order, "ACCEPTED")', async () => {
    const result = await ingestDeliveryOrder(makeNormalized(), link) // link.orderAcceptanceMode = 'AUTO' (fixture)

    expect(result.created).toBe(true)
    expect(dispatchOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'order1' }), 'ACCEPTED')
  })

  it('I2: link MANUAL → dispatchOrderStatus NO se llama (aceptación manual queda para el staff)', async () => {
    const manualLink = { ...link, orderAcceptanceMode: 'MANUAL' }

    await ingestDeliveryOrder(makeNormalized(), manualLink)

    expect(dispatchOrderStatus).not.toHaveBeenCalled()
  })

  it('I2: orden ya existente (created:false, es un update) → dispatchOrderStatus NO se llama aunque el link sea AUTO', async () => {
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(existingOrderRow)

    const result = await ingestDeliveryOrder(makeNormalized(), link)

    expect(result.created).toBe(false)
    expect(dispatchOrderStatus).not.toHaveBeenCalled()
  })

  it('I2: si dispatchOrderStatus lanza/rechaza, la ingesta de todas formas retorna normal (defensa doble, no fatal)', async () => {
    ;(dispatchOrderStatus as jest.Mock).mockRejectedValue(new Error('Deliverect inalcanzable'))

    await expect(ingestDeliveryOrder(makeNormalized(), link)).resolves.toEqual(
      expect.objectContaining({ created: true, order: expect.objectContaining({ id: 'order1' }) }),
    )
  })

  // ============================================================
  // 12. Fix C4 (audit, MONEY, spec §10.1.5): serviceChargeAmount/deliveryFeeAmount se
  // normalizaban en el mapper pero nunca se escribían en el Order — quedaban en 0
  // aunque el `total` SÍ los incluía (pedido internamente inconsistente).
  // ============================================================
  it('Fix C4: persiste serviceChargeAmount y deliveryFeeAmount en el Order (antes se normalizaban pero nunca se escribían)', async () => {
    const normalized = makeNormalized({ serviceChargeAmount: 12.5, deliveryFeeAmount: 25 })

    await ingestDeliveryOrder(normalized, link)

    const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
    expect(callArg.create.serviceChargeAmount.toString()).toBe('12.5')
    expect(callArg.create.deliveryFeeAmount.toString()).toBe('25')
  })

  it('Fix C4: serviceChargeAmount/deliveryFeeAmount en 0 (default) se persisten como 0 explícito (regresión)', async () => {
    await ingestDeliveryOrder(makeNormalized(), link) // baseNormalized: ambos en 0

    const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
    expect(callArg.create.serviceChargeAmount.toString()).toBe('0')
    expect(callArg.create.deliveryFeeAmount.toString()).toBe('0')
  })

  // ============================================================
  // 13. Fix C4 (audit, MONEY, spec §10.1.2): orderIsAlreadyPaid — Deliverect manda
  // payment.amount para pedidos PAGADOS Y NO pagados. Antes: SIEMPRE se creaba un
  // Payment COMPLETED → un pedido no-pagado se volvía ingreso liquidado ficticio.
  // Fix conservador: SOLO orderIsAlreadyPaid === true crea el Payment.
  // ============================================================
  describe('Fix C4 — orderIsAlreadyPaid (spec §10.1.2)', () => {
    it('orderIsAlreadyPaid: true (default de baseNormalized) → crea Payment COMPLETED, Order.paymentStatus PAID', async () => {
      await ingestDeliveryOrder(makeNormalized(), link)

      expect(prisma.payment.create).toHaveBeenCalledTimes(1)
      expect(prisma.paymentAllocation.create).toHaveBeenCalledTimes(1)
      const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
      expect(callArg.create.paymentStatus).toBe('PAID')
    })

    it('orderIsAlreadyPaid: false → NO crea Payment ni PaymentAllocation, Order.paymentStatus PENDING (nunca ingreso fantasma)', async () => {
      const normalized = makeNormalized({ raw: { any: 'payload', orderIsAlreadyPaid: false } })

      await ingestDeliveryOrder(normalized, link)

      expect(prisma.payment.create).not.toHaveBeenCalled()
      expect(prisma.paymentAllocation.create).not.toHaveBeenCalled()
      const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
      expect(callArg.create.paymentStatus).toBe('PENDING')
      // La orden SÍ se confirma para cocina — el flujo de preparación es independiente del de dinero.
      expect(callArg.create.status).toBe('CONFIRMED')
    })

    it('orderIsAlreadyPaid ausente del payload → tratado como NO pagado (conservador, nunca asume pagado por default)', async () => {
      const normalized = makeNormalized({ raw: { any: 'payload' } }) // sin el campo

      await ingestDeliveryOrder(normalized, link)

      expect(prisma.payment.create).not.toHaveBeenCalled()
      const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
      expect(callArg.create.paymentStatus).toBe('PENDING')
    })

    it('orderIsAlreadyPaid: "true" (string, no boolean) → tratado como NO pagado (=== true estricto, nunca truthy laxo)', async () => {
      const normalized = makeNormalized({ raw: { any: 'payload', orderIsAlreadyPaid: 'true' } })

      await ingestDeliveryOrder(normalized, link)

      expect(prisma.payment.create).not.toHaveBeenCalled()
    })

    it('items SIEMPRE se procesan aunque orderIsAlreadyPaid sea false (el pedido no-pagado igual entra a cocina)', async () => {
      const normalized = makeNormalized({ raw: { any: 'payload', orderIsAlreadyPaid: false } })

      await ingestDeliveryOrder(normalized, link)

      expect(prisma.orderItem.create).toHaveBeenCalled()
    })
  })
})
