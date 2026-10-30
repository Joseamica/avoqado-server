import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { getDeliveryDailySummary } from '@/services/delivery-channels/core/deliverySummary.service'
import { resolveDeliveryHours } from '@/services/delivery-channels/core/deliveryHours.service'
import { calcularTasaInyeccion } from '@/services/delivery-channels/core/injectionRate.service'
import { menuSyncStatusOf, revisionDeMenuOf } from '@/services/delivery-channels/core/menuSync.service'
import { hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { listDeliveryCashPending } from '@/services/delivery-channels/core/deliveryCashPending.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { auditMcpWrite } from '../audit'
import AppError from '@/errors/AppError'

export function registerDeliveryChannelTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_channels',
    'Estado de los canales de delivery del venue (Uber Eats/Rappi/DiDi vía Deliverect): canales conectados, estado (activo/pausado), modo de aceptación de pedidos, si su integración YA está lista para operar, último sync de menú, HORARIO en que acepta pedidos (y si es el configurado o un estimado), MARGEN de precios sobre el mostrador, pedidos de delivery de hoy por canal, y los últimos intentos de conectar tiendas de Uber Eats o Rappi con su resultado por tienda. Responde "¿cómo van mis canales de delivery? ¿cuántos pedidos de Uber/Rappi hoy? ¿cuál canal ya funciona de verdad? ¿a qué horas acepto pedidos en Uber? ¿qué margen tengo puesto? ¿por qué no quedó conectada mi tienda de Uber? ¿por qué no quedó conectada mi tienda de Rappi?". Pass venueId.',
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
      // «¿por qué no quedó conectada mi tienda de Uber?»: los últimos intentos de conexión, con el
      // resultado por tienda. Sólo estado — el token cifrado NUNCA sale del server.
      const conexiones = await prisma.deliveryConnectIntent.findMany({
        where: { venueId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          provider: true,
          state: true,
          failureReason: true,
          createdAt: true,
          expiresAt: true,
          selectionJson: true,
          resultsJson: true,
        },
      })

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
          // La revisión del menú: pendiente, plazo vencido sin veredicto, último rechazo y problemas. Campo NUEVO y OPCIONAL de
          // lectura (la tool está en el catálogo certificado: su descripción no cambia ni se quita nada). Sin huellas, y
          // `revisionDeMenuOf` es total: una `config` ilegible sale con la forma vacía, nunca tumba la lectura.
          menuRevision: revisionDeMenuOf(l.config),
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
        conexionesRecientes: conexiones.map(c => ({
          id: c.id,
          provider: c.provider,
          estado: c.state,
          motivo: c.failureReason,
          creado: c.createdAt.toISOString(),
          vence: c.expiresAt.toISOString(),
          tiendasElegidas: Array.isArray(c.selectionJson) ? c.selectionJson.length : 0,
          resultadoPorTienda: Object.fromEntries(
            Object.entries((c.resultsJson as Record<string, { outcome?: string }> | null) ?? {}).map(([tienda, r]) => [
              tienda,
              r?.outcome ?? null,
            ]),
          ),
        })),
        // `porcentaje: null` con `estado: SIN_DATOS` significa que aún no llegan pedidos —
        // NO que la tasa sea 0. Reportar 0% sin datos dispararía alarma en cada negocio
        // que todavía no vende por ahí, y las alarmas falsas enseñan a ignorarlas.
        inyeccion,
      })
    },
  )

  // El mismo enlace que `GET /venues/:venueId/channels/rappi/connect-url` (mismas guardas: manage + PREMIUM).
  // Import perezoso: la cadena de Rappi lee el env al usarse, y ese chequeo debe fallar aquí, no al cargar el MCP.
  server.tool(
    'delivery_cash_pending',
    'Pedidos de reparto que el negocio cobra en EFECTIVO con su propio repartidor (hoy, Rappi) y que la caja todavía no ha cobrado, de los últimos 2 días: por pedido, cuánto falta por cobrar y su desglose (venta, propina y lo que se cobra por cuenta de la plataforma, que no es venta). Es la misma lista «Rappi · por cobrar» de la pantalla de pedidos en línea del POS. Responde "¿qué pedidos de Rappi faltan por cobrar? ¿cuánto efectivo me debe traer el repartidor?". Montos en pesos. Pass venueId.',
    {
      venueId: z.string().describe('Venue cuyos pedidos de reparto por cobrar leer (debe estar en tu scope)'),
      cursor: z.string().max(200).optional().describe('nextCursor de la respuesta anterior, para la siguiente página'),
    },
    async ({ venueId, cursor }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Mismo permiso que la bandeja del POS; sin candado de plan (R14: atender lo que ya existe nunca se bloquea).
      guard.requirePermission('orders:read', venueId)
      const r = await listDeliveryCashPending({ venueId, ...(cursor !== undefined ? { cursor } : {}) })
      const pesos = (c: number) => Math.round(c) / 100
      return text({
        total: r.total,
        truncated: r.truncated,
        nextCursor: r.nextCursor,
        orders: r.orders.map(o => ({
          orderId: o.orderId,
          orderNumber: o.orderNumber,
          plataforma: o.thirdPartyLabel,
          estado: o.status,
          cocina: o.kitchenStatus,
          cliente: o.customerName,
          creado: o.createdAt,
          porCobrar: pesos(o.remainingBalanceCents),
          venta: pesos(o.saleCents),
          propina: pesos(o.tipCents),
          deLaPlataforma: pesos(o.thirdPartyCents),
        })),
      })
    },
  )

  server.tool(
    'rappi_connect_link',
    'Genera el enlace para que el dueño conecte SU cuenta de Rappi (Portal Partners) con Avoqado: al abrirlo autoriza y elige qué tiendas conectar. Vence en 10 minutos; si venció, se pide otro. Requiere permiso de administrar canales de delivery y plan PREMIUM. Responde "¿cómo conecto mi tienda de Rappi? ¿me pasas el enlace para conectar Rappi?". Luego el estado de cada tienda se ve con delivery_channels (conexionesRecientes). Pass venueId.',
    { venueId: z.string().describe('Venue cuya tienda de Rappi se va a conectar (debe estar en tu scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('delivery-channels:manage', venueId) // mirror the REST route's delivery-channels:manage gate
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Conectar canales de delivery') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
      // Primero la configuración ENTERA (retorno, host y webhooks), igual que el REST: nada se crea si falta algo.
      const { preflightSelfOnboardingRappi } = await import('@/services/delivery-channels/providers/rappi/rappi.client')
      let base: string
      try {
        base = preflightSelfOnboardingRappi()
      } catch {
        throw new AppError('La conexión con Rappi no está configurada en el servidor.', 500, true, 'RAPPI_CONNECT_NOT_CONFIGURED')
      }
      const { depsDesdeEnv, crearIntentRappi } = await import('@/services/delivery-channels/providers/rappi/rappi.connect')
      const { urlDeInicio } = await import('@/services/delivery-channels/providers/rappi/rappi.selfOnboarding')
      // `staffId` = quien pide por el MCP; el callback público revalida ESE usuario en cada paso.
      const { id, firmado } = await crearIntentRappi(await depsDesdeEnv(), { venueId, staffId: scope.staffId })
      await auditMcpWrite(scope, { action: 'RAPPI_CONNECT_LINK_CREATED', entity: 'DeliveryConnectIntent', entityId: id, venueId })
      return text({
        ok: true,
        url: urlDeInicio(base, firmado),
        instrucciones:
          'Abre este enlace con la cuenta del Portal Partners de Rappi del negocio (vence en 10 minutos). Al autorizar, eliges qué tiendas conectar a Avoqado.',
        venceEnMinutos: 10,
      })
    },
  )

  server.tool(
    'rappi_disconnect',
    'Desconecta una tienda de Rappi del venue: Avoqado le avisa a Rappi que ya no está integrada y los pedidos nuevos de Rappi dejan de llegar a Avoqado (el historial y los ajustes se conservan; se reconecta con rappi_connect_link). Si Rappi no confirma, no se desconecta (con forzar:true se desconecta igual, y Rappi podría seguir mandando pedidos que sólo se verán en su tableta). Con pedidos de esa tienda en curso no se puede. Primero muestra qué se desconecta; se aplica al llamar de nuevo con confirm:true y el conexionId de la vista previa. Requiere permiso de administrar canales de delivery y plan PREMIUM. Responde "desconecta mi tienda de Rappi". El linkId sale de delivery_channels. Pass venueId.',
    {
      venueId: z.string().describe('Venue de la tienda (debe estar en tu scope)'),
      linkId: z.string().describe('Id del canal de Rappi (de delivery_channels)'),
      conexionId: z.string().optional().describe('El conexionId que devolvió la vista previa; obligatorio con confirm:true'),
      confirm: z.boolean().optional().describe('true sólo después de mostrar la vista previa y que el dueño la acepte'),
      forzar: z
        .boolean()
        .optional()
        .describe(
          'true sólo si Rappi no aceptó o no confirmó un intento anterior y el dueño acepta que Rappi podría seguir mandando pedidos',
        ),
    },
    async ({ venueId, linkId, conexionId, confirm, forzar }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('delivery-channels:manage', venueId) // mirror the REST route's delivery-channels:manage gate
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Desconectar canales de delivery') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
      const { conexionIdDe, contarPedidosEnCurso, desconectarTiendaRappi } = await import(
        '@/services/delivery-channels/providers/rappi/rappi.desconectar'
      )
      if (confirm !== true || !conexionId) {
        const link = await prisma.deliveryChannelLink.findFirst({
          where: { id: linkId, venueId },
          select: { id: true, provider: true, status: true, externalLocationId: true, externalAccountId: true, config: true },
        })
        if (!link) throw new AppError('Canal de delivery no encontrado', 404, true, 'NOT_FOUND')
        if (link.provider !== 'RAPPI') throw new AppError('Sólo las tiendas de Rappi se desconectan desde aquí.', 400, true, 'SOLO_RAPPI')
        const pedidosEnCurso = (await contarPedidosEnCurso(prisma, [link.id])).get(link.id) ?? 0
        return text({
          ok: false,
          requiresConfirmation: true,
          venueId,
          linkId,
          tienda: link.externalAccountId ?? link.externalLocationId,
          storeId: link.externalLocationId,
          estado: link.status,
          pedidosEnCurso,
          conexionId: conexionIdDe(link),
          queVaAPasar:
            link.status === 'DISABLED'
              ? 'La tienda ya está desconectada; no hay nada que hacer.'
              : pedidosEnCurso > 0
                ? `Hay ${pedidosEnCurso} pedido(s) de Rappi en curso: hay que terminarlos antes de desconectar.`
                : 'Avoqado le avisa a Rappi que la tienda ya no está integrada y deja de recibir sus pedidos nuevos. El historial y los ajustes se conservan para reconectar.',
        })
      }
      const r = await desconectarTiendaRappi({ venueId, linkId, conexionId, forzar, performedBy: scope.staffId, origen: 'MCP' })
      // Si otra persona se adelantó no hubo cambio: no se audita un hecho que no ocurrió.
      if (!r.yaEstaba) {
        await auditMcpWrite(scope, {
          action: 'RAPPI_DISCONNECTED',
          entity: 'DeliveryChannelLink',
          entityId: linkId,
          venueId,
          data: { forzada: r.forzada },
        })
      }
      return text({ ok: true, venueId, linkId, estado: r.link.status, yaEstaba: r.yaEstaba, forzada: r.forzada })
    },
  )
}
