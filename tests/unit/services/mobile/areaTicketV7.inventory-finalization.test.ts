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
