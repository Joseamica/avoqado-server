/**
 * List prices per function and «% de descuento» groups from the customer MCP (spec 2026-09-30 §8).
 *
 * 🔴 SUPERADMIN ONLY, twice: `registerLaunchCampaignTools` is registered only for superadmin connections, and every
 * handler checks again. These are PLATFORM prices (what every venue is charged), not data of a venue.
 * 🔴 Writes go through `requireWriteScopeAlways` and are confirm-gated with a current → new preview. The services write
 * their own ActivityLog inside the transaction; `auditMcpWrite` adds the MCP trail (no venue: `venueId: null`).
 * Money in pesos, 1:1.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { listPriceBoard, saveListPrice } from '@/services/launchCampaigns/hybridListPrice.service'
import { priceGapSummary, priceGapVenues, type PriceGapSummaryRow } from '@/services/launchCampaigns/hybridPriceGap.service'
import {
  createPercentPromotion,
  getPromotionGroup,
  percentPromotionBody,
  previewPercentPromotion,
  setPromotionGroupStatus,
} from '@/services/launchCampaigns/hybridPromotionGroup.service'

const ONLY_AVOQADO = 'Solo Avoqado puede ver o cambiar los precios de lista y los descuentos.'
const GAP_PAGE_SIZE = 50
const confirm = z.boolean().optional().describe('true sólo después de revisar y aceptar la vista previa')
const featureKey = z
  .string()
  .regex(/^FEATURE:[A-Z][A-Z0-9_]{0,63}$/, 'Producto no válido')
  .describe('La función, como aparece en list_prices (p. ej. "FEATURE:CFDI")')
const pesos = (value: number | null) => (value === null ? 'sin precio' : `$${value.toFixed(2)}`)

const gapView = (gap: PriceGapSummaryRow) => ({
  negocios: gap.venues,
  diferenciaMensual: Number(gap.monthlyGap),
  negociosPaganMas: gap.aboveListVenues,
  negociosEnPaquetes: gap.bundleVenues,
})

/** A refusal that carries its reasons (the promotions a list breaks, the functions under $10) returns them; others throw. */
function refusal(error: unknown) {
  const e = error as { isOperational?: boolean; message?: string; code?: string; details?: unknown }
  if (e?.isOperational !== true || e.details === undefined) throw error
  return text({ ok: false, error: e.message, codigo: e.code, detalles: e.details })
}

export function registerHybridPricingTools(server: McpServer, scope: McpScope) {
  const forbidden = () => text({ ok: false, error: ONLY_AVOQADO })
  const write = () => requireWriteScopeAlways(scope, 'launch-campaigns:write', 'modifica precios de lista o promociones')

  server.tool(
    'list_prices',
    'Precio de lista mensual de cada función y de los planes Pro y Premium, en pesos MXN con IVA incluido: si está en venta suelta o pausada, si tiene un precio nuevo pendiente de preparar, qué descuentos % activos la abarcan (al cambiar la lista hay que recalcularlos), y el aviso de negocios que pagan una tarifa anterior (diferencia de tarifas al mes, no efectivo cobrado). Sólo lectura. Sólo para Avoqado.',
    {},
    async () => {
      if (!scope.isSuperAdmin) return forbidden()
      const [board, gaps] = await Promise.all([listPriceBoard(), priceGapSummary()])
      const gapOf = new Map(gaps.map(gap => [gap.productKey, gap]))
      return text({
        ok: true,
        productos: board.map(row => {
          const gap = gapOf.get(row.productKey)
          return {
            producto: row.productKey,
            nombre: row.name,
            categoria: row.category,
            planQueLaIncluye: row.minimumTier,
            editable: row.editable,
            motivoNoEditable: row.notEditableReason,
            estado: row.status,
            precioLista: row.price,
            precioPendiente: row.pendingPrice,
            revision: row.revision,
            descuentosActivos: row.activeGroups,
            tarifaAnterior: gap ? gapView(gap) : null,
          }
        }),
      })
    },
  )

  server.tool(
    'set_feature_list_price',
    'Cambia el precio de lista mensual (pesos MXN con IVA incluido) de una función que se vende suelta. Quien ya la paga conserva su precio. Sin confirm devuelve el precio actual y el nuevo; con confirm:true lo guarda y lo pone en venta cuando Stripe lo tenga listo (si falla, el precio anterior se sigue vendiendo). Si el precio dejaría promociones vigentes por encima de la lista, se rechaza y dice cuáles pausar. Requiere la revisión vigente. Sólo para Avoqado.',
    {
      productKey: featureKey,
      price: z.number().describe('Precio de lista mensual en pesos MXN con IVA incluido, p. ej. 249.00'),
      expectedRevision: z.number().int().positive().nullable().describe('Revisión vigente según list_prices; null si aún no tiene precio'),
      confirm,
    },
    async ({ productKey, price, expectedRevision, confirm: approved }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      const current = (await listPriceBoard()).find(row => row.productKey === productKey)
      if (!current) return text({ ok: false, error: 'Producto no encontrado.' })
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            producto: productKey,
            nombre: current.name,
            precioActual: current.price,
            precioNuevo: price,
            estado: current.status,
            descuentosActivos: current.activeGroups,
          },
          mensaje: `Precio de lista de ${current.name}: ${pesos(current.price)} → ${pesos(price)} al mes con IVA. Quien ya la paga conserva su precio.${
            current.activeGroups.length
              ? ` Descuentos activos que la abarcan: ${current.activeGroups.map(g => `«${g.name}»`).join(', ')}; después de guardar, recalcúlalos para que el % aplique sobre el precio nuevo.`
              : ''
          } Vuelve a llamar con confirm: true.`,
        })
      try {
        const row = await saveListPrice({ productKey, price, expectedRevision }, scope.staffId)
        await auditMcpWrite(scope, {
          venueId: null,
          action: 'MCP_HYBRID_LIST_PRICE_SAVED',
          entity: 'HybridCampaign',
          entityId: row.campaignId ?? productKey,
          data: { productKey, before: current.price, after: price },
        })
        return text({
          ok: true,
          precio: {
            producto: row.productKey,
            precioLista: row.price,
            precioPendiente: row.pendingPrice,
            estado: row.status,
            revision: row.revision,
          },
        })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  server.tool(
    'price_gap_report',
    'Negocios que pagan una tarifa menor que el precio de lista de hoy. Sin función: el resumen por función (negocios, diferencia de tarifas al mes en pesos, quienes pagan más y quienes la tienen en un paquete). Con función: quiénes son, con su tarifa, la lista, la diferencia y el motivo (lista anterior, promoción para siempre, temporal, renovó a una lista anterior o que termina), paginado. Sólo lectura. Sólo para Avoqado.',
    {
      productKey: featureKey.optional(),
      page: z.number().int().min(1).max(10_000).optional().describe('Página del detalle (50 por página)'),
    },
    async ({ productKey, page }) => {
      if (!scope.isSuperAdmin) return forbidden()
      if (!productKey) {
        const summary = await priceGapSummary()
        return text({ ok: true, resumen: summary.map(gap => ({ producto: gap.productKey, ...gapView(gap) })) })
      }
      const current = page ?? 1
      const { items, total } = await priceGapVenues(productKey, current, GAP_PAGE_SIZE)
      return text({
        ok: true,
        producto: productKey,
        total,
        pagina: current,
        paginas: Math.ceil(total / GAP_PAGE_SIZE),
        contratos: items.map(item => ({
          contrato: item.contractId,
          negocio: item.venueName,
          organizacion: item.organizationName,
          tarifa: Number(item.rate),
          precioLista: Number(item.listPrice),
          diferencia: Number(item.gap),
          desde: item.since,
          motivo: item.reason,
          motivoHasta: item.reasonUntil,
        })),
      })
    },
  )

  server.tool(
    'preview_percent_promotion',
    'Simula un descuento por porcentaje sobre el precio de lista: por función muestra el precio de lista, el precio con descuento y a cuánto renueva, las que se omiten por no tener lista en venta, las que quedarían bajo $10 (bloquean), las que requieren otra función y, en «overlaps», las promociones activas de esa misma función cuya vigencia se traslapa (es un aviso: no bloquea). No crea nada. Sólo para Avoqado.',
    percentPromotionBody.shape,
    async input => {
      if (!scope.isSuperAdmin) return forbidden()
      try {
        return text({ ok: true, ...(await previewPercentPromotion(input)) })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  server.tool(
    'create_percent_promotion',
    'Crea un descuento por porcentaje: una promoción pausada por cada función con precio de lista en venta, con el cupo indicado POR función. No vende nada hasta activarlo con set_promotion_group_status. Sin confirm devuelve la vista previa por función. Sólo para Avoqado.',
    { ...percentPromotionBody.shape, confirm },
    async ({ confirm: approved, ...input }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      try {
        if (!approved) {
          const { rows, creatable } = await previewPercentPromotion(input)
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: {
              nombre: input.name,
              porcentaje: input.percentOff,
              vigencia: { desde: input.startsAt, hasta: input.endsAt },
              duracion: input.promotionCycles === null ? 'para siempre' : `${input.promotionCycles} meses, luego el precio de lista`,
              cupoPorFuncion: input.capacityPerFeature,
              sePuedeCrear: creatable,
              funciones: rows.map(row => ({
                funcion: row.name,
                precioLista: row.listPrice,
                precioConDescuento: row.price,
                renovacion: row.renewalPrice,
                estado: row.status,
                requiere: row.requires,
                // Spec §4.4: other ACTIVE promotions of the function whose window meets this one (a warning, not a block).
                traslapes: row.overlaps.map(overlap => ({ promocion: overlap.name, precio: overlap.price })),
              })),
            },
            mensaje: `Sin descuento → ${rows.filter(row => row.status === 'OK').length} promociones pausadas al ${input.percentOff} %. Vuelve a llamar con confirm: true.`,
          })
        }
        const created = await createPercentPromotion(input, scope.staffId)
        await auditMcpWrite(scope, {
          venueId: null,
          action: 'MCP_HYBRID_PERCENT_PROMOTION_CREATED',
          entity: 'HybridPromotionGroup',
          entityId: created.groupId,
          data: { percentOff: input.percentOff, campaignIds: created.campaignIds },
        })
        return text({ ok: true, ...created })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  server.tool(
    'set_promotion_group_status',
    'Activa, pausa o termina un descuento por porcentaje: cambia todas sus promociones juntas o ninguna. Activar vuelve a validar que ninguna quede por encima de su precio de lista. Quien ya compró conserva lo que compró. Requiere confirmación y la revisión vigente. Sólo para Avoqado.',
    {
      groupId: z.string().describe('El descuento'),
      status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).describe('Nuevo estado'),
      expectedRevision: z.number().int().positive().describe('Revisión vigente del descuento'),
      confirm,
    },
    async ({ groupId, status, expectedRevision, confirm: approved }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      try {
        if (!approved) {
          const group = await getPromotionGroup(groupId)
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: {
              nombre: group.name,
              porcentaje: group.percentOff,
              estadoActual: group.status,
              nuevoEstado: status,
              promociones: group.campaigns.map(campaign => ({
                nombre: campaign.name,
                estado: campaign.status,
                precio: (campaign.publication?.definition as unknown as { terms?: { price?: number } } | undefined)?.terms?.price ?? null,
              })),
            },
            mensaje: `${group.name}: ${group.status} → ${status} en todas sus promociones a la vez. Vuelve a llamar con confirm: true.`,
          })
        }
        const row = await setPromotionGroupStatus(groupId, { status, expectedRevision }, scope.staffId)
        await auditMcpWrite(scope, {
          venueId: null,
          action: 'MCP_HYBRID_PROMOTION_GROUP_STATUS',
          entity: 'HybridPromotionGroup',
          entityId: groupId,
          data: { status },
        })
        return text({ ok: true, descuento: row })
      } catch (error) {
        return refusal(error)
      }
    },
  )
}
