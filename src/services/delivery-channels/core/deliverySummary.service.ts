/**
 * Resumen diario por canal de delivery (Task 5 del plan delivery-activation-backend): servicio
 * compartido, DRY entre el MCP tool `delivery_channels` (`todayByChannel`,
 * src/mcp/tools/deliveryChannels.ts) y el REST GET /venues/:venueId/delivery/summary
 * (deliveryChannels.controller.ts). Antes vivía inline en el MCP tool — Task 12 del backend lo
 * cableó con `venueStartOfDay`; esta extracción no cambia esa lógica, solo la comparte.
 *
 * Pedidos e ingreso de HOY, agrupados por `Order.source`, solo pedidos con
 * `originSystem: DELIVERY_PLATFORM` (inyectados por un canal de delivery — Deliverect u origen
 * directo).
 *
 * - Dinero en PESOS 1:1 (`totalPesos = Number(_sum.total)`) — NUNCA cents (critical-warnings.md).
 * - "Hoy" es VENUE-LOCAL vía `venueStartOfDay(tz)` — nunca un bare `new Date()` del host
 *   (regla venue-local, critical-warnings.md).
 */
import { OriginSystem } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay } from '@/utils/datetime'

export interface DeliveryDailySummaryChannel {
  channel: string
  orders: number
  totalPesos: number
}

export interface DeliveryDailySummary {
  channels: DeliveryDailySummaryChannel[]
  generatedAt: string
}

export async function getDeliveryDailySummary(venueId: string): Promise<DeliveryDailySummary> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || 'America/Mexico_City'
  const startOfToday = venueStartOfDay(tz) // "hoy" en la tz del VENUE, nunca la del host (regla venue-local)

  const grouped = await prisma.order.groupBy({
    by: ['source'],
    where: { venueId, originSystem: OriginSystem.DELIVERY_PLATFORM, createdAt: { gte: startOfToday } },
    _count: { id: true },
    _sum: { total: true },
  })

  return {
    channels: grouped.map(g => ({ channel: g.source, orders: g._count.id, totalPesos: Number(g._sum.total ?? 0) })),
    generatedAt: new Date().toISOString(),
  }
}
