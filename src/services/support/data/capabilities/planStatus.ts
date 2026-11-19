import { getPlanState, type PlanOrigin, type PlanState } from '@/services/dashboard/planState.service'
import type { DataCapability, DataScope } from '../catalog'
import { template, type Rendered } from '../check'

/**
 * C5 · «Estado del plan»: lo que dice «Tu plan» en Facturación › Suscripciones del panel, leído con el mismo servicio que su ruta
 * (`getPlanState`, `GET /venues/:venueId/plan`) y escrito con el mismo árbol y las mismas frases (`PlanRow.tsx` y `billing.json` del
 * panel): fundador, Gratis, pago pendiente, problema de pago de un contrato, cortesía, deja de renovarse, primer cobro o se renueva.
 * Nunca un precio, un descuento ni una tarjeta: el renglón del descuento del panel (D5) son precios y aquí no sale. T-F16: el Plan Básico
 * como lo decide `basicNotice` del panel (`planActions.ts`): su contrato es el plan (con la etiqueta fija «Básico»: el nombre de su
 * publicación puede traer el precio, T-F19) y una prueba de Pro que termina sin cobrar dice cuándo termina; sus ofertas (contratarlo,
 * terminar Pro) son precios y no salen. Permisos y puesto
 * de la pantalla: `billing:read` y `billing:subscriptions:read`, dentro de `AdminProtectedRoute` (ADMIN y OWNER; la ruta del panel
 * pide `billing:subscriptions:read`). Sin candado de plan.
 */

/**
 * Lo que espera a Stripe: por debajo del tope de la lectura (`SUPPORT_DATA_QUERY_TIMEOUT_SECONDS`, 8 s por omisión y 5 como mínimo,
 * `SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS`). Así un Stripe que no contesta da el plan sin fecha, como el panel, y no «No pude leer ese
 * dato». Se exporta para que la prueba del config amarre los dos números.
 */
export const STRIPE_TIMEOUT_MS = 3_000

/** El nombre de cada nivel, como el panel (`plan.tiers.*.name`). */
const TIER: Record<'PRO' | 'PREMIUM', string> = { PRO: 'Pro', PREMIUM: 'Premium' }

/**
 * La frase de «Tu plan», en el orden del panel: lo que frena el plan (sólo el clásico: pausado o con el cobro fallido; un contrato con
 * un problema de pago) antes que sus fechas. null cuando el panel no dice nada (p. ej. Stripe no contestó: no hay fecha).
 */
function planSentence(t: ReturnType<typeof template>, state: PlanState, origin: PlanOrigin, tier: string): string | null {
  const until = origin.cancelAt ?? origin.currentPeriodEnd
  if (origin.kind === 'CLASSIC' && state.state === 'suspended')
    return 'Tu pago está pendiente y el acceso de pago está en pausa. Actualiza tu método de pago para recuperarlo.'
  if (origin.kind === 'CLASSIC' && state.state === 'past_due')
    // La gracia (D4 y D6: 4 días tras una prueba, 7 para quien ya pagaba) la fija la cobranza; aquí sólo se dice hasta qué día
    return state.gracePeriodEndsAt
      ? `No pudimos cobrar tu plan. Actualiza tu método de pago antes del ${t.date(state.gracePeriodEndsAt)} para no perderlo.`
      : 'No pudimos cobrar tu plan. Actualiza tu método de pago para no perderlo.'
  if (origin.kind === 'CONTRACT' && origin.paymentIssue)
    return 'Una devolución o disputa afectó el pago de esta compra. Estamos revisando su acceso. Las funciones pagadas por otras compras se conservan.'
  // T-F16 (`TRIAL_ENDS_FREE` del panel): la prueba termina sin cobrar y hay un Básico publicado; un contrato del Básico le gana
  if (state.trialModality === 'ENDS_FREE' && state.basicOffer && !state.basicPlan) {
    const ends = state.trialEndsAt ?? origin.cancelAt ?? origin.currentPeriodEnd
    return ends
      ? `Tu prueba termina el ${t.date(ends)}. Ese día podrás contratar el Básico.`
      : 'Cuando termine tu prueba podrás contratar el Básico.'
  }
  if (origin.kind === 'COMP') return until ? `Tu plan ${tier} es de cortesía hasta el ${t.date(until)}.` : `Tu plan ${tier} es de cortesía.`
  if (origin.cancelAt)
    return origin.kind === 'CONTRACT'
      ? `Tu plan ${tier} deja de renovarse el ${t.date(origin.cancelAt)}.`
      : `Tu plan ${tier} sigue activo hasta el ${t.date(origin.cancelAt)}; después pasas a Gratis.`
  // En una prueba con tarjeta esa fecha es el PRIMER cobro, no una renovación (D3)
  if (until) return state.state === 'trial' ? `Tu primer cobro será el ${t.date(until)}.` : `Se renueva el ${t.date(until)}.`
  return null
}

/**
 * T-F19 (Codex 1): la B no da precios. Lo que pone el plan no puede traer un signo de moneda ni una palabra de dinero: checkRendered deja
 * pasar un texto de la base («Básico $499 + IVA» pasaba como hueco de texto). Si los trae, render lanza y la B no lo manda
 * (`SUPPORT_DATA_CHECK_FAILED`). Hoy todo lo del plan es texto fijo («Básico», «Pro»…): es la red para un campo de plan nuevo.
 * T-F19b: el nombre de la sucursal no se revisa; «Tacos a 10 pesos» es un negocio, no un precio.
 */
const MONEY = /[$¢£€¥]|\b(?:MXN|USD|IVA|pesos?)\b/i
export function withoutPrice(rendered: Rendered, venueName: string): Rendered {
  const plan = rendered.figures
    .filter(f => f.kind === 'text' && f.value === venueName)
    .reduce((text, venue) => text.split(venue.shown).join(' '), rendered.text)
  if (MONEY.test(plan.normalize('NFKC').replace(/\p{Cf}/gu, ''))) throw new Error('El texto del plan trae un precio')
  return rendered
}

/** El texto de «Tu plan», sin precios (withoutPrice). */
export const renderPlan = (scope: DataScope, state: PlanState): Rendered => withoutPrice(planText(scope, state), scope.venueName)

/** Las fechas son días de la sucursal (`t.date`); los huecos se anotan en el orden en que salen. */
function planText(scope: DataScope, state: PlanState): Rendered {
  const t = template(scope.timezone)
  const origin = state.origin
  // Fundador y Gratis empiezan con la sucursal. Sin nivel no hay plan que nombrar: el panel marca «Gratis» como el actual.
  if (state.grandfathered || !origin || origin.kind === 'NONE' || !origin.tier) {
    // T-F16: con un contrato del Básico, la píldora de «Tu plan actual» es el Básico (el fundador va antes). T-F19: con la etiqueta
    // fija, nunca `basic.name`, que puede traer el precio
    const basic = state.grandfathered ? null : state.basicPlan
    if (basic) {
      const line = `Plan de ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): Básico.`
      // «más abajo» del panel es su lista de contrataciones; por aquí, el panel
      return t.done(basic.active ? line : `${line} Tu Básico no da acceso hoy: revisa tus contrataciones en el panel.`)
    }
    const where = `${t.text(scope.venueName)} (corte ${t.time(scope.now)}):`
    return t.done(
      state.grandfathered
        ? `${where} Tu negocio es fundador: tienes todas las funciones sin costo.`
        : `${where} Tu negocio está en el plan Gratis.`,
    )
  }
  const tier = TIER[origin.tier]
  const line = `Plan de ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${tier}.`
  const sentence = planSentence(t, state, origin, tier)
  return t.done(sentence ? `${line} ${sentence}` : line)
}

export const planStatus: DataCapability<Record<string, never>, PlanState> = {
  key: 'plan_status',
  label: 'el estado de tu plan',
  object: 'el estado del plan',
  aiHint:
    'Cómo está el plan de Avoqado de la sucursal: cuál tiene, si se renueva, si hay un pago pendiente o si está por terminar. Sin precios.',
  permissions: ['billing:read', 'billing:subscriptions:read'],
  roles: ['ADMIN', 'OWNER'],
  params: () => ({ ok: true, value: {} }),
  read: async scope => getPlanState(scope.venueId, { skipPauseOffer: true, stripeTimeoutMs: STRIPE_TIMEOUT_MS }),
  render: (scope, _params, state) => renderPlan(scope, state),
}
