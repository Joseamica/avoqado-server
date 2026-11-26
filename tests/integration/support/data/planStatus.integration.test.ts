/**
 * C5 · «Estado del plan» (la B): lo que dice «Tu plan» en Facturación › Suscripciones del panel, leído con el MISMO servicio
 * (`getPlanState`, el de `GET /venues/:venueId/plan`). Postgres de verdad (la base de la nube); Stripe nunca se llama:
 * `retrievePlanSubscription` es de mentira en cada prueba que tiene suscripción. Lo que vale para toda capacidad (venenos, logs, datos
 * ajenos, candados) lo prueba el barrido (`sweeps.integration.test.ts`). Las fechas son relativas al reloj de la prueba, y se escriben
 * a mano desde el día de la sucursal (no con `fmtDate`), para que un día de UTC no pase.
 */
import type { Request, Response } from 'express'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as stripeService from '@/services/stripe.service'
import { getVenuePlan } from '@/controllers/dashboard/venue.dashboard.controller'
import { getPlanState, type PlanState } from '@/services/dashboard/planState.service'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { planStatus } from '@/services/support/data/capabilities/planStatus'
import { DATA_CAPABILITIES, dataCatalog, type DataCatalog, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { fmtTime } from '@/services/support/data/format'
import { supportDataNoPermission } from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import { seedDataFixture, seedPlanRow, spyLogger, spyQueries, type DataFixture } from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const DAY = 86_400_000
/** La pantalla del panel: `billing:read` y `billing:subscriptions:read`, dentro de `AdminProtectedRoute` (ADMIN). */
const GRANT = { permissions: ['billing:read', 'billing:subscriptions:read'], role: 'ADMIN' as const }
const REQUEST: DataRequest = { capability: 'plan_status', day: null, amount: null, time: null, otherVenue: false }
const MESSAGE = '¿Cómo está mi plan de Avoqado?'
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
/** '16-nov-2026', desde el día de la sucursal: escrito aquí aparte, no con el formato del código. */
const civil = (d: Date, timezone = CDMX) => {
  const [y, m, day] = formatInTimeZone(d, timezone, 'yyyy-MM-dd').split('-').map(Number)
  return `${day}-${MONTHS[m - 1]}-${y}`
}
const inDays = (now: Date, days: number) => new Date(now.getTime() + days * DAY)
/** Las 23:30 de la sucursal, `days` días después de hoy: en UTC ya es el día siguiente. */
const lateOn = (now: Date, days: number) => fromZonedTime(`${formatInTimeZone(inDays(now, days), CDMX, 'yyyy-MM-dd')}T23:30:00`, CDMX)

type StripeSub = Awaited<ReturnType<typeof stripeService.retrievePlanSubscription>>
/** Lo que contesta Stripe de una suscripción mensual al corriente, con 60 días de antigüedad, sin cupón ni pausa. */
const stripeSub = (now: Date, over: Partial<StripeSub> = {}): StripeSub => ({
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: inDays(now, 10),
  createdAt: inDays(now, -60),
  hasActiveDiscount: false,
  pausedUntil: null,
  interval: 'month',
  grossAmountCents: 115884,
  descuento: null,
  // Planes editables (B2, Task 7): una suscripción de hoy, no una prueba sin tarjeta.
  sinTarjeta: false,
  trialEnd: null,
  noHabraCobro: false,
  ...over,
})
const stripeAnswers = (sub: StripeSub) => jest.spyOn(stripeService, 'retrievePlanSubscription').mockResolvedValue(sub)
let serial = 0
/** `VenueFeature.stripeSubscriptionId` es único en toda la base. */
const subId = () => `sub_c5_${Date.now()}_${++serial}`

let f: DataFixture
beforeAll(async () => {
  f = await seedDataFixture('support-data-plan')
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset() // borra también las filas del plan de las sucursales de la persona
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await prisma.venueFeature.deleteMany({ where: { venueId: { in: [f.siblingId, f.foreignId] } } })
  await f.grant(GRANT)
  await f.unlock()
})
afterEach(() => jest.restoreAllMocks())

/** La pregunta por el orquestador, con el reloj de verdad (el desbloqueo es de hoy). */
const ask = async (now = new Date(), catalog: DataCatalog = DATA_CAPABILITIES) =>
  prepareDataAnswer({ conversation: await f.conversation(), request: REQUEST, message: MESSAGE, now }, catalog)
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`plan_status: ${out.text}`)
  return out.envelope.text
}
const planLine = (now: Date, tier = 'Pro') => `Plan de Norte (corte ${fmtTime(now, CDMX)}): ${tier}.`
const venueLine = (now: Date) => `Norte (corte ${fmtTime(now, CDMX)}):`
const scopeFor = (venueId = f.northId, now = new Date()): DataScope => ({
  venueId,
  organizationId: f.orgId,
  venueName: 'Norte',
  timezone: CDMX,
  day: venueDayKey(now, CDMX),
  kycVerified: true,
  now,
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
})
/** Lo que el logger recibió, con el mensaje de cada Error (JSON.stringify no lo trae solo). */
const logged = (args: unknown[]) =>
  JSON.stringify(args, (_key, value: unknown) => (value instanceof Error ? { name: value.name, message: value.message } : value))

it("a MANAGER with billing:subscriptions:read is refused (supportDataNoPermission('el estado del plan')) and an ADMIN gets the sentence (case 8)", async () => {
  const end = inDays(new Date(), 20)
  await seedPlanRow(f.northId, { endDate: end })
  const read = jest.fn(planStatus.read)
  const catalog = dataCatalog({ ...planStatus, read })
  for (const grant of [
    { permissions: ['billing:read', 'billing:subscriptions:read'], role: 'MANAGER' as const },
    { permissions: ['billing:subscriptions:read'], role: 'MANAGER' as const },
    // El puesto sin la pantalla de suscripciones
    { permissions: ['billing:read'], role: 'ADMIN' as const },
  ]) {
    await f.grant(grant)
    expect([grant, await ask(undefined, catalog)]).toMatchObject([
      grant,
      { kind: 'refusal', text: supportDataNoPermission('el estado del plan'), log: { result: 'NO_PERMISSION', capability: 'plan_status' } },
    ])
  }
  expect(read).not.toHaveBeenCalled()
  for (const role of ['ADMIN', 'OWNER'] as const) {
    await f.grant({ ...GRANT, role })
    const now = new Date()
    expect([role, answered(await ask(now, catalog))]).toEqual([role, `${planLine(now)} Tu plan Pro es de cortesía hasta el ${civil(end)}.`])
  }
  expect(read).toHaveBeenCalledTimes(2)
})

it('with skipPauseOffer, an active classic plan without discount or pause reads no ActivityLog and the plan rows once; without the option the panel still reads both (case 22)', async () => {
  const now = new Date()
  await seedPlanRow(f.northId, { stripeSubscriptionId: subId() })
  stripeAnswers(stripeSub(now))
  const reads = async (plan: () => Promise<PlanState>) => {
    const spy = spyQueries()
    try {
      const state = await plan()
      const of = (model: string) => spy.calls.filter(call => call.model === model).length
      return { pauseOfferEligible: state.pauseOfferEligible, ActivityLog: of('ActivityLog'), VenueFeature: of('VenueFeature') }
    } finally {
      spy.restore()
    }
  }
  expect(await reads(() => getPlanState(f.northId, { skipPauseOffer: true }))).toEqual({
    pauseOfferEligible: false,
    ActivityLog: 0,
    VenueFeature: 1,
  })
  // La lectura de la capacidad, igual
  expect(await reads(() => planStatus.read(scopeFor(), {}))).toEqual({ pauseOfferEligible: false, ActivityLog: 0, VenueFeature: 1 })
  // El panel, sin la opción: la oferta de pausa sigue leyendo el plan base (otra vez las filas del plan) y la pausa anterior
  expect(await reads(() => getPlanState(f.northId))).toEqual({ pauseOfferEligible: true, ActivityLog: 1, VenueFeature: 2 })
})

it('parity: read gives what GET /plan gives the panel, without the pause offer; only the B asks Stripe with its bound; the fields it receives are a closed list', async () => {
  const now = new Date()
  const id = subId()
  await seedPlanRow(f.northId, { stripeSubscriptionId: id, monthlyPrice: 999 })
  const stripe = stripeAnswers(stripeSub(now, { cancelAtPeriodEnd: true }))
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  await getVenuePlan({ params: { venueId: f.northId } } as unknown as Request<{ venueId: string }>, res as unknown as Response, next)
  expect(next).not.toHaveBeenCalled()
  const panel = (res.json.mock.calls[0][0] as { data: PlanState }).data
  const b = await planStatus.read(scopeFor(), {})
  expect(b).toEqual({ ...panel, pauseOfferEligible: false })
  expect(panel.state).toBe('canceling')
  expect(stripe.mock.calls).toEqual([[id], [id, { timeoutMs: 3000 }]])
  // Lista cerrada: un campo nuevo de «Tu plan» (una tarjeta, otro precio) truena aquí y se revisa antes de que llegue a la capacidad
  // develop (Plan Básico, #484) suma basicOffer, basicPlan y trialModality: llegan a la lectura, renderPlan no los imprime (ni precios)
  expect(Object.keys(b).sort()).toEqual([
    'basicOffer',
    'basicPlan',
    'cancelAtPeriodEnd',
    'currentPeriodEnd',
    'gracePeriodEndsAt',
    'grandfathered',
    'hasPlan',
    'interval',
    'origin',
    'pauseOfferEligible',
    'paymentMethod',
    'planName',
    'planTier',
    'price',
    'retentionOfferEligible',
    'state',
    'stripeSubscriptionId',
    'suspendedAt',
    'trialEndsAt',
    'trialModality',
  ])
  expect(Object.keys(b.origin ?? {}).sort()).toEqual([
    'cancelAt',
    'contractId',
    'contractRevision',
    'currentPeriodEnd',
    'discount',
    'interval',
    'kind',
    'paymentIssue',
    'price',
    'subscriptionId',
    'tier',
  ])
  expect(answered(await ask(now))).toBe(
    `${planLine(now)} Tu plan Pro sigue activo hasta el ${civil(inDays(now, 10))}; después pasas a Gratis.`,
  )
})

type PlanRow = Parameters<typeof seedPlanRow>[1]
/** Cada estado que enseña «Tu plan», sembrado en la base y leído por el orquestador: la frase de la B y su nivel. */
const STATES: [string, (now: Date) => { row?: PlanRow; sub?: StripeSub; tier?: string; sentence: string }][] = [
  [
    'a paid plan renews',
    now => ({ row: { stripeSubscriptionId: subId() }, sub: stripeSub(now), sentence: `Se renueva el ${civil(inDays(now, 10))}.` }),
  ],
  [
    'a Premium plan says Premium',
    now => ({
      row: { code: 'PLAN_PREMIUM', stripeSubscriptionId: subId() },
      sub: stripeSub(now),
      tier: 'Premium',
      sentence: `Se renueva el ${civil(inDays(now, 10))}.`,
    }),
  ],
  [
    'a plan cancelled at period end keeps it until then',
    now => ({
      row: { stripeSubscriptionId: subId() },
      sub: stripeSub(now, { cancelAtPeriodEnd: true }),
      sentence: `Tu plan Pro sigue activo hasta el ${civil(inDays(now, 10))}; después pasas a Gratis.`,
    }),
  ],
  [
    'a trial with a card says its first charge, never «Se renueva»',
    now => ({
      row: { endDate: inDays(now, 5), stripeSubscriptionId: subId() },
      sub: stripeSub(now, { status: 'trialing', currentPeriodEnd: inDays(now, 5) }),
      sentence: `Tu primer cobro será el ${civil(inDays(now, 5))}.`,
    }),
  ],
  [
    'D4: the first charge after a trial failed: 4 days of grace, until that day of the venue',
    now => ({
      row: { endDate: lateOn(now, 4), gracePeriodEndsAt: lateOn(now, 4), stripeSubscriptionId: subId() },
      sub: stripeSub(now, { status: 'past_due', currentPeriodEnd: inDays(now, -1) }),
      sentence: `No pudimos cobrar tu plan. Actualiza tu método de pago antes del ${civil(lateOn(now, 4))} para no perderlo.`,
    }),
  ],
  [
    'D6: one who already paid: 7 days of grace',
    now => ({
      row: { gracePeriodEndsAt: lateOn(now, 7), stripeSubscriptionId: subId() },
      sub: stripeSub(now, { status: 'past_due' }),
      sentence: `No pudimos cobrar tu plan. Actualiza tu método de pago antes del ${civil(lateOn(now, 7))} para no perderlo.`,
    }),
  ],
  [
    'D4: the 4 days are over: the paid access is paused',
    now => ({
      row: { endDate: inDays(now, -0.05), gracePeriodEndsAt: inDays(now, -0.05), stripeSubscriptionId: subId() },
      sub: stripeSub(now, { status: 'past_due' }),
      sentence: 'Tu pago está pendiente y el acceso de pago está en pausa. Actualiza tu método de pago para recuperarlo.',
    }),
  ],
  [
    'suspended after the last attempt',
    now => ({
      row: { suspendedAt: inDays(now, -1), stripeSubscriptionId: subId() },
      sub: stripeSub(now, { status: 'unpaid' }),
      sentence: 'Tu pago está pendiente y el acceso de pago está en pausa. Actualiza tu método de pago para recuperarlo.',
    }),
  ],
  [
    'a courtesy until a day',
    now => ({ row: { endDate: inDays(now, 20) }, sentence: `Tu plan Pro es de cortesía hasta el ${civil(inDays(now, 20))}.` }),
  ],
  ['a courtesy without an end', () => ({ row: {}, sentence: 'Tu plan Pro es de cortesía.' })],
]

it.each(STATES)('%s', async (_name, build) => {
  const now = new Date()
  const { row, sub, tier, sentence } = build(now)
  if (row) await seedPlanRow(f.northId, row)
  if (sub) stripeAnswers(sub)
  expect(answered(await ask(now))).toBe(`${planLine(now, tier)} ${sentence}`)
})

it('no plan row, or a courtesy that already ended: Gratis, starting with the venue', async () => {
  const now = new Date()
  expect(answered(await ask(now))).toBe(`${venueLine(now)} Tu negocio está en el plan Gratis.`)
  await seedPlanRow(f.northId, { endDate: inDays(now, -2) })
  expect(answered(await ask(now))).toBe(`${venueLine(now)} Tu negocio está en el plan Gratis.`)
})

it('a venue whose organization is a founder says so: the flag comes through the venue, never by the organization id', async () => {
  const now = new Date()
  await seedPlanRow(f.northId, { stripeSubscriptionId: subId() })
  stripeAnswers(stripeSub(now))
  await prisma.organization.update({ where: { id: f.orgId }, data: { seatCapExempt: true } })
  try {
    expect(answered(await ask(now))).toBe(`${venueLine(now)} Tu negocio es fundador: tienes todas las funciones sin costo.`)
  } finally {
    await prisma.organization.update({ where: { id: f.orgId }, data: { seatCapExempt: false } })
  }
})

it('Stripe does not answer: the plan line without a date; its message reaches neither the text, the log row nor the logger (case 21)', async () => {
  const poison = 'sk_live_VENENO_51Hx cus_VENENO'
  // Un plan pagado y una prueba con tarjeta: los dos sin fecha, y la prueba nunca dice «Se renueva»
  for (const trial of [false, true]) {
    const now = new Date()
    const id = subId()
    await seedPlanRow(f.northId, { stripeSubscriptionId: id, ...(trial ? { endDate: inDays(now, 5) } : {}) })
    const stripe = jest
      .spyOn(stripeService, 'retrievePlanSubscription')
      .mockRejectedValue(
        Object.assign(new Error(`Request aborted due to timeout being reached (3000ms) ${poison}`), { type: 'StripeConnectionError' }),
      )
    const log = spyLogger()
    const out = await ask(now)
    const loggerArgs = logged(log.args())
    log.restore()
    expect([trial, answered(out)]).toEqual([trial, planLine(now)])
    expect(out).toMatchObject({ log: { result: 'ANSWERED', capability: 'plan_status' } })
    expect(JSON.stringify(out)).not.toContain('VENENO')
    // La degradación sí se registra (con el nombre del error), pero sin su mensaje
    expect({ registraElTipo: loggerArgs.includes('StripeConnectionError'), registraElMensaje: loggerArgs.includes('VENENO') }).toEqual({
      registraElTipo: true,
      registraElMensaje: false,
    })
    expect(stripe).toHaveBeenCalledWith(id, { timeoutMs: 3000 })
    jest.restoreAllMocks()
  }
})

it('the panel, with no options, keeps its warn as today: the whole Stripe message, without the type of the B', async () => {
  const id = subId()
  await seedPlanRow(f.northId, { stripeSubscriptionId: id })
  const message = 'Request aborted due to timeout being reached (80000ms)'
  jest
    .spyOn(stripeService, 'retrievePlanSubscription')
    .mockRejectedValue(Object.assign(new Error(message), { type: 'StripeConnectionError' }))
  const warn = jest.spyOn(logger, 'warn')
  await getPlanState(f.northId)
  const degraded = 'getPlanState: failed to retrieve Stripe subscription; degrading to nulls'
  expect((warn.mock.calls as unknown[][]).filter(([text]) => text === degraded)).toEqual([
    [degraded, { venueId: f.northId, subscriptionId: id, error: message }],
  ])
})

it('a plan row never comes in through grant: PLAN_PRO and PLAN_PREMIUM as features are refused; they enter only through seedPlanRow', async () => {
  for (const code of ['PLAN_PRO', 'PLAN_PREMIUM'])
    await expect(f.grant({ ...GRANT, features: [code] })).rejects.toThrow(
      `grant: ${code} es la fila del plan de Avoqado; siémbrala con seedPlanRow`,
    )
  const venues = [f.northId, f.cancunId, f.emptyId]
  expect(
    await prisma.venueFeature.count({ where: { venueId: { in: venues }, feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } } } }),
  ).toBe(0)
})

it('the plan of another venue never answers for this one: Norte without a plan says Gratis while its sister and a foreign venue have Premium', async () => {
  for (const venueId of [f.siblingId, f.foreignId]) await seedPlanRow(venueId, { code: 'PLAN_PREMIUM', endDate: inDays(new Date(), 30) })
  const now = new Date()
  expect(answered(await ask(now))).toBe(`${venueLine(now)} Tu negocio está en el plan Gratis.`)
  // Control positivo: la hermana, leída con su alcance, sí es Premium
  const sister = await planStatus.read(scopeFor(f.siblingId, now), {})
  expect(sister.origin).toMatchObject({ kind: 'COMP', tier: 'PREMIUM' })
  const rendered = planStatus.render({ ...scopeFor(f.siblingId, now), venueName: 'Hermana' }, {}, sister)
  expect(checkRendered(rendered, CDMX)).toBe(true)
  expect(rendered.text).toMatch(/^Plan de Hermana \(corte \d{2}:\d{2}\): Premium\. Tu plan Premium es de cortesía hasta el /)
})
