import type Stripe from 'stripe'
import { PlanRenewalReminderJob, TOPE_PRUEBAS, diasParaAvisar } from '@/jobs/plan-renewal-reminder.job'
import { montoDelSiguienteCobro, noHabraCobro } from '@/services/billing/siguienteCobro'
import logger from '@/config/logger'
import { retry } from '@/utils/retry'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'
import { getPlanState } from '@/services/dashboard/planState.service'

// Make retry transparent: just invoke the wrapped fn (deterministic, no backoff).
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: jest.fn((fn: () => unknown) => fn()),
  shouldRetryDbConnectionError: jest.fn(),
}))

// Stripe is constructed at module load (`new Stripe(...)`). Mock the constructor so
// `stripe.subscriptions.retrieve` and `stripe.invoices.createPreview` are controllable jest fns.
// The fns are created INSIDE the factory (jest hoists the factory above imports) and re-exposed
// on the mock constructor so the test body can drive them.
jest.mock('stripe', () => {
  const retrieve = jest.fn()
  const createPreview = jest.fn()
  const ctor = jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve },
    invoices: { createPreview },
  })) as jest.Mock & { __retrieve: jest.Mock; __createPreview: jest.Mock }
  ctor.__retrieve = retrieve
  ctor.__createPreview = createPreview
  return ctor
})

const stripeMock = require('stripe') as jest.Mock & { __retrieve: jest.Mock; __createPreview: jest.Mock }
const mockRetrieve = stripeMock.__retrieve
const mockCreatePreview = stripeMock.__createPreview

jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))

jest.mock('@/services/dashboard/planState.service', () => ({
  __esModule: true,
  getPlanState: jest.fn(),
}))

const mockPrisma = prisma as unknown as {
  venueFeature: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
}

const DAY = 86400000

// A VenueFeature row as the job's findMany selects it.
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'vf1',
  venueId: 'v1',
  stripeSubscriptionId: 'sub_1',
  renewalReminderSentAt: null as Date | null,
  feature: { code: 'PLAN_PRO' },
  venue: { slug: 'bar', timezone: 'America/Monterrey' },
  ...overrides,
})

// Build a Stripe subscription stub renewing `daysOut` days from now.
const stripeSub = (daysOut: number, overrides: Record<string, unknown> = {}) => {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    status: 'active',
    current_period_start: nowSec - 22 * 24 * 3600,
    current_period_end: nowSec + Math.round(daysOut * 24 * 3600),
    items: { data: [{ price: { recurring: { interval: 'month' }, unit_amount: 115884 } }] },
    ...overrides,
  }
}

// The REAL shape the pinned API (2025-09-30.clover) returns: the period lives ONLY on the item.
const cloverSub = (daysOut: number) => {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    status: 'active',
    items: {
      data: [
        {
          current_period_start: nowSec - 22 * 24 * 3600,
          current_period_end: nowSec + Math.round(daysOut * 24 * 3600),
          price: { recurring: { interval: 'month' }, unit_amount: 115884 },
        },
      ],
    },
  }
}

describe('diasParaAvisar (0 < días < 9)', () => {
  it.each([
    [9, false],
    [8.9, true],
    [7, true],
    [3, true],
    [0, false],
    [-1, false],
  ])('%s días → %s', (dias, esperado) => {
    const now = Date.UTC(2026, 9, 17, 15)
    expect(diasParaAvisar(now + dias * DAY, now)).toBe(esperado)
  })
})

describe('noHabraCobro', () => {
  const finMs = Date.UTC(2026, 10, 16, 18)
  const finS = finMs / 1000
  const sub = (o: Record<string, unknown>) =>
    ({ cancel_at_period_end: false, cancel_at: null, pause_collection: null, ...o }) as unknown as Stripe.Subscription
  const pausa = (resumes_at: number | null) => ({ pause_collection: { behavior: 'mark_uncollectible', resumes_at } })

  it('cancel_at_period_end → true', () => expect(noHabraCobro(sub({ cancel_at_period_end: true }), finMs)).toBe(true))
  it('cancel_at exactamente al fin → true', () => expect(noHabraCobro(sub({ cancel_at: finS }), finMs)).toBe(true))
  it('cancel_at antes del fin → true', () => expect(noHabraCobro(sub({ cancel_at: finS - 1 }), finMs)).toBe(true))
  it('cancel_at después del fin → false', () => expect(noHabraCobro(sub({ cancel_at: finS + 1 }), finMs)).toBe(false))
  it('cobranza en pausa sin reanudación → true', () => expect(noHabraCobro(sub(pausa(null)), finMs)).toBe(true))
  it('pausa que reanuda justo al fin → true', () => expect(noHabraCobro(sub(pausa(finS)), finMs)).toBe(true))
  it('pausa que reanuda después del fin → true', () => expect(noHabraCobro(sub(pausa(finS + 86400)), finMs)).toBe(true))
  it('pausa que reanuda ANTES del fin → false', () => expect(noHabraCobro(sub(pausa(finS - 1)), finMs)).toBe(false))
  it('sin cancelación ni pausa → false', () => expect(noHabraCobro(sub({}), finMs)).toBe(false))
})

describe('montoDelSiguienteCobro', () => {
  const stripeCon = (createPreview: jest.Mock) => ({ invoices: { createPreview } }) as unknown as Stripe

  it('devuelve amount_due de la vista previa de la próxima factura', async () => {
    const createPreview = jest.fn().mockResolvedValue({ amount_due: 1000, total: 1000 })
    await expect(montoDelSiguienteCobro(stripeCon(createPreview), 'sub_9')).resolves.toBe(1000)
    expect(createPreview).toHaveBeenCalledWith({ subscription: 'sub_9' })
  })

  it('0 es un monto válido', async () => {
    await expect(montoDelSiguienteCobro(stripeCon(jest.fn().mockResolvedValue({ amount_due: 0 })), 'sub_9')).resolves.toBe(0)
  })

  it('la vista previa lanza → null (sin respaldo al precio de lista)', async () => {
    await expect(montoDelSiguienteCobro(stripeCon(jest.fn().mockRejectedValue(new Error('Stripe 503'))), 'sub_9')).resolves.toBeNull()
  })

  it('la vista previa no trae monto → null', async () => {
    await expect(montoDelSiguienteCobro(stripeCon(jest.fn().mockResolvedValue({})), 'sub_9')).resolves.toBeNull()
  })
})

describe('PlanRenewalReminderJob.runNow', () => {
  let sendSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockRetrieve.mockReset()
    mockCreatePreview.mockReset().mockResolvedValue({ amount_due: 115884 })
    sendSpy = jest.spyOn(emailService, 'sendPlanRenewalReminderEmail').mockResolvedValue(true)
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: 'owner@x.com',
      locale: 'es',
      venueName: 'Bar',
      ownerName: 'Ana',
    })
    mockPrisma.venueFeature.update.mockResolvedValue({})
  })

  afterEach(() => sendSpy.mockRestore())

  it('queries active PLAN_PRO and PLAN_PREMIUM features with a Stripe subscription, selecting the code and the venue timezone', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([])

    await new PlanRenewalReminderJob().runNow()

    expect(mockPrisma.venueFeature.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          stripeSubscriptionId: { not: null },
          feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
        }),
        select: expect.objectContaining({
          feature: { select: { code: true } },
          venue: { select: { slug: true, timezone: true } },
        }),
      }),
    )
  })

  // 1. NEW FEATURE TESTS
  it('active PLAN_PRO renewing in 8 days → sends the preview amount, real date, venue zone + stamps', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    const sub = stripeSub(8)
    mockRetrieve.mockResolvedValue(sub)

    await new PlanRenewalReminderJob().runNow()

    expect(mockRetrieve).toHaveBeenCalledWith('sub_1')
    expect(mockCreatePreview).toHaveBeenCalledWith({ subscription: 'sub_1' })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [to, data] = sendSpy.mock.calls[0]
    expect(to).toBe('owner@x.com')
    expect(data).toMatchObject({
      locale: 'es',
      venueName: 'Bar',
      interval: 'monthly',
      amountCents: 115884,
      planName: 'Pro',
      isTrialEnd: false,
      timeZone: 'America/Monterrey',
    })
    expect(data.renewalDate.getTime()).toBe(sub.current_period_end * 1000)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf1' },
      data: { renewalReminderSentAt: expect.any(Date) },
    })
  })

  it('trialing PLAN_PREMIUM 8 days out → isTrialEnd, planName Premium, preview amount (not the $0 trial invoice)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row({ feature: { code: 'PLAN_PREMIUM' } })])
    mockRetrieve.mockResolvedValue(
      stripeSub(8, { status: 'trialing', items: { data: [{ price: { recurring: { interval: 'month' }, unit_amount: 197084 } }] } }),
    )
    mockCreatePreview.mockResolvedValue({ amount_due: 197084 })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][1]).toMatchObject({ isTrialEnd: true, planName: 'Premium', amountCents: 197084 })
  })

  it('campaign subscription: amountCents is the preview amount_due (1000), not the list unit_amount (115884)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8))
    mockCreatePreview.mockResolvedValue({ amount_due: 1000 })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy.mock.calls[0][1]).toMatchObject({ amountCents: 1000 })
  })

  it('amount_due 0 is a valid amount → sends amountCents 0', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8))
    mockCreatePreview.mockResolvedValue({ amount_due: 0 })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][1]).toMatchObject({ amountCents: 0 })
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('maps annual interval from price.recurring.interval=year', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(
      stripeSub(8, { items: { data: [{ price: { recurring: { interval: 'year' }, unit_amount: 1158840 } }] } }),
    )
    mockCreatePreview.mockResolvedValue({ amount_due: 1158840 })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy.mock.calls[0][1]).toMatchObject({ interval: 'annual', amountCents: 1158840 })
  })

  it('empty venue timezone → America/Mexico_City (an empty string would make the date formatting throw)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row({ venue: { slug: 'bar', timezone: '' } })])
    mockRetrieve.mockResolvedValue(stripeSub(8))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy.mock.calls[0][1]).toMatchObject({ timeZone: 'America/Mexico_City' })
  })

  it('M8: invalid venue timezone ("GMT-6") → America/Mexico_City, and the reminder still goes out and stamps', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row({ venue: { slug: 'bar', timezone: 'GMT-6' } })])
    mockRetrieve.mockResolvedValue(stripeSub(8))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][1]).toMatchObject({ timeZone: 'America/Mexico_City' })
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('preview throws → no send, no stamp, batch continues; next run with a healthy preview sends', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row(), row({ id: 'vf2', venueId: 'v2', stripeSubscriptionId: 'sub_2' })])
    mockRetrieve.mockResolvedValue(stripeSub(8))
    mockCreatePreview.mockRejectedValueOnce(new Error('Stripe 503')).mockResolvedValueOnce({ amount_due: 115884 })

    await expect(new PlanRenewalReminderJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({ where: { id: 'vf2' }, data: { renewalReminderSentAt: expect.any(Date) } })

    // Next daily run: only vf1 is still pending; the preview is healthy now.
    sendSpy.mockClear()
    mockPrisma.venueFeature.update.mockClear()
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({ where: { id: 'vf1' }, data: { renewalReminderSentAt: expect.any(Date) } })
  })

  it('email returns false → no stamp; next run (email ok) sends and stamps', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8))
    sendSpy.mockResolvedValueOnce(false)

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  // Codex r2: a run that fails at 7.25 days must not lose the reminder once the charge is under 7 days away.
  it('7.25 days with a failing preview → nothing; next day (6.25) sends and stamps; third day does not resend', async () => {
    const realNow = Date.now()
    const vf = row()
    mockPrisma.venueFeature.findMany.mockResolvedValue([vf])
    mockPrisma.venueFeature.update.mockImplementation(({ data }: { data: { renewalReminderSentAt: Date } }) => {
      vf.renewalReminderSentAt = data.renewalReminderSentAt
      return Promise.resolve({})
    })
    mockRetrieve.mockResolvedValue(stripeSub(7.25))
    mockCreatePreview.mockRejectedValueOnce(new Error('Stripe 503'))
    const nowSpy = jest.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(realNow)
      await new PlanRenewalReminderJob().runNow()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(vf.renewalReminderSentAt).toBeNull()

      nowSpy.mockReturnValue(realNow + DAY)
      await new PlanRenewalReminderJob().runNow()
      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(vf.renewalReminderSentAt).toBeInstanceOf(Date)

      nowSpy.mockReturnValue(realNow + 2 * DAY)
      await new PlanRenewalReminderJob().runNow()
      expect(sendSpy).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  // 2. SKIP / EDGE CASES
  it('cancel_at_period_end at 8 days → no send, no preview, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8, { cancel_at_period_end: true }))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockCreatePreview).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('cancel_at at the period end → no send', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    const sub = stripeSub(8)
    mockRetrieve.mockResolvedValue({ ...sub, cancel_at: sub.current_period_end })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('paused collection with no resume date at 8 days → no email, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8, { pause_collection: { behavior: 'mark_uncollectible', resumes_at: null } }))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('paused collection that resumes before the period end → email sent', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    const sub = stripeSub(8)
    mockRetrieve.mockResolvedValue({
      ...sub,
      pause_collection: { behavior: 'mark_uncollectible', resumes_at: sub.current_period_end - 2 * 24 * 3600 },
    })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('two active rows on ONE subscription (PRO + PREMIUM residue) → one email per run', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row(), row({ id: 'vf2', feature: { code: 'PLAN_PREMIUM' } })])
    mockRetrieve.mockResolvedValue(stripeSub(8))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('summary log counts the rows skipped for lack of an amount (sinMonto)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row(), row({ id: 'vf2', venueId: 'v2', stripeSubscriptionId: 'sub_2' })])
    mockRetrieve.mockResolvedValue(stripeSub(8))
    mockCreatePreview.mockRejectedValueOnce(new Error('Stripe 503')).mockResolvedValueOnce({ amount_due: 115884 })

    await new PlanRenewalReminderJob().runNow()

    expect(logger.info).toHaveBeenCalledWith(
      '✅ Plan renewal reminder check complete',
      expect.objectContaining({ total: 2, sent: 1, sinMonto: 1, errors: 0 }),
    )
  })

  it('only the entry read and the stamp go through retry (never the email)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect((retry as jest.Mock).mock.calls.map(c => c[1].context)).toEqual([
      'plan-renewal-reminder.findMany',
      'plan-renewal-reminder.stamp',
      'plan-renewal-reminder.pruebasSinTarjeta.findMany',
    ])
  })

  it('renewing in ~10 days → skip (outside the 0-9 day window)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(10))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('already reminded this billing period → skip', async () => {
    // Reminder was sent AFTER current_period_start → already reminded this period.
    mockPrisma.venueFeature.findMany.mockResolvedValue([row({ renewalReminderSentAt: new Date(Date.now() - 1 * DAY) })])
    mockRetrieve.mockResolvedValue(stripeSub(8))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('reminded in a PREVIOUS period (older than current_period_start) → re-sends', async () => {
    // before current_period_start (-22d)
    mockPrisma.venueFeature.findMany.mockResolvedValue([row({ renewalReminderSentAt: new Date(Date.now() - 40 * DAY) })])
    mockRetrieve.mockResolvedValue(stripeSub(8))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('canceled/past_due subscription status → skip', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8, { status: 'past_due' }))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('null recipient → skip, no throw, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(stripeSub(8))
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: null,
      locale: 'es',
      venueName: 'Bar',
      ownerName: null,
    })

    await expect(new PlanRenewalReminderJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  // 🔴 Real defect (2026-09-27): the job read the period from the subscription, which the clover API no longer
  // carries → NaN → NaN slipped past BOTH the window and the dedup checks → a daily email saying "Invalid Date".
  it('🔴 clover shape (period only on the item): sends with the real renewal date', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    const sub = cloverSub(8)
    mockRetrieve.mockResolvedValue(sub)

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][1].renewalDate.getTime()).toBe(sub.items.data[0].current_period_end * 1000)
  })

  it('🔴 clover shape renewing in ~10 days → skip (the window still applies)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue(cloverSub(10))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('🔴 no period anywhere → skip: never an "Invalid Date" email, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row()])
    mockRetrieve.mockResolvedValue({ status: 'active', items: { data: [{ price: { recurring: { interval: 'month' } } }] } })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  // REGRESSION: one failing row must not abort the batch
  it('isolates a per-venue Stripe failure so the rest of the batch still sends', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([row(), row({ id: 'vf2', venueId: 'v2', stripeSubscriptionId: 'sub_2' })])
    mockRetrieve.mockRejectedValueOnce(new Error('Stripe 503')).mockResolvedValueOnce(stripeSub(8))

    await expect(new PlanRenewalReminderJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf2' },
      data: { renewalReminderSentAt: expect.any(Date) },
    })
  })
})

// D2 (5-nov-2026): la prueba REGALADA del SUPERADMIN («Dar días de prueba», sin Stripe) se acababa sin avisarle al negocio.
describe('PlanRenewalReminderJob.runNow — pruebas regaladas sin tarjeta', () => {
  const NOW = Date.UTC(2026, 10, 27, 15) // 27-nov, 9:00 en CDMX (la hora del cron)
  const FIN = new Date(Date.UTC(2026, 11, 5, 17, 19)) // 5-dic 11:19 CDMX: ~8.1 días
  let freeSpy: jest.SpyInstance
  let renewalSpy: jest.SpyInstance

  const prueba = (overrides: Record<string, unknown> = {}) => ({
    id: 'vf9',
    venueId: 'v9',
    endDate: FIN,
    freeTrialNoticeFor: null as Date | null,
    feature: { code: 'PLAN_PRO' },
    venue: { slug: 'taqueria-el-patio', timezone: 'America/Mexico_City', status: 'ACTIVE' },
    ...overrides,
  })
  // Lo que Facturación ve: el plan del negocio ES esta prueba de cortesía.
  const cortesia = (fin: Date, overrides: Record<string, unknown> = {}) => ({
    grandfathered: false,
    origin: { kind: 'COMP', tier: 'PRO', currentPeriodEnd: fin.toISOString() },
    ...overrides,
  })
  // La lectura de cobros (con Stripe) va vacía; la de pruebas regaladas devuelve `filas`.
  const conPruebas = (filas: unknown[]) =>
    mockPrisma.venueFeature.findMany.mockImplementation((args: { where: { stripeSubscriptionId: unknown } }) =>
      Promise.resolve(args.where.stripeSubscriptionId === null ? filas : []),
    )

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] })
    freeSpy = jest.spyOn(emailService, 'sendPlanFreeTrialEndingEmail').mockResolvedValue(true)
    renewalSpy = jest.spyOn(emailService, 'sendPlanRenewalReminderEmail').mockResolvedValue(true)
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: 'ivonne@x.com',
      locale: 'es',
      venueName: 'Taqueria El Patio',
      ownerName: 'Ivonne',
    })
    ;(getPlanState as jest.Mock).mockResolvedValue(cortesia(FIN))
    mockPrisma.venueFeature.update.mockResolvedValue({})
    mockPrisma.venueFeature.updateMany.mockResolvedValue({ count: 1 })
  })

  afterEach(() => {
    jest.useRealTimers()
    freeSpy.mockRestore()
    renewalSpy.mockRestore()
  })

  it('lee sólo planes activos sin Stripe de negocios activos, que vencen en <9 días y faltan por avisar para SU fecha, con tope', async () => {
    conPruebas([])
    await new PlanRenewalReminderJob().runNow()

    expect(mockPrisma.venueFeature.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          stripeSubscriptionId: null,
          suspendedAt: null,
          endDate: { gt: new Date(NOW), lt: new Date(NOW + 9 * DAY) },
          feature: { code: { in: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
          venue: { status: 'ACTIVE' },
          // Las ya avisadas no ocupan el tope: sin esto, 200 avisadas tapaban para siempre a la 201 (Codex r1 #2).
          AND: [
            {
              OR: [
                { freeTrialNoticeFor: null },
                { freeTrialNoticeFor: { lt: prisma.venueFeature.fields.endDate } },
                { freeTrialNoticeFor: { gt: prisma.venueFeature.fields.endDate } },
              ],
            },
          ],
        },
        orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
        take: expect.any(Number),
      }),
    )
  })

  // 1. NEW FEATURE TESTS
  it('vence en ~8 días → manda el aviso con la fecha y la zona del negocio, y sella LA FECHA sólo si sigue siendo la prueba', async () => {
    conPruebas([prueba()])
    await new PlanRenewalReminderJob().runNow()

    expect(getPlanState).toHaveBeenCalledWith('v9')
    expect(freeSpy).toHaveBeenCalledTimes(1)
    const [to, data] = freeSpy.mock.calls[0]
    expect(to).toBe('ivonne@x.com')
    expect(data).toEqual({
      locale: 'es',
      venueName: 'Taqueria El Patio',
      endDate: FIN,
      planName: 'Pro',
      timeZone: 'America/Mexico_City',
      idempotencyKey: `prueba-regalada:vf9:${FIN.toISOString()}`,
    })
    expect(renewalSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.updateMany).toHaveBeenCalledWith({
      where: { id: 'vf9', stripeSubscriptionId: null, endDate: FIN },
      data: { freeTrialNoticeFor: FIN },
    })
    // 🔴 Codex r1 #1: nunca el sello del aviso de cobro, que lo leería como «ya avisado».
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('Premium → planName Premium', async () => {
    conPruebas([prueba({ feature: { code: 'PLAN_PREMIUM' } })])
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy.mock.calls[0][1]).toMatchObject({ planName: 'Premium' })
  })

  it('zona del negocio inválida → CDMX', async () => {
    conPruebas([prueba({ venue: { slug: 'x', timezone: 'GMT-6', status: 'ACTIVE' } })])
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy.mock.calls[0][1]).toMatchObject({ timeZone: 'America/Mexico_City' })
  })

  it('vence en más de 9 días → nada (aunque la consulta la trajera)', async () => {
    const lejos = new Date(NOW + 10 * DAY)
    conPruebas([prueba({ endDate: lejos })])
    ;(getPlanState as jest.Mock).mockResolvedValue(cortesia(lejos))
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy).not.toHaveBeenCalled()
  })

  it('ya se avisó ESTA fecha → no repite al día siguiente ni el último día', async () => {
    conPruebas([prueba({ freeTrialNoticeFor: FIN })])
    for (const dias of [0, 1, 8]) {
      jest.setSystemTime(NOW + dias * DAY)
      await new PlanRenewalReminderJob().runNow()
    }
    expect(freeSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['se alargó dos días una prueba corta ya avisada', new Date(FIN.getTime() - 2 * DAY)],
    ['se acortó una prueba ya avisada', new Date(FIN.getTime() + 5 * DAY)],
  ])('%s → avisa otra vez con la fecha nueva (Codex r1 #3)', async (_caso, anunciada) => {
    conPruebas([prueba({ freeTrialNoticeFor: anunciada })])
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy).toHaveBeenCalledTimes(1)
    expect(freeSpy.mock.calls[0][1]).toMatchObject({ endDate: FIN })
  })

  it.each([
    ['tiene un plan pagado (CLASSIC)', { origin: { kind: 'CLASSIC', tier: 'PRO', currentPeriodEnd: null } }],
    ['tiene un contrato (CONTRACT)', { origin: { kind: 'CONTRACT', tier: 'PRO', currentPeriodEnd: null } }],
    ['Facturación muestra otra fila de cortesía', { origin: { kind: 'COMP', tier: 'PRO', currentPeriodEnd: '2027-01-01T00:00:00.000Z' } }],
    ['es fundador (grandfathered)', { grandfathered: true }],
  ])('%s → no se le dice que pasa a Gratis', async (_caso, cambio) => {
    conPruebas([prueba()])
    ;(getPlanState as jest.Mock).mockResolvedValue(cortesia(FIN, cambio))
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it.each(['CLOSED', 'SUSPENDED', 'LIVE_DEMO', 'TRIAL', 'ONBOARDING'])('negocio en %s → nada (Codex r1 #5)', async status => {
    conPruebas([prueba({ venue: { slug: 'x', timezone: 'America/Mexico_City', status } })])
    await new PlanRenewalReminderJob().runNow()
    expect(getPlanState).not.toHaveBeenCalled()
    expect(freeSpy).not.toHaveBeenCalled()
  })

  it('sin destinatario → nada, sin sellar', async () => {
    conPruebas([prueba()])
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({ email: null, locale: 'es', venueName: 'X' })
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('el correo no sale → no sella; al día siguiente sí sale, con la misma llave, y sella', async () => {
    conPruebas([prueba()])
    freeSpy.mockResolvedValueOnce(false)
    await new PlanRenewalReminderJob().runNow()
    expect(mockPrisma.venueFeature.updateMany).not.toHaveBeenCalled()

    jest.setSystemTime(NOW + DAY)
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy).toHaveBeenCalledTimes(2)
    expect(freeSpy.mock.calls[1][1].idempotencyKey).toBe(freeSpy.mock.calls[0][1].idempotencyKey)
    expect(mockPrisma.venueFeature.updateMany).toHaveBeenCalledTimes(1)
  })

  it('sólo la lectura y el sello pasan por retry, nunca el correo', async () => {
    conPruebas([prueba()])
    await new PlanRenewalReminderJob().runNow()
    expect((retry as jest.Mock).mock.calls.map(c => c[1].context)).toEqual([
      'plan-renewal-reminder.findMany',
      'plan-renewal-reminder.pruebasSinTarjeta.findMany',
      'plan-renewal-reminder.pruebasSinTarjeta.stamp',
    ])
  })

  it('🔴 Codex r2: 200 fundadores en la primera página no tapan a la prueba que sí toca: se lee la página siguiente por llave', async () => {
    const fundadores = Array.from({ length: TOPE_PRUEBAS }, (_, i) =>
      prueba({ id: `vf-f${String(i).padStart(3, '0')}`, venueId: `fund-${i}` }),
    )
    const elegible = prueba({ id: 'vf-z', venueId: 'v-elegible' })
    mockPrisma.venueFeature.findMany.mockImplementation((args: { where: { stripeSubscriptionId: unknown; AND?: unknown[] } }) => {
      if (args.where.stripeSubscriptionId !== null) return Promise.resolve([])
      return Promise.resolve((args.where.AND?.length ?? 0) > 1 ? [elegible] : fundadores)
    })
    ;(getPlanState as jest.Mock).mockImplementation(async (venueId: string) =>
      cortesia(FIN, venueId.startsWith('fund-') ? { grandfathered: true } : {}),
    )

    await new PlanRenewalReminderJob().runNow()

    expect(freeSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'vf-z' }) }),
    )
    const segunda = mockPrisma.venueFeature.findMany.mock.calls.map(c => c[0]).filter(a => a.where.stripeSubscriptionId === null)[1]
    expect(segunda.where.AND[1]).toEqual({
      OR: [{ endDate: { gt: FIN } }, { endDate: FIN, id: { gt: `vf-f${String(TOPE_PRUEBAS - 1).padStart(3, '0')}` } }],
    })
  })

  // 2. REGRESSION TESTS
  it('una fila que truena no detiene a las demás', async () => {
    conPruebas([prueba(), prueba({ id: 'vf10', venueId: 'v10' })])
    ;(getPlanState as jest.Mock).mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce(cortesia(FIN))
    await expect(new PlanRenewalReminderJob().runNow()).resolves.toBeUndefined()
    expect(freeSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'vf10' }) }),
    )
  })

  it('si la lectura de cobros con Stripe truena, las pruebas regaladas se avisan igual', async () => {
    mockPrisma.venueFeature.findMany.mockImplementation((args: { where: { stripeSubscriptionId: unknown } }) =>
      args.where.stripeSubscriptionId === null ? Promise.resolve([prueba()]) : Promise.reject(new Error('P1001')),
    )
    await new PlanRenewalReminderJob().runNow()
    expect(freeSpy).toHaveBeenCalledTimes(1)
  })

  it('el aviso de cobro (con Stripe) nunca manda el correo de prueba regalada', async () => {
    mockPrisma.venueFeature.findMany.mockImplementation((args: { where: { stripeSubscriptionId: unknown } }) =>
      Promise.resolve(args.where.stripeSubscriptionId === null ? [] : [row()]),
    )
    mockRetrieve.mockResolvedValue(stripeSub(8))
    mockCreatePreview.mockResolvedValue({ amount_due: 115884 })
    await new PlanRenewalReminderJob().runNow()
    expect(renewalSpy).toHaveBeenCalledTimes(1)
    expect(freeSpy).not.toHaveBeenCalled()
  })
})
