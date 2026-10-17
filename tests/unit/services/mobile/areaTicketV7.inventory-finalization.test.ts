import { AreaTicketCheckoutStatus, AreaTicketInventoryTarget, AreaTicketPaymentAttemptStatus, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import {
  cerrarSesionDeValesAlCerrarLaVenta,
  cerrarSesionDeVentaCerradaPorOtroCanal,
  finalizeAreaTicketPaymentInTransaction,
  lockAreaTicketCheckoutForPayment,
} from '@/services/mobile/areaTicketV7.mobile.service'
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
    // R10-3: este cobro es el primer saldado ⇒ quien llama corre sus efectos una vez.
    expect(result).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, primerSaldado: true })
  })
})

/**
 * 🔴 R8-1 (Codex recheck-12 P2): conciliar el cobro capturado de una sesión de vales (dinero que ENTRA) nunca reabre una venta
 * cerrada. La sesión sólo admite OPEN/PARTIALLY_PAID, pero la venta pudo saldarse por otro camino y luego corregirse su cobro.
 */
describe('🔴 R8-1: el cobro capturado de una sesión de vales sobre una venta PAID', () => {
  beforeEach(() => primePaidCheckout())

  const conciliar = (pagos: string[]) => {
    // La venta la cerró OTRO canal: su vale de inventario SALE existe (R10-3: sin él la habría cerrado el barrido).
    prismaMock.inventoryPosting.findUnique.mockResolvedValue({ id: 'posting-del-otro-canal' })
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
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true, primerSaldado: false })
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
    // La venta no se vuelve a cerrar (ni estado ni fecha nuevos); R10-3: el barrido no le dio lealtad ⇒ este cobro la deja durable
    // y es su primer saldado (quien llama corre sus efectos UNA vez).
    expect([ultimaOrden().paymentStatus, ultimaOrden().status, ultimaOrden().completedAt]).toEqual(['PAID', undefined, undefined])
    expect([ultimaOrden().loyaltyEligibleAt, ultimaOrden().loyaltyStaffId]).toEqual([expect.any(Date), 'staff-paid'])
    expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true, primerSaldado: true })
  })

  it('regresión: una venta PARTIAL que no se cubre ⇒ la sesión queda PARTIALLY_PAID y sin consumir (como hoy)', async () => {
    const resultado = await conciliar('PARTIAL', ['50.00', '10.00'])

    expect(estadoDeLaSesion()).toEqual([AreaTicketCheckoutStatus.PARTIALLY_PAID])
    expect(consumioInventario()).toBe(false)
    expect([ultimaOrden().paymentStatus, Number(ultimaOrden().remainingBalance)]).toEqual(['PARTIAL', 40])
    expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: false, primerSaldado: false })
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
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, primerSaldado: true })
    },
  )
})

/**
 * 🔴 Ronda 10 (Codex recheck-14): la venta de vales $100 (un vale de $60 con su reserva + un producto suelto de $40).
 *   · R10-1: la sesión que consume deja su vale SALE `SKIPPED / AREA_TICKET_TRANSACTIONAL` en la MISMA transacción; con él, «existe un
 *     vale SALE» es la señal fiel de «alguien ya tiene la obligación de inventario» y un reenvío no vuelve a consumir.
 *   · R10-2: si el vale SALE es de otro canal (ya descontó TODO), las reservas ACTIVE de la sesión se sueltan sin mover stock.
 *   · R10-3: la venta que cerró el barrido (sin vale ni efectos) recupera con ESTE cobro su lealtad durable y su marca de cocina.
 *   · R10-4: la salida temprana (este mismo cobro ya se finalizó) dice lo PERSISTIDO y no corre efectos.
 */
describe('🔴 R10: constancia del consumo, reservas de otro canal, recuperación tras el barrido y salida temprana', () => {
  const RESERVA = {
    id: 'reservation-r10',
    areaTicketLineId: 'line-r10',
    inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
    inventoryId: 'inventory-r10',
    quantityBaseUnits: new Prisma.Decimal('1.000'),
  }

  beforeEach(() => {
    primePaidCheckout()
    prismaMock.areaTicket.findMany.mockResolvedValue([{ id: 'ticket-r10', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID' }])
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([RESERVA])
    prismaMock.areaTicketInventoryReservation.updateMany.mockResolvedValue({ count: 1 } as any)
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
    prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'movement-r10' })
    prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'posting-de-la-sesion', status: 'SKIPPED' } as any)
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('UPDATE "Inventory"')) {
        return [{ id: 'inventory-r10', currentStock: new Prisma.Decimal('9.000'), previousStock: new Prisma.Decimal('10.000') }]
      }
      if (sql.includes('FROM "Inventory"')) return [{ id: 'inventory-suelto', currentStock: new Prisma.Decimal('10.000') }]
      return []
    })
  })

  /** `vale`: el vale SALE de la venta (de otro canal o de la propia sesión), o `null` si no hay (la cerró el barrido). */
  const conciliar = (
    paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING',
    pagos: string[],
    opciones: {
      vale?: { id: string; status?: string; skipReason?: string } | null
      orden?: Record<string, unknown>
      cocina?: boolean
    } = {},
  ) => {
    prismaMock.inventoryPosting.findUnique.mockResolvedValue((opciones.vale ?? null) as any)
    prismaMock.order.findFirst.mockResolvedValue({
      paymentStatus,
      status: paymentStatus === 'PAID' ? 'COMPLETED' : 'PENDING',
      subtotal: new Prisma.Decimal('100.00'),
      discountAmount: new Prisma.Decimal('0.00'),
      serviceChargeAmount: new Prisma.Decimal('0.00'),
      servedById: 'staff-paid',
      createdById: 'staff-paid',
      areaTicketCode: 'VALE-R10',
      loyaltyEligibleAt: null,
      kitchenPendingAt: null,
      ...opciones.orden,
    })
    prismaMock.payment.findMany.mockResolvedValue(
      pagos.map(p => ({ amount: new Prisma.Decimal(p), tipAmount: new Prisma.Decimal('0.00') })),
    )
    return finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId,
      orderId,
      paymentId: 'payment-r10',
      fullyPaid: false,
      staffId: 'staff-del-cobro',
      marcarCocina: opciones.cocina ?? false,
      locked: { sessionId, attemptId },
      reconcileCapturedPayment: true,
    } as any)
  }
  const ultimaOrden = () => (prismaMock.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data
  const valesCreados = () => (prismaMock.inventoryPosting.create as jest.Mock).mock.calls.map(([a]: any[]) => a.data)
  const consumio = () =>
    (prismaMock.$queryRaw as jest.Mock).mock.calls.some(([q]: any[]) => sqlText(q).includes('UPDATE "Inventory"')) ||
    (prismaMock.inventoryMovement.create as jest.Mock).mock.calls.length > 0 ||
    (prismaMock.areaTicketInventoryReservation.update as jest.Mock).mock.calls.length > 0
  const reservasSoltadas = () =>
    (prismaMock.areaTicketInventoryReservation.updateMany as jest.Mock).mock.calls.filter(([a]: any[]) => a?.data?.status === 'RELEASED')

  describe('R10-1: la constancia durable del consumo de la sesión', () => {
    it('🔴 la venta que el cobro de la sesión salda ⇒ consume UNA vez y deja su vale SALE SKIPPED AREA_TICKET_TRANSACTIONAL en la misma tx', async () => {
      await conciliar('PARTIAL', ['50.00', '50.00'])

      expect(consumio()).toBe(true)
      expect(valesCreados()).toEqual([
        expect.objectContaining({
          venueId,
          sourceKind: 'ORDER',
          sourceId: orderId,
          effectKind: 'SALE',
          orderId,
          status: 'SKIPPED',
          skipReason: 'AREA_TICKET_TRANSACTIONAL',
        }),
      ])
      // Sin renglones: nadie aplica ni revierte este vale (los movimientos ya los escribió la sesión).
      expect(valesCreados()[0].lines).toBeUndefined()
    })

    it('🔴 el efectivo del POS (sin conciliar) también deja el vale SKIPPED al consumir', async () => {
      prismaMock.inventoryPosting.findUnique.mockResolvedValue(null as any)

      await finalize()

      expect(consumio()).toBe(true)
      expect(valesCreados()).toEqual([expect.objectContaining({ status: 'SKIPPED', skipReason: 'AREA_TICKET_TRANSACTIONAL' })])
    })

    it('🔴 la cadena de Codex: la sesión ya consumió (su vale SKIPPED) y un catch tardío la degradó ⇒ el reenvío NO vuelve a consumir (10 → 9, no → 8)', async () => {
      const resultado = await conciliar('PAID', ['100.00'], {
        vale: { id: 'posting-de-la-sesion', status: 'SKIPPED', skipReason: 'AREA_TICKET_TRANSACTIONAL' },
      })

      expect(consumio()).toBe(false)
      expect(valesCreados()).toEqual([])
      expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: AreaTicketCheckoutStatus.PAID }) }),
      )
      // No es el primer saldado: los efectos ya corrieron con quien finalizó primero.
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true, primerSaldado: false })
    })

    it('regresión: un abono parcial (no salda) no consume ni deja vale', async () => {
      await conciliar('PENDING', ['50.00'])

      expect(consumio()).toBe(false)
      expect(valesCreados()).toEqual([])
    })
  })

  describe('R10-2: las reservas de una venta que cerró otro canal', () => {
    it('🔴 venta PAID con el vale SALE de otro canal ⇒ sus reservas ACTIVE pasan a RELEASED SIN mover stock', async () => {
      await conciliar('PAID', ['80.00', '20.00'], { vale: { id: 'posting-del-pago-manual', status: 'APPLIED' } })

      expect(reservasSoltadas()).toEqual([
        [
          {
            where: { venueId, areaTicket: { checkoutSessionId: sessionId }, status: 'ACTIVE' },
            data: { status: 'RELEASED', releasedAt: expect.any(Date) },
          },
        ],
      ])
      expect(consumio()).toBe(false)
      expect(valesCreados()).toEqual([])
    })

    it('regresión: cuando la sesión consume (primer descuento) las reservas se CONSUMEN, no se sueltan', async () => {
      await conciliar('PENDING', ['100.00'])

      expect(reservasSoltadas()).toEqual([])
      expect(prismaMock.areaTicketInventoryReservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: RESERVA.id }, data: expect.objectContaining({ status: 'CONSUMED' }) }),
      )
    })
  })

  describe('R10-3: la venta que cerró el barrido recupera su lealtad con ESTE cobro', () => {
    it('🔴 PAID sin vale (barrido) ⇒ consume, lealtad durable con el empleado del cobro, marca de cocina y primer saldado', async () => {
      const resultado = await conciliar('PAID', ['100.00'], { cocina: true })

      expect(consumio()).toBe(true)
      expect(ultimaOrden()).toMatchObject({
        paymentStatus: 'PAID',
        loyaltyEligibleAt: expect.any(Date),
        loyaltyStaffId: 'staff-del-cobro',
        kitchenPendingAt: expect.any(Date),
      })
      // No se vuelve a cerrar: ni estado ni fecha de cierre nuevos.
      expect([ultimaOrden().status, ultimaOrden().completedAt]).toEqual([undefined, undefined])
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true, primerSaldado: true })
    })

    it('🔴 no pisa la lealtad ni la marca que la venta ya tenga (una liga tardía con permiso ya abrió la suya, con SU actor)', async () => {
      const antes = new Date('2026-10-16T10:00:00Z')
      await conciliar('PAID', ['100.00'], { cocina: true, orden: { loyaltyEligibleAt: antes, kitchenPendingAt: antes } })

      expect([ultimaOrden().loyaltyEligibleAt, ultimaOrden().loyaltyStaffId, ultimaOrden().kitchenPendingAt]).toEqual([
        undefined,
        undefined,
        undefined,
      ])
    })

    it('regresión: la venta que cerró OTRO canal (con su vale) no es primer saldado: ni lealtad ni marca otra vez', async () => {
      const resultado = await conciliar('PAID', ['80.00', '20.00'], { cocina: true, vale: { id: 'posting-del-pago-manual' } })

      expect([ultimaOrden().loyaltyEligibleAt, ultimaOrden().loyaltyStaffId, ultimaOrden().kitchenPendingAt]).toEqual([
        undefined,
        undefined,
        undefined,
      ])
      expect(resultado.primerSaldado).toBe(false)
    })
  })

  describe('R10-4: la salida temprana (este mismo cobro ya se finalizó) dice lo persistido', () => {
    const yaFinalizado = (estadoDeLaSesion: AreaTicketCheckoutStatus) => {
      prismaMock.areaTicketPaymentAttempt.findFirst.mockResolvedValue({
        id: attemptId,
        status: AreaTicketPaymentAttemptStatus.SUCCEEDED,
        paymentId: 'payment-r10',
      })
      prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue({ id: sessionId, orderId, status: estadoDeLaSesion })
    }

    it.each([
      ['$80 + $10 (la aritmética dice «parcial»)', ['80.00', '10.00']],
      ['$80 + $20 (vuelve a cubrir)', ['80.00', '20.00']],
    ])('🔴 venta cerrada, %s ⇒ PAID (la sesión guardada), venta cerrada y SIN efectos', async (_caso, pagos) => {
      yaFinalizado(AreaTicketCheckoutStatus.PAID)

      const resultado = await conciliar('PAID', pagos as string[], { vale: { id: 'posting-del-pago-manual' } })

      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true, primerSaldado: false })
      expect(consumio()).toBe(false)
      expect(valesCreados()).toEqual([])
      expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
      expect(prismaMock.areaTicketPaymentAttempt.update).not.toHaveBeenCalled()
    })

    it('regresión: el abono parcial ya finalizado ⇒ PARTIALLY_PAID (la sesión guardada) y sin efectos', async () => {
      yaFinalizado(AreaTicketCheckoutStatus.PARTIALLY_PAID)

      const resultado = await conciliar('PARTIAL', ['50.00'])

      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: false, primerSaldado: false })
    })
  })
})

/**
 * 🔴 Ronda 11 (Codex recheck-15): la venta de vales $100 (un vale de $60 con su reserva + un producto suelto de $40).
 *   · R11-3: una finalización de ANTES de la constancia de R10-1 ya consumió (vales con `paidAt`, sin vale SALE) y el `catch` viejo
 *     degradó la sesión: el reenvío no vuelve a consumir (9 se queda en 9); con evidencia ambigua no consume y la deja en conciliación.
 *   · R11-5: la salida temprana SUCCEEDED es de sólo lectura (ni totales, ni lealtad, ni marca).
 *   · R11-7: con el vale SALE de otro canal todavía PENDIENTE de aplicar, la finalización no suelta las reservas (su aplicador lo hará).
 *   · R11-8: un abono no le quita la sesión a otro intento vivo; el dinero ya capturado nunca recibe 409; el cierre por otro canal.
 */
describe('🔴 R11: consumo viejo, salida de sólo lectura, reservas del vale pendiente y la sesión de otro intento', () => {
  const RESERVA = {
    id: 'reservation-r11',
    areaTicketLineId: 'line-r11',
    inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
    inventoryId: 'inventory-r11',
    quantityBaseUnits: new Prisma.Decimal('1.000'),
  }
  const PAGADO_ANTES = new Date('2026-10-10T18:00:00Z')

  beforeEach(() => {
    primePaidCheckout()
    prismaMock.areaTicket.findMany.mockResolvedValue([{ id: 'ticket-r11', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID', paidAt: null }])
    prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([RESERVA])
    prismaMock.areaTicketInventoryReservation.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.areaTicketInventoryReservation.count.mockResolvedValue(0)
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
    prismaMock.inventoryMovement.create.mockResolvedValue({ id: 'movement-r11' })
    prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'posting-de-la-sesion', status: 'SKIPPED' } as any)
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlText(query)
      if (sql.includes('UPDATE "Inventory"')) {
        return [{ id: 'inventory-r11', currentStock: new Prisma.Decimal('8.000'), previousStock: new Prisma.Decimal('9.000') }]
      }
      if (sql.includes('FROM "Inventory"')) return [{ id: 'inventory-suelto', currentStock: new Prisma.Decimal('9.000') }]
      return []
    })
  })

  const conciliar = (
    paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING',
    pagos: string[],
    opciones: { vale?: { id: string; status?: string } | null; intento?: Record<string, unknown>; sesion?: Record<string, unknown> } = {},
  ) => {
    prismaMock.inventoryPosting.findUnique.mockResolvedValue((opciones.vale ?? null) as any)
    if (opciones.intento) prismaMock.areaTicketPaymentAttempt.findFirst.mockResolvedValue({ id: attemptId, ...opciones.intento })
    if (opciones.sesion) prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue({ id: sessionId, orderId, ...opciones.sesion })
    prismaMock.order.findFirst.mockResolvedValue({
      paymentStatus,
      status: paymentStatus === 'PAID' ? 'COMPLETED' : 'PENDING',
      subtotal: new Prisma.Decimal('100.00'),
      discountAmount: new Prisma.Decimal('0.00'),
      serviceChargeAmount: new Prisma.Decimal('0.00'),
      servedById: 'staff-paid',
      createdById: 'staff-paid',
      areaTicketCode: 'VALE-R11',
      loyaltyEligibleAt: null,
      kitchenPendingAt: null,
    })
    prismaMock.payment.findMany.mockResolvedValue(
      pagos.map(p => ({ amount: new Prisma.Decimal(p), tipAmount: new Prisma.Decimal('0.00') })),
    )
    return finalizeAreaTicketPaymentInTransaction(prismaMock, {
      venueId,
      orderId,
      paymentId: 'payment-r11',
      fullyPaid: false,
      staffId: 'staff-del-cobro',
      marcarCocina: true,
      locked: { sessionId, attemptId },
      reconcileCapturedPayment: true,
    } as any)
  }
  const consumio = () =>
    (prismaMock.$queryRaw as jest.Mock).mock.calls.some(([q]: any[]) => sqlText(q).includes('UPDATE "Inventory"')) ||
    (prismaMock.inventoryMovement.create as jest.Mock).mock.calls.length > 0 ||
    (prismaMock.areaTicketInventoryReservation.update as jest.Mock).mock.calls.length > 0
  const valesCreados = () => (prismaMock.inventoryPosting.create as jest.Mock).mock.calls.map(([a]: any[]) => a.data)
  const reservasSoltadas = () =>
    (prismaMock.areaTicketInventoryReservation.updateMany as jest.Mock).mock.calls.filter(([a]: any[]) => a?.data?.status === 'RELEASED')
  const ninguneEscritura = () => ({
    orden: (prismaMock.order.update as jest.Mock).mock.calls.length,
    intento: (prismaMock.areaTicketPaymentAttempt.update as jest.Mock).mock.calls.length,
    sesion: (prismaMock.areaTicketCheckoutSession.update as jest.Mock).mock.calls.length,
    vales: (prismaMock.areaTicket.updateMany as jest.Mock).mock.calls.length,
    inventario: consumio(),
    constancia: valesCreados().length,
  })

  describe('R11-3: la sesión que degradó el catch viejo DESPUÉS de consumir', () => {
    it('🔴 venta PAID sin vale SALE, su vale con `paidAt`, intento UNKNOWN con `completedAt`, sin reservas vivas ⇒ NO vuelve a consumir (9 se queda en 9); cierra la sesión, deja la constancia y no es primer saldado', async () => {
      prismaMock.areaTicket.findMany.mockResolvedValue([
        { id: 'ticket-r11', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID', paidAt: PAGADO_ANTES },
      ])
      const resultado = await conciliar('PAID', ['100.00'], {
        intento: { status: AreaTicketPaymentAttemptStatus.UNKNOWN, paymentId: 'payment-r11', completedAt: PAGADO_ANTES },
        sesion: { status: AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED, activePaymentAttemptId: attemptId },
      })

      expect(consumio()).toBe(false)
      expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
      expect(valesCreados()).toEqual([expect.objectContaining({ status: 'SKIPPED', skipReason: 'AREA_TICKET_TRANSACTIONAL' })])
      expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: AreaTicketCheckoutStatus.PAID, activePaymentAttemptId: null }) }),
      )
      expect(prismaMock.areaTicketPaymentAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED', paymentId: 'payment-r11' }) }),
      )
      // Ni lealtad ni marca de cocina nuevas: los efectos ya corrieron con quien la finalizó.
      const orden = (prismaMock.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data
      expect([orden.loyaltyEligibleAt, orden.kitchenPendingAt]).toEqual([undefined, undefined])
      expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: true, ventaYaCerrada: true, primerSaldado: false })
    })

    it.each([
      [
        'unos vales con `paidAt` y otros no',
        [
          { id: 'ticket-a', fulfillmentModeSnapshot: 'IMMEDIATE', paidAt: PAGADO_ANTES },
          { id: 'ticket-b', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID', paidAt: null },
        ],
        0,
      ],
      [
        'todos con `paidAt` pero una reserva sigue ACTIVE',
        [{ id: 'ticket-a', fulfillmentModeSnapshot: 'IMMEDIATE', paidAt: PAGADO_ANTES }],
        1,
      ],
    ])('🔴 evidencia ambigua (%s) ⇒ NO consume, no escribe nada y lanza para que se quede en conciliación', async (_caso, vales, vivas) => {
      prismaMock.areaTicket.findMany.mockResolvedValue(vales as any)
      prismaMock.areaTicketInventoryReservation.count.mockResolvedValue(vivas as number)

      await expect(
        conciliar('PAID', ['100.00'], { intento: { status: AreaTicketPaymentAttemptStatus.UNKNOWN, paymentId: 'payment-r11' } }),
      ).rejects.toMatchObject({ code: 'AREA_TICKET_PRIOR_CONSUMPTION_UNCERTAIN' })
      expect(ninguneEscritura()).toEqual({ orden: 0, intento: 0, sesion: 0, vales: 0, inventario: false, constancia: 0 })
    })

    it('regresión: `completedAt` SOLO no prueba consumo (un abono también lo tiene): la venta que cerró el barrido se consume UNA vez', async () => {
      const resultado = await conciliar('PAID', ['100.00'], {
        intento: { status: AreaTicketPaymentAttemptStatus.UNKNOWN, paymentId: 'payment-r11', completedAt: PAGADO_ANTES },
      })

      expect(consumio()).toBe(true)
      expect(resultado.primerSaldado).toBe(true)
    })
  })

  describe('R11-5: la salida temprana SUCCEEDED es de sólo lectura', () => {
    it.each([
      ['$80 + $20 sobre una venta que cerró el barrido (sin vale ni lealtad)', 'PAID', ['80.00', '20.00'], AreaTicketCheckoutStatus.PAID],
      ['$80 + $10 (la aritmética dice «parcial»)', 'PAID', ['80.00', '10.00'], AreaTicketCheckoutStatus.PAID],
      ['un abono ya finalizado', 'PARTIAL', ['50.00'], AreaTicketCheckoutStatus.PARTIALLY_PAID],
    ] as const)('🔴 %s ⇒ ni totales, ni lealtad, ni marca de cocina, ni sesión ni intento', async (_caso, estado, pagos, sesion) => {
      const resultado = await conciliar(estado, [...pagos], {
        intento: { status: AreaTicketPaymentAttemptStatus.SUCCEEDED, paymentId: 'payment-r11' },
        sesion: { status: sesion },
      })

      expect(ninguneEscritura()).toEqual({ orden: 0, intento: 0, sesion: 0, vales: 0, inventario: false, constancia: 0 })
      expect(resultado).toMatchObject({ fullyPaid: sesion === AreaTicketCheckoutStatus.PAID, primerSaldado: false })
    })
  })

  describe('R12-2 (revierte R11-7; Codex recheck-16 #2/#3): las reservas de una venta que otro canal cerró', () => {
    it.each(['PENDING', 'APPLYING', 'PARTIAL_FAILED', 'APPLIED'])(
      '🔴 vale SALE del otro canal %s ⇒ la finalización tardía suelta las reservas ACTIVE, sin mover stock (la obligación vive en el vale)',
      async status => {
        await conciliar('PAID', ['80.00', '20.00'], { vale: { id: 'posting-del-pago-manual', status } })

        expect(reservasSoltadas()).toHaveLength(1)
        expect(consumio()).toBe(false)
      },
    )
  })

  describe('R12-4: al cerrar PAID, el intento UNKNOWN hermano cuyo cobro ya contó queda SUCCEEDED', () => {
    it('🔴 la finalización que cierra la sesión PAID resuelve los intentos UNKNOWN con su cobro COMPLETED de ESTA venta', async () => {
      await conciliar('PAID', ['80.00', '20.00'], { vale: { id: 'posting-del-pago-manual', status: 'APPLIED' } })

      expect(prismaMock.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith({
        where: { checkoutSessionId: sessionId, orderId, status: 'UNKNOWN', payment: { is: { status: 'COMPLETED', orderId } } },
        data: { status: 'SUCCEEDED', completedAt: expect.any(Date), lastCheckedAt: expect.any(Date) },
      })
    })

    it('regresión: un abono que no cierra la sesión no toca a los hermanos', async () => {
      await conciliar('PENDING', ['30.00'], {
        sesion: { status: AreaTicketCheckoutStatus.PAYMENT_PENDING, activePaymentAttemptId: attemptId },
      })

      expect(prismaMock.areaTicketPaymentAttempt.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('R11-8: un abono no le quita la sesión a otro intento', () => {
    it.each([AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED, AreaTicketCheckoutStatus.PAYMENT_PENDING])(
      '🔴 sesión %s de OTRO intento ⇒ este abono queda SUCCEEDED y la sesión no se toca',
      async estado => {
        const resultado = await conciliar('PENDING', ['30.00'], { sesion: { status: estado, activePaymentAttemptId: 'otro-intento' } })

        expect(prismaMock.areaTicketPaymentAttempt.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
        )
        expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
        expect(resultado).toEqual({ areaTicketOrder: true, sessionId, fullyPaid: false, primerSaldado: false })
      },
    )

    it('regresión: el abono del intento que tiene la sesión ⇒ PARTIALLY_PAID, como siempre', async () => {
      await conciliar('PENDING', ['30.00'], {
        sesion: { status: AreaTicketCheckoutStatus.PAYMENT_PENDING, activePaymentAttemptId: attemptId },
      })

      expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: AreaTicketCheckoutStatus.PARTIALLY_PAID }) }),
      )
    })
  })
})

/**
 * 🔴 R11-8 (decisión A del controlador para R10-5): el dinero YA capturado nunca recibe 409 de la sesión; sólo el cobro NUEVO se
 * rechaza. Y cuando otro canal cierra la venta, su sesión cierra con ella (salvo la de un intento vivo o en conciliación).
 */
describe('🔴 R11-8: la sesión de vales ante el dinero capturado y ante el cierre por otro canal', () => {
  const sesionBloqueada = (status: AreaTicketCheckoutStatus, activePaymentAttemptId: string | null = null) => ({
    id: sessionId,
    orderId,
    status,
    activePaymentAttemptId,
    tickets: [
      { id: 'ticket-ya', fulfillmentModeSnapshot: 'IMMEDIATE' },
      { id: 'ticket-guardado', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID' },
    ],
    paymentAttempts: [{ sequence: 2 }],
  })
  const preparar = (status: AreaTicketCheckoutStatus, activo: string | null = null) => {
    prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(sesionBloqueada(status, activo) as any)
    prismaMock.areaTicketPaymentAttempt.findUnique.mockResolvedValue(null)
    prismaMock.areaTicketPaymentAttempt.create.mockResolvedValue({ id: 'intento-nuevo' } as any)
    prismaMock.$queryRaw.mockResolvedValue([])
  }
  const registrar = (dineroCapturado?: boolean) =>
    lockAreaTicketCheckoutForPayment(prismaMock, {
      venueId,
      orderId,
      idempotencyKey: 'llave-nueva-de-la-terminal',
      amount: new Prisma.Decimal('50.00'),
      method: 'CARD' as any,
      ...(dineroCapturado === undefined ? {} : { dineroCapturado }),
    })

  it.each([
    ['PAID (otro canal la cerró)', AreaTicketCheckoutStatus.PAID, null],
    ['RECONCILIATION_REQUIRED (otro intento en conciliación)', AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED, 'intento-viejo'],
    ['PAYMENT_PENDING con otro intento vivo', AreaTicketCheckoutStatus.PAYMENT_PENDING, 'intento-vivo'],
  ] as const)(
    '🔴 dinero capturado sobre una sesión %s ⇒ se crea SU intento y la sesión no se toca (antes: 409, el dinero se perdía)',
    async (_caso, status, activo) => {
      preparar(status, activo)

      await expect(registrar(true)).resolves.toEqual({ sessionId, attemptId: 'intento-nuevo' })
      expect(prismaMock.areaTicketPaymentAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sequence: 3, status: 'PENDING', idempotencyKey: 'llave-nueva-de-la-terminal' }),
        }),
      )
      expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
    },
  )

  it.each([AreaTicketCheckoutStatus.PAID, AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED])(
    'regresión: un cobro NUEVO (sin decir que ya se capturó) sobre una sesión %s ⇒ 409 antes de tomar el dinero, sin escribir',
    async status => {
      preparar(status, status === AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED ? 'intento-viejo' : null)

      await expect(registrar()).rejects.toMatchObject({ statusCode: 409, code: 'CHECKOUT_PAYMENT_NOT_ALLOWED' })
      expect(prismaMock.areaTicketPaymentAttempt.create).not.toHaveBeenCalled()
    },
  )

  it('🔴 la MISMA llave sobre una sesión en conciliación con dinero capturado ⇒ devuelve su intento (no 409)', async () => {
    preparar(AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED, 'intento-viejo')
    prismaMock.areaTicketPaymentAttempt.findUnique.mockResolvedValue({ id: 'intento-preparado', status: 'PREPARED' } as any)

    await expect(registrar(true)).resolves.toEqual({ sessionId, attemptId: 'intento-preparado' })
    expect(prismaMock.areaTicketPaymentAttempt.create).not.toHaveBeenCalled()
  })

  it('regresión: sesión materializada ⇒ como siempre, PAYMENT_PENDING con el intento nuevo', async () => {
    preparar(AreaTicketCheckoutStatus.MATERIALIZED)

    await registrar(true)

    expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAYMENT_PENDING', activePaymentAttemptId: 'intento-nuevo' }) }),
    )
  })

  describe('el cierre por otro canal (`cerrarSesionDeValesAlCerrarLaVenta`)', () => {
    it.each([AreaTicketCheckoutStatus.PARTIALLY_PAID, AreaTicketCheckoutStatus.MATERIALIZED])(
      '🔴 sesión %s ⇒ PAID, sus vales CLAIMED pagados (DELIVERED / PAID con paidAt) y se suelta el reclamo de la terminal',
      async status => {
        const cerro = await cerrarSesionDeValesAlCerrarLaVenta(prismaMock, sesionBloqueada(status) as any, { venueId, orderId })

        expect(cerro).toBe(true)
        expect(
          (prismaMock.areaTicket.updateMany as jest.Mock).mock.calls.map(([a]: any[]) => [a.where.id.in, a.where.status, a.data.status]),
        ).toEqual([
          [['ticket-ya'], 'CLAIMED', 'DELIVERED'],
          [['ticket-guardado'], 'CLAIMED', 'PAID'],
        ])
        expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', activePaymentAttemptId: null }) }),
        )
        expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
          where: { id: orderId, venueId, areaTicketCode: { not: null } },
          data: { claimedByTerminalId: null, claimedAt: null },
        })
        // Ni inventario ni reservas: el vale SALE del cierre ya tomó la obligación y soltó las reservas al crearse (R10-2/R12-2).
        expect(prismaMock.areaTicketInventoryReservation.updateMany).not.toHaveBeenCalled()
        // R12-4: el intento UNKNOWN hermano cuyo cobro ya contó deja de pedir conciliación.
        expect(prismaMock.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith({
          where: { checkoutSessionId: sessionId, orderId, status: 'UNKNOWN', payment: { is: { status: 'COMPLETED', orderId } } },
          data: { status: 'SUCCEEDED', completedAt: expect.any(Date), lastCheckedAt: expect.any(Date) },
        })
      },
    )

    it.each([
      ['en conciliación (su intento la recupera con su evidencia)', AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED, 'intento-viejo'],
      ['con un intento vivo (llegará por la rama de la venta cerrada)', AreaTicketCheckoutStatus.PAYMENT_PENDING, 'intento-vivo'],
      ['ya PAID', AreaTicketCheckoutStatus.PAID, null],
    ] as const)('🔴 sesión %s ⇒ no se toca nada', async (_caso, status, activo) => {
      const cerro = await cerrarSesionDeValesAlCerrarLaVenta(prismaMock, sesionBloqueada(status, activo) as any, { venueId, orderId })

      expect(cerro).toBe(false)
      expect(prismaMock.areaTicket.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    })
  })
})

/**
 * 🔴 Ronda 12 (Codex recheck-16 #1 y #4): el dinero ya capturado sobre una sesión CANCELADA o EXPIRADA sigue la regla de nivel venta (como
 * una venta sin vales: se registra y la cuenta cancelada se reabre), sin apropiarse de los vales que la cancelación liberó; y la
 * recuperación de las reservas que dejó un cierre por otro canal ANTES de R10-2.
 */
describe('🔴 R12: dinero capturado sobre una sesión cancelada y reservas viejas de otro canal', () => {
  const sesion = (status: AreaTicketCheckoutStatus, activePaymentAttemptId: string | null = null) => ({
    id: sessionId,
    orderId,
    status,
    activePaymentAttemptId,
    tickets: [{ id: 'ticket-r12', fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID' }],
    paymentAttempts: [{ sequence: 1 }],
  })
  const registrar = (dineroCapturado?: boolean) =>
    lockAreaTicketCheckoutForPayment(prismaMock, {
      venueId,
      orderId,
      idempotencyKey: 'llave-r12',
      amount: new Prisma.Decimal('100.00'),
      method: 'CASH' as any,
      ...(dineroCapturado === undefined ? {} : { dineroCapturado }),
    })
  beforeEach(() => {
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.areaTicketPaymentAttempt.findUnique.mockResolvedValue(null)
    prismaMock.areaTicketPaymentAttempt.create.mockResolvedValue({ id: 'intento-nuevo' } as any)
  })

  describe('R12-1: la sesión cancelada no es razón de 409 para el dinero ya capturado', () => {
    it.each([AreaTicketCheckoutStatus.CANCELLED, AreaTicketCheckoutStatus.EXPIRED])(
      '🔴 dinero capturado sobre una sesión %s ⇒ `null` (se registra como venta sin vales); ni intento, ni sesión, ni vales, y queda la alerta',
      async status => {
        prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion(status) as any)

        await expect(registrar(true)).resolves.toBeNull()

        expect(prismaMock.areaTicketPaymentAttempt.findUnique).not.toHaveBeenCalled()
        expect(prismaMock.areaTicketPaymentAttempt.create).not.toHaveBeenCalled()
        expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
        expect(prismaMock.areaTicket.updateMany).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('🚨'),
          expect.objectContaining({ checkoutSessionId: sessionId, orderId, estadoDeLaSesion: status }),
        )
      },
    )

    it.each([AreaTicketCheckoutStatus.CANCELLED, AreaTicketCheckoutStatus.EXPIRED])(
      'regresión: un cobro NUEVO sobre una sesión %s ⇒ 409 antes de tomar el dinero',
      async status => {
        prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(sesion(status) as any)

        await expect(registrar()).rejects.toMatchObject({ statusCode: 409, code: 'CHECKOUT_PAYMENT_NOT_ALLOWED' })
        expect(prismaMock.areaTicketPaymentAttempt.create).not.toHaveBeenCalled()
      },
    )
  })

  describe('R12-3: la recuperación de una venta que otro canal cerró antes de R10-2 (`cerrarSesionDeVentaCerradaPorOtroCanal`)', () => {
    const preparar = (o: { sesion?: AreaTicketCheckoutStatus; activo?: string | null; venta?: string; vale?: boolean } = {}) => {
      prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(
        sesion(o.sesion ?? AreaTicketCheckoutStatus.PARTIALLY_PAID, o.activo ?? null) as any,
      )
      prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: o.venta ?? 'PAID', status: 'COMPLETED' } as any)
      prismaMock.inventoryPosting.findUnique.mockResolvedValue((o.vale === false ? null : { id: 'vale-del-pago-manual' }) as any)
      prismaMock.areaTicketInventoryReservation.updateMany.mockResolvedValue({ count: 1 } as any)
    }

    it('🔴 venta PAID con el vale SALE del otro canal y su sesión PARTIALLY_PAID ⇒ la sesión cierra PAID y sus reservas ACTIVE se sueltan, sin stock, pagos ni efectos', async () => {
      preparar()

      await expect(cerrarSesionDeVentaCerradaPorOtroCanal(venueId, orderId)).resolves.toBe(true)

      // La jerarquía (sesión → vales → venta) es lo primero que se bloquea.
      expect(sqlText((prismaMock.$queryRaw as jest.Mock).mock.calls[0][0])).toContain('"AreaTicketCheckoutSession"')
      expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', activePaymentAttemptId: null }) }),
      )
      expect(prismaMock.areaTicketInventoryReservation.updateMany).toHaveBeenCalledWith({
        where: { venueId, areaTicket: { checkoutSessionId: sessionId }, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: expect.any(Date) },
      })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
      expect(prismaMock.inventoryPosting.create).not.toHaveBeenCalled()
      expect(prismaMock.order.update).not.toHaveBeenCalled()
    })

    /**
     * 🔴 R13-4 (re-revisión r12): una venta de vales ya REFUNDED, o una sesión PAYMENT_PENDING sin intento, conservaban la reserva
     * fantasma. El helper de R11-8 ya cierra la PAYMENT_PENDING sin intento; la venta devuelta sigue siendo una venta cerrada con su vale
     * SALE. Mismo cierre: sin pagos, sin lealtad, sin comanda, sin mover stock.
     */
    it.each([
      ['la venta ya está REFUNDED (sesión PARTIALLY_PAID)', { venta: 'REFUNDED' }],
      ['la sesión está PAYMENT_PENDING sin intento (venta PAID)', { sesion: AreaTicketCheckoutStatus.PAYMENT_PENDING }],
      ['venta REFUNDED y sesión PAYMENT_PENDING sin intento', { venta: 'REFUNDED', sesion: AreaTicketCheckoutStatus.PAYMENT_PENDING }],
    ] as const)('🔴 R13-4: %s ⇒ la sesión cierra y sus reservas ACTIVE se sueltan, sin stock, pagos ni efectos', async (_caso, o) => {
      preparar(o as any)

      await expect(cerrarSesionDeVentaCerradaPorOtroCanal(venueId, orderId)).resolves.toBe(true)
      expect(prismaMock.areaTicketCheckoutSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', activePaymentAttemptId: null }) }),
      )
      expect(prismaMock.areaTicketInventoryReservation.updateMany).toHaveBeenCalledWith({
        where: { venueId, areaTicket: { checkoutSessionId: sessionId }, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: expect.any(Date) },
      })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
      expect(prismaMock.inventoryPosting.create).not.toHaveBeenCalled()
      expect(prismaMock.order.update).not.toHaveBeenCalled()
    })

    it.each([
      ['sin vale SALE (la cerró el barrido de estado: la retoma su propio camino)', { vale: false }],
      ['la venta no está cobrada', { venta: 'PARTIAL' }],
      ['la sesión está PAYMENT_PENDING CON su intento vivo', { sesion: AreaTicketCheckoutStatus.PAYMENT_PENDING, activo: 'intento-vivo' }],
      ['la sesión está en conciliación', { sesion: AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED, activo: 'intento-viejo' }],
      ['la sesión ya está PAID', { sesion: AreaTicketCheckoutStatus.PAID }],
      ['la sesión está cancelada', { sesion: AreaTicketCheckoutStatus.CANCELLED }],
    ] as const)('regresión: %s ⇒ no toca nada', async (_caso, o) => {
      preparar(o as any)

      await expect(cerrarSesionDeVentaCerradaPorOtroCanal(venueId, orderId)).resolves.toBe(false)
      expect(prismaMock.areaTicketCheckoutSession.update).not.toHaveBeenCalled()
      expect(prismaMock.areaTicketInventoryReservation.updateMany).not.toHaveBeenCalled()
    })
  })
})
