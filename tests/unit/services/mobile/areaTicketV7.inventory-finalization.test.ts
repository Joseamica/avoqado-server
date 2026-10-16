import { AreaTicketCheckoutStatus, AreaTicketInventoryTarget, AreaTicketPaymentAttemptStatus, Prisma } from '@prisma/client'

import { finalizeAreaTicketPaymentInTransaction } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'venue-inventory'
const orderId = 'order-paid'
const sessionId = 'checkout-session'
const attemptId = 'payment-attempt'

function sqlText(query: unknown): string {
  if (Array.isArray(query)) return query.join(' ')
  if (query && typeof query === 'object' && 'strings' in query) {
    return Array.from((query as { strings: readonly string[] }).strings).join(' ')
  }
  return String(query)
}

function primePaidCheckout() {
  prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue({
    id: sessionId,
    orderId,
    status: AreaTicketCheckoutStatus.PAYMENT_PENDING,
  })
  prismaMock.areaTicket.findMany.mockResolvedValue([])
  prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PAID', status: 'COMPLETED' })
  prismaMock.areaTicketPaymentAttempt.findFirst.mockResolvedValue({
    id: attemptId,
    status: AreaTicketPaymentAttemptStatus.PENDING,
    paymentId: null,
  })
  prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
  prismaMock.areaTicketInventoryReservation.aggregate.mockResolvedValue({ _sum: { quantityBaseUnits: null } })
  prismaMock.areaTicketPaymentAttempt.update.mockResolvedValue({})
  prismaMock.areaTicketCheckoutSession.update.mockResolvedValue({})
}

function finalize() {
  return finalizeAreaTicketPaymentInTransaction(prismaMock, {
    venueId,
    orderId,
    paymentId: 'payment-paid',
    fullyPaid: true,
    staffId: 'staff-paid',
    locked: { sessionId, attemptId },
  })
}

describe('AreaTicket v7 inventory finalization', () => {
  beforeEach(() => {
    primePaidCheckout()
  })

  it('rechaza atómicamente una línea NONE cuando no hay stock libre al finalizar', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-none',
        areaTicketLineId: 'line-none',
        quantity: 2,
        weightQuantity: null,
        product: {
          id: 'product-none',
          name: 'Producto NONE',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-none' },
          recipe: null,
        },
        modifiers: [],
      },
    ])
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      if (sqlText(query).includes('FROM "Inventory"')) {
        return [{ id: 'inventory-none', currentStock: new Prisma.Decimal('1.000') }]
      }
      return []
    })

    await expect(finalize()).rejects.toMatchObject({ code: 'AREA_TICKET_INSUFFICIENT_STOCK' })

    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: AreaTicketCheckoutStatus.PAID }) }),
    )
  })

  it('protege reservas ACTIVE de otros vales cuando una línea normal comparte inventario', async () => {
    const currentReservation = {
      id: 'reservation-current',
      areaTicketLineId: 'line-held',
      inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
      inventoryId: 'inventory-shared',
      quantityBaseUnits: new Prisma.Decimal('2.000'),
    }
    prismaMock.areaTicketInventoryReservation.findMany.mockImplementation(async ({ where }: any) => {
      if (where.areaTicket?.checkoutSessionId) return [currentReservation]
      return [currentReservation]
    })
    prismaMock.areaTicketInventoryReservation.aggregate.mockResolvedValue({
      _sum: { quantityBaseUnits: new Prisma.Decimal('4.000') },
    })
    prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'movement-reservation' })
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-held',
        areaTicketLineId: 'line-held',
        quantity: 2,
        weightQuantity: null,
        product: {
          id: 'product-shared',
          name: 'Producto reservado',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-shared' },
          recipe: null,
        },
        modifiers: [],
      },
      {
        id: 'item-normal',
        areaTicketLineId: null,
        quantity: 5,
        weightQuantity: null,
        product: {
          id: 'product-shared',
          name: 'Producto de caja',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-shared' },
          recipe: null,
        },
        modifiers: [],
      },
    ])
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('UPDATE "Inventory"')) {
        return [
          {
            id: 'inventory-shared',
            currentStock: new Prisma.Decimal('8.000'),
            previousStock: new Prisma.Decimal('10.000'),
          },
        ]
      }
      if (sql.includes('FROM "Inventory"')) {
        // Hay 8 físicas, pero 4 pertenecen a otro vale: sólo 4 están libres.
        return [{ id: 'inventory-shared', currentStock: new Prisma.Decimal('8.000') }]
      }
      return []
    })

    await expect(finalize()).rejects.toMatchObject({ code: 'AREA_TICKET_INSUFFICIENT_STOCK' })
  })

  it('bloquea la unión de reservas y líneas normales en un único orden determinista', async () => {
    const rawReservation = {
      id: 'reservation-z',
      areaTicketLineId: 'line-z',
      inventoryKind: AreaTicketInventoryTarget.RAW_MATERIAL,
      inventoryId: 'raw-z',
      quantityBaseUnits: new Prisma.Decimal('1.000'),
    }
    prismaMock.areaTicketInventoryReservation.findMany.mockImplementation(async ({ where }: any) => {
      if (where.areaTicket?.checkoutSessionId) return [rawReservation]
      return []
    })
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-a',
        areaTicketLineId: null,
        quantity: 1,
        weightQuantity: null,
        product: {
          id: 'product-a',
          name: 'Producto A',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-a' },
          recipe: null,
        },
        modifiers: [],
      },
    ])
    prismaMock.areaTicketInventoryReservation.aggregate.mockResolvedValue({
      _sum: { quantityBaseUnits: new Prisma.Decimal('0.000') },
    })
    prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'movement-a' })
    prismaMock.rawMaterialMovement.create.mockResolvedValue({ id: 'movement-z' })

    const footprintLocks: string[] = []
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('SELECT id') && sql.includes('FROM "Inventory"')) {
        footprintLocks.push('QUANTITY_INVENTORY')
        return [{ id: 'inventory-a', currentStock: new Prisma.Decimal('5.000') }]
      }
      if (sql.includes('SELECT id') && sql.includes('FROM "RawMaterial"')) {
        footprintLocks.push('RAW_MATERIAL')
        return [{ id: 'raw-z', currentStock: new Prisma.Decimal('5.000'), unit: 'KILOGRAM' }]
      }
      if (sql.includes('FROM "StockBatch"')) {
        return [
          {
            id: 'batch-z',
            remainingQuantity: new Prisma.Decimal('5.000'),
            costPerUnit: new Prisma.Decimal('1.000'),
          },
        ]
      }
      if (sql.includes('UPDATE "Inventory"')) {
        return [
          {
            id: 'inventory-a',
            currentStock: new Prisma.Decimal('4.000'),
            previousStock: new Prisma.Decimal('5.000'),
          },
        ]
      }
      return []
    })

    await expect(finalize()).resolves.toEqual({ areaTicketOrder: true, sessionId })

    expect(footprintLocks.slice(0, 2)).toEqual(['QUANTITY_INVENTORY', 'RAW_MATERIAL'])
  })

  it('consume el remanente cuando una reserva legacy cubre sólo parte de la demanda de la línea', async () => {
    const partialReservation = {
      id: 'reservation-partial',
      areaTicketLineId: 'line-partial',
      inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
      inventoryId: 'inventory-partial',
      quantityBaseUnits: new Prisma.Decimal('2.000'),
    }
    prismaMock.areaTicketInventoryReservation.findMany.mockImplementation(async ({ where }: any) => {
      if (where.areaTicket?.checkoutSessionId) return [partialReservation]
      return [partialReservation]
    })
    prismaMock.areaTicketInventoryReservation.aggregate.mockResolvedValue({ _sum: { quantityBaseUnits: null } })
    prismaMock.inventoryMovement.create
      .mockResolvedValueOnce({ id: 'movement-reservation' })
      .mockResolvedValueOnce({ id: 'movement-remainder' })
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-partial',
        areaTicketLineId: 'line-partial',
        quantity: 3,
        weightQuantity: null,
        product: {
          id: 'product-partial',
          name: 'Producto con reserva parcial',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-partial' },
          recipe: null,
        },
        modifiers: [],
      },
    ])
    let inventoryUpdates = 0
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('UPDATE "Inventory"')) {
        inventoryUpdates += 1
        return inventoryUpdates === 1
          ? [
              {
                id: 'inventory-partial',
                currentStock: new Prisma.Decimal('8.000'),
                previousStock: new Prisma.Decimal('10.000'),
              },
            ]
          : [
              {
                id: 'inventory-partial',
                currentStock: new Prisma.Decimal('7.000'),
                previousStock: new Prisma.Decimal('8.000'),
              },
            ]
      }
      if (sql.includes('FROM "Inventory"')) {
        return [{ id: 'inventory-partial', currentStock: new Prisma.Decimal('8.000') }]
      }
      return []
    })

    await expect(finalize()).resolves.toEqual({ areaTicketOrder: true, sessionId })

    expect(prismaMock.inventoryMovement.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.inventoryMovement.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        inventoryId: 'inventory-partial',
        quantity: new Prisma.Decimal('-1.000'),
        reference: orderId,
      }),
    })
  })

  it('valida el modificador antes de mutar el inventario del producto base', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-with-modifier',
        areaTicketLineId: null,
        quantity: 1,
        weightQuantity: null,
        product: {
          id: 'product-base',
          name: 'Producto base',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-base' },
          recipe: null,
        },
        modifiers: [
          {
            quantity: 1,
            modifier: {
              id: 'modifier-cheese',
              groupId: 'group-cheese',
              rawMaterialId: 'raw-cheese',
              quantityPerUnit: new Prisma.Decimal('0.200'),
              unit: 'KILOGRAM',
              inventoryMode: 'ADDITION',
              rawMaterial: { id: 'raw-cheese', name: 'Queso', unit: 'KILOGRAM' },
            },
          },
        ],
      },
    ])
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('FROM "Inventory"')) {
        return [{ id: 'inventory-base', currentStock: new Prisma.Decimal('10.000') }]
      }
      if (sql.includes('FROM "RawMaterial"')) {
        return [{ id: 'raw-cheese', currentStock: new Prisma.Decimal('0.100'), unit: 'KILOGRAM' }]
      }
      return []
    })

    await expect(finalize()).rejects.toMatchObject({ code: 'AREA_TICKET_INSUFFICIENT_STOCK' })

    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('no vuelve a consumir inventario cuando el mismo pago ya finalizó la sesión', async () => {
    prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue({
      id: sessionId,
      orderId,
      status: AreaTicketCheckoutStatus.PAID,
    })
    prismaMock.areaTicketPaymentAttempt.findFirst.mockResolvedValue({
      id: attemptId,
      status: AreaTicketPaymentAttemptStatus.SUCCEEDED,
      paymentId: 'payment-paid',
    })

    await expect(finalize()).resolves.toEqual({ areaTicketOrder: true, sessionId })

    expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
    expect(prismaMock.areaTicketInventoryReservation.findMany).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(prismaMock.rawMaterialMovement.create).not.toHaveBeenCalled()
  })

  it('reconcilia los totales de la orden con el Payment ya capturado antes de consumir inventario', async () => {
    prismaMock.order.findFirst.mockResolvedValue({
      paymentStatus: 'PENDING',
      status: 'PENDING',
      subtotal: new Prisma.Decimal('100.00'),
      discountAmount: new Prisma.Decimal('10.00'),
      serviceChargeAmount: new Prisma.Decimal('5.00'),
      servedById: null,
      createdById: null,
    })
    prismaMock.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('95.00'), tipAmount: new Prisma.Decimal('0.00') }])
    prismaMock.orderItem.findMany.mockResolvedValue([])

    const result = await finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId,
      orderId,
      paymentId: 'payment-paid',
      fullyPaid: false,
      staffId: 'staff-paid',
      locked: { sessionId, attemptId },
      reconcileCapturedPayment: true,
    } as any)

    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: orderId },
      data: expect.objectContaining({
        paymentStatus: 'PAID',
        status: 'COMPLETED',
        paidAmount: new Prisma.Decimal('95.00'),
        remainingBalance: new Prisma.Decimal('0.00'),
        tipAmount: new Prisma.Decimal('0.00'),
        total: new Prisma.Decimal('95.00'),
        loyaltyEligibleAt: expect.any(Date),
        loyaltyStaffId: 'staff-paid',
      }),
    })
    expect(result).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true })
  })
})

/**
 * 🔴 R8-1 (Codex recheck-12 P2): conciliar el cobro capturado de una sesión de vales (dinero que ENTRA) nunca reabre una venta
 * cerrada. La sesión sólo admite OPEN/PARTIALLY_PAID, pero la venta pudo saldarse por otro camino y luego corregirse su cobro.
 */
describe('🔴 R8-1: el cobro capturado de una sesión de vales sobre una venta PAID', () => {
  beforeEach(() => primePaidCheckout())

  const conciliar = (pagos: string[]) => {
    prismaMock.order.findFirst.mockResolvedValue({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      subtotal: new Prisma.Decimal('100.00'),
      discountAmount: new Prisma.Decimal('0.00'),
      serviceChargeAmount: new Prisma.Decimal('0.00'),
      servedById: 'staff-paid',
      createdById: 'staff-paid',
    })
    prismaMock.payment.findMany.mockResolvedValue(
      pagos.map(p => ({ amount: new Prisma.Decimal(p), tipAmount: new Prisma.Decimal('0.00') })),
    )
    prismaMock.orderItem.findMany.mockResolvedValue([])
    return finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId,
      orderId,
      paymentId: 'payment-paid',
      fullyPaid: false,
      staffId: 'staff-paid',
      locked: { sessionId, attemptId },
      reconcileCapturedPayment: true,
    } as any)
  }
  const escrito = () => (prismaMock.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data

  it('🔴 $80 + $10 ($90 < $100) ⇒ sigue PAID con saldo 0 (antes: PARTIAL con $10 por cobrar)', async () => {
    await conciliar(['80.00', '10.00'])
    const data = escrito()
    expect([data.paymentStatus, Number(data.remainingBalance), Number(data.paidAmount)]).toEqual(['PAID', 0, 90])
    expect([data.status, data.completedAt, data.loyaltyEligibleAt]).toEqual([undefined, undefined, undefined])
  })

  it('🔴 $80 + $20 que vuelve a cubrir ⇒ sin cierre con fecha nueva ni lealtad otra vez', async () => {
    await conciliar(['80.00', '20.00'])
    const data = escrito()
    expect([data.paymentStatus, Number(data.remainingBalance)]).toEqual(['PAID', 0])
    expect([data.status, data.completedAt, data.loyaltyEligibleAt, data.loyaltyStaffId]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

/**
 * 🔴 R9-1 (Codex recheck-13 #3): la venta ya estaba CERRADA (PAID, leída bajo el `FOR UPDATE` de la orden) antes de que entrara el
 * cobro de la sesión de vales. La cadena: la sesión cobra un abono (PARTIALLY_PAID) → otro canal salda la venta (el pago manual, que
 * no conoce la sesión, ya descontó TODO el inventario con su vale) → el panel corrige ese cobro → llega un cobro tardío por la sesión.
 * R8-1 dejó la venta PAID con saldo 0, pero la sesión quedaba PARTIALLY_PAID (Android e iOS la restauran como carrito cobrable) y, si
 * los importes cubrían, se volvía a consumir el inventario. Ahora la sesión cierra como pagada y no se repite ningún efecto de saldar.
 * «No se repite» exige que el primer cierre lo haya hecho: el barrido de pagadas-abiertas cierra SIN vale ni descuento, y ahí el
 * consumo de la sesión es el primero.
 */
describe('🔴 R9-1: la sesión de vales de una venta que YA estaba cerrada', () => {
  const RESERVA = {
    id: 'reservation-r9',
    areaTicketLineId: 'line-r9',
    inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
    inventoryId: 'inventory-r9',
    quantityBaseUnits: new Prisma.Decimal('1.000'),
  }

  beforeEach(() => {
    primePaidCheckout()
    // Un vale para llevar y otro que se guarda, una reserva ACTIVE y un producto suelto: todo lo que la finalización consumiría.
    prismaMock.areaTicket.findMany.mockResolvedValue([
      { id: 'ticket-ya', fulfillmentModeSnapshot: 'IMMEDIATE' },
      { id: 'ticket-guardado', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID' },
    ])
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([RESERVA])
    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-suelto',
        areaTicketLineId: null,
        quantity: 1,
        weightQuantity: null,
        product: {
          id: 'product-suelto',
          name: 'Producto suelto',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { id: 'inventory-suelto' },
          recipe: null,
        },
        modifiers: [],
      },
    ])
    prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'movement-r9' })
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('UPDATE "Inventory"')) {
        return [{ id: 'inventory-r9', currentStock: new Prisma.Decimal('9.000'), previousStock: new Prisma.Decimal('10.000') }]
      }
      if (sql.includes('FROM "Inventory"')) return [{ id: 'inventory-suelto', currentStock: new Prisma.Decimal('10.000') }]
      return []
    })
  })

  /**
   * `valeDeInventario`: el primer cierre dejó su vale SALE (el pago manual, el panel, cripto o la terminal: descontaron TODOS los
   * renglones). Sin él, la cerró el barrido de pagadas-abiertas, que no descuenta nada.
   */
  const conciliar = (paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING', pagos: string[], valeDeInventario = true) => {
    prismaMock.inventoryPosting.findUnique.mockResolvedValue(valeDeInventario ? { id: 'posting-del-primer-cierre' } : null)
    prismaMock.order.findFirst.mockResolvedValue({
      paymentStatus,
      status: paymentStatus === 'PAID' ? 'COMPLETED' : 'PENDING',
      subtotal: new Prisma.Decimal('100.00'),
      discountAmount: new Prisma.Decimal('0.00'),
      serviceChargeAmount: new Prisma.Decimal('0.00'),
      servedById: 'staff-paid',
      createdById: 'staff-paid',
      areaTicketCode: 'VALE-R9',
    })
    prismaMock.payment.findMany.mockResolvedValue(
      pagos.map(p => ({ amount: new Prisma.Decimal(p), tipAmount: new Prisma.Decimal('0.00') })),
    )
    return finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId,
      orderId,
      paymentId: 'payment-tardio',
      fullyPaid: false,
      staffId: 'staff-paid',
      locked: { sessionId, attemptId },
      reconcileCapturedPayment: true,
    } as any)
  }
  const estadoDeLaSesion = () =>
    (prismaMock.areaTicketCheckoutSession.update as jest.Mock).mock.calls.map(([a]: any[]) => a?.data?.status).filter(Boolean)
  const consumioInventario = () =>
    (prismaMock.$queryRaw as jest.Mock).mock.calls.some(([q]: any[]) => sqlText(q).includes('UPDATE "Inventory"')) ||
    (prismaMock.inventoryMovement.create as jest.Mock).mock.calls.length > 0 ||
    (prismaMock.rawMaterialMovement.create as jest.Mock).mock.calls.length > 0 ||
    (prismaMock.areaTicketInventoryReservation.update as jest.Mock).mock.calls.length > 0
  const ultimaOrden = () => (prismaMock.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data

  it.each([
    ['$80 + $10 ($90 < $100)', ['80.00', '10.00'], 90],
    ['$80 + $20 que vuelve a cubrir', ['80.00', '20.00'], 100],
  ])(
    '🔴 PAID con %s ⇒ la sesión cierra PAID (antes: PARTIALLY_PAID o un segundo consumo), sin inventario y con el dinero registrado',
    async (_caso, pagos, pagado) => {
      const resultado = await conciliar('PAID', pagos as string[])

      expect(estadoDeLaSesion()).toEqual([AreaTicketCheckoutStatus.PAID])
      expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ activePaymentAttemptId: null }) }),
      )
      expect(prismaMock.areaTicketPaymentAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED', paymentId: 'payment-tardio' }) }),
      )
      // Ningún efecto de saldar otra vez: ni reservas, ni productos sueltos (el primer cierre ya descontó).
      expect(consumioInventario()).toBe(false)
      expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
      // El dinero, como hoy (R8-1): todo lo cobrado, saldo 0 y la venta sigue PAID sin otro cierre.
      expect([ultimaOrden().paymentStatus, Number(ultimaOrden().remainingBalance), Number(ultimaOrden().paidAmount)]).toEqual([
        'PAID',
        0,
        pagado,
      ])
      expect([ultimaOrden().status, ultimaOrden().completedAt, ultimaOrden().loyaltyEligibleAt]).toEqual([undefined, undefined, undefined])
      // La TPV recibe «PAID» y quien la llama sabe que la venta ya estaba cerrada (no repite cupones, referido, lealtad ni comanda).
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true })
    },
  )

  it('🔴 PAID: los vales de la sesión quedan como los de una venta pagada (sólo los CLAIMED) y se suelta el reclamo de la terminal', async () => {
    await conciliar('PAID', ['80.00', '10.00'])

    const vales = (prismaMock.areaTicket.updateMany as jest.Mock).mock.calls.map(([a]: any[]) => [
      a.where.id.in,
      a.where.status,
      a.data.status,
    ])
    expect(vales).toEqual([
      [['ticket-ya'], 'CLAIMED', 'DELIVERED'],
      [['ticket-guardado'], 'CLAIMED', 'PAID'],
    ])
    expect([ultimaOrden().claimedByTerminalId, ultimaOrden().claimedAt]).toEqual([null, null])
  })

  it('🔴 PAID que cerró el barrido (SIN vale de inventario) ⇒ la sesión cierra PAID y SÍ consume, una vez: es el primer descuento, no una repetición', async () => {
    const resultado = await conciliar('PAID', ['100.00'], false)

    expect(estadoDeLaSesion()).toEqual([AreaTicketCheckoutStatus.PAID])
    expect(prismaMock.inventoryPosting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_sourceKind_sourceId_effectKind: { venueId, sourceKind: 'ORDER', sourceId: orderId, effectKind: 'SALE' } },
      }),
    )
    expect(prismaMock.areaTicketInventoryReservation.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.areaTicketInventoryReservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RESERVA.id }, data: expect.objectContaining({ status: 'CONSUMED' }) }),
    )
    expect(prismaMock.orderItem.findMany).toHaveBeenCalled()
    // La venta no se vuelve a cerrar (ni fecha ni lealtad nuevas) y quien llama sabe que ya estaba cerrada.
    expect([ultimaOrden().paymentStatus, ultimaOrden().status, ultimaOrden().loyaltyEligibleAt]).toEqual(['PAID', undefined, undefined])
    expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true })
  })

  it('regresión: una venta PARTIAL que no se cubre ⇒ la sesión queda PARTIALLY_PAID y sin consumir (como hoy)', async () => {
    const resultado = await conciliar('PARTIAL', ['50.00', '10.00'])

    expect(estadoDeLaSesion()).toEqual([AreaTicketCheckoutStatus.PARTIALLY_PAID])
    expect(consumioInventario()).toBe(false)
    expect([ultimaOrden().paymentStatus, Number(ultimaOrden().remainingBalance)]).toEqual(['PARTIAL', 40])
    expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: false })
  })

  it.each(['PENDING', 'PARTIAL'] as const)(
    'regresión: una venta %s que el cobro de la sesión salda ⇒ consume reservas y sueltos UNA vez y cierra PAID (como hoy)',
    async previo => {
      const resultado = await conciliar(previo, ['50.00', '50.00'])

      expect(estadoDeLaSesion()).toEqual([AreaTicketCheckoutStatus.PAID])
      expect(prismaMock.areaTicketInventoryReservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RESERVA.id }, data: expect.objectContaining({ status: 'CONSUMED' }) }),
      )
      expect(prismaMock.orderItem.findMany).toHaveBeenCalled()
      expect([ultimaOrden().paymentStatus, ultimaOrden().status]).toEqual(['PAID', 'COMPLETED'])
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true })
    },
  )
})
