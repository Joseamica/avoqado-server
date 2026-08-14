import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { auditMcpWrite } from '../audit'
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'
import { validatePromotionForPublish } from '@/services/promotions/validatePromotion'

/**
 * Promociones del POS (combos, bundles, 2x1) — tier PRO, código PROMOTIONS.
 *
 * `create_promotion` crea SIEMPRE en DRAFT y detrás de confirmación: una promo
 * mal armada cobra de menos en cada venta, así que publicarla es un paso
 * deliberado del dashboard, nunca de un asistente interpretando una frase.
 *
 * 🔴 El ciclo de vida (publicar/archivar/desarchivar) y la EDICIÓN de
 * promociones son actos deliberados del dashboard, NO del MCP — cambiar o
 * apagar una promoción altera lo que ven los CLIENTES del negocio, exactamente
 * la clase de escritura que la regla del MCP manda mantener detrás de una
 * decisión humana en pantalla (mismo criterio que `upsell.ts`). El MCP LEE
 * (list/status) y CREA EN DRAFT; todo lo demás vive en el dashboard. Si algún
 * día se pide operar el ciclo de vida por MCP, va confirm-gated con preview
 * current→new.
 */
export function registerPromotionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_promotions',
    'Lista las promociones de un venue (combos, bundles y 2x1) con su estado: DRAFT, PUBLISHED o ARCHIVED. Úsala para ver qué tiene armado el local y qué le falta publicar. Los precios vienen en pesos. Requiere plan PRO.',
    {
      venueId: z.string().describe('Venue (debe estar en tu alcance)'),
      status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional().describe('Filtrar por estado; omite para todas'),
    },
    async ({ venueId, status }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('discounts:read', venueId) // mismo permiso que leer descuentos
      const gate = await planGateMessage(venueId, 'PROMOTIONS', 'Las promociones') // tier PRO
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const rows = await prisma.promotion.findMany({
        where: { ...where, ...(status ? { status } : {}) },
        include: { groups: { include: { options: true } } },
        orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }],
        take: 100,
      })
      return text({
        count: rows.length,
        promotions: rows.map(p => ({
          id: p.id,
          name: p.name,
          type: p.type,
          pricingMode: p.pricingMode,
          price: p.priceCents / 100,
          status: p.status,
          schedule: { daysOfWeek: p.daysOfWeek, from: p.timeFrom, until: p.timeUntil },
          groups: p.groups.map(g => ({ name: g.name, options: g.options.length })),
        })),
      })
    },
  )

  server.tool(
    'promotion_status',
    'Dice qué promociones están VIGENTES ahora mismo en un venue y cuáles abren en las próximas 4 horas, evaluado en la hora del negocio (no la del servidor). Úsala para contestar "¿qué promo tengo corriendo?" sin adivinar con el reloj. Requiere plan PRO.',
    { venueId: z.string().describe('Venue (debe estar en tu alcance)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('discounts:read', venueId)
      const gate = await planGateMessage(venueId, 'PROMOTIONS', 'Las promociones')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const { active, upcoming } = await listPromotionsForPos(venueId)
      return text({
        activeNow: active.map(p => ({ id: p.id, name: p.name, price: p.priceCents / 100 })),
        startingSoon: upcoming.map(p => ({ id: p.id, name: p.name, startsAt: p.startsAt })),
      })
    },
  )

  server.tool(
    'create_promotion',
    'Crea una promoción en DRAFT (combo, bundle o 2x1). Se crea SIEMPRE apagada: publicarla es un paso aparte y deliberado, porque una promo mal armada cobra de menos en cada venta. Por DEFAULT sólo valida y muestra qué quedaría; llama otra vez con confirm:true para crearla. Requiere discounts:create y plan PRO.',
    {
      venueId: z.string().describe('Venue dueño de la promoción (debe estar en tu alcance)'),
      name: z.string().min(1).describe('Nombre visible, ej. "Combo del día"'),
      type: z.enum(['BUNDLE', 'COMBO']).describe('BUNDLE = grupo fijo; COMBO = el cliente elige'),
      pricingMode: z.enum(['FIXED_TOTAL', 'PER_UNIT']).describe('FIXED_TOTAL = cuesta un precio fijo; PER_UNIT = 2x1'),
      price: z.number().min(0).describe('Precio de la promoción en PESOS. 0 en PER_UNIT.'),
      groups: z
        .array(
          z.object({
            name: z.string().min(1),
            options: z.array(
              z.object({
                productId: z.string(),
                quantity: z.number().int().min(1).describe('Unidades que ENTRAN al carrito. 2 en un 2x1.'),
                chargedQuantity: z.number().int().min(0).describe('Unidades que se COBRAN. 1 en un 2x1.'),
                priceDelta: z.number().min(0).default(0).describe('Sobreprecio en pesos (sólo FIXED_TOTAL)'),
              }),
            ),
          }),
        )
        .min(1, 'La promoción necesita al menos un grupo de productos.')
        .describe('Grupos de elección. Un bundle lleva un grupo por componente, cada uno con UNA opción.'),
      confirm: z.boolean().optional().describe('Debe ser true para crearla; sin esto sólo obtienes la validación'),
    },
    async ({ venueId, name, type, pricingMode, price, groups, confirm }) => {
      const base = guard.venueFilter(venueId)
      guard.requirePermission('discounts:create', venueId)
      const gate = await planGateMessage(venueId, 'PROMOTIONS', 'Las promociones')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const productIds = groups.flatMap(g => g.options.map(o => o.productId))
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, ...base },
        select: { id: true, venueId: true, active: true, name: true },
      })

      const draft = {
        venueId,
        type,
        pricingMode,
        priceCents: Math.round(price * 100),
        groups: groups.map(g => ({
          name: g.name,
          minSelect: 1,
          maxSelect: 1,
          options: g.options.map(o => {
            const product = products.find(p => p.id === o.productId)
            return {
              productId: o.productId,
              productVenueId: product?.venueId ?? 'desconocido',
              productActive: product?.active ?? false,
              quantity: o.quantity,
              chargedQuantity: o.chargedQuantity,
              priceDeltaCents: Math.round(o.priceDelta * 100),
            }
          }),
        })),
      }

      const validation = validatePromotionForPublish(draft)
      if (!validation.ok) {
        return text({ ok: false, errors: validation.errors, message: 'Así no se puede publicar. Corrige y vuelve a intentar.' })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { name, type, pricingMode, price, groups: groups.length },
          message: `Esto creará la promoción "${name}" en DRAFT (apagada). Vuelve a llamar con confirm:true para crearla.`,
        })
      }

      const created = await prisma.promotion.create({
        data: {
          venueId,
          name,
          type,
          pricingMode,
          priceCents: draft.priceCents,
          status: 'DRAFT',
          groups: {
            create: groups.map((g, gi) => ({
              name: g.name,
              displayOrder: gi,
              options: {
                create: g.options.map((o, oi) => ({
                  productId: o.productId,
                  quantity: o.quantity,
                  chargedQuantity: o.chargedQuantity,
                  priceDeltaCents: Math.round(o.priceDelta * 100),
                  displayOrder: oi,
                })),
              },
            })),
          },
        },
      })

      await auditMcpWrite(scope, {
        action: 'PROMOTION_CREATED',
        entity: 'Promotion',
        entityId: created.id,
        venueId,
        data: { name, type, pricingMode, price },
      })

      return text({
        ok: true,
        promotionId: created.id,
        message: `Creada "${name}" en DRAFT. Todavía NO la ve nadie en el POS: hay que publicarla desde el dashboard.`,
      })
    },
  )
}
