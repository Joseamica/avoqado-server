/**
 * 🔴 Codex C8 (22-sep): tras un cambio de plan el negocio tiene DOS filas de plan (la vieja inactiva, la nueva activa). Los
 * lectores de facturación tomaban «la primera» (`findFirst` / `take: 1`) sin orden: podían mostrar el plan viejo como
 * cancelado y rechazar la cancelación del vigente («No hay suscripción de Stripe»). La fila administrable se elige con una
 * regla explícita.
 */
import { elegirFilaDelPlan, hayAmbiguedadDePlan } from '@/services/access/filaDelPlan'
import { choquesAlConcederPlan, planesPedidos } from '@/services/access/concederPlanDecision'

const fila = (
  over: Partial<{
    id: string
    active: boolean
    suspendedAt: Date | null
    stripeSubscriptionId: string | null
    endDate: Date | null
    cobroVivo: boolean | null
    updatedAt: Date
  }>,
) => ({
  id: 'f',
  active: false,
  suspendedAt: null as Date | null,
  stripeSubscriptionId: null as string | null,
  endDate: null as Date | null,
  cobroVivo: null as boolean | null,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
})

describe('elegirFilaDelPlan', () => {
  it('sin filas: null', () => {
    expect(elegirFilaDelPlan([])).toBeNull()
  })

  it('🔴 la que da acceso gana a la vieja retirada, sin importar el orden de la consulta', () => {
    const vieja = fila({ id: 'pro', stripeSubscriptionId: null })
    const vigente = fila({ id: 'premium', active: true, stripeSubscriptionId: 'sub_1' })
    expect(elegirFilaDelPlan([vieja, vigente])?.id).toBe('premium')
    expect(elegirFilaDelPlan([vigente, vieja])?.id).toBe('premium')
  })

  it('🔴 una suspendida que sigue ligada (se puede cobrar/cancelar) gana a una sin vínculo', () => {
    const suspendida = fila({ id: 'pro', active: false, suspendedAt: new Date(), stripeSubscriptionId: 'sub_1' })
    const cortesiaRetirada = fila({ id: 'premium', active: false })
    expect(elegirFilaDelPlan([cortesiaRetirada, suspendida])?.id).toBe('pro')
  })

  it('empate: la más reciente', () => {
    const a = fila({ id: 'a', stripeSubscriptionId: 's1', updatedAt: new Date('2026-09-01T00:00:00Z') })
    const b = fila({ id: 'b', stripeSubscriptionId: 's2', updatedAt: new Date('2026-09-10T00:00:00Z') })
    expect(elegirFilaDelPlan([a, b])?.id).toBe('b')
  })
})

/**
 * 🔴 Codex R10 (ronda 2): «la fila más recientemente escrita» todavía podía ser la obligación equivocada. Faltaban dos
 * cosas: la VIGENCIA (una prueba vencida ganaba como si diera acceso) y el estado económico del vínculo (un webhook
 * tardío de una suscripción CANCELADA le subía el `updatedAt` a su fila y volvía a elegirla, mientras la nueva cobraba).
 */
describe('🔴 R10: vigencia y estado económico', () => {
  const AHORA = new Date('2026-09-22T12:00:00Z')

  it('🔴 una prueba VENCIDA no gana a una activa vigente', () => {
    const vencida = fila({ id: 'pro', active: true, endDate: new Date('2026-09-01T00:00:00Z') })
    const vigente = fila({ id: 'premium', active: true, endDate: null })
    expect(elegirFilaDelPlan([vencida, vigente], AHORA)?.id).toBe('premium')
    expect(elegirFilaDelPlan([vigente, vencida], AHORA)?.id).toBe('premium')
  })

  it('🔴 un vínculo que CONSTA terminado no gana a la fila que sigue cobrando', () => {
    // El webhook tardío de la cancelada le subió el `updatedAt`: sin el estado económico, ganaba ella.
    const cancelada = fila({
      id: 'vieja',
      active: true,
      stripeSubscriptionId: 'sub_muerta',
      cobroVivo: false,
      updatedAt: new Date('2026-09-22T11:59:00Z'),
    })
    const vivaSuspendida = fila({
      id: 'nueva',
      active: false,
      suspendedAt: new Date('2026-09-20T00:00:00Z'),
      stripeSubscriptionId: 'sub_viva',
      cobroVivo: true,
      updatedAt: new Date('2026-09-10T00:00:00Z'),
    })
    expect(elegirFilaDelPlan([cancelada, vivaSuspendida], AHORA)?.id).toBe('nueva')
  })

  it('🔴 la que CONSTA cobrando gana a una activa local sin vínculo (es la obligación que se administra)', () => {
    const cobrando = fila({ id: 'cobra', active: false, suspendedAt: null, stripeSubscriptionId: 'sub_1', cobroVivo: true })
    const cortesiaLocal = fila({ id: 'cortesia', active: true })
    expect(elegirFilaDelPlan([cortesiaLocal, cobrando], AHORA)?.id).toBe('cobra')
  })

  it('no saber si el cobro vive NO degrada la fila (sólo degrada lo que consta terminado)', () => {
    const sinConsultar = fila({ id: 'a', active: true, stripeSubscriptionId: 'sub_1' })
    const cortesia = fila({ id: 'b', active: true })
    expect(elegirFilaDelPlan([cortesia, sinConsultar], AHORA)?.id).toBe('a')
  })

  it('🔴 dos filas administrables empatadas arriba son AMBIGUAS: el que administra tiene que decidir, no adivinar', () => {
    const a = fila({ id: 'a', active: true, stripeSubscriptionId: 's1', updatedAt: new Date('2026-09-20T00:00:00Z') })
    const b = fila({ id: 'b', active: true, stripeSubscriptionId: 's2', updatedAt: new Date('2026-09-21T00:00:00Z') })
    expect(hayAmbiguedadDePlan([a, b], AHORA)).toBe(true)
    // Una sola administrable no es ambigua.
    expect(hayAmbiguedadDePlan([a, fila({ id: 'c' })], AHORA)).toBe(false)
    expect(hayAmbiguedadDePlan([], AHORA)).toBe(false)
  })
})

/**
 * 🔴 Codex R2 (ronda 2): los escritores administrativos (pruebas gratis, wizard) escribían su fila sin mirar el OTRO
 * tier. Concediendo una prueba PRO a un negocio con PREMIUM activo quedaban los DOS planes activos — y bastaba la
 * ejecución secuencial, sin carrera. La decisión es una sola y vive aquí.
 */
describe('🔴 R2: no se concede un plan encima de otro', () => {
  const filaDe = (featureId: string, over: Partial<{ active: boolean; stripeSubscriptionId: string | null }> = {}) => ({
    featureId,
    active: false,
    stripeSubscriptionId: null as string | null,
    ...over,
  })

  it('sin otras filas: se puede conceder', () => {
    expect(choquesAlConcederPlan([], 'f-pro')).toEqual({ propiaLigada: false, otroPlanVivo: false })
    expect(choquesAlConcederPlan([filaDe('f-pro')], 'f-pro')).toEqual({ propiaLigada: false, otroPlanVivo: false })
  })

  it('🔴 la fila PROPIA ligada a Stripe no se enciende a mano: su acceso lo decide el cobro', () => {
    expect(choquesAlConcederPlan([filaDe('f-pro', { stripeSubscriptionId: 'sub_1' })], 'f-pro').propiaLigada).toBe(true)
  })

  it('🔴 el OTRO tier activo bloquea (el caso que dejaba dos planes vivos)', () => {
    expect(choquesAlConcederPlan([filaDe('f-premium', { active: true })], 'f-pro').otroPlanVivo).toBe(true)
  })

  it('🔴 el OTRO tier ligado a Stripe bloquea aunque su fila esté apagada (sigue cobrando)', () => {
    expect(choquesAlConcederPlan([filaDe('f-premium', { stripeSubscriptionId: 'sub_2' })], 'f-pro').otroPlanVivo).toBe(true)
  })

  it('el otro tier retirado y sin vínculo no estorba', () => {
    expect(choquesAlConcederPlan([filaDe('f-premium')], 'f-pro')).toEqual({ propiaLigada: false, otroPlanVivo: false })
  })
})

/**
 * 🔴 Codex R2 (ronda 2), el wizard: creaba una fila por cada código pedido sin mirar nada, así que con los dos planes
 * en el mismo payload dejaba los DOS activos de una sola pasada. La regla se decide aquí y el wizard la aplica.
 */
describe('🔴 R2: el alta no puede pedir dos planes a la vez', () => {
  const CODIGOS = ['PLAN_PRO', 'PLAN_PREMIUM'] as const

  it('reconoce cuántos planes trae el payload', () => {
    expect(planesPedidos(['PLAN_PRO', 'CFDI'], CODIGOS)).toEqual(['PLAN_PRO'])
    expect(planesPedidos(['PLAN_PRO', 'PLAN_PREMIUM', 'CFDI'], CODIGOS)).toHaveLength(2)
    expect(planesPedidos(['CFDI', 'LOYALTY_PROGRAM'], CODIGOS)).toEqual([])
  })
})

/**
 * 🔴 Codex ronda 3, hallazgo 12 (P1) — regresión MÍA: `choqueAlConcederPlan` devolvía `PLAN_LIGADO_A_STRIPE` en cuanto
 * la fila PROPIA tenía vínculo, y ahí se detenía: nunca llegaba a mirar el otro tier. Con `vinculoPropioYaComprobado`
 * (la excepción legítima para limpiar un vínculo MUERTO) ese resultado se ignoraba entero, así que conceder una prueba
 * PRO sobre un PREMIUM ACTIVO pasaba — justo el defecto que R2 venía a cerrar. Los dos choques son independientes.
 */
describe('🔴 R2 (ronda 3): los dos choques se evalúan por separado', () => {
  const f = (featureId: string, over: Partial<{ active: boolean; stripeSubscriptionId: string | null }> = {}) => ({
    featureId,
    active: false,
    stripeSubscriptionId: null as string | null,
    ...over,
  })

  it('🔴 la fila propia LIGADA no tapa el choque con el otro tier activo', () => {
    const r = choquesAlConcederPlan([f('f-pro', { stripeSubscriptionId: 'sub_muerta' }), f('f-premium', { active: true })], 'f-pro')
    expect(r).toEqual({ propiaLigada: true, otroPlanVivo: true })
  })

  it('cada choque se reporta por su cuenta', () => {
    expect(choquesAlConcederPlan([f('f-pro', { stripeSubscriptionId: 's' })], 'f-pro')).toEqual({
      propiaLigada: true,
      otroPlanVivo: false,
    })
    expect(choquesAlConcederPlan([f('f-premium', { active: true })], 'f-pro')).toEqual({ propiaLigada: false, otroPlanVivo: true })
    expect(choquesAlConcederPlan([], 'f-pro')).toEqual({ propiaLigada: false, otroPlanVivo: false })
  })
})
