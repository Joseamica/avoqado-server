import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { planGateMessage } from '../planGate'
import {
  createLoyaltyPromotion,
  endLoyaltyPromotion,
  estadoDePromo,
  listLoyaltyPromotions,
  validarNuevaPromocion,
  type NewLoyaltyPromotionInput,
} from '@/services/loyalty/promotions/loyaltyPromotion.service'

/**
 * Promociones de lealtad (días de sellos/puntos dobles). Sólo el MCP libre: NO están en src/mcp/directory/catalog.ts.
 * Toda la validación vive en el servicio (fechas del negocio, tope de 10, rangos); aquí sólo se devuelve su mensaje.
 */

const MESES = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.']
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const dia = (f: string) => `${Number(f.slice(8, 10))} de ${MESES[Number(f.slice(5, 7)) - 1]}`

function cuando(inicio: string, fin?: string | null) {
  if (!fin) return `Desde el ${dia(inicio)}, sin fecha de fin`
  if (fin === inicio) return `El ${dia(inicio)}`
  if (inicio.slice(0, 7) === fin.slice(0, 7)) return `Del ${Number(inicio.slice(8))} al ${dia(fin)}`
  return `Del ${dia(inicio)} al ${dia(fin)}`
}

/** Vista previa como la del panel: sólo habla de lo que el negocio tiene prendido (sellos y/o puntos). */
function vistaPrevia(
  i: {
    kind: string
    multiplier: number | null
    extraStamps: number | null
    extraPoints: number | null
    daysOfWeek: number[]
    timeFrom: string | null
    timeUntil: string | null
    productIds: string[]
    categoryIds: string[]
    minSpend: number | null
    limit: string
  },
  startDate: string,
  endDate: string | null,
  cfg: { active: boolean; stampsEnabled: boolean } | null,
) {
  const sellos = cfg?.stampsEnabled ?? false
  const puntos = cfg?.active ?? false
  const partes: string[] = []
  if (i.kind === 'MULTIPLY') {
    const m = i.multiplier as number
    if (sellos) partes.push(`${m} sellos en vez de 1`)
    if (puntos) partes.push(m === 2 ? 'el doble de puntos' : `${m} veces los puntos`)
  } else {
    if (i.extraStamps != null && sellos) partes.push(`${i.extraStamps} ${i.extraStamps === 1 ? 'sello' : 'sellos'} de más`)
    if (i.extraPoints != null && puntos) partes.push(`${i.extraPoints} puntos de más`)
  }
  const que = partes.length
    ? `cada visita da ${partes.join(' y ')}`
    : 'la promoción quedaría sin efecto: el negocio no tiene prendidos esos beneficios'
  const extras: string[] = []
  if (i.daysOfWeek?.length) extras.push(`sólo ${i.daysOfWeek.map(d => DIAS[d]).join(', ')}`)
  if (i.timeFrom && i.timeUntil) extras.push(`de ${i.timeFrom} a ${i.timeUntil}`)
  if (i.productIds?.length) extras.push(`en ${i.productIds.length} producto(s) elegidos`)
  if (i.categoryIds?.length) extras.push(`en ${i.categoryIds.length} categoría(s) elegidas`)
  if (i.minSpend) extras.push(`con consumo mínimo de $${i.minSpend}`)
  if (i.limit === 'ONCE_PER_DAY') extras.push('una vez al día por cliente')
  if (i.limit === 'ONCE_PER_PROMOTION') extras.push('una vez por cliente en toda la promoción')
  return `${cuando(startDate, endDate)}, ${que}${extras.length ? ` (${extras.join(', ')})` : ''}`
}

export function registerLoyaltyPromotionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_loyalty_promotions',
    'List the loyalty promotions (double or extra stamps / points on certain days) of a venue you can access: active, scheduled (not started yet) or ended, newest first, each with its dates, days, hours, products and conditions. Answers "¿qué promociones de lealtad tengo?". Read-only; requires loyalty:read.',
    {
      venueId: z.string().describe('Venue whose promotions to list (must be in your scope)'),
      status: z.enum(['ACTIVE', 'SCHEDULED', 'ENDED']).optional().describe('Only this state; omit for all'),
      page: z.number().int().positive().optional().describe('Page to read (default 1)'),
      pageSize: z.number().int().positive().max(100).optional().describe('Promotions per page (default 50)'),
    },
    async ({ venueId, status, page, pageSize }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:read', venueId)
      const gate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad')
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      try {
        return text(await listLoyaltyPromotions(venueId, { status, page, pageSize }))
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'create_loyalty_promotion',
    'Create a loyalty promotion for a venue you can access: for a range of days, each visit gives MULTIPLIED stamps/points (kind MULTIPLY, multiplier 2-10) or EXTRA ones (kind ADD, extraStamps 1-9 and/or extraPoints). Optionally limit it to weekdays (0 = Sunday … 6 = Saturday), an hour window, certain products OR categories (ids from list_menu), a minimum spend in pesos, and once per customer per day or per promotion. Dates are venue-local days YYYY-MM-DD and cannot be in the past; a venue may have at most 10 active + scheduled promotions. By DEFAULT it only PREVIEWS in plain Spanish; show it to the operator and call again with confirm:true to create. This WRITES; requires loyalty:update.',
    {
      venueId: z.string().describe('Venue that owns the promotion (must be in your scope)'),
      name: z.string().trim().min(1).max(80).describe('Promotion name, e.g. "Martes de sellos dobles"'),
      kind: z.enum(['MULTIPLY', 'ADD']).describe('MULTIPLY = multiplied stamps/points, ADD = extra stamps/points'),
      multiplier: z.number().int().min(2).max(10).optional().describe('With MULTIPLY: 2-10'),
      extraStamps: z.number().int().min(1).max(9).optional().describe('With ADD: extra stamps per visit (1-9)'),
      extraPoints: z.number().int().min(1).max(10000).optional().describe('With ADD: extra points per visit'),
      startDate: z.string().describe('First day, venue-local, YYYY-MM-DD'),
      endDate: z.string().nullable().optional().describe('Last day (inclusive), YYYY-MM-DD; omit/null = no end'),
      daysOfWeek: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe('Weekdays it applies, 0 = Sunday … 6 = Saturday; omit = every day'),
      timeFrom: z.string().optional().describe('Start hour HH:mm (venue-local); give both timeFrom and timeUntil or neither'),
      timeUntil: z.string().optional().describe('End hour HH:mm (venue-local)'),
      productIds: z.array(z.string()).optional().describe('Only these products (ids); not together with categoryIds'),
      categoryIds: z.array(z.string()).optional().describe('Only these categories (ids); not together with productIds'),
      minSpend: z.number().min(0).optional().describe('Minimum spend in pesos'),
      limit: z
        .enum(['NONE', 'ONCE_PER_DAY', 'ONCE_PER_PROMOTION'])
        .optional()
        .describe('How many times one customer can benefit (default NONE)'),
      confirm: z.boolean().optional().describe('Must be true to actually create; without it you get a preview'),
    },
    async ({ venueId, confirm, ...rest }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:update', venueId)
      const gate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad')
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const input = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as unknown as NewLoyaltyPromotionInput

      if (!confirm) {
        // Lectura directa (nunca get-or-create): la vista previa no debe prender nada.
        let validado
        try {
          validado = await validarNuevaPromocion(venueId, input) // las mismas reglas que el alta: no se promete lo que se rechazaría
        } catch (err) {
          return text({ ok: false, error: (err as Error).message })
        }
        const cfg = await prisma.loyaltyConfig.findFirst({ where, select: { active: true, stampsEnabled: true } })
        const preview = vistaPrevia(validado.v, input.startDate, input.endDate ?? null, cfg)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview,
          message: `Voy a crear la promoción «${input.name}»: ${preview}.\n\nConfirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }

      try {
        const p = await createLoyaltyPromotion(venueId, input, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'LOYALTY_PROMOTION_CREATED_VIA_MCP', // el servicio ya deja LOYALTY_PROMOTION_CREATED; esta fila sólo marca el origen
          entity: 'LoyaltyPromotion',
          entityId: p.id,
          venueId,
          data: input as unknown as Record<string, unknown>,
        })
        return text({ ok: true, promotion: p })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'end_loyalty_promotion',
    'End a loyalty promotion of a venue you can access right now (active or scheduled): it stops giving extra stamps/points from this moment; what was already given stays. Get the promotionId from list_loyalty_promotions. By DEFAULT it only PREVIEWS; call again with confirm:true to end it. This WRITES; requires loyalty:update.',
    {
      venueId: z.string().describe('Venue that owns the promotion (must be in your scope)'),
      promotionId: z.string().describe('Promotion id from list_loyalty_promotions'),
      confirm: z.boolean().optional().describe('Must be true to actually end it; without it you get a preview'),
    },
    async ({ venueId, promotionId, confirm }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:update', venueId)
      const gate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      if (!confirm) {
        const p = await prisma.loyaltyPromotion.findFirst({
          where: { ...where, id: promotionId },
          select: { id: true, name: true, startsAt: true, endsAt: true, endedAt: true },
        })
        if (!p) return text({ ok: false, error: 'Promoción de lealtad no encontrada' })
        if (estadoDePromo(p, new Date()) === 'ENDED')
          return text({ ok: true, alreadyEnded: true, message: `La promoción «${p.name}» ya había terminado.` })
        const preview = `Terminar la promoción «${p.name}» ahora mismo; lo ya otorgado no cambia`
        return text({
          ok: false,
          requiresConfirmation: true,
          preview,
          message: `${preview}.\n\nConfirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }

      try {
        const antes = await prisma.loyaltyPromotion.findFirst({
          where: { ...where, id: promotionId },
          select: { startsAt: true, endsAt: true, endedAt: true },
        })
        const p = await endLoyaltyPromotion(venueId, promotionId, scope.staffId)
        // Sólo si de verdad cambió algo; el servicio ya deja LOYALTY_PROMOTION_ENDED, esta fila sólo marca el origen.
        if (antes && estadoDePromo(antes, new Date()) !== 'ENDED')
          await auditMcpWrite(scope, {
            action: 'LOYALTY_PROMOTION_ENDED_VIA_MCP',
            entity: 'LoyaltyPromotion',
            entityId: promotionId,
            venueId,
            data: { name: p.name },
          })
        return text({ ok: true, promotion: p })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
