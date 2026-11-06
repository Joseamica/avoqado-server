import { prismaMock } from '@tests/__helpers__/setup'
import { getFeatureMetadataForVenue, resolveFeatureGateState } from '@/services/access/feature-metadata.service'

describe('feature-metadata.service', () => {
  describe('resolveFeatureGateState', () => {
    const now = new Date('2026-04-20T12:00:00.000Z')

    it('returns LOCKED when venue feature does not exist', () => {
      expect(resolveFeatureGateState(null, now)).toBe('LOCKED')
    })

    it('returns SUSPENDED when feature is suspended', () => {
      expect(
        resolveFeatureGateState(
          {
            active: false,
            endDate: null,
            suspendedAt: new Date('2026-04-20T10:00:00.000Z'),
            gracePeriodEndsAt: new Date('2026-04-21T10:00:00.000Z'),
          },
          now,
        ),
      ).toBe('SUSPENDED')
    })

    it('returns GRACE_PERIOD when grace period is still active', () => {
      expect(
        resolveFeatureGateState(
          {
            active: true,
            endDate: null,
            suspendedAt: null,
            gracePeriodEndsAt: new Date('2026-04-21T10:00:00.000Z'),
          },
          now,
        ),
      ).toBe('GRACE_PERIOD')
    })

    it('returns TRIALING when trial is active', () => {
      expect(
        resolveFeatureGateState(
          {
            active: true,
            endDate: new Date('2026-04-21T10:00:00.000Z'),
            suspendedAt: null,
            gracePeriodEndsAt: null,
          },
          now,
        ),
      ).toBe('TRIALING')
    })

    it('returns TRIAL_EXPIRED when trial date is in the past', () => {
      expect(
        resolveFeatureGateState(
          {
            active: false,
            endDate: new Date('2026-04-19T10:00:00.000Z'),
            suspendedAt: null,
            gracePeriodEndsAt: null,
          },
          now,
        ),
      ).toBe('TRIAL_EXPIRED')
    })

    it('returns ACTIVE when paid subscription is active', () => {
      expect(
        resolveFeatureGateState(
          {
            active: true,
            endDate: null,
            suspendedAt: null,
            gracePeriodEndsAt: null,
          },
          now,
        ),
      ).toBe('ACTIVE')
    })
  })

  // D4 + D6 (5-nov-2026): el estado que ve el DASHBOARD sale de la MISMA regla que el portero (ventanaDeAcceso.ts).
  describe('resolveFeatureGateState — una sola regla con el portero', () => {
    const now = new Date('2026-04-20T12:00:00.000Z')
    const antes = new Date('2026-04-19T12:00:00.000Z')
    const despues = new Date('2026-04-21T12:00:00.000Z')
    const fila = (f: Record<string, unknown>) => ({ active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null, ...f }) as any

    it.each([
      [
        '🔴 D6: prueba vencida + gracia vigente → GRACE_PERIOD (con acceso)',
        { endDate: antes, gracePeriodEndsAt: despues },
        'GRACE_PERIOD',
      ],
      ['REGRESIÓN v4: pagada con la gracia vencida (aún sin suspender) → ACTIVE, como hoy', { gracePeriodEndsAt: antes }, 'ACTIVE'],
      ['🔴 apagada con gracia vigente → no dice GRACE_PERIOD (no hay acceso)', { active: false, gracePeriodEndsAt: despues }, 'LOCKED'],
      ['prueba vencida + gracia vencida → SUSPENDED', { endDate: antes, gracePeriodEndsAt: antes }, 'SUSPENDED'],
      ['una cortesía vigente gana sobre una gracia vencida → TRIALING', { endDate: despues, gracePeriodEndsAt: antes }, 'TRIALING'],
      ['REGRESIÓN: prueba vencida activa sin gracia → TRIAL_EXPIRED', { endDate: antes }, 'TRIAL_EXPIRED'],
      ['REGRESIÓN: apagada con prueba vencida → TRIAL_EXPIRED', { active: false, endDate: antes }, 'TRIAL_EXPIRED'],
      ['REGRESIÓN: apagada con vencimiento futuro → LOCKED', { active: false, endDate: despues }, 'LOCKED'],
    ])('%s', (_caso, f, esperado) => {
      expect(resolveFeatureGateState(fila(f), now)).toBe(esperado)
    })
  })

  describe('getFeatureMetadataForVenue', () => {
    it('returns metadata for all globally active features and maps missing venue feature to LOCKED', async () => {
      prismaMock.feature.findMany.mockResolvedValue([
        {
          code: 'CHATBOT',
          name: 'Chatbot AI',
          description: 'Chat with your data',
          monthlyPrice: { toString: () => '299.00' },
          stripePriceId: 'price_chatbot',
        },
        {
          code: 'INVENTORY_TRACKING',
          name: 'Inventory Tracking',
          description: null,
          monthlyPrice: { toString: () => '89.00' },
          stripePriceId: null,
        },
      ])

      prismaMock.venueFeature.findMany.mockResolvedValue([
        {
          active: true,
          endDate: new Date('2099-12-31T00:00:00.000Z'),
          suspendedAt: null,
          gracePeriodEndsAt: null,
          feature: { code: 'CHATBOT' },
        },
      ])

      const metadata = await getFeatureMetadataForVenue('venue_123')

      expect(Object.keys(metadata)).toHaveLength(2)
      expect(metadata.CHATBOT).toMatchObject({
        code: 'CHATBOT',
        state: 'TRIALING',
        monthlyPrice: '299.00',
        currency: 'MXN',
        trialDays: 14,
        stripePriceId: 'price_chatbot',
        checkoutUrl: '/api/v1/dashboard/venues/venue_123/features',
      })
      expect(metadata.CHATBOT.trialEndsAt).toEqual('2099-12-31T00:00:00.000Z')

      expect(metadata.INVENTORY_TRACKING).toMatchObject({
        code: 'INVENTORY_TRACKING',
        name: 'Inventory Tracking',
        description: 'Inventory Tracking',
        state: 'LOCKED',
        trialEndsAt: null,
      })
    })
  })
})
