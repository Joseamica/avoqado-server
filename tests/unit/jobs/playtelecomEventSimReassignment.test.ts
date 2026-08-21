jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organization: { findFirst: jest.fn() },
    venue: { findFirst: jest.fn() },
    serializedItem: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
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
      .mockResolvedValueOnce([{ categoryName: 'SIM de Evento' }]) // items de esa orden, para el check de pureza
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
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_VENUE_REASSIGNED', entity: 'Order', entityId: 'order-1', staffId: null }),
    )
  })

  it('salta una orden mixta (Evento + otra categoría) SIN tocar ninguna tabla, y no cuenta como reasignada', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1' }])
    ;(prisma.orderItem.findMany as jest.Mock)
      .mockResolvedValueOnce([{ orderId: 'order-mixta' }])
      .mockResolvedValueOnce([{ categoryName: 'SIM de Evento' }, { categoryName: '$100 de Promotor' }])

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
