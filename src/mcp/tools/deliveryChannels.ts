import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { getDeliveryDailySummary } from '@/services/delivery-channels/core/deliverySummary.service'
import { calcularTasaInyeccion } from '@/services/delivery-channels/core/injectionRate.service'
import { menuSyncStatusOf } from '@/services/delivery-channels/core/menuSync.service'
import { hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'

export function registerDeliveryChannelTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_channels',
    'Estado de los canales de delivery del venue (Uber Eats/Rappi/DiDi vía Deliverect): canales conectados, estado (activo/pausado), modo de aceptación de pedidos, si su integración YA está lista para operar, último sync de menú, y pedidos de delivery de hoy por canal. Responde "¿cómo van mis canales de delivery? ¿cuántos pedidos de Uber/Rappi hoy? ¿cuál canal ya funciona de verdad?". Pass venueId.',
    { venueId: z.string().describe('Venue cuyos canales de delivery leer (debe estar en tu scope)') },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('delivery-channels:read', venueId) // mirror the dashboard's delivery-channels:read gate (MANAGER+)
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Los canales de delivery') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
      const links = await prisma.deliveryChannelLink.findMany({
        where: { venueId: where.venueId ?? venueId },
        select: {
          id: true,
          provider: true,
          status: true,
          orderAcceptanceMode: true,
          autoSyncMenu: true,
          lastMenuSyncAt: true,
          lastMenuHash: true,
          externalLocationId: true,
        },
      })
      // Task 5: fuente compartida con el REST GET .../delivery/summary (DRY) — misma lógica
      // venue-local (venueStartOfDay) que antes vivía inline aquí, ahora en deliverySummary.service.
      const { channels: todayByChannel } = await getDeliveryDailySummary(venueId)

      // 🔴 La tasa de inyección es el número con el que el proveedor decide REVOCAR el
      // acceso (Uber exige 99.9%, revoca por debajo de 99%). Un operador tiene que poder
      // preguntarlo — hasta hoy sólo existía en el log, o sea que se veía cuando alguien
      // ya estaba buscando el problema, nunca antes.
      const inyeccion = await Promise.all(
        [...new Set(links.map(l => l.provider))].map(async provider => ({
          provider,
          // El venue resuelto por el scope, no el filtro crudo: `where.venueId` puede ser
          // un `{ in: [...] }` del guard multi-venue, y la tasa se reporta por venue.
          ...(await calcularTasaInyeccion({ venueId, provider })),
        })),
      )
      return text({
        venueId,
        channels: links.map(l => ({
          ...l,
          lastMenuSyncAt: l.lastMenuSyncAt?.toISOString() ?? null,
          // Task 8 (plan 2026-08-20-delivery-nucleo-unico, §8.2): el vínculo puede existir
          // (el dueño ya conectó el canal) sin que el core todavía sepa traducirlo — la ÚNICA
          // fuente de verdad de "¿ya hay a quién delegarle?" es el registro de adaptadores
          // (core/adapterRegistry.ts), nunca una lista de proveedores copiada aquí a mano.
          integrationReady: hasAdapter(l.provider),
          // 🔴 "¿mi menú está actualizado allá?" es la pregunta que un operador SÍ hace, y
          // hasta ahora no había forma de contestarla sin entrar a la base. Un menú viejo
          // cobra el precio equivocado o provoca rechazos que Uber cuenta contra la tasa de
          // inyección que exige para no revocar el acceso.
          //
          // `lastMenuHash` se guarda SÓLO cuando la publicación salió bien, así que su
          // ausencia con `autoSyncMenu` prendido significa exactamente "nunca se logró
          // publicar" — no "todavía no toca". Por eso se puede responder sin adivinar.
          menuPublicado: l.lastMenuHash !== null,
          // Una sola derivación compartida con el REST del dashboard: dos copias acabarían
          // contestando distinto y nadie sabría a cuál creerle.
          menuSyncStatus: menuSyncStatusOf(l),
          lastMenuHash: undefined, // la huella misma no le sirve a nadie fuera del sincronizador
        })),
        todayByChannel,
        // `porcentaje: null` con `estado: SIN_DATOS` significa que aún no llegan pedidos —
        // NO que la tasa sea 0. Reportar 0% sin datos dispararía alarma en cada negocio
        // que todavía no vende por ahí, y las alarmas falsas enseñan a ignorarlas.
        inyeccion,
      })
    },
  )
}
