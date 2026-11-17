/**
 * D1 (16-nov-2026): qué productos vende cada canal de delivery, por MCP (sólo el modo libre; no está en el catálogo certificado).
 * Lectura acotada (todo `id IN` la lista o contado en la base) y escritura de UN producto en UN canal, en dos pasos.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { idsDelCanal, productosDelCanal } from '@/services/delivery-channels/core/productosDelCanal'
import { ponerProductoEnCanales } from '@/services/delivery-channels/core/productoEnCanales.service'
import { precioPublicado as precioUber } from '@/services/delivery-channels/providers/uber-eats/uber.menuMapper'
import { precioPublicado as precioRappi } from '@/services/delivery-channels/providers/rappi/rappi.menuMapper'
import { deRappiAPesos } from '@/services/delivery-channels/providers/rappi/rappi.unidades'

const MAX_CANALES = 200

const objeto = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Precio en pesos que se publica para un producto; con `porProducto` sólo cuenta SU entrada (no hay copia del catálogo aquí). */
function precioQueSePublica(provider: string, config: unknown, productId: string, sku: string, mostrador: number): number {
  const guardados = objeto(objeto(config)?.precios) ?? {}
  const porProducto = objeto(guardados.porProducto)
  let precios = guardados as { markupPercent?: number; overrides?: Record<string, number> }
  if (porProducto) {
    const { porProducto: _p, overrides: _o, ...resto } = guardados
    const propio = Object.prototype.hasOwnProperty.call(porProducto, productId) ? { [sku]: porProducto[productId] as number } : {}
    precios = { ...resto, overrides: propio }
  }
  return provider === 'RAPPI'
    ? deRappiAPesos(precioRappi(sku, mostrador, precios, [])).toNumber()
    : precioUber(sku, mostrador, precios) / 100
}

export function registerDeliveryChannelProductTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'delivery_channel_products',
    'Which products each delivery channel (Rappi, Uber Eats...) sells: per channel, either todoElCatalogo (no list: the whole active catalog, with totalEnCatalogo) or the list of products (id, sku, nombre, activo and precioQueSePublica in pesos, with the channel margin or fixed price), the ones in the list that no longer exist (yaNoExisten) and how many new products were created after the channel was set up and not yet reviewed (nuevos). Read-only — requires delivery-channels:read and the PREMIUM plan. Pass venueId; linkId (from delivery_channels) narrows to one channel.',
    {
      venueId: z.string().describe('Venue cuyos canales leer (debe estar en tu scope)'),
      linkId: z.string().optional().describe('Un solo canal (de delivery_channels)'),
    },
    async ({ venueId, linkId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('delivery-channels:read', venueId)
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Los canales de delivery')
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })

      const links = await prisma.deliveryChannelLink.findMany({
        where: { venueId, ...(linkId ? { id: linkId } : {}) },
        select: { id: true, provider: true, status: true, config: true, createdAt: true },
        take: MAX_CANALES + 1,
      })
      const truncated = links.length > MAX_CANALES
      if (truncated) links.length = MAX_CANALES

      let totalCatalogo: number | undefined
      const channels = []
      for (const l of links) {
        const base = { channelId: l.id, provider: l.provider, status: l.status }
        let ids: string[] | null
        let codigos: Set<string> | null = null
        try {
          ids = idsDelCanal(l.config)
          if (!ids) codigos = productosDelCanal(l.config)
        } catch (e) {
          channels.push({ ...base, error: `La lista de productos del canal está dañada: ${(e as Error).message}` })
          continue
        }
        if (!ids && !codigos) {
          totalCatalogo ??= await prisma.product.count({ where: { venueId, deletedAt: null } })
          channels.push({ ...base, todoElCatalogo: true, totalEnCatalogo: totalCatalogo, nuevos: 0 })
          continue
        }
        const tam = ids ? ids.length : codigos!.size
        const filas = await prisma.product.findMany({
          where: { venueId, deletedAt: null, ...(ids ? { id: { in: ids } } : { sku: { in: [...codigos!] } }) },
          select: { id: true, sku: true, name: true, active: true, price: true },
          take: tam,
        })
        const yaNoExisten = ids ? ids.filter(id => !filas.some(p => p.id === id)) : [...codigos!].filter(c => !filas.some(p => p.sku === c))
        let nuevos = 0
        if (ids) {
          const revisados = objeto(l.config)?.productosRevisados
          const excluir = [...new Set([...ids, ...(Array.isArray(revisados) ? (revisados as string[]) : [])])]
          nuevos = await prisma.product.count({
            where: { venueId, deletedAt: null, createdAt: { gt: l.createdAt }, id: { notIn: excluir } },
          })
        }
        channels.push({
          ...base,
          todoElCatalogo: false,
          productos: filas.map(p => ({
            productId: p.id,
            sku: p.sku,
            nombre: p.name,
            activo: p.active,
            precioQueSePublica: precioQueSePublica(l.provider, l.config, p.id, p.sku, Number(p.price)),
          })),
          yaNoExisten,
          nuevos,
        })
      }
      return text({ venueId, truncated, channels })
    },
  )

  server.tool(
    'set_delivery_channel_product',
    'Sell (vender:true) or stop selling (vender:false) ONE product in ONE delivery channel. If the channel publishes the whole catalog and you stop selling a product, the channel gets an explicit list with every other product (the whole catalog minus this one). Two steps: the first call only previews; call again with confirm:true to save. Requires delivery-channels:manage and the PREMIUM plan. linkId comes from delivery_channels. Pass venueId.',
    {
      venueId: z.string().describe('Venue del canal (debe estar en tu scope)'),
      productId: z.string().describe('Id del producto'),
      linkId: z.string().describe('Id del canal (de delivery_channels)'),
      vender: z.boolean().describe('true = venderlo en este canal; false = dejar de venderlo'),
      confirm: z.boolean().optional().describe('true sólo en la SEGUNDA llamada, para guardar'),
    },
    async ({ venueId, productId, linkId, vender, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('delivery-channels:manage', venueId)
      requireWriteScopeAlways(scope, 'delivery-channels:manage', 'cambia qué productos se venden en este canal')
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Elegir los productos de un canal de delivery')
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })

      const [link] = await prisma.deliveryChannelLink.findMany({
        where: { id: linkId, venueId },
        select: { id: true, provider: true, config: true },
        take: 1,
      })
      if (!link) return text({ ok: false, error: 'Canal de delivery no encontrado' })

      if (confirm !== true) {
        let publicaTodo = false
        try {
          publicaTodo = !idsDelCanal(link.config) && !productosDelCanal(link.config)
        } catch {
          // lista dañada: el servicio lo dirá al guardar
        }
        return text({
          ok: false,
          requiresConfirmation: true,
          mensaje: `Vas a ${vender ? 'vender' : 'dejar de vender'} este producto en ${link.provider}. Vuelve a llamar con confirm:true para guardarlo.`,
          venueId,
          linkId,
          productId,
          vender,
          ...(publicaTodo &&
            !vender && {
              aviso:
                'Este canal publica todo el catálogo: la lista se vuelve explícita (todos los productos menos éste) y los productos nuevos ya no entrarán solos.',
            }),
        })
      }

      try {
        await ponerProductoEnCanales(venueId, productId, { [linkId]: vender }, scope.staffId)
      } catch (error) {
        if (error instanceof AppError) return text({ ok: false, error: error.message })
        throw error
      }
      await auditMcpWrite(scope, {
        action: 'DELIVERY_CHANNEL_PRODUCT_SET',
        entity: 'DeliveryChannelLink',
        entityId: linkId,
        venueId,
        data: { productId, vender },
      })
      return text({ ok: true, venueId, linkId, productId, vender })
    },
  )
}
