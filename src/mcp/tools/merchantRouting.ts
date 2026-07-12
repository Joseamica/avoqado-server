/**
 * MERCHANT_ROUTING_RULES — reglas condicionales de visibilidad/auto-selección
 * de merchants en la TPV (feature PREMIUM).
 *
 * 3 tools: list (read) · preview (read, mismo motor que la TPV) · set (WRITE,
 * confirm-gated en 2 pasos con preview actual → nuevo, resolve-don't-guess).
 * Montos SIEMPRE en PESOS (unidades mayores, 1:1) — invariante del MCP.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { merchantRoutingConditionsSchema } from '@/schemas/dashboard/merchantRouting.schema'
import {
  deleteVenueRoutingRule,
  listVenueRoutingRules,
  upsertVenueRoutingRule,
} from '@/services/dashboard/merchantRouting.dashboard.service'
import { getMerchantEligibility, MERCHANT_ROUTING_FEATURE_CODE } from '@/services/tpv/merchantRouting.service'
import { auditMcpWrite } from '../audit'
import { createGuard } from '../guard'
import { planGateMessage } from '../planGate'
import { text } from '../respond'
import type { McpScope } from '../scope'

const GATE_CAPABILITY = 'Reglas de enrutamiento de cobro (mostrar/ocultar merchants en la TPV)'

const DAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const PERIOD_LABELS: Record<string, string> = { DAY: 'por día', WEEK: 'por semana (ISO, lunes)', MONTH: 'por mes' }

/** Resumen humano (español) de un objeto de condiciones — para previews confirm-gated. */
function conditionsToSpanish(conditions: Record<string, any> | null | undefined): string[] {
  if (!conditions || Object.keys(conditions).length === 0) return ['(sin condiciones — el merchant siempre se muestra)']
  const lines: string[] = []
  if (conditions.schedule) {
    const days = (conditions.schedule.days ?? []).map((d: number) => DAY_LABELS[d] ?? d).join(', ')
    const windows = (conditions.schedule.windows ?? []).map((w: any) => `${w.start}–${w.end}`).join(' y ')
    lines.push(`Horario: ${days} de ${windows} (hora del venue)`)
  }
  if (conditions.geofence) {
    lines.push(`Geocerca: radio de ${conditions.geofence.radiusM} m alrededor de (${conditions.geofence.lat}, ${conditions.geofence.lng})`)
  }
  if (conditions.volumeCap) {
    const parts: string[] = []
    if (conditions.volumeCap.maxAmount !== undefined) parts.push(`hasta $${Number(conditions.volumeCap.maxAmount).toFixed(2)}`)
    if (conditions.volumeCap.maxTxCount !== undefined) parts.push(`hasta ${conditions.volumeCap.maxTxCount} transacciones`)
    lines.push(
      `Tope de volumen ${PERIOD_LABELS[conditions.volumeCap.period] ?? conditions.volumeCap.period}: ${parts.join(' y ')} (proyectado: se oculta antes de rebasar)`,
    )
  }
  if (conditions.ticketAmount) {
    const min = conditions.ticketAmount.min !== undefined ? `desde $${Number(conditions.ticketAmount.min).toFixed(2)}` : ''
    const max = conditions.ticketAmount.max !== undefined ? `hasta $${Number(conditions.ticketAmount.max).toFixed(2)}` : ''
    lines.push(`Monto del ticket: ${[min, max].filter(Boolean).join(' ')}`)
  }
  if (conditions.staff) {
    const parts: string[] = []
    if (conditions.staff.staffIds?.length) parts.push(`${conditions.staff.staffIds.length} empleado(s) específico(s)`)
    if (conditions.staff.roles?.length) parts.push(`roles: ${conditions.staff.roles.join(', ')}`)
    lines.push(`Solo cuando cobra: ${parts.join(' o ')}`)
  }
  if (conditions.circuitBreaker) {
    lines.push(
      `Circuit breaker: se oculta tras ${conditions.circuitBreaker.consecutiveFailures} fallos técnicos seguidos, por ${conditions.circuitBreaker.cooldownMinutes} min (aplicado por la TPV)`,
    )
  }
  return lines
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export function registerMerchantRoutingTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'list_merchant_routing_rules',
    'List the conditional merchant-routing rules of a venue (MERCHANT_ROUTING_RULES, PREMIUM): which merchant accounts the TPV offers and, per merchant, the rule that shows/hides it (schedule, geofence, volume caps, ticket amount, staff, circuit breaker). A merchant WITHOUT a rule is always visible. Amounts in PESOS. Read-only — requires payments:routing-read.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:routing-read', venueId)
      const gate = await planGateMessage(venueId, MERCHANT_ROUTING_FEATURE_CODE, GATE_CAPABILITY)
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const view = await listVenueRoutingRules(venueId)
      return text({
        ok: true,
        merchants: view.merchants.map(m => ({
          ...m,
          resumen: m.rule ? conditionsToSpanish(m.rule.conditions as Record<string, any>) : ['(sin regla — siempre visible)'],
        })),
        semantica:
          'AND entre condiciones; sin regla = siempre visible; 0 elegibles = la TPV muestra TODOS con aviso (una regla nunca bloquea una venta); exactamente 1 elegible = auto-selección.',
      })
    },
  )

  server.tool(
    'preview_merchant_eligibility',
    'Simulate which merchant accounts the TPV would offer for a charge (MERCHANT_ROUTING_RULES, PREMIUM) — same engine the TPV uses. Give the ticket amount in PESOS and optionally staff, GPS location and an ISO datetime to simulate ("¿qué vería el mesero mañana a las 8pm con $500?"). Read-only — requires payments:routing-read.',
    {
      venueId: z.string().describe('Venue to simulate (must be in your scope)'),
      amount: z.number().nonnegative().describe('Ticket amount in PESOS (e.g. 250.50)'),
      staffId: z.string().optional().describe('Staff who charges (optional; defaults to the connected user)'),
      lat: z.number().min(-90).max(90).optional().describe('Latitude of the terminal (optional; omit = geofence rules fail)'),
      lng: z.number().min(-180).max(180).optional().describe('Longitude of the terminal (optional)'),
      simulateAt: z.string().optional().describe('ISO 8601 datetime to simulate (optional; default = now)'),
    },
    async ({ venueId, amount, staffId, lat, lng, simulateAt }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:routing-read', venueId)
      const gate = await planGateMessage(venueId, MERCHANT_ROUTING_FEATURE_CODE, GATE_CAPABILITY)
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const result = await getMerchantEligibility(venueId, { amount, staffId, lat, lng, simulateAt }, { staffId: scope.staffId })
      return text({
        ok: true,
        ...result,
        nota: result.fallbackAll
          ? 'NINGÚN merchant cumplió las reglas: la TPV mostraría TODOS con un aviso (la venta nunca se bloquea). Revisa las razones por merchant.'
          : result.autoSelectMerchantAccountId
            ? 'Exactamente 1 merchant elegible: la TPV lo auto-seleccionaría sin mostrar pantalla de selección.'
            : undefined,
      })
    },
  )

  server.tool(
    'set_merchant_routing_rule',
    'Create, update, deactivate or REMOVE the conditional routing rule of ONE merchant account of a venue (MERCHANT_ROUTING_RULES, PREMIUM). Identify the merchant by merchantAccountId (preferred — see list_merchant_routing_rules) or by merchantName. Conditions object (all optional, AND semantics, amounts in PESOS): { schedule: { days: [0-6, 0=domingo], windows: [{start:"HH:mm", end:"HH:mm"}] }, geofence: { lat, lng, radiusM }, volumeCap: { period: "DAY"|"WEEK"|"MONTH", maxAmount?, maxTxCount? }, ticketAmount: { min?, max? }, staff: { staffIds?, roles? }, circuitBreaker: { consecutiveFailures, cooldownMinutes } }. By DEFAULT this only PREVIEWS the change (current → new); call again with confirm:true to save. This WRITES — requires payments:routing-manage.',
    {
      venueId: z.string().describe('Venue of the rule (must be in your scope)'),
      merchantAccountId: z.string().optional().describe('Merchant account id (preferred, exact)'),
      merchantName: z
        .string()
        .optional()
        .describe('Merchant display name to resolve (if ambiguous you get the candidates back — never guessed)'),
      active: z.boolean().optional().describe('Whether the rule is active (default true; false keeps it saved but ignored)'),
      conditions: z
        .object({})
        .passthrough()
        .optional()
        .describe('Conditions object (see tool description). Omit when only toggling active on an existing rule.'),
      remove: z.boolean().optional().describe('true = DELETE the rule entirely (merchant becomes always visible)'),
      confirm: z.boolean().optional().describe('Must be true to actually save; without it you get a preview of the change'),
    },
    async ({ venueId, merchantAccountId, merchantName, active, conditions, remove, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:routing-manage', venueId)
      const gate = await planGateMessage(venueId, MERCHANT_ROUTING_FEATURE_CODE, GATE_CAPABILITY)
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const view = await listVenueRoutingRules(venueId)

      // Resolve-don't-guess: id exacto o nombre; ambiguo/no encontrado ⇒ candidatos, nunca adivinar.
      let target = merchantAccountId ? view.merchants.find(m => m.merchantAccountId === merchantAccountId) : undefined
      if (!target && merchantName) {
        const needle = normalize(merchantName)
        const matches = view.merchants.filter(m => normalize(m.displayName ?? '').includes(needle))
        if (matches.length === 1) target = matches[0]
        else if (matches.length > 1) {
          return text({
            ok: false,
            requiresDisambiguation: true,
            error: `"${merchantName}" coincide con ${matches.length} merchants — indica merchantAccountId exacto.`,
            candidates: matches.map(m => ({ merchantAccountId: m.merchantAccountId, displayName: m.displayName })),
          })
        }
      }
      if (!target) {
        return text({
          ok: false,
          error: 'Merchant no encontrado en la configuración de pagos de este venue.',
          candidates: view.merchants.map(m => ({ merchantAccountId: m.merchantAccountId, displayName: m.displayName })),
        })
      }

      const current = target.rule ? { active: target.rule.active, conditions: target.rule.conditions as Record<string, any> } : null

      // ── Borrado ──────────────────────────────────────────────────────────
      if (remove) {
        if (!current) return text({ ok: false, error: `"${target.displayName}" no tiene regla — nada que borrar.` })
        if (!confirm) {
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: {
              merchant: target.displayName,
              actual: conditionsToSpanish(current.conditions),
              nuevo: ['(sin regla — el merchant volverá a mostrarse SIEMPRE)'],
            },
            instruccion: 'Llama de nuevo con confirm:true para borrar la regla.',
          })
        }
        await deleteVenueRoutingRule(venueId, target.merchantAccountId, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'MCP_MERCHANT_ROUTING_RULE_SET',
          entity: 'MerchantRoutingRule',
          entityId: target.merchantAccountId,
          venueId,
          data: { operation: 'delete', merchant: target.displayName },
        })
        return text({ ok: true, deleted: true, merchant: target.displayName })
      }

      // ── Upsert ───────────────────────────────────────────────────────────
      const newActive = active ?? current?.active ?? true
      const newConditionsRaw = conditions ?? current?.conditions
      if (!newConditionsRaw) {
        return text({ ok: false, error: 'Este merchant no tiene regla: para crearla debes pasar `conditions`.' })
      }
      const parsed = merchantRoutingConditionsSchema.safeParse(newConditionsRaw)
      if (!parsed.success) {
        return text({
          ok: false,
          error: 'Condiciones inválidas',
          issues: parsed.error.issues.map(i => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
        })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            merchant: target.displayName,
            actual: current ? [`activa: ${current.active}`, ...conditionsToSpanish(current.conditions)] : ['(sin regla — siempre visible)'],
            nuevo: [`activa: ${newActive}`, ...conditionsToSpanish(parsed.data as Record<string, any>)],
          },
          recordatorio:
            'Semántica: AND entre condiciones; si NINGÚN merchant del venue queda elegible la TPV muestra todos con aviso (nunca se bloquea una venta).',
          instruccion: 'Llama de nuevo con confirm:true para guardar.',
        })
      }

      const saved = await upsertVenueRoutingRule(
        venueId,
        { merchantAccountId: target.merchantAccountId, active: newActive, conditions: parsed.data },
        scope.staffId,
      )
      await auditMcpWrite(scope, {
        action: 'MCP_MERCHANT_ROUTING_RULE_SET',
        entity: 'MerchantRoutingRule',
        entityId: saved.id,
        venueId,
        data: { operation: current ? 'update' : 'create', merchant: target.displayName, active: newActive },
      })
      return text({
        ok: true,
        merchant: target.displayName,
        rule: { active: saved.active, resumen: conditionsToSpanish(saved.conditions as Record<string, any>) },
      })
    },
  )
}
