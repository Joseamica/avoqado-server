/**
 * C5 · «Estado del plan»: el árbol de «Tu plan» del panel (PlanRow.tsx) sobre un PlanState armado a mano, sin base. Lo que pasa con
 * la base de verdad (lo que lee getPlanState, Stripe que no contesta, el puesto, la oferta de pausa) está en
 * `tests/integration/support/data/planStatus.integration.test.ts`.
 */
jest.mock('@/services/dashboard/planState.service', () => ({ getPlanState: jest.fn() }))
jest.mock('@/services/billing/nombresDeLosPlanes', () => ({
  nombresDeLosPlanes: jest.fn().mockResolvedValue({ FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' }),
}))

import { getPlanState, type PlanOrigin, type PlanState } from '@/services/dashboard/planState.service'
import { planStatus, renderPlan, withoutPrice } from '@/services/support/data/capabilities/planStatus'
import type { DataRequest, DataScope } from '@/services/support/data/catalog'
import { checkRendered, template } from '@/services/support/data/check'
import { SUPPORT_DATA_OMITTED } from '@/services/support/data/texts'

const scope: DataScope = {
  venueId: 'ckq7z1x2y0000abcd1234efgh',
  organizationId: 'org',
  venueName: 'Flautas Coyoacán',
  timezone: 'America/Mexico_City',
  day: '2026-11-12',
  kycVerified: true,
  now: new Date('2026-11-12T20:32:00Z'), // jueves 12-nov, 14:32 en la CDMX
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
}
const D = (d: string) => `${d}T18:00:00.000Z`
/** Un PlanState con todo lo demás en null (o false), `state: 'active'` y un origen clásico Pro. */
const base = (s: Partial<PlanState> = {}, o: Partial<PlanOrigin> = {}): PlanState => ({
  hasPlan: false,
  state: 'active',
  planTier: null,
  planName: null,
  interval: null,
  price: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  paymentMethod: null,
  stripeSubscriptionId: null,
  grandfathered: false,
  retentionOfferEligible: false,
  ...s,
  origin: {
    kind: 'CLASSIC',
    tier: 'PRO',
    price: null,
    interval: null,
    currentPeriodEnd: null,
    cancelAt: null,
    contractId: null,
    contractRevision: null,
    subscriptionId: null,
    paymentIssue: null,
    ...o,
  },
})
/** El texto, con el cotejo pasado: una plantilla que no lo pasa nunca sale. */
const text = (state: PlanState, at: DataScope = scope) => {
  const out = renderPlan(at, state)
  expect(checkRendered(out, at.timezone)).toBe(true)
  return out.text
}
const PLAN_LINE = 'Plan de Flautas Coyoacán (corte 14:32): Pro.'

it.each([
  ['founder', base({ grandfathered: true }), 'Tu negocio es fundador: tienes todas las funciones sin costo.'],
  ['no plan', base({ state: 'none' }, { kind: 'NONE', tier: null }), 'Tu negocio está en el plan Gratis.'],
  [
    'suspended',
    base({ state: 'suspended' }),
    'Tu pago está pendiente y el acceso de pago está en pausa. Actualiza tu método de pago para recuperarlo.',
  ],
  [
    'past due with a date',
    base({ state: 'past_due', gracePeriodEndsAt: D('2026-11-16') }),
    'No pudimos cobrar tu plan. Actualiza tu método de pago antes del 16-nov-2026 para no perderlo.',
  ],
  ['past due without a date', base({ state: 'past_due' }), 'No pudimos cobrar tu plan. Actualiza tu método de pago para no perderlo.'],
  [
    'contract in dispute',
    base({ state: 'none' }, { kind: 'CONTRACT', paymentIssue: 'DISPUTE' }),
    'Una devolución o disputa afectó el pago de esta compra. Estamos revisando su acceso. Las funciones pagadas por otras compras se conservan.',
  ],
  [
    'courtesy with a date',
    base({}, { kind: 'COMP', currentPeriodEnd: D('2026-11-30') }),
    'Tu plan Pro es de cortesía hasta el 30-nov-2026.',
  ],
  ['courtesy without a date', base({}, { kind: 'COMP' }), 'Tu plan Pro es de cortesía.'],
  [
    'a contract that stops renewing',
    base({ state: 'none' }, { kind: 'CONTRACT', cancelAt: D('2026-12-03'), currentPeriodEnd: D('2026-12-03') }),
    'Tu plan Pro deja de renovarse el 3-dic-2026.',
  ],
  [
    'a classic plan that ends',
    base({}, { cancelAt: D('2026-12-03'), currentPeriodEnd: D('2026-12-03') }),
    'Tu plan Pro sigue activo hasta el 3-dic-2026; después pasas a Gratis.',
  ],
  ['a trial with a card', base({ state: 'trial' }, { currentPeriodEnd: D('2026-11-20') }), 'Tu primer cobro será el 20-nov-2026.'],
  ['renews', base({}, { currentPeriodEnd: D('2026-12-03') }), 'Se renueva el 3-dic-2026.'],
])('%s', (_name, state, sentence) => {
  const out = renderPlan(scope, state)
  // Si no termina así, el mensaje enseña el texto entero
  expect(out.text.endsWith(sentence) ? sentence : out.text).toBe(sentence)
  expect(checkRendered(out, scope.timezone)).toBe(true)
})

it('rows 3 to 8 start with the plan line; Premium says Premium; founder and Gratis start with the venue', () => {
  expect(renderPlan(scope, base({}, { currentPeriodEnd: D('2026-12-03') })).text).toBe(
    'Plan de Flautas Coyoacán (corte 14:32): Pro. Se renueva el 3-dic-2026.',
  )
  expect(renderPlan(scope, base({}, { tier: 'PREMIUM' })).text).toBe('Plan de Flautas Coyoacán (corte 14:32): Premium.') // Stripe no contestó: sin fecha (caso 21)
  expect(renderPlan(scope, base({ state: 'none' }, { kind: 'NONE', tier: null })).text).toBe(
    'Flautas Coyoacán (corte 14:32): Tu negocio está en el plan Gratis.',
  )
  expect(text(base({ grandfathered: true }))).toBe(
    'Flautas Coyoacán (corte 14:32): Tu negocio es fundador: tienes todas las funciones sin costo.',
  )
  expect(text(base({}, { kind: 'COMP', tier: 'PREMIUM', currentPeriodEnd: D('2026-11-30') }))).toBe(
    'Plan de Flautas Coyoacán (corte 14:32): Premium. Tu plan Premium es de cortesía hasta el 30-nov-2026.',
  )
  expect(text(base({}, { tier: 'PREMIUM', cancelAt: D('2026-12-03'), currentPeriodEnd: D('2026-12-03') }))).toBe(
    'Plan de Flautas Coyoacán (corte 14:32): Premium. Tu plan Premium sigue activo hasta el 3-dic-2026; después pasas a Gratis.',
  )
})

it('a trial never says «Se renueva», and a contract with state none never says «Gratis» (case 21)', () => {
  // La prueba con tarjeta y Stripe sin contestar: sin fecha, y nunca «Se renueva»
  expect(text(base({ state: 'trial' }))).toBe(PLAN_LINE)
  expect(text(base({ state: 'trial' }, { currentPeriodEnd: D('2026-11-20') }))).not.toContain('Se renueva')
  // Un contrato no deja fila de plan: su state es 'none' y aun así es un plan de pago
  for (const origin of [
    { kind: 'CONTRACT' as const },
    { kind: 'CONTRACT' as const, currentPeriodEnd: D('2026-12-03') },
    { kind: 'CONTRACT' as const, cancelAt: D('2026-12-03'), currentPeriodEnd: D('2026-12-03') },
  ])
    expect(text(base({ state: 'none' }, origin))).not.toMatch(/Gratis/)
  expect(text(base({ state: 'none' }, { kind: 'CONTRACT', currentPeriodEnd: D('2026-12-03') }))).toBe(
    `${PLAN_LINE} Se renueva el 3-dic-2026.`,
  )
  expect(text(base({ state: 'none' }, { kind: 'CONTRACT' }))).toBe(PLAN_LINE)
})

it('no price and no card: with origin.price, origin.discount (D5) and paymentMethod filled, none of their digits is in the text', () => {
  const money = {
    price: { base: 999, gross: 1158.84, currency: 'MXN' as const },
    paymentMethod: { brand: 'visa', last4: '4242', expMonth: 7, expYear: 2031 },
  }
  const discount = { gross: 699.3, percentOff: 30, duration: 'repeating' as const, endsAt: D('2027-01-15') }
  const digits = ['999', '1158', '1,158', '84', '699', '30', '4242', '2031', '2027', '15-ene']
  for (const [state, expected] of [
    [base(money, { price: money.price, discount, currentPeriodEnd: D('2026-12-03') }), `${PLAN_LINE} Se renueva el 3-dic-2026.`],
    [base(money, { price: money.price, discount: { ...discount, duration: 'forever', endsAt: null } }), PLAN_LINE],
    [
      base({ ...money, state: 'none' }, { kind: 'CONTRACT', price: money.price, currentPeriodEnd: D('2026-12-03') }),
      `${PLAN_LINE} Se renueva el 3-dic-2026.`,
    ],
  ] as const) {
    const shown = text(state)
    expect(shown).toBe(expected)
    expect(digits.filter(d => shown.includes(d))).toEqual([])
    expect(shown).not.toMatch(/\$|IVA|visa|tarjeta|descuento/i)
  }
})

it('a COMP origin with firstChargeAt (D3) says the same courtesy sentence: the field adds nothing to the text', () => {
  const courtesy = { kind: 'COMP' as const, currentPeriodEnd: D('2026-11-30') }
  expect(text(base({ state: 'trial' }, { ...courtesy, firstChargeAt: D('2026-11-30') }))).toBe(text(base({ state: 'trial' }, courtesy)))
  expect(text(base({ state: 'trial' }, { ...courtesy, firstChargeAt: D('2026-11-30') }))).toBe(
    `${PLAN_LINE} Tu plan Pro es de cortesía hasta el 30-nov-2026.`,
  )
})

it('the order of the panel: what blocks the plan is said before when it ends or renews', () => {
  const ends = { cancelAt: D('2026-12-03'), currentPeriodEnd: D('2026-12-03') }
  // fundador antes que todo, también con un pago pendiente
  expect(text(base({ grandfathered: true, state: 'suspended' }, ends))).toMatch(/es fundador/)
  expect(text(base({ grandfathered: true }, { kind: 'NONE', tier: null }))).toMatch(/es fundador/)
  // un plan clásico en pausa o con el cobro fallido lo dice aunque iba a terminar o a renovarse
  expect(text(base({ state: 'suspended' }, ends))).toMatch(/Tu pago está pendiente/)
  expect(text(base({ state: 'past_due', gracePeriodEndsAt: D('2026-11-16') }, { currentPeriodEnd: D('2026-12-03') }))).toMatch(
    /antes del 16-nov-2026/,
  )
  // un contrato con un problema de pago lo dice aunque deja de renovarse
  expect(text(base({ state: 'none' }, { kind: 'CONTRACT', paymentIssue: 'REFUND', ...ends }))).toMatch(/devolución o disputa/)
  // la pausa y el pago pendiente son del plan clásico: una cortesía o un contrato dicen lo suyo
  expect(text(base({ state: 'past_due', gracePeriodEndsAt: D('2026-11-16') }, { kind: 'COMP', currentPeriodEnd: D('2026-11-30') }))).toBe(
    `${PLAN_LINE} Tu plan Pro es de cortesía hasta el 30-nov-2026.`,
  )
  expect(text(base({ state: 'suspended' }, { kind: 'CONTRACT', currentPeriodEnd: D('2026-12-03') }))).toBe(
    `${PLAN_LINE} Se renueva el 3-dic-2026.`,
  )
  // un problema de pago es de un contrato: en un plan clásico no se lee
  expect(text(base({}, { paymentIssue: 'DISPUTE', currentPeriodEnd: D('2026-12-03') }))).toBe(`${PLAN_LINE} Se renueva el 3-dic-2026.`)
})

it('the dates are calendar days in the zone of the venue, not of UTC', () => {
  // 05:30 UTC del 17 son las 23:30 del 16 en la CDMX y las 00:30 del 17 en Cancún
  const late = base({ state: 'past_due', gracePeriodEndsAt: '2026-11-17T05:30:00.000Z' })
  expect(text(late)).toMatch(/antes del 16-nov-2026 /)
  expect(text(late, { ...scope, timezone: 'America/Cancun' })).toMatch(/antes del 17-nov-2026 /)
  expect(text(base({}, { currentPeriodEnd: '2026-12-01T05:59:00.000Z' }))).toBe(`${PLAN_LINE} Se renueva el 30-nov-2026.`)
})

it('a venue named like a card number is omitted, and nothing else of the database is printed', () => {
  const poisoned = { ...scope, venueName: 'Corte 4111/1111/1111/1111' }
  expect(text(base({}, { currentPeriodEnd: D('2026-12-03') }), poisoned)).toBe(
    `Plan de ${SUPPORT_DATA_OMITTED} (corte 14:32): Pro. Se renueva el 3-dic-2026.`,
  )
  expect(text(base({ state: 'none' }, { kind: 'NONE', tier: null }), poisoned)).toBe(
    `${SUPPORT_DATA_OMITTED} (corte 14:32): Tu negocio está en el plan Gratis.`,
  )
  // el nombre del plan, el id de la suscripción o del contrato y el código del problema nunca salen
  expect(
    text(
      base(
        { planName: 'Plan Avoqado Pro 99999999', stripeSubscriptionId: 'sub_1Abc' },
        { subscriptionId: 'sub_1Abc', contractId: 'ckq7z1x2y0000abcd1234efgh', currentPeriodEnd: D('2026-12-03') },
      ),
    ),
  ).toBe(`${PLAN_LINE} Se renueva el 3-dic-2026.`)
})

/**
 * T-F16 · el Plan Básico, como lo decide el panel (`basicNotice` en planActions.ts y `PlanRow.tsx`, DASHBOARD 760a1c91):
 * - un contrato del Básico (`basicPlan`) le gana a la oferta y a la prueba que termina sin cobrar; con el plan en Gratis, la píldora de
 *   «Tu plan actual» es el Básico, con su nombre (`plan.basic.current` / `currentNoPrice`), y si hoy no da acceso lo dice (`inactive`);
 * - una prueba de Pro que termina sin cobrar (`trialModality: 'ENDS_FREE'`) con un Básico publicado cambia la frase de sus fechas por
 *   «Tu prueba termina el…» (`plan.basic.trialEnds`), después de lo que frena el plan;
 * - un plan de pago vivo sigue siendo «Tu plan actual» aunque haya un Básico; el fundador, antes que todo.
 * Nunca el precio (`basicPlan.price`, `basicOffer.price`): la B no da precios (diseño de la B, «Montos»). Los Básicos vencidos no llegan:
 * `getPlanState` sólo lee contratos sin terminar, así que la B dice Gratis, como el panel.
 */
describe('T-F16: the Plan Básico, as the panel says it', () => {
  const PRICE = { base: 499, gross: 578.84, currency: 'MXN' as const }
  const OFFER = { availableAt: null, price: PRICE, canEndProNow: false, discountEndsAt: null }
  const NONE = { kind: 'NONE' as const, tier: null }
  const basic = (active: boolean, name = 'Básico') => ({ basicPlan: { active, name, price: PRICE } })
  const noPrice = (shown: string) => expect(shown).not.toMatch(/\$|IVA|499|578|Gratis|contratar/i)

  it('a Básico that gives access today: the plan line says its name, without its price', () => {
    const shown = text(base({ state: 'none', ...basic(true) }, NONE))
    expect(shown).toBe('Plan de Flautas Coyoacán (corte 14:32): Básico.')
    noPrice(shown)
  })

  it('a Básico that gives no access today says so (the panel: «Tu Básico no da acceso hoy»)', () => {
    const shown = text(base({ state: 'none', ...basic(false) }, NONE))
    expect(shown).toBe('Plan de Flautas Coyoacán (corte 14:32): Básico. Tu Básico no da acceso hoy: revisa tus contrataciones en el panel.')
    noPrice(shown)
  })

  // T-F19 (Codex 1): el nombre de la publicación puede traer el precio y pasaba el cotejo como texto. La B dice la etiqueta fija.
  it('the B says the fixed label «Básico», never the name of its publication, which can carry its price', () => {
    for (const name of ['Básico $499 + IVA', 'Básico Estética', 'Básico 5512345678']) {
      const on = text(base({ state: 'none', ...basic(true, name) }, NONE))
      expect(on).toBe('Plan de Flautas Coyoacán (corte 14:32): Básico.')
      noPrice(on)
      const off = text(base({ state: 'none', ...basic(false, name) }, NONE))
      expect(off).toBe('Plan de Flautas Coyoacán (corte 14:32): Básico. Tu Básico no da acceso hoy: revisa tus contrataciones en el panel.')
      noPrice(off)
    }
  })

  // T-F19b: el candado revisa sólo lo que pone el plan; el nombre de la sucursal es un negocio, no un precio.
  it('a venue named «Tacos a 10 pesos» gets its plan as always: its name and «Básico»', () => {
    const at = { ...scope, venueName: 'Tacos a 10 pesos' }
    expect(text(base({ state: 'none', ...basic(true, 'Básico $499 + IVA') }, NONE), at)).toBe(
      'Plan de Tacos a 10 pesos (corte 14:32): Básico.',
    )
    expect(text(base({}, { currentPeriodEnd: D('2026-12-03') }), { ...scope, venueName: 'Café $ MXN IVA' })).toBe(
      'Plan de Café $ MXN IVA (corte 14:32): Pro. Se renueva el 3-dic-2026.',
    )
    expect(text(base({ state: 'none' }, NONE), at)).toBe('Tacos a 10 pesos (corte 14:32): Tu negocio está en el plan Gratis.')
  })

  it('withoutPrice: a currency sign or a money word in a text of the plan throws; the same inside the venue name does not', () => {
    const rendered = (venue: string, plan: string) => {
      const t = template(scope.timezone)
      return t.done(`Plan de ${t.text(venue)} (corte ${t.time(scope.now)}): ${plan}.`)
    }
    for (const plan of ['Básico $499', 'Básico ＄499', 'Básico 499 MXN', 'Básico + IVA', 'Básico de 499 pesos', 'Básico M\u200bXN'])
      expect(() => withoutPrice(rendered('Flautas Coyoacán', plan), 'Flautas Coyoacán')).toThrow()
    expect(withoutPrice(rendered('Tacos $10 pesos', 'Básico'), 'Tacos $10 pesos').text).toBe(
      'Plan de Tacos $10 pesos (corte 14:32): Básico.',
    )
    expect(withoutPrice(rendered('Viva Coyoacán', 'Pro'), 'Viva Coyoacán').text).toBe('Plan de Viva Coyoacán (corte 14:32): Pro.')
  })

  it('without a Básico (none, or one that already ended): Gratis as today, even with the Básico offered', () => {
    const today = 'Flautas Coyoacán (corte 14:32): Tu negocio está en el plan Gratis.'
    expect(text(base({ state: 'none' }, NONE))).toBe(today)
    expect(text(base({ state: 'none', basicPlan: null, basicOffer: OFFER }, NONE))).toBe(today)
    // una prueba que termina sin cobrar sin plan vivo: el panel no enseña su renglón
    expect(text(base({ state: 'none', trialModality: 'ENDS_FREE', basicOffer: OFFER }, NONE))).toBe(today)
  })

  it('the founder comes first, also with a Básico', () => {
    expect(text(base({ grandfathered: true, ...basic(true) }, NONE))).toBe(
      'Flautas Coyoacán (corte 14:32): Tu negocio es fundador: tienes todas las funciones sin costo.',
    )
  })

  it('a live paid plan stays «Tu plan actual» with a Básico on top: the B says that plan', () => {
    expect(text(base(basic(true), { currentPeriodEnd: D('2026-12-03') }))).toBe(`${PLAN_LINE} Se renueva el 3-dic-2026.`)
    // un contrato del Básico le gana a la prueba que termina sin cobrar (basicNotice lo revisa primero)
    expect(
      text(
        base(
          { state: 'trial', trialModality: 'ENDS_FREE', trialEndsAt: D('2026-12-01'), basicOffer: OFFER, ...basic(true) },
          { cancelAt: D('2026-12-01'), currentPeriodEnd: D('2026-12-01') },
        ),
      ),
    ).toBe(`${PLAN_LINE} Tu plan Pro sigue activo hasta el 1-dic-2026; después pasas a Gratis.`)
  })

  it('a Pro trial that ends without a charge, with the Básico published: «Tu prueba termina…», without its price', () => {
    const trial = (s: Partial<PlanState> = {}, o: Partial<PlanOrigin> = {}) =>
      base(
        { state: 'trial', trialModality: 'ENDS_FREE', trialEndsAt: D('2026-12-01'), basicOffer: OFFER, ...s },
        { cancelAt: D('2026-12-02'), currentPeriodEnd: D('2026-12-02'), ...o },
      )
    const shown = text(trial())
    // la fecha es la del fin de la prueba antes que la de la cancelación, como el panel
    expect(shown).toBe(`${PLAN_LINE} Tu prueba termina el 1-dic-2026. Ese día podrás contratar el Básico.`)
    expect(shown).not.toMatch(/\$|IVA|499|578/)
    expect(text(trial({ trialEndsAt: null }))).toBe(`${PLAN_LINE} Tu prueba termina el 2-dic-2026. Ese día podrás contratar el Básico.`)
    expect(text(trial({ trialEndsAt: null }, { cancelAt: null, currentPeriodEnd: null }))).toBe(
      `${PLAN_LINE} Cuando termine tu prueba podrás contratar el Básico.`,
    )
    // también sobre una cortesía (el panel lo revisa antes que la cortesía)
    expect(text(trial({ trialEndsAt: null }, { kind: 'COMP', cancelAt: null, currentPeriodEnd: D('2026-11-30') }))).toBe(
      `${PLAN_LINE} Tu prueba termina el 30-nov-2026. Ese día podrás contratar el Básico.`,
    )
    // sin un Básico publicado: lo de siempre, sin prometer el Básico
    expect(text(trial({ basicOffer: null }))).toBe(`${PLAN_LINE} Tu plan Pro sigue activo hasta el 2-dic-2026; después pasas a Gratis.`)
    expect(text(trial({ trialModality: 'RENEWS_AS_PRO' }, { cancelAt: null }))).toBe(`${PLAN_LINE} Tu primer cobro será el 2-dic-2026.`)
  })

  it('what blocks the plan is said before the end of the trial, as the panel', () => {
    const ends = { state: 'trial' as const, trialModality: 'ENDS_FREE' as const, basicOffer: OFFER, trialEndsAt: D('2026-12-01') }
    expect(text(base({ ...ends, state: 'suspended' }))).toMatch(/Tu pago está pendiente/)
    expect(text(base({ ...ends, state: 'past_due' }))).toMatch(/No pudimos cobrar tu plan/)
    expect(text(base({ ...ends, state: 'none' }, { kind: 'CONTRACT', paymentIssue: 'DISPUTE' }))).toMatch(/devolución o disputa/)
  })
})

const request = (day: DataRequest['day'], otherVenue = false): DataRequest => ({
  capability: 'plan_status',
  day,
  amount: null,
  time: null,
  otherVenue,
})

it('the catalog row: the texts, the permissions and the role of the panel page, without a plan gate', () => {
  expect({ ...planStatus, params: undefined, read: undefined, render: undefined }).toEqual({
    key: 'plan_status',
    label: 'el estado de tu plan',
    object: 'el estado del plan',
    aiHint:
      'Cómo está el plan de Avoqado de la sucursal: cuál tiene, si se renueva, si hay un pago pendiente o si está por terminar. Sin precios.',
    permissions: ['billing:read', 'billing:subscriptions:read'],
    roles: ['ADMIN', 'OWNER'],
    params: undefined,
    read: undefined,
    render: undefined,
  })
})

it('params never refuses: any day is the plan of today', () => {
  for (const day of [null, 'today', 'yesterday', 'other'] as const)
    expect(planStatus.params(request(day), '¿Cómo está mi plan?', scope)).toEqual({ ok: true, value: {} })
})

it('read asks the panel for the plan of the venue of the scope, without the pause offer and with Stripe bounded', async () => {
  const state = base({}, { currentPeriodEnd: D('2026-12-03') })
  ;(getPlanState as jest.Mock).mockResolvedValueOnce(state)
  // B4: el estado, más el nombre de cada plan de la versión vigente
  expect(await planStatus.read(scope, {})).toEqual({ ...state, nombres: { FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' } })
  expect(getPlanState).toHaveBeenCalledWith(scope.venueId, { skipPauseOffer: true, stripeTimeoutMs: 3000 })
})

it('render is renderPlan', () => {
  const state = base({ state: 'trial' }, { currentPeriodEnd: D('2026-11-20') })
  expect(planStatus.render(scope, {}, state)).toEqual(renderPlan(scope, state))
})
