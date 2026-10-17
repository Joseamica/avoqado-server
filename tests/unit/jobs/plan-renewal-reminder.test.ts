import type Stripe from 'stripe'
import { PlanRenewalReminderJob, diasParaAvisar } from '@/jobs/plan-renewal-reminder.job'
import { montoDelSiguienteCobro, seCancelaAntesDe } from '@/services/billing/siguienteCobro'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'

// Make retry transparent: just invoke the wrapped fn (deterministic, no backoff).
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: (fn: () => unknown) => fn(),
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

const mockPrisma = prisma as unknown as {
  venueFeature: { findMany: jest.Mock; update: jest.Mock }
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

describe('seCancelaAntesDe', () => {
  const finMs = Date.UTC(2026, 10, 16, 18)
  const sub = (o: Record<string, unknown>) => ({ cancel_at_period_end: false, cancel_at: null, ...o }) as unknown as Stripe.Subscription

  it('cancel_at_period_end → true', () => expect(seCancelaAntesDe(sub({ cancel_at_period_end: true }), finMs)).toBe(true))
  it('cancel_at exactamente al fin → true', () => expect(seCancelaAntesDe(sub({ cancel_at: finMs / 1000 }), finMs)).toBe(true))
  it('cancel_at antes del fin → true', () => expect(seCancelaAntesDe(sub({ cancel_at: finMs / 1000 - 1 }), finMs)).toBe(true))
  it('cancel_at después del fin → false', () => expect(seCancelaAntesDe(sub({ cancel_at: finMs / 1000 + 1 }), finMs)).toBe(false))
  it('sin cancelación → false', () => expect(seCancelaAntesDe(sub({}), finMs)).toBe(false))
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
