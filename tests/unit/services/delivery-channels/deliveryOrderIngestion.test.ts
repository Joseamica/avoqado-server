import { OrderSource, OrderType, OriginSystem, PaymentMethod, PaymentSource, PaymentStatus, TransactionStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { socketManager } from '../../../../src/communication/sockets/managers/socketManager'
import { SocketEventType } from '../../../../src/communication/sockets/types'
import { ingestDeliveryOrder } from '../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service'
import { dispatchOrderStatus } from '../../../../src/services/delivery-channels/core/statusDispatcher.service'
import { DeliveryMoneyMismatchError } from '../../../../src/services/delivery-channels/core/money'
import { NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '../../../../src/services/delivery-channels/core/types'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../../../../src/services/master-catalog/catalogGovernance.service'

jest.mock('../../../../src/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

// El tender del canal se auto-provisiona contra la base real; aquí sólo interesa que el
// Payment quede estampado con él (la provisión tiene su propio test de integración).
jest.mock('../../../../src/services/delivery-channels/core/deliveryTenderProvisioning.service', () => ({
  ensureDeliveryTenderType: jest.fn(async () => ({ id: 'tender-canal-1', revision: 1 })),
}))

jest.mock('../../../../src/services/delivery-channels/core/statusDispatcher.service', () => ({
  dispatchOrderStatus: jest.fn(),
}))

jest.mock('../../../../src/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn().mockResolvedValue(undefined),
  writeLegacyServiceProductCreationAuditForVenue: jest.fn().mockResolvedValue(undefined),
}))

const createSalePostingInTxMock = jest.fn()
const applySalePostingMock = jest.fn()
jest.mock('../../../../src/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: any[]) => createSalePostingInTxMock(...a),
  applySalePosting: (...a: any[]) => applySalePostingMock(...a),
}))

const link: any = { id: 'link1', venueId: 'venue1', provider: 'DELIVERECT', orderAcceptanceMode: 'AUTO' }

// Reparto por default: pagado 100% por la plataforma (nada por cobrar en persona) — el
// caso normal para un agregador. saleAmount 90 + merchantFees 0 = externallyPaidSale 90;
// tipAmount 10 = externallyPaidTip 10. cashDue* en 0 ⇒ Order.paymentStatus PAID.
const basePayment: NormalizedDeliveryPayment = {
  currency: 'MXN',
  saleAmount: '90.00',
  merchantFees: '0.00',
  tipAmount: '10.00',
  externallyPaidSale: '90.00',
  externallyPaidTip: '10.00',
  cashDueSale: '0.00',
  cashDueTip: '0.00',
}

const baseNormalized: NormalizedDeliveryOrder = {
  externalId: 'UE-1',
  displayId: 'A1',
  source: OrderSource.UBER_EATS,
  items: [{ externalId: 'TACO', name: 'Taco', quantity: 2, unitPrice: '45.00', total: '90.00', modifiers: [] }],
  payment: basePayment,
  raw: { any: 'payload' },
  placedAt: new Date('2026-07-18T12:00:00.000Z'),
}

function makeNormalized(overrides: Partial<NormalizedDeliveryOrder> = {}): NormalizedDeliveryOrder {
  return { ...baseNormalized, ...overrides }
}

function makePayment(overrides: Partial<NormalizedDeliveryPayment> = {}): NormalizedDeliveryPayment {
  return { ...basePayment, ...overrides }
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
    // La consulta que resuelve la CATEGORÍA de cada renglón, para poder rutear la comanda a
    // su estación (tacos a cocina, cerveza a barra). El código la envuelve en try/catch —una
    // falla aquí no puede tumbar la ingesta de un pedido ya pagado— pero el camino feliz sí
    // tiene que devolver filas, o el ruteo se probaría siempre en su modo degradado.
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([{ id: 'prod1', categoryId: 'cat1' }])
    ;(prisma.order.upsert as jest.Mock).mockResolvedValue(existingOrderRow)
    // Devuelve la fila COMPLETA (como Prisma): el vale de inventario se arma con
    // los renglones recién creados, así que necesita id + productId + cantidad.
    ;(prisma.orderItem.create as jest.Mock).mockResolvedValue({
      id: 'item1',
      productId: 'prod1',
      productName: 'Taco',
      quantity: 2,
      weightQuantity: null,
    })
    ;(prisma.payment.count as jest.Mock).mockResolvedValue(0)
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'pay1', amount: 90 })
    ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({ id: 'alloc1' })
    // Placeholder category already exists by default (find-or-create path tested separately)
    ;(prisma.menuCategory.findUnique as jest.Mock).mockResolvedValue({ id: 'cat-placeholder', slug: 'delivery-desconocido' })
    ;(prisma.menuCategory.create as jest.Mock).mockResolvedValue({ id: 'cat-placeholder', slug: 'delivery-desconocido' })
    ;(prisma.product.create as jest.Mock).mockResolvedValue({ id: 'prod-placeholder' })
    ;(dispatchOrderStatus as jest.Mock).mockResolvedValue(undefined)
    createSalePostingInTxMock.mockResolvedValue({ id: 'posting-del-1', status: 'PENDING' })
    applySalePostingMock.mockResolvedValue({ postingId: 'posting-del-1', applied: true, issues: [] })
  })

  // ============================================================
  // 1. Crea Order tipo DELIVERY con los campos del canal
  // ============================================================
  it('crea un Order type DELIVERY con source del canal, originSystem DELIVERY_PLATFORM, externalId y posRawData', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_externalId: { venueId: 'venue1', externalId: 'DELIVERECT:UE-1' } },
        create: expect.objectContaining({
          externalId: 'DELIVERECT:UE-1',
          orderNumber: 'A1',
          source: OrderSource.UBER_EATS,
          originSystem: OriginSystem.DELIVERY_PLATFORM,
          type: OrderType.DELIVERY,
          status: 'CONFIRMED',
          paymentStatus: PaymentStatus.PAID,
          kitchenStatus: 'PENDING',
          posRawData: { any: 'payload' },
          createdAt: baseNormalized.placedAt,
        }),
      }),
    )

    const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
    // subtotal/total ya NO se derivan de los items — vienen de payment.saleAmount/merchantFees.
    expect(callArg.create.subtotal.toString()).toBe('90')
    expect(callArg.create.taxAmount.toString()).toBe('0') // México: IVA incluido, nunca fuente fiscal el del proveedor
    expect(callArg.create.total.toString()).toBe('90') // saleAmount + merchantFees, SIN propina
    expect(callArg.create.tipAmount.toString()).toBe('10')
  })

  it('lanza si el venue del channel link no existe', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue(null)

    await expect(ingestDeliveryOrder(makeNormalized(), link)).rejects.toThrow('Venue venue1 del channel link no existe')
  })

  // ============================================================
  // 2. OrderItems con productId resuelto por sku (externalId del canal)
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
          externalId: 'DELIVERECT:UE-1-TACO-0',
        }),
      }),
    )
  })

  it('usa externalData como SKU local y conserva externalId como id del proveedor', async () => {
    const rappiLink = { ...link, provider: 'RAPPI' }
    const normalized = makeNormalized({
      externalId: 'RAPPI-ORDER-1',
      items: [
        {
          externalId: 'rappi-item-729970',
          externalData: 'SKU-AVOQADO-0007',
          name: 'Producto 8',
          quantity: 2,
          unitPrice: '45.00',
          total: '90.00',
          modifiers: [],
        },
      ],
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.product.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args.where?.venueId_sku?.sku === 'SKU-AVOQADO-0007' ? { id: 'prod-rappi' } : null,
    )

    await ingestDeliveryOrder(normalized, rappiLink)

    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 'prod-rappi',
          productSku: 'SKU-AVOQADO-0007',
          externalId: 'RAPPI:RAPPI-ORDER-1-rappi-item-729970-0',
        }),
      }),
    )
    expect(prisma.product.create).not.toHaveBeenCalled()
  })

  it('unitPrice/total de la línea pasan TAL CUAL del contrato normalizado, sin recomputar (el mapper ya hizo la cuenta)', async () => {
    // total (110) deliberadamente distinto de unitPrice×quantity (90) — si el servicio
    // recomputara localmente en vez de confiar en el mapper, este test lo detectaría.
    // payment.saleAmount sube a 110 para cuadrar con el total real del item (Hallazgo 2).
    const normalized = makeNormalized({
      items: [{ externalId: 'TACO', name: 'Taco', quantity: 2, unitPrice: '45.00', total: '110.00', modifiers: [] }],
      payment: makePayment({ saleAmount: '110.00', externallyPaidSale: '110.00' }),
    })

    await ingestDeliveryOrder(normalized, link)

    const callArg = (prisma.orderItem.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.unitPrice.toString()).toBe('45')
    expect(callArg.data.total.toString()).toBe('110')
    expect(callArg.data.taxAmount.toString()).toBe('0')
  })

  // ============================================================
  // 3b. Modifiers → filas OrderItemModifier reales (contrato unificado; ya NO texto en notes)
  // ============================================================
  it('crea una fila OrderItemModifier por cada modifier del item, con name/quantity/price', async () => {
    const normalized = makeNormalized({
      items: [
        {
          externalId: 'TACO',
          name: 'Taco',
          quantity: 2,
          unitPrice: '45.00',
          total: '110.00',
          modifiers: [
            { externalId: 'MOD-QUESO', name: 'Extra queso', quantity: 1, price: '20.00' },
            { externalId: 'MOD-SALSA', name: 'Salsa verde', quantity: 2, price: '0.00' },
          ],
        },
      ],
      // payment.saleAmount cuadra con el total del item (Hallazgo 2).
      payment: makePayment({ saleAmount: '110.00', externallyPaidSale: '110.00' }),
    })

    await ingestDeliveryOrder(normalized, link)

    expect(prisma.orderItemModifier.create).toHaveBeenCalledTimes(2)
    expect(prisma.orderItemModifier.create).toHaveBeenNthCalledWith(1, {
      data: { orderItemId: 'item1', modifierId: null, name: 'Extra queso', quantity: 1, price: expect.anything() },
    })
    const firstCallPrice = (prisma.orderItemModifier.create as jest.Mock).mock.calls[0][0].data.price
    expect(firstCallPrice.toString()).toBe('20')
    const secondCallPrice = (prisma.orderItemModifier.create as jest.Mock).mock.calls[1][0].data.price
    expect(secondCallPrice.toString()).toBe('0')
  })

  it('item sin modifiers → no crea ninguna fila OrderItemModifier (regresión)', async () => {
    await ingestDeliveryOrder(makeNormalized(), link) // baseNormalized: modifiers: []

    expect(prisma.orderItemModifier.create).not.toHaveBeenCalled()
  })

  it('crea un OrderItem por cada item normalizado', async () => {
    const normalized = makeNormalized({
      items: [
        { externalId: 'TACO', name: 'Taco', quantity: 2, unitPrice: '45.00', total: '90.00', modifiers: [] },
        { externalId: 'REFRESCO', name: 'Refresco', quantity: 1, unitPrice: '20.00', total: '20.00', modifiers: [] },
      ],
      // Dos líneas suman 110 — payment.saleAmount cuadra con eso (Hallazgo 2).
      payment: makePayment({ saleAmount: '110.00', externallyPaidSale: '110.00' }),
    })
    ;(prisma.product.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'prod1', sku: 'TACO', name: 'Taco' })
      .mockResolvedValueOnce({ id: 'prod2', sku: 'REFRESCO', name: 'Refresco' })

    await ingestDeliveryOrder(normalized, link)

    expect(prisma.orderItem.create).toHaveBeenCalledTimes(2)
  })

  // ============================================================
  // 3. Placeholder si el sku no existe (find-or-create categoría delivery-desconocido)
  // ============================================================
  it('crea producto placeholder + categoría delivery-desconocido si el sku no existe', async () => {
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
    expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        venueId: 'venue1',
        productId: 'prod-placeholder',
        actor: { type: 'SERVICE', servicePrincipalId: 'DELIVERY_INGESTION' },
      }),
    )
  })

  it('reuses a placeholder created while waiting for the Venue fence without duplicate create/audit', async () => {
    ;(prisma.product.findUnique as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'prod-concurrent', sku: 'TACO', name: 'Taco concurrente' })

    await ingestDeliveryOrder(makeNormalized(), link)

    expect(assertLegacyCatalogGovernanceForVenue).toHaveBeenCalled()
    expect(prisma.product.create).not.toHaveBeenCalled()
    expect(writeLegacyServiceProductCreationAuditForVenue).not.toHaveBeenCalled()
    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: 'prod-concurrent' }) }),
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
          externalId: 'DELIVERECT:UE-1-platform',
          posRawData: { any: 'payload' },
        }),
      }),
    )

    const callArg = (prisma.payment.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.amount.toString()).toBe('90')
    expect(callArg.data.tipAmount.toString()).toBe('10')
    expect(callArg.data.feePercentage.toString()).toBe('0')
    expect(callArg.data.feeAmount.toString()).toBe('0')
    expect(callArg.data.netAmount.toString()).toBe('90')
    expect(callArg.data.order).toEqual({ connect: { id: 'order1' } })
    expect(callArg.data.venue).toEqual({ connect: { id: 'venue1' } })
  })

  // ============================================================
  // 4b. 🔴 EL BUG QUE ESTE CAMBIO MATA — la propina ya NO se cuenta dos veces
  // ============================================================
  it('🔴 Payment.amount es la venta SIN propina; la propina va sólo en tipAmount (antes: amount=230, tipAmount=30 — doble conteo)', async () => {
    const normalized = makeNormalized({
      // items debe cuadrar contra el nuevo saleAmount (Hallazgo 2: assertDeliveryMoneyInvariants
      // ahora también compara saleAmount contra la suma de las líneas).
      items: [{ externalId: 'TACO', name: 'Taco', quantity: 2, unitPrice: '100.00', total: '200.00', modifiers: [] }],
      payment: makePayment({
        saleAmount: '200.00',
        merchantFees: '0.00',
        tipAmount: '30.00',
        externallyPaidSale: '200.00',
        externallyPaidTip: '30.00',
        cashDueSale: '0.00',
        cashDueTip: '0.00',
      }),
    })

    await ingestDeliveryOrder(normalized, link)

    const callArg = (prisma.payment.create as jest.Mock).mock.calls[0][0]
    expect(callArg.data.amount.toString()).toBe('200') // la venta, SIN la propina
    expect(callArg.data.tipAmount.toString()).toBe('30') // la propina, aparte
    expect(callArg.data.netAmount.toString()).toBe('200') // netAmount consistente con amount
  })

  it('🔴 rechaza un pedido cuyo reparto de dinero no cuadra, sin tocar la base (ni venue.findUnique)', async () => {
    const malo = makeNormalized({
      payment: makePayment({
        saleAmount: '100.00',
        merchantFees: '0.00',
        tipAmount: '0.00',
        externallyPaidSale: '99.00', // 100 ≠ 99 + 0 — no cuadra
        externallyPaidTip: '0.00',
        cashDueSale: '0.00',
        cashDueTip: '0.00',
      }),
    })

    await expect(ingestDeliveryOrder(malo, link)).rejects.toThrow(DeliveryMoneyMismatchError)

    expect(prisma.venue.findUnique).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.order.upsert).not.toHaveBeenCalled()
  })

  // ============================================================
  // 5. PaymentAllocation
  // ============================================================
  it('crea PaymentAllocation ligado al payment y a la orden por el monto completo', async () => {
    await ingestDeliveryOrder(makeNormalized(), link)

    expect(prisma.paymentAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 90,
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
        update: expect.objectContaining({ posRawData: { any: 'payload' } }),
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
  // 6b. Inventario: el pedido pagado DESCUENTA del almacén (fase 5.8)
  // ============================================================
  describe('inventario — el pedido pagado descuenta del almacén', () => {
    it('un pedido YA PAGADO (nada por cobrar en persona) deja vale CON sus renglones (no SKIPPED)', async () => {
      await ingestDeliveryOrder(makeNormalized(), link)

      expect(createSalePostingInTxMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ venueId: 'venue1', orderId: 'order1' }),
      )
      const params = createSalePostingInTxMock.mock.calls[0][1]
      expect(params.skipReason).toBeUndefined()
      // Los renglones tienen que ser los OrderItem REALES recién creados: con
      // una lista vacía el vale nacería SKIPPED y no descontaría nada.
      expect(params.items).toEqual([expect.objectContaining({ id: 'item1', productId: 'prod1', quantity: 2 })])
    })

    it('aplica el vale DESPUÉS del commit, no dentro de la transacción', async () => {
      let aplicadoDentroDeLaTx = false
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
        const r = await fn(prisma)
        aplicadoDentroDeLaTx = applySalePostingMock.mock.calls.length > 0
        return r
      })

      await ingestDeliveryOrder(makeNormalized(), link)

      expect(aplicadoDentroDeLaTx).toBe(false)
      // staffId null a propósito: un pedido de agregador no lo cobró nadie del
      // negocio. Inventar un actor falsearía la atribución del movimiento.
      expect(applySalePostingMock).toHaveBeenCalledWith('posting-del-1', null)
    })

    it('un pedido con saldo por cobrar en persona (NO pagado en su totalidad) todavía no deja vale', async () => {
      const normalized = makeNormalized({
        payment: makePayment({
          externallyPaidSale: '0.00',
          externallyPaidTip: '0.00',
          cashDueSale: '90.00',
          cashDueTip: '10.00',
        }),
      })

      await ingestDeliveryOrder(normalized, link)

      expect(createSalePostingInTxMock).not.toHaveBeenCalled()
    })

    it('un webhook repetido sobre una orden existente no abre un segundo vale', async () => {
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(existingOrderRow)

      await ingestDeliveryOrder(makeNormalized(), link)

      expect(createSalePostingInTxMock).not.toHaveBeenCalled()
    })

    it('si aplicar el vale truena, la ingesta NO se cae (el pedido ya está pagado)', async () => {
      applySalePostingMock.mockRejectedValueOnce(new Error('pool agotado'))

      await expect(ingestDeliveryOrder(makeNormalized(), link)).resolves.toBeDefined()
    })
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
  // 10. C1 (CRITICAL): sku duplicado en el mismo pedido NO debe perder el pedido
  // ============================================================
  it('C1: mismo sku en 2 líneas → 2 OrderItems con externalIds DISTINTOS (nunca choca @@unique([orderId, externalId]))', async () => {
    const normalized = makeNormalized({
      items: [
        { externalId: 'TACO', name: 'Taco', quantity: 1, unitPrice: '45.00', total: '45.00', modifiers: [] },
        {
          externalId: 'TACO',
          name: 'Taco (extra queso)',
          quantity: 1,
          unitPrice: '45.00',
          total: '55.00',
          modifiers: [{ externalId: 'MOD-QUESO', name: 'Extra queso', quantity: 1, price: '10.00' }],
        },
      ],
      // 45 + 55 = 100 — payment.saleAmount cuadra con eso (Hallazgo 2).
      payment: makePayment({ saleAmount: '100.00', externallyPaidSale: '100.00' }),
    })

    await ingestDeliveryOrder(normalized, link)

    expect(prisma.orderItem.create).toHaveBeenCalledTimes(2)
    const externalIds = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data.externalId)
    expect(new Set(externalIds).size).toBe(2) // distintos — jamás el mismo `${externalId}-${sku}` para ambas líneas
    expect(externalIds).toEqual(['DELIVERECT:UE-1-TACO-0', 'DELIVERECT:UE-1-TACO-1'])

    const totals = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => Number(c[0].data.total))
    expect(totals).toEqual([45, 55])
  })

  it('C1: 2 items SIN externalId con nombres distintos → 2 placeholders con skus determinísticos DISTINTOS (nunca Date.now())', async () => {
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValue(null) // ningún sku existe en catálogo
    ;(prisma.product.create as jest.Mock).mockResolvedValueOnce({ id: 'prod-agua' }).mockResolvedValueOnce({ id: 'prod-coca' })
    const normalized = makeNormalized({
      items: [
        { externalId: '', name: 'Agua mineral', quantity: 1, unitPrice: '20.00', total: '20.00', modifiers: [] },
        { externalId: '', name: 'Coca cola', quantity: 1, unitPrice: '25.00', total: '25.00', modifiers: [] },
      ],
      // 20 + 25 = 45 — payment.saleAmount cuadra con eso (Hallazgo 2).
      payment: makePayment({ saleAmount: '45.00', externallyPaidSale: '45.00' }),
    })

    await ingestDeliveryOrder(normalized, link)

    const findSkus = (prisma.product.findUnique as jest.Mock).mock.calls.map((c: any[]) => c[0].where.venueId_sku.sku)
    expect(findSkus).toEqual([
      'delivery-unknown-agua-mineral',
      'delivery-unknown-agua-mineral',
      'delivery-unknown-coca-cola',
      'delivery-unknown-coca-cola',
    ])
    expect(new Set(findSkus).size).toBe(2)

    const createSkus = (prisma.product.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data.sku)
    expect(createSkus).toEqual(['delivery-unknown-agua-mineral', 'delivery-unknown-coca-cola'])

    const productSkus = (prisma.orderItem.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data.productSku)
    expect(productSkus).toEqual(['delivery-unknown-agua-mineral', 'delivery-unknown-coca-cola'])
  })

  it('C1: item SIN externalId repetido en 2 pedidos distintos → el placeholder se REUSA (findUnique hit, create llamado 1 vez)', async () => {
    const placeholderProduct = { id: 'prod-agua-reused' }
    // Pedido 1: no existe todavía → se crea
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    ;(prisma.product.create as jest.Mock).mockResolvedValueOnce(placeholderProduct)
    // payment.saleAmount cuadra con el total del item ($20, Hallazgo 2) en los dos pedidos.
    const order1 = makeNormalized({
      externalId: 'UE-1',
      items: [{ externalId: '', name: 'Agua mineral', quantity: 1, unitPrice: '20.00', total: '20.00', modifiers: [] }],
      payment: makePayment({ saleAmount: '20.00', externallyPaidSale: '20.00' }),
    })
    await ingestDeliveryOrder(order1, link)

    // Pedido 2: mismo nombre sin externalId → el sku determinístico coincide → findUnique lo encuentra, NO crea de nuevo
    ;(prisma.product.findUnique as jest.Mock).mockResolvedValueOnce(placeholderProduct)
    ;(prisma.order.upsert as jest.Mock).mockResolvedValueOnce({ ...existingOrderRow, id: 'order2', externalId: 'UE-2' })
    const order2 = makeNormalized({
      externalId: 'UE-2',
      items: [{ externalId: '', name: 'Agua mineral', quantity: 1, unitPrice: '20.00', total: '20.00', modifiers: [] }],
      payment: makePayment({ saleAmount: '20.00', externallyPaidSale: '20.00' }),
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
    expect(new Set(findSkus)).toEqual(new Set(['delivery-unknown-agua-mineral']))
    expect(findSkus[0]).toBe('delivery-unknown-agua-mineral')
  })

  // ============================================================
  // 11. I2 (IMPORTANT): modo AUTO dispara el accept al canal tras ingesta exitosa
  // ============================================================
  it('I2: link AUTO + orden nueva (created:true) → dispatchOrderStatus con el LINK que ya tenemos', async () => {
    const result = await ingestDeliveryOrder(makeNormalized(), link) // link.orderAcceptanceMode = 'AUTO' (fixture)

    expect(result.created).toBe(true)
    // 🔴 El tercer argumento no es adorno: sin él, el despachador vuelve a buscar el canal
    // en la base y NO lo encuentra, porque el evento se liga a la orden DESPUÉS de esta
    // ingesta. Era una carrera que producía un warning en cada pedido de Uber.
    expect(dispatchOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'order1' }), 'ACCEPTED', link)
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
  // 12. Reparto de dinero — Payment/paymentStatus (contrato unificado, Tarea 2/3)
  //
  // Sustituye al viejo `orderIsAlreadyPaid` (leído de un campo crudo de Deliverect,
  // `normalized.raw`): con el reparto explícito, "¿hay pago de plataforma?" se
  // contesta con externallyPaidSale + externallyPaidTip > 0, sin cast a `any`.
  // ============================================================
  describe('reparto de dinero — reemplaza al viejo orderIsAlreadyPaid', () => {
    it('pago externo > 0 (default) → crea Payment COMPLETED, Order.paymentStatus PAID', async () => {
      await ingestDeliveryOrder(makeNormalized(), link)

      expect(prisma.payment.create).toHaveBeenCalledTimes(1)
      expect(prisma.paymentAllocation.create).toHaveBeenCalledTimes(1)
      const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
      expect(callArg.create.paymentStatus).toBe(PaymentStatus.PAID)
    })

    it('sin pago externo (todo por cobrar en persona) → NO crea Payment ni PaymentAllocation, Order.paymentStatus PENDING (nunca ingreso fantasma)', async () => {
      const normalized = makeNormalized({
        payment: makePayment({ externallyPaidSale: '0.00', externallyPaidTip: '0.00', cashDueSale: '90.00', cashDueTip: '10.00' }),
      })

      await ingestDeliveryOrder(normalized, link)

      expect(prisma.payment.create).not.toHaveBeenCalled()
      expect(prisma.paymentAllocation.create).not.toHaveBeenCalled()
      const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
      expect(callArg.create.paymentStatus).toBe(PaymentStatus.PENDING)
      // La orden SÍ se confirma para cocina — el flujo de preparación es independiente del de dinero.
      expect(callArg.create.status).toBe('CONFIRMED')
    })

    it('pago parcial (algo externo + algo por cobrar) → Order.paymentStatus PARTIAL, SÍ crea Payment por lo ya liquidado', async () => {
      const normalized = makeNormalized({
        payment: makePayment({
          saleAmount: '90.00',
          externallyPaidSale: '50.00',
          externallyPaidTip: '10.00',
          cashDueSale: '40.00',
          cashDueTip: '0.00',
        }),
      })

      await ingestDeliveryOrder(normalized, link)

      const callArg = (prisma.order.upsert as jest.Mock).mock.calls[0][0]
      expect(callArg.create.paymentStatus).toBe(PaymentStatus.PARTIAL)
      expect(prisma.payment.create).toHaveBeenCalledTimes(1)
      const paymentArg = (prisma.payment.create as jest.Mock).mock.calls[0][0]
      expect(paymentArg.data.amount.toString()).toBe('50')
      expect(paymentArg.data.tipAmount.toString()).toBe('10')
      // Parcial: SIGUE sin descontar inventario — sólo cuando queda en 0 lo por cobrar.
      expect(createSalePostingInTxMock).not.toHaveBeenCalled()
    })

    it('items SIEMPRE se procesan aunque no haya pago externo todavía (el pedido no-pagado igual entra a cocina)', async () => {
      const normalized = makeNormalized({
        payment: makePayment({ externallyPaidSale: '0.00', externallyPaidTip: '0.00', cashDueSale: '90.00', cashDueTip: '10.00' }),
      })

      await ingestDeliveryOrder(normalized, link)

      expect(prisma.orderItem.create).toHaveBeenCalled()
    })
  })

  // ── Reingesta de un pedido CANCELADO ────────────────────────────────────────────────
  //
  // 🔴 La guarda de la comanda pasó de `isNew` a `!comandaYaExiste` para reponer la comanda
  // de un pedido que sí sigue vivo (webhooks at-least-once). Pero cancelar BORRA las filas de
  // KDS, así que en la reingesta de un pedido ya cancelado `comandaYaExiste` vuelve a ser
  // false y se imprimía una comanda NUEVA: la cocina prepara comida que nadie va a recoger, y
  // el ticket ya no sale del tablero por ninguna vía de cancelación (el upsert conserva
  // `status: CANCELLED`). Falta la tercera pregunta: ¿el pedido sigue vivo?
  it('🔴 NO imprime comanda al reingerir un pedido CANCELADO', async () => {
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ ...existingOrderRow, status: 'CANCELLED' })
    ;(prisma.order.upsert as jest.Mock).mockResolvedValue({ ...existingOrderRow, status: 'CANCELLED' })
    ;(prisma.kdsOrder.count as jest.Mock).mockResolvedValue(0) // cancelar borró las filas de KDS

    const r: any = await ingestDeliveryOrder(makeNormalized() as never, link as never)

    expect(prisma.kdsOrder.create).not.toHaveBeenCalled()
    expect(r.kitchenTicketCreated).toBe(false)
  })

  // El processor de Uber decide si CANCELAR el pedido a partir de esto. Antes miraba
  // `created` ("la orden no existía"), que es otra pregunta: en cualquier reproceso valía
  // false y desarmaba la red de seguridad de las notas de alergia. Lo que necesita saber es
  // si HAY comanda, ahora, la haya creado esta pasada o una anterior.
  it('🔴 informa si HAY comanda (no si la orden era nueva)', async () => {
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(existingOrderRow)
    ;(prisma.order.upsert as jest.Mock).mockResolvedValue(existingOrderRow)
    ;(prisma.kdsOrder.count as jest.Mock).mockResolvedValue(1) // ya existe de una pasada previa

    const r: any = await ingestDeliveryOrder(makeNormalized() as never, link as never)

    expect(r.hayComanda).toBe(true) // aunque `created` sea false y no se creara ahora
    expect(prisma.kdsOrder.create).not.toHaveBeenCalled()
  })

  // ── Promociones ─────────────────────────────────────────────────────────────────────
  //
  // 🔴 Como en cualquier POS: la venta guarda el BRUTO y el descuento va en su propio campo
  // (`Order.discountAmount`, que ya existía y esta ingesta no llenaba). Square define las
  // ventas brutas SIN ajustar por descuentos y las netas como la resta; Fudo lleva
  // «Descuentos ($)» como línea propia del reporte. Así el dueño ve cuánto le costaron sus
  // promociones, en vez de encontrarse una venta más chica sin explicación.
  //
  // México: los montos vienen con IVA incluido, así que el descuento se resta sobre el precio
  // con impuesto — no se reconstruye una base sin él.
  it('🔴 guarda la promoción como descuento y baja el total', async () => {
    const conPromo = makeNormalized({
      payment: makePayment({
        saleAmount: '90.00', // bruto: cuadra con los renglones
        discountAmount: '20.00',
        externallyPaidSale: '70.00', // lo que la plataforma liquida
      }),
    })

    await ingestDeliveryOrder(conPromo as never, link as never)

    const creado = (prisma.order.upsert as jest.Mock).mock.calls[0][0].create
    expect(String(creado.subtotal)).toBe('90') // el bruto no se toca
    expect(String(creado.discountAmount)).toBe('20') // visible, en su campo
    expect(String(creado.total)).toBe('70') // 90 − 20: lo que se cobró
  })

  it('sin promoción el total no cambia (el caso de siempre)', async () => {
    await ingestDeliveryOrder(makeNormalized() as never, link as never)
    const creado = (prisma.order.upsert as jest.Mock).mock.calls[0][0].create
    expect(String(creado.discountAmount)).toBe('0')
    expect(String(creado.total)).toBe('90')
  })
})
