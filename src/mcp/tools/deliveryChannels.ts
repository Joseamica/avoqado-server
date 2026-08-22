import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { getDeliveryDailySummary } from '@/services/delivery-channels/core/deliverySummary.service'
import { resolveDeliveryHours } from '@/services/delivery-channels/core/deliveryHours.service'
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
    'Estado de los canales de delivery del venue (Uber Eats/Rappi/DiDi vía Deliverect): canales conectados, estado (activo/pausado), modo de aceptación de pedidos, si su integración YA está lista para operar, último sync de menú, HORARIO en que acepta pedidos (y si es el configurado o un estimado), MARGEN de precios sobre el mostrador, y pedidos de delivery de hoy por canal. Responde "¿cómo van mis canales de delivery? ¿cuántos pedidos de Uber/Rappi hoy? ¿cuál canal ya funciona de verdad? ¿a qué horas acepto pedidos en Uber? ¿qué margen tengo puesto?". Pass venueId.',
    { venueId: z.string().describe('Venue cuyos canales de delivery leer (debe estar en tu scope)') },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('delivery-channels:read', venueId) // mirror the dashboard's delivery-channels:read gate (MANAGER+)
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Los canales de delivery') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
      // Sin `select`: `resolveDeliveryHours` recibe el registro entero (firma
      // `DeliveryChannelLink`). `webhookSecret` se descarta abajo, explícitamente.
      const links = await prisma.deliveryChannelLink.findMany({
        where: { venueId: where.venueId ?? venueId },
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
      // 🔴 El horario se RESUELVE, no se lee crudo: si nadie lo configuró el canal publica
      // un estimado, y un estimado presentado como certeza es peor que no tenerlo — nadie lo
      // revisa. Por eso viaja junto con `fuente`, que dice de dónde salió.
      const horarios = new Map(await Promise.all(links.map(async l => [l.id, await resolveDeliveryHours(l)] as const)))

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
          webhookSecret: undefined, // NUNCA sale del server
          config: undefined, // se expone desglosado abajo, no como blob crudo
          // A qué horas acepta pedidos este canal. `fuente: 'ESTIMADO'` = NADIE lo configuró
          // y estamos publicando una suposición: es la respuesta accionable, no un detalle.
          horario: horarios.get(l.id)?.horario ?? null,
          horarioFuente: horarios.get(l.id)?.fuente ?? null,
          // El margen sobre el precio de mostrador. `null` = se está publicando el precio de
          // mostrador tal cual, y como el marketplace se queda ~30%, cada pedido deja menos
          // de lo que el comercio cree. Se contesta sin que nadie tenga que abrir la base.
          // Hasta cuándo dura la pausa que alguien pidió desde el POS. `null` con status
          // PAUSED = pausa INDEFINIDA (la del dashboard): no se reactiva sola. Es la
          // diferencia entre "la cocina está respirando 20 minutos" y "el negocio lleva
          // apagado desde ayer y nadie se ha dado cuenta" — y desde afuera se ven igual.
          snoozedUntil: l.snoozedUntil?.toISOString() ?? null,
          margenPorcentaje:
            typeof (l.config as { precios?: { markupPercent?: unknown } } | null)?.precios?.markupPercent === 'number'
              ? ((l.config as { precios: { markupPercent: number } }).precios.markupPercent as number)
              : null,
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
