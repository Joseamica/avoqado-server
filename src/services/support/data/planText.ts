import type { NombresDeLosPlanes } from '@/services/billing/nombresDeLosPlanes'
import type { PlanOrigin, PlanState } from '@/services/dashboard/planState.service'
import type { DataScope } from './catalog'
import { checkRendered, template, type Rendered } from './check'

/**
 * El texto de «Tu plan» del bot, en un módulo PURO (sin base, sin config): lo importan la capacidad `plan_status` y el editor de
 * la oferta (`problemasDeLaOferta`), que así rechaza lo mismo que el bot no podría decir (B4, Task 4).
 */

/** El estado del plan más el nombre de cada plan (el de la versión vigente del editor). */
export type PlanData = PlanState & { nombres?: NombresDeLosPlanes }

/** Lo de hoy, byte por byte, cuando no hay una versión del editor (sin base: este módulo es puro). */
const NOMBRES_DE_HOY: NombresDeLosPlanes = { FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' }
/** El nombre de un plan donde el texto lo dice: un hueco de texto, para que checkRendered lo cotee como cualquier dato de la base. */
type Nombre = () => string

/**
 * La frase de «Tu plan», en el orden del panel: lo que frena el plan (sólo el clásico: pausado o con el cobro fallido; un contrato con
 * un problema de pago) antes que sus fechas. null cuando el panel no dice nada (p. ej. Stripe no contestó: no hay fecha).
 */
function planSentence(t: ReturnType<typeof template>, state: PlanState, origin: PlanOrigin, tier: Nombre, free: Nombre): string | null {
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
  if (origin.kind === 'COMP')
    return until ? `Tu plan ${tier()} es de cortesía hasta el ${t.date(until)}.` : `Tu plan ${tier()} es de cortesía.`
  if (origin.cancelAt)
    return origin.kind === 'CONTRACT'
      ? `Tu plan ${tier()} deja de renovarse el ${t.date(origin.cancelAt)}.`
      : `Tu plan ${tier()} sigue activo hasta el ${t.date(origin.cancelAt)}; después pasas a ${free()}.`
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
export const renderPlan = (scope: DataScope, state: PlanData): Rendered => withoutPrice(planText(scope, state), scope.venueName)

/** Las fechas son días de la sucursal (`t.date`); los huecos se anotan en el orden en que salen. */
function planText(scope: DataScope, state: PlanData): Rendered {
  const t = template(scope.timezone)
  const nombres = state.nombres ?? NOMBRES_DE_HOY
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
        : `${where} Tu negocio está en el plan ${t.text(nombres.FREE)}.`,
    )
  }
  const tier: Nombre = () => t.text(nombres[origin.tier as 'PRO' | 'PREMIUM'])
  const free: Nombre = () => t.text(nombres.FREE)
  const line = `Plan de ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${tier()}.`
  const sentence = planSentence(t, state, origin, tier, free)
  return t.done(sentence ? `${line} ${sentence}` : line)
}

/**
 * ¿El asistente de WhatsApp podría decir un plan con este nombre? Por el MISMO camino que el bot: arma el texto de «Tu plan» con ese
 * nombre en cada frase donde sale (la línea del plan, el plan Gratis, la cortesía, el plan que deja de renovarse) y exige que pase
 * `withoutPrice` y `checkRendered`, y que el nombre salga tal cual (si el filtro de texto lo cambia o lo omite, el bot no lo diría).
 * Nunca lanza.
 */
export function nombreQueElBotPuedeDecir(nombre: string): boolean {
  try {
    const scope = { venueName: 'Negocio', timezone: 'America/Mexico_City', now: new Date('2026-11-12T20:32:00Z') } as DataScope
    const dia = new Date('2026-12-03T18:00:00Z')
    const origin = (kind: PlanOrigin['kind'], cancelAt: Date | null) =>
      ({
        kind,
        tier: 'PRO',
        price: null,
        interval: null,
        currentPeriodEnd: null,
        cancelAt,
        contractId: null,
        paymentIssue: null,
      }) as unknown as PlanOrigin
    const estado = (o: PlanOrigin | null, extra: Partial<PlanState> = {}): PlanData =>
      ({
        state: 'active',
        grandfathered: false,
        origin: o,
        nombres: { FREE: nombre, PRO: nombre, PREMIUM: nombre },
        ...extra,
      }) as unknown as PlanData
    const casos = [
      estado(origin('CLASSIC', null)),
      estado(origin('COMP', dia)),
      estado(origin('CLASSIC', dia)),
      estado(origin('NONE', null), { state: 'none' } as Partial<PlanState>),
    ]
    return casos.every(caso => {
      const rendered = renderPlan(scope, caso)
      return rendered.text.includes(nombre) && checkRendered(rendered, scope.timezone)
    })
  } catch {
    return false
  }
}
