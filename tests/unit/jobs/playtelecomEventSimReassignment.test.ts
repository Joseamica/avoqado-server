jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organization: { findFirst: jest.fn() },
    venue: { findFirst: jest.fn() },
    serializedItem: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    order: { findUnique: jest.fn() },
    activityLog: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  isOrderPureCategoryMatch,
  reassignEventSimSalesForRule,
  reassignEventSimSales,
  PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES,
  type EventVenueReassignmentRule,
} from '@/jobs/playtelecomEventSimReassignment.job'

const RULE: EventVenueReassignmentRule = {
  orgName: 'PlayTelecom',
  categoryName: 'SIM de Evento',
  originState: 'San Luis Potosí',
  targetVenueSlug: 'activacion-slp',
}
const SOURCE_VENUE = 'origin-venue-1'
const TARGET_VENUE = 'venue-activacion-slp'
const ORDER_GENERATION = new Date('2026-09-04T09:00:00.000Z')
const EXPECTED_DISCOVERY_PAGE_SIZE = 100
const PURE_EVENT_ITEM = {
  serializedItem: {
    status: 'SOLD',
    sellingVenueId: SOURCE_VENUE,
    category: { name: 'SIM de Evento' },
  },
}

beforeEach(() => jest.resetAllMocks())

describe('reassignEventSimSalesForRule', () => {
  it('salta la regla completa si la organización no existe en este ambiente (dev/CI limpios)', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue(null)

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.venue.findFirst).not.toHaveBeenCalled()
  })

  it('salta la regla completa si el venue destino todavía no existe', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(null)

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.serializedItem.findMany).not.toHaveBeenCalled()
  })

  it('reasigna una orden pura (100% SIM de Evento) en las 4 tablas, y audita', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-1' }])
    const immutableTenderSnapshot = {
      tenderRevision: 7,
      tenderLabel: 'Vale corporativo',
      tenderCountsAsCash: true,
      tenderCaptureTip: false,
      tenderSatFormaPago: '05',
      tenderCommissionPercent: '3.50',
      tenderCommissionAmount: '7.00',
      method: 'OTHER',
      fundsFlow: 'CASH_DRAWER',
    }
    const paymentState = {
      venueId: SOURCE_VENUE,
      tenderTypeId: 'source-venue-tender',
      ...immutableTenderSnapshot,
    }
    const verificationState = { venueId: SOURCE_VENUE }
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'order-1',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ])
        .mockResolvedValueOnce([{ id: 'payment-1', venueId: SOURCE_VENUE }])
        .mockResolvedValueOnce([{ id: 'verification-1', paymentId: 'payment-1', venueId: SOURCE_VENUE }]),
      orderItem: {
        // La pureza se conoce sólo después de bloquear Order. La categoría REAL de un SIM
        // vive en SerializedItem.category, no en OrderItem.categoryName.
        findMany: jest.fn().mockResolvedValue([PURE_EVENT_ITEM]),
      },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payment: {
        updateMany: jest.fn().mockImplementation(async ({ data }) => {
          const nextState = { ...paymentState, ...data }
          // Mirrors Payment's real composite FK [venueId, tenderTypeId]. A source
          // tender cannot be attached to the destination venue.
          if (nextState.venueId === TARGET_VENUE && nextState.tenderTypeId !== null) {
            throw new Error('Payment_venueId_tenderTypeId_fkey')
          }
          Object.assign(paymentState, nextState)
          return { count: 1 }
        }),
      },
      saleVerification: {
        updateMany: jest.fn().mockImplementation(async () => {
          // Esta FK/dependencia se debe mover mientras Payment aún conserva el source venue.
          expect(paymentState.venueId).toBe(SOURCE_VENUE)
          verificationState.venueId = TARGET_VENUE
          return { count: 1 }
        }),
      },
      serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'atomic-marker' }) },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 1, skippedMixed: 0 })
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1)
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: SOURCE_VENUE, updatedAt: ORDER_GENERATION },
      data: { venueId: TARGET_VENUE },
    })
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['payment-1'] }, orderId: 'order-1', venueId: SOURCE_VENUE },
      data: { venueId: TARGET_VENUE, tenderTypeId: null },
    })
    expect(tx.saleVerification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['verification-1'] }, paymentId: { in: ['payment-1'] }, venueId: SOURCE_VENUE },
      data: { venueId: TARGET_VENUE },
    })
    expect(tx.saleVerification.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.payment.updateMany.mock.invocationCallOrder[0])
    expect(paymentState.venueId).toBe(TARGET_VENUE)
    expect(paymentState.tenderTypeId).toBeNull()
    expect(paymentState).toEqual(expect.objectContaining(immutableTenderSnapshot))
    expect(verificationState.venueId).toBe(TARGET_VENUE)
    expect(tx.serializedItem.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'SOLD',
        sellingVenueId: SOURCE_VENUE,
        orderItem: { orderId: 'order-1' },
        category: { name: { equals: RULE.categoryName, mode: 'insensitive' } },
      },
      data: { sellingVenueId: TARGET_VENUE },
    })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3)
    // Auditoría BIDIRECCIONAL y marker comparten la MISMA transacción que mueve Order/Payment.
    // Si una fila de audit falla, el movimiento tampoco puede quedar commiteado sin evidencia.
    expect(tx.activityLog.create).toHaveBeenCalledTimes(2)
    for (const venueId of [TARGET_VENUE, SOURCE_VENUE]) {
      expect(tx.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ORDER_VENUE_REASSIGNED',
          entity: 'Order',
          entityId: 'order-1',
          staffId: null,
          venueId,
          createdAt: expect.any(Date),
          data: expect.objectContaining({
            fromVenueId: 'origin-venue-1',
            toVenueId: 'venue-activacion-slp',
            reason: 'playtelecom_evento_sim',
            sourceOrderUpdatedAt: ORDER_GENERATION.toISOString(),
          }),
        }),
      })
    }
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('si falla el marker bidireccional, la reasignación falla dentro de la misma transacción y no se cuenta como movida', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-1' }])
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'order-1',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ])
        .mockResolvedValueOnce([{ id: 'payment-1', venueId: SOURCE_VENUE }])
        .mockResolvedValueOnce([{ id: 'verification-1', paymentId: 'payment-1', venueId: SOURCE_VENUE }]),
      orderItem: { findMany: jest.fn().mockResolvedValue([PURE_EVENT_ITEM]) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      saleVerification: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activityLog: {
        create: jest.fn().mockResolvedValueOnce({ id: 'marker-destino' }).mockRejectedValueOnce(new Error('audit unavailable')),
      },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(2)
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each([
    ['cambió al venue actual de otra fuente', { venueId: 'venue-otra-fuente', organizationId: 'org1', state: RULE.originState }],
    ['el venue fuente ya pertenece a otra organización', { venueId: SOURCE_VENUE, organizationId: 'org-2', state: RULE.originState }],
    ['el venue fuente ya no está en el estado de la regla', { venueId: SOURCE_VENUE, organizationId: 'org1', state: 'Querétaro' }],
  ])('discovery→lock: %s, así que no mueve ni crea marker', async (_case, currentAuthority) => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-race' }])
    ;(prisma.activityLog.findFirst as jest.Mock).mockResolvedValue(null)
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'order-race', updatedAt: ORDER_GENERATION, ...currentAuthority }]),
      orderItem: { findMany: jest.fn().mockResolvedValue([PURE_EVENT_ITEM]) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activityLog: { create: jest.fn() },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    await expect(reassignEventSimSalesForRule(RULE)).resolves.toEqual({ reassigned: 0, skippedMixed: 0 })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.activityLog.findFirst).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(tx.payment.updateMany).not.toHaveBeenCalled()
    expect(tx.saleVerification.updateMany).not.toHaveBeenCalled()
    expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('aun con fuentes descubiertas mixtas para una Order, entra a la tx y bloquea Order antes de descartarla', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([
      { orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE },
      { orderItemId: 'oi-2', sellingVenueId: 'otra-fuente-descubierta' },
    ])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      { id: 'oi-1', orderId: 'order-multi-source' },
      { id: 'oi-2', orderId: 'order-multi-source' },
    ])
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'order-multi-source',
          venueId: SOURCE_VENUE,
          updatedAt: ORDER_GENERATION,
          organizationId: 'org1',
          state: RULE.originState,
        },
      ]),
      orderItem: { findMany: jest.fn() },
      order: { updateMany: jest.fn() },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn() },
      activityLog: { findFirst: jest.fn(), create: jest.fn() },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    await expect(reassignEventSimSalesForRule(RULE)).resolves.toEqual({ reassigned: 0, skippedMixed: 0 })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.findMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it.each([
    [
      'apareció un item no-evento',
      [{ serializedItem: { status: 'SOLD', sellingVenueId: SOURCE_VENUE, category: { name: '$100 de Promotor' } } }],
      1,
      1,
    ],
    [
      'el SerializedItem cambió de selling venue',
      [{ serializedItem: { status: 'SOLD', sellingVenueId: 'venue-otra-fuente', category: { name: RULE.categoryName } } }],
      0,
      0,
    ],
  ])(
    'discovery→lock: %s, así que la revalidación transaccional no mueve nada',
    async (_case, currentItems, skippedMixed, mixedAuditWrites) => {
      ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
      ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
      ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
      ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-race' }])
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'order-race',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ]),
        orderItem: { findMany: jest.fn().mockResolvedValue(currentItems) },
        order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        payment: { updateMany: jest.fn() },
        saleVerification: { updateMany: jest.fn() },
        serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        activityLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'mixed-audit' }) },
      }
      ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

      await expect(reassignEventSimSalesForRule(RULE)).resolves.toEqual({ reassigned: 0, skippedMixed })

      expect(tx.order.updateMany).not.toHaveBeenCalled()
      expect(tx.payment.updateMany).not.toHaveBeenCalled()
      expect(tx.saleVerification.updateMany).not.toHaveBeenCalled()
      expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
      expect(tx.activityLog.create).toHaveBeenCalledTimes(mixedAuditWrites)
      if (mixedAuditWrites === 1) {
        expect(tx.activityLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
            entity: 'Order',
            entityId: 'order-race',
            venueId: SOURCE_VENUE,
          }),
        })
      }
    },
  )

  it('salta una orden mixta (Evento + otra categoría) SIN tocar ninguna tabla, y la deja marcada para revisión manual', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-mixta' }])
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'order-mixta',
          venueId: SOURCE_VENUE,
          updatedAt: ORDER_GENERATION,
          organizationId: 'org1',
          state: RULE.originState,
        },
      ]),
      orderItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            PURE_EVENT_ITEM,
            { serializedItem: { status: 'SOLD', sellingVenueId: SOURCE_VENUE, category: { name: '$100 de Promotor' } } },
          ]),
      },
      order: { updateMany: jest.fn() },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn() },
      activityLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'mixed-audit' }),
      },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 1 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.findFirst).toHaveBeenCalledWith({
      where: {
        action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
        entity: 'Order',
        entityId: 'order-mixta',
        venueId: SOURCE_VENUE,
      },
      select: { id: true },
    })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
        entity: 'Order',
        entityId: 'order-mixta',
        venueId: SOURCE_VENUE,
        staffId: null,
      }),
    })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una orden mixta YA reportada no se vuelve a auditar (el job la reencuentra cada 15 min para siempre)', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-mixta' }])
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'order-mixta',
          venueId: SOURCE_VENUE,
          updatedAt: ORDER_GENERATION,
          organizationId: 'org1',
          state: RULE.originState,
        },
      ]),
      orderItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            PURE_EVENT_ITEM,
            { serializedItem: { status: 'SOLD', sellingVenueId: SOURCE_VENUE, category: { name: '$100 de Promotor' } } },
          ]),
      },
      order: { updateMany: jest.fn() },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn() },
      activityLog: { findFirst: jest.fn().mockResolvedValue({ id: 'existing-log-1' }), create: jest.fn() },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('dos jobs concurrentes serializados por el lock de Order crean un solo audit mixto y sólo uno lo cuenta', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ id: 'oi-1', orderId: 'order-mixta-concurrente' }])

    let mixedAuditExists = false
    const auditCreate = jest.fn().mockImplementation(async () => {
      mixedAuditExists = true
      return { id: 'mixed-audit' }
    })
    const transactions: any[] = []
    let previousTransaction = Promise.resolve()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      const waitForPrevious = previousTransaction
      let release!: () => void
      previousTransaction = new Promise<void>(resolve => {
        release = resolve
      })
      await waitForPrevious
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'order-mixta-concurrente',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ]),
        orderItem: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              PURE_EVENT_ITEM,
              { serializedItem: { status: 'SOLD', sellingVenueId: SOURCE_VENUE, category: { name: 'OTRA' } } },
            ]),
        },
        order: { updateMany: jest.fn() },
        payment: { updateMany: jest.fn() },
        saleVerification: { updateMany: jest.fn() },
        serializedItem: { updateMany: jest.fn() },
        activityLog: {
          findFirst: jest.fn().mockImplementation(async () => (mixedAuditExists ? { id: 'mixed-audit' } : null)),
          create: auditCreate,
        },
      }
      transactions.push(tx)
      try {
        return await cb(tx)
      } finally {
        release()
      }
    })

    const results = await Promise.all([reassignEventSimSalesForRule(RULE), reassignEventSimSalesForRule(RULE)])

    expect(results.reduce((sum, result) => sum + result.skippedMixed, 0)).toBe(1)
    expect(results.every(result => result.reassigned === 0)).toBe(true)
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(transactions).toHaveLength(2)
    expect(auditCreate).toHaveBeenCalledTimes(1)
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'Payment cambió de source antes de su lock',
      paymentVenue: 'venue-payment-drift',
      verificationVenue: SOURCE_VENUE,
      paymentCount: 1,
      verificationCount: 1,
      verificationCalls: 0,
      paymentCalls: 0,
    },
    {
      name: 'SaleVerification cambió de source antes de su lock',
      paymentVenue: SOURCE_VENUE,
      verificationVenue: 'venue-verification-drift',
      paymentCount: 1,
      verificationCount: 1,
      verificationCalls: 0,
      paymentCalls: 0,
    },
    {
      name: 'el count de SaleVerification deriva al escribir',
      paymentVenue: SOURCE_VENUE,
      verificationVenue: SOURCE_VENUE,
      paymentCount: 1,
      verificationCount: 0,
      verificationCalls: 1,
      paymentCalls: 0,
    },
    {
      name: 'el count de Payment deriva al escribir',
      paymentVenue: SOURCE_VENUE,
      verificationVenue: SOURCE_VENUE,
      paymentCount: 0,
      verificationCount: 1,
      verificationCalls: 1,
      paymentCalls: 1,
    },
  ])('$name: aborta y revierte todo sin marker ni reassigned', async testCase => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-dependent-drift' }])

    const state = {
      paymentVenue: testCase.paymentVenue,
      verificationVenue: testCase.verificationVenue,
    }
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'order-dependent-drift',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ])
        .mockResolvedValueOnce([{ id: 'payment-1', venueId: testCase.paymentVenue }])
        .mockResolvedValueOnce([{ id: 'verification-1', paymentId: 'payment-1', venueId: testCase.verificationVenue }]),
      orderItem: { findMany: jest.fn().mockResolvedValue([PURE_EVENT_ITEM]) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      saleVerification: {
        updateMany: jest.fn().mockImplementation(async () => {
          if (testCase.verificationCount === 1) state.verificationVenue = TARGET_VENUE
          return { count: testCase.verificationCount }
        }),
      },
      payment: {
        updateMany: jest.fn().mockImplementation(async () => {
          if (testCase.paymentCount === 1) state.paymentVenue = TARGET_VENUE
          return { count: testCase.paymentCount }
        }),
      },
      serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'must-not-commit' }) },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      const snapshot = { ...state }
      try {
        return await cb(tx)
      } catch (error) {
        Object.assign(state, snapshot)
        throw error
      }
    })

    await expect(reassignEventSimSalesForRule(RULE)).resolves.toEqual({ reassigned: 0, skippedMixed: 0 })

    expect(tx.saleVerification.updateMany).toHaveBeenCalledTimes(testCase.verificationCalls)
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(testCase.paymentCalls)
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(state).toEqual({
      paymentVenue: testCase.paymentVenue,
      verificationVenue: testCase.verificationVenue,
    })
  })

  it.each([
    ['SerializedItem', 0, 1, 0],
    ['Order', 1, 0, 1],
  ])('si deriva el count exacto de %s, aborta antes del marker', async (_model, serializedCount, orderCount, orderCalls) => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1', sellingVenueId: SOURCE_VENUE }])
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'oi-1', orderId: 'order-count-drift' }])
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'order-count-drift',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      orderItem: { findMany: jest.fn().mockResolvedValue([PURE_EVENT_ITEM]) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: orderCount }) },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: serializedCount }) },
      activityLog: { create: jest.fn() },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    await expect(reassignEventSimSalesForRule(RULE)).resolves.toEqual({ reassigned: 0, skippedMixed: 0 })

    expect(tx.serializedItem.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.order.updateMany).toHaveBeenCalledTimes(orderCalls)
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('exhausts bounded keyset pages so a recurring mixed order in the first full page cannot starve a later eligible order', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: TARGET_VENUE })

    const earlyCandidates = Array.from({ length: EXPECTED_DISCOVERY_PAGE_SIZE }, (_, index) => ({
      id: `serialized-${String(index + 1).padStart(4, '0')}`,
      orderItemId: `mixed-item-${String(index + 1).padStart(4, '0')}`,
      sellingVenueId: SOURCE_VENUE,
    }))
    const laterCandidate = {
      id: 'serialized-0101',
      orderItemId: 'eligible-item-0101',
      sellingVenueId: SOURCE_VENUE,
    }
    const firstPageLastId = earlyCandidates[earlyCandidates.length - 1].id

    ;(prisma.serializedItem.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const afterId = where.id?.gt
      if (afterId == null) return earlyCandidates
      if (afterId === firstPageLastId) return [laterCandidate]
      if (afterId === laterCandidate.id) return []
      throw new Error(`unexpected discovery cursor ${String(afterId)}`)
    })
    ;(prisma.orderItem.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const ids: string[] = where.id.in
      if (ids.includes(laterCandidate.orderItemId)) {
        return [{ id: laterCandidate.orderItemId, orderId: 'order-later-eligible' }]
      }
      return ids.map(id => ({ id, orderId: 'order-recurring-mixed' }))
    })

    const mixedTx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'order-recurring-mixed',
          venueId: SOURCE_VENUE,
          updatedAt: ORDER_GENERATION,
          organizationId: 'org1',
          state: RULE.originState,
        },
      ]),
      orderItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            PURE_EVENT_ITEM,
            { serializedItem: { status: 'SOLD', sellingVenueId: SOURCE_VENUE, category: { name: 'OTRA' } } },
          ]),
      },
      order: { updateMany: jest.fn() },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn() },
      activityLog: { findFirst: jest.fn().mockResolvedValue({ id: 'existing-mixed-marker' }), create: jest.fn() },
    }
    const eligibleTx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'order-later-eligible',
            venueId: SOURCE_VENUE,
            updatedAt: ORDER_GENERATION,
            organizationId: 'org1',
            state: RULE.originState,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      orderItem: { findMany: jest.fn().mockResolvedValue([PURE_EVENT_ITEM]) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      activityLog: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'move-marker' }) },
    }
    ;(prisma.$transaction as jest.Mock)
      .mockImplementationOnce(async (callback: any) => callback(mixedTx))
      .mockImplementationOnce(async (callback: any) => callback(eligibleTx))

    await expect(reassignEventSimSalesForRule(RULE)).resolves.toEqual({ reassigned: 1, skippedMixed: 0 })

    expect(prisma.serializedItem.findMany).toHaveBeenCalledTimes(2)
    const discoveryCalls = (prisma.serializedItem.findMany as jest.Mock).mock.calls.map(([args]) => args)
    for (const args of discoveryCalls) {
      expect(args.take).toBe(EXPECTED_DISCOVERY_PAGE_SIZE)
      expect(args.orderBy).toEqual({ id: 'asc' })
      expect(args.select).toEqual(expect.objectContaining({ id: true, orderItemId: true, sellingVenueId: true }))
    }
    expect(discoveryCalls[1].where.id).toEqual({ gt: firstPageLastId })

    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(2)
    const hydrationCalls = (prisma.orderItem.findMany as jest.Mock).mock.calls.map(([args]) => args)
    for (const args of hydrationCalls) {
      expect(args.take).toBeLessThanOrEqual(EXPECTED_DISCOVERY_PAGE_SIZE)
      expect(args.orderBy).toEqual({ id: 'asc' })
      expect(args.where.id.in).toHaveLength(args.take)
    }
    expect(mixedTx.activityLog.create).not.toHaveBeenCalled()
    expect(eligibleTx.order.updateMany).toHaveBeenCalledTimes(1)
  })

  it('sin candidatos, no hace ninguna llamada de escritura', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([])

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
  })
})

describe('isOrderPureCategoryMatch', () => {
  it('es true cuando TODOS los items de la orden son de la categoría pedida', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', 'SIM de Evento'], 'SIM de Evento')).toBe(true)
  })

  it('ignora mayúsculas y espacios al comparar', () => {
    expect(isOrderPureCategoryMatch(['  sim de evento  '], 'SIM de Evento')).toBe(true)
  })

  it('es false cuando hay un item de OTRA categoría mezclado', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', '$100 de Promotor'], 'SIM de Evento')).toBe(false)
  })

  it('es false cuando un item no tiene categoría (producto no serializado)', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', null], 'SIM de Evento')).toBe(false)
  })

  it('es false para una orden vacía (nunca reasigna algo sin items)', () => {
    expect(isOrderPureCategoryMatch([], 'SIM de Evento')).toBe(false)
  })
})

describe('reassignEventSimSales (orquestador)', () => {
  it('corre TODAS las reglas de PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES y no truena si una falla', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(null)

    await expect(reassignEventSimSales()).resolves.toBeUndefined()

    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES.length)
  })

  it('si UNA regla truena, sigue procesando la SIGUIENTE regla distinta (no aborta el loop)', async () => {
    const ruleA: EventVenueReassignmentRule = {
      orgName: 'OrgA',
      categoryName: 'CatA',
      originState: 'StateA',
      targetVenueSlug: 'slug-a',
    }
    const ruleB: EventVenueReassignmentRule = {
      orgName: 'OrgB',
      categoryName: 'CatB',
      originState: 'StateB',
      targetVenueSlug: 'slug-b',
    }
    ;(prisma.organization.findFirst as jest.Mock).mockRejectedValueOnce(new Error('boom en ruleA')).mockResolvedValueOnce(null) // ruleB: org no existe, se salta limpio (no cuenta como error)

    await expect(reassignEventSimSales([ruleA, ruleB])).resolves.toBeUndefined()

    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(2)
    expect(prisma.organization.findFirst).toHaveBeenNthCalledWith(1, {
      where: { name: { equals: 'OrgA', mode: 'insensitive' } },
      select: { id: true },
    })
    expect(prisma.organization.findFirst).toHaveBeenNthCalledWith(2, {
      where: { name: { equals: 'OrgB', mode: 'insensitive' } },
      select: { id: true },
    })
  })
})
