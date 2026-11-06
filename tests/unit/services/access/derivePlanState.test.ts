import { derivePlanState } from '@/services/access/basePlan.service'

const future = new Date(Date.now() + 5 * 86400000) // +5d
const past = new Date(Date.now() - 5 * 86400000) // -5d

describe('derivePlanState (7-state pure helper)', () => {
  // 1. NEW FEATURE TESTS
  it('returns "none" when there is no PLAN_PRO VenueFeature', () => {
    expect(derivePlanState(null, null).state).toBe('none')
    expect(derivePlanState(null, null).hasPlan).toBe(false)
  })

  it('returns "suspended" when suspendedAt is set (precedence over everything)', () => {
    const vf = { active: true, endDate: future, suspendedAt: past, gracePeriodEndsAt: future }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).state).toBe('suspended')
  })

  it('returns "canceled" when the feature is inactive (and not suspended)', () => {
    const vf = { active: false, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, null).state).toBe('canceled')
  })

  it('returns "past_due" when grace period is in the future', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: future }
    expect(derivePlanState(vf, null).state).toBe('past_due')
  })

  it('returns "past_due" when Stripe status is past_due (no grace set)', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'past_due', cancelAtPeriodEnd: false }).state).toBe('past_due')
  })

  it('returns "trial" when endDate is in the future', () => {
    const vf = { active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'trialing', cancelAtPeriodEnd: false }).state).toBe('trial')
  })

  it('returns "canceling" when cancelAtPeriodEnd is true on the Stripe sub', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: true }).state).toBe('canceling')
  })

  it('returns "active" for a healthy paid subscription', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).state).toBe('active')
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).hasPlan).toBe(true)
  })

  // 2. EDGE / REGRESSION TESTS
  it('🔴 D4: una prueba vencida que el portero niega NO se pinta como «activa», aunque Stripe ya cobrara', () => {
    // Antes decía `active` mientras el acceso se negaba (fila sin reparar: el aviso de la renovación no llegó). Mientras
    // el barrido la repara, la pantalla dice lo mismo que el portero: sin acceso.
    const vf = { active: true, endDate: past, suspendedAt: null, gracePeriodEndsAt: null, stripeSubscriptionId: 'sub_1' }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: false }).state).toBe('suspended')
  })

  it('derives state from the VenueFeature alone when there is no Stripe sub (DB-only trial)', () => {
    const vf = { active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: null }
    expect(derivePlanState(vf, null).state).toBe('trial')
  })

  it('past_due beats canceling when both grace and cancelAtPeriodEnd are set', () => {
    const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: future }
    expect(derivePlanState(vf, { status: 'active', cancelAtPeriodEnd: true }).state).toBe('past_due')
  })

  // 3. D4 + D6 (5-nov-2026): la pantalla del plan contesta con la MISMA regla que el portero (ventanaDeAcceso.ts).
  describe('una sola regla con el portero', () => {
    it('🔴 D6: prueba vencida + gracia vigente → «past_due» (con acceso), no «suspended»', () => {
      const vf = { active: true, endDate: past, suspendedAt: null, gracePeriodEndsAt: future, stripeSubscriptionId: 'sub_1' }
      expect(derivePlanState(vf, { status: 'past_due', cancelAtPeriodEnd: false }).state).toBe('past_due')
    })

    it('🔴 los 4 días tras una prueba vencidos → «suspended» (el DASHBOARD lee «past_due» como «con acceso»)', () => {
      const vf = { active: true, endDate: past, suspendedAt: null, gracePeriodEndsAt: past, stripeSubscriptionId: 'sub_1' }
      expect(derivePlanState(vf, { status: 'past_due', cancelAtPeriodEnd: false }).state).toBe('suspended')
      // Codex D6 r2 #4: si Stripe no contestó, antes caía a «active».
      expect(derivePlanState(vf, null).state).toBe('suspended')
    })

    it('REGRESIÓN v4: quien ya pagaba, con la gracia vencida y sin suspender todavía, conserva acceso → «past_due»', () => {
      const vf = { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: past, stripeSubscriptionId: 'sub_1' }
      expect(derivePlanState(vf, { status: 'past_due', cancelAtPeriodEnd: false }).state).toBe('past_due')
    })

    it('prueba local (sin Stripe) vencida → «canceled», nunca «active»', () => {
      const vf = { active: true, endDate: past, suspendedAt: null, gracePeriodEndsAt: null, stripeSubscriptionId: null }
      expect(derivePlanState(vf, null).state).toBe('canceled')
    })

    it('una cortesía vigente gana sobre una gracia vencida → «trial»', () => {
      const vf = { active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: past, stripeSubscriptionId: null }
      expect(derivePlanState(vf, null).state).toBe('trial')
    })
  })
})
