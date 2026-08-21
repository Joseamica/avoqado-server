jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organization: { findFirst: jest.fn() },
    venue: { findFirst: jest.fn() },
    serializedItem: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    order: { findUnique: jest.fn() },
    activityLog: { findFirst: jest.fn() },
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

describe('reassignEventSimSalesForRule', () => {
  beforeEach(() => jest.clearAllMocks())

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
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1' }])
    ;(prisma.orderItem.findMany as jest.Mock)
      .mockResolvedValueOnce([{ orderId: 'order-1' }]) // resolver orderId desde orderItemIds candidatos
      // items de esa orden, para el check de pureza — la categoría REAL de un SIM vive en
      // SerializedItem.category (ItemCategory), NUNCA en OrderItem.categoryName (que es de MenuCategory
      // y siempre es null en ventas serializadas).
      .mockResolvedValueOnce([{ serializedItem: { category: { name: 'SIM de Evento' } } }])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ venueId: 'origin-venue-1' }) // venue ORIGEN, antes de mover
    const tx = {
      order: { updateMany: jest.fn() },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn() },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 1, skippedMixed: 0 })
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', NOT: { venueId: 'venue-activacion-slp' } },
      data: { venueId: 'venue-activacion-slp' },
    })
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1', NOT: { venueId: 'venue-activacion-slp' } },
      data: { venueId: 'venue-activacion-slp' },
    })
    expect(tx.saleVerification.updateMany).toHaveBeenCalledWith({
      where: { payment: { orderId: 'order-1' }, NOT: { venueId: 'venue-activacion-slp' } },
      data: { venueId: 'venue-activacion-slp' },
    })
    expect(tx.serializedItem.updateMany).toHaveBeenCalledWith({
      where: { orderItem: { orderId: 'order-1' } },
      data: { sellingVenueId: 'venue-activacion-slp' },
    })
    // Auditoría BIDIRECCIONAL: la pantalla de bitácora filtra `where: { venueId }`, así que una sola
    // fila en el destino deja la tienda de ORIGEN sin rastro de que le quitaron una venta.
    expect(logAction).toHaveBeenCalledTimes(2)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_VENUE_REASSIGNED',
        entity: 'Order',
        entityId: 'order-1',
        staffId: null,
        venueId: 'venue-activacion-slp',
        data: expect.objectContaining({ fromVenueId: 'origin-venue-1', toVenueId: 'venue-activacion-slp' }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_VENUE_REASSIGNED',
        entity: 'Order',
        entityId: 'order-1',
        staffId: null,
        venueId: 'origin-venue-1',
        data: expect.objectContaining({ fromVenueId: 'origin-venue-1', toVenueId: 'venue-activacion-slp' }),
      }),
    )
  })

  it('salta una orden mixta (Evento + otra categoría) SIN tocar ninguna tabla, y la deja marcada para revisión manual', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1' }])
    ;(prisma.orderItem.findMany as jest.Mock)
      .mockResolvedValueOnce([{ orderId: 'order-mixta' }])
      .mockResolvedValueOnce([
        { serializedItem: { category: { name: 'SIM de Evento' } } },
        { serializedItem: { category: { name: '$100 de Promotor' } } },
      ])
    ;(prisma.activityLog.findFirst as jest.Mock).mockResolvedValue(null) // todavía no se había reportado
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ venueId: 'store-venue-1' })

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 1 })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    // Se audita UNA vez, en el venue donde la orden está hoy — es lo que hace visible la revisión
    // manual, en vez de un warn cada 15 min que nadie lee.
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_VENUE_REASSIGNMENT_SKIPPED_MIXED',
        entity: 'Order',
        entityId: 'order-mixta',
        venueId: 'store-venue-1',
      }),
    )
  })

  it('una orden mixta YA reportada no se vuelve a auditar (el job la reencuentra cada 15 min para siempre)', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1' }])
    ;(prisma.orderItem.findMany as jest.Mock)
      .mockResolvedValueOnce([{ orderId: 'order-mixta' }])
      .mockResolvedValueOnce([
        { serializedItem: { category: { name: 'SIM de Evento' } } },
        { serializedItem: { category: { name: '$100 de Promotor' } } },
      ])
    ;(prisma.activityLog.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-log-1' }) // ya reportada antes

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 1 })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
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
