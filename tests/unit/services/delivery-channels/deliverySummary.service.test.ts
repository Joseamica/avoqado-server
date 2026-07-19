/**
 * getDeliveryDailySummary (Task 5 del plan delivery-activation-backend): servicio compartido
 * DRY entre el MCP tool `delivery_channels` (`todayByChannel`, src/mcp/tools/deliveryChannels.ts)
 * y el nuevo REST GET /venues/:venueId/delivery/summary (deliveryChannels.controller.ts).
 *
 * Pedidos e ingreso de HOY, agrupados por `Order.source`, solo pedidos con
 * `originSystem: DELIVERY_PLATFORM` (inyectados por un canal de delivery).
 *
 * Casos obligatorios (brief): agrupa por canal filtrando DELIVERY_PLATFORM + hoy venue-local
 * (venueStartOfDay(tz)); totalPesos = Number(_sum.total) — PESOS, nunca cents; venue sin
 * pedidos -> channels: [].
 */
import { OriginSystem } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { getDeliveryDailySummary } from '../../../../src/services/delivery-channels/core/deliverySummary.service'

const mockVenueStartOfDay = jest.fn()

// "Hoy" debe resolverse vía venueStartOfDay(tz) del VENUE, nunca un bare new Date() del host
// (regla venue-local, critical-warnings.md). Mockeado determinísticamente — mismo patrón que
// tests/unit/mcp-customer/delivery-channels.test.ts y organizationDashboard.service.test.ts.
// venueStartOfDay en sí ya está unit-testeado en tests/unit/utils/datetime*.
jest.mock('@/utils/datetime', () => ({
  venueStartOfDay: (...a: unknown[]) => mockVenueStartOfDay(...(a as [])),
}))

describe('deliverySummary.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVenueStartOfDay.mockReturnValue(new Date('2026-07-18T06:00:00.000Z'))
  })

  describe('getDeliveryDailySummary', () => {
    it('agrupa pedidos DELIVERY_PLATFORM de hoy por canal con totales en PESOS (Decimal -> Number, nunca cents)', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
      ;(prisma.order.groupBy as jest.Mock).mockResolvedValue([
        // Prisma Decimal en la vida real; un number sirve porque Number(x) es idempotente sobre
        // él — lo que se prueba es que el valor se queda en PESOS (452.50), nunca *100 a cents.
        { source: 'UBER_EATS', _count: { id: 3 }, _sum: { total: 452.5 } },
        { source: 'RAPPI', _count: { id: 1 }, _sum: { total: 99 } },
      ])

      const result = await getDeliveryDailySummary('venue1')

      expect(result.channels).toEqual([
        { channel: 'UBER_EATS', orders: 3, totalPesos: 452.5 },
        { channel: 'RAPPI', orders: 1, totalPesos: 99 },
      ])
      expect(typeof result.channels[0].totalPesos).toBe('number')
    })

    it('consulta prisma.order.groupBy filtrando venueId + originSystem DELIVERY_PLATFORM + createdAt >= inicio de hoy venue-local', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Cancun' })
      ;(prisma.order.groupBy as jest.Mock).mockResolvedValue([])

      await getDeliveryDailySummary('venue1')

      expect(prisma.venue.findUnique).toHaveBeenCalledWith({ where: { id: 'venue1' }, select: { timezone: true } })
      expect(mockVenueStartOfDay).toHaveBeenCalledWith('America/Cancun')
      const callArg = (prisma.order.groupBy as jest.Mock).mock.calls[0][0]
      expect(callArg.by).toEqual(['source'])
      expect(callArg.where).toEqual({
        venueId: 'venue1',
        originSystem: OriginSystem.DELIVERY_PLATFORM,
        createdAt: { gte: mockVenueStartOfDay.mock.results[0].value },
      })
      expect(callArg._count).toEqual({ id: true })
      expect(callArg._sum).toEqual({ total: true })
    })

    it('venue sin timezone configurado usa America/Mexico_City por default (nunca crashea)', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: null })
      ;(prisma.order.groupBy as jest.Mock).mockResolvedValue([])

      await getDeliveryDailySummary('venue1')

      expect(mockVenueStartOfDay).toHaveBeenCalledWith('America/Mexico_City')
    })

    it('venue sin pedidos de delivery hoy -> channels: []', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
      ;(prisma.order.groupBy as jest.Mock).mockResolvedValue([])

      const result = await getDeliveryDailySummary('venue1')

      expect(result.channels).toEqual([])
    })

    it('_sum.total null (edge case de agregación sin filas) -> totalPesos 0, nunca NaN/undefined', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
      ;(prisma.order.groupBy as jest.Mock).mockResolvedValue([{ source: 'DIDI_FOOD', _count: { id: 1 }, _sum: { total: null } }])

      const result = await getDeliveryDailySummary('venue1')

      expect(result.channels).toEqual([{ channel: 'DIDI_FOOD', orders: 1, totalPesos: 0 }])
    })

    it('devuelve generatedAt como ISO string (timestamp de generación del resumen)', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
      ;(prisma.order.groupBy as jest.Mock).mockResolvedValue([])

      const result = await getDeliveryDailySummary('venue1')

      expect(typeof result.generatedAt).toBe('string')
      expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt)
    })
  })
})
