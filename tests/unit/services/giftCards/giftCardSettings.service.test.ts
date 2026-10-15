jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/giftCards/giftCardTender', () => ({
  ensureGiftCardTender: jest.fn().mockResolvedValue({ id: 'tt-gift', revision: 1 }),
}))

import { Prisma } from '@prisma/client'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { assertGiftCardsSellable, getGiftCardSettings, updateGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const D = (v: number) => new Prisma.Decimal(v)
const fila = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  suggestedAmounts: [D(500), D(1000), D(2000)],
  minAmount: D(100),
  maxAmount: D(10000),
  validityMonths: null,
  termsVersion: '2026-10-14',
  updatedAt: new Date('2026-10-14T18:00:00Z'),
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.giftCardSettings.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.giftCardSettings.upsert
    .mockReset()
    .mockImplementation(async ({ create }: any) => ({ ...create, updatedAt: new Date('2026-10-14T18:00:00Z') }))
  prismaMock.$queryRaw.mockReset().mockResolvedValue([{ pg_advisory_xact_lock: '' }])
  ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
})

describe('getGiftCardSettings', () => {
  it('sin fila: los defaults, APAGADA (toca dinero), $100–$10,000, sin vencimiento y el tope de la operación', async () => {
    await expect(getGiftCardSettings(VENUE)).resolves.toEqual({
      enabled: false,
      suggestedAmounts: [500, 1000, 2000],
      minAmount: 100,
      maxAmount: 10000,
      validityMonths: null,
      termsVersion: '2026-10-14',
      topePorOperacion: 70000,
      llavesConfiguradas: true,
      updatedAt: null,
    })
  })
})

describe('updateGiftCardSettings', () => {
  it('prender exige aceptar los términos', async () => {
    await expect(updateGiftCardSettings(VENUE, { enabled: true }, 'owner-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.giftCardSettings.upsert).not.toHaveBeenCalled()
  })

  it('prender sin el plan: GIFT_CARDS_NOT_IN_PLAN y no crea el tender', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(updateGiftCardSettings(VENUE, { enabled: true, aceptaTerminos: true }, 'owner-1')).rejects.toMatchObject({
      code: 'GIFT_CARDS_NOT_IN_PLAN',
      statusCode: 403,
    })
    expect(venueHasFeatureAccess).toHaveBeenCalledWith(VENUE, 'GIFT_CARDS')
    expect(ensureGiftCardTender).not.toHaveBeenCalled()
  })

  it('prender con plan y términos: crea el tender de sistema, guarda y deja rastro en ActivityLog', async () => {
    const vista = await updateGiftCardSettings(VENUE, { enabled: true, aceptaTerminos: true, validityMonths: 24 }, 'owner-1')
    expect(ensureGiftCardTender).toHaveBeenCalledWith(expect.anything(), VENUE)
    expect(prismaMock.giftCardSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: VENUE },
        create: expect.objectContaining({
          venueId: VENUE,
          enabled: true,
          validityMonths: 24,
          termsVersion: '2026-10-14',
          updatedById: 'owner-1',
        }),
      }),
    )
    expect(vista).toMatchObject({ enabled: true, validityMonths: 24 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'GIFT_CARD_SETTINGS_UPDATED', venueId: VENUE, staffId: 'owner-1' }),
    )
  })

  it.each([
    [{ maxAmount: 12000 }, 'no puede pasar de $10,000.00'],
    [{ minAmount: 50 }, 'no puede ser menor a $100.00'],
    [{ minAmount: 600, maxAmount: 500 }, 'no puede ser mayor que el máximo'],
    [{ suggestedAmounts: [] }, 'de 1 a 6 montos'],
    [{ suggestedAmounts: [50] }, 'deben estar entre $100.00 y $10,000.00'],
    [{ validityMonths: 18 }, '12, 24, 36 o 60 meses'],
  ])('rechaza %o con un mensaje claro', async (input, mensaje) => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila())
    await expect(updateGiftCardSettings(VENUE, input as any, 'owner-1')).rejects.toThrow(mensaje)
    expect(prismaMock.giftCardSettings.upsert).not.toHaveBeenCalled()
  })

  it('apagar no pide términos ni plan (apagar siempre se puede) y no toca el tender', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila())
    await updateGiftCardSettings(VENUE, { enabled: false }, 'owner-1')
    expect(venueHasFeatureAccess).not.toHaveBeenCalled()
    expect(ensureGiftCardTender).not.toHaveBeenCalled()
    expect(prismaMock.giftCardSettings.upsert.mock.calls[0][0].update).toMatchObject({ enabled: false })
  })

  it('🔴 r1 (A-4): guardar montos SIN `enabled` no lo escribe: una foto vieja nunca vuelve a prender lo que otro apagó', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila({ enabled: false }))
    await updateGiftCardSettings(VENUE, { suggestedAmounts: [300, 800] }, 'owner-1')
    const { update } = prismaMock.giftCardSettings.upsert.mock.calls[0][0]
    expect(update).toEqual({ suggestedAmounts: [D(300), D(800)], updatedById: 'owner-1' })
    expect(update).not.toHaveProperty('enabled')
    expect(venueHasFeatureAccess).not.toHaveBeenCalled()
  })

  it('r1 (A-4): leer, validar y escribir van en UNA transacción con el candado consultivo del negocio PRIMERO', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila())
    await updateGiftCardSettings(VENUE, { maxAmount: 5000 }, 'owner-1')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const candado = prismaMock.$queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(candado.sql).toContain('pg_advisory_xact_lock')
    expect(candado.values).toEqual(['avoqado:gift-card-settings:v1:venue-1'])
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.giftCardSettings.findUnique.mock.invocationCallOrder[0],
    )
    expect(prismaMock.giftCardSettings.upsert.mock.calls[0][0].update).toEqual({ maxAmount: D(5000), updatedById: 'owner-1' })
  })

  it('r1 (A-4): la validación cruzada usa lo guardado bajo el candado (sugeridos de la fila contra el máximo nuevo)', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila({ suggestedAmounts: [D(500), D(8000)] }))
    await expect(updateGiftCardSettings(VENUE, { maxAmount: 5000 }, 'owner-1')).rejects.toThrow('deben estar entre $100.00 y $5,000.00')
    expect(prismaMock.giftCardSettings.upsert).not.toHaveBeenCalled()
  })
})

describe('assertGiftCardsSellable', () => {
  it('apagada: GIFT_CARDS_DISABLED con el camino para prenderla', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila({ enabled: false }))
    await expect(assertGiftCardsSellable(VENUE)).rejects.toMatchObject({ code: 'GIFT_CARDS_DISABLED', statusCode: 403 })
  })

  it('prendida pero sin plan: GIFT_CARDS_NOT_IN_PLAN', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila())
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(assertGiftCardsSellable(VENUE)).rejects.toMatchObject({ code: 'GIFT_CARDS_NOT_IN_PLAN' })
  })

  it('prendida, con plan y llaves: se puede vender', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila())
    await expect(assertGiftCardsSellable(VENUE)).resolves.toBeUndefined()
  })

  it('sin llaves en el servidor: GIFT_CARD_KEYS_MISSING', async () => {
    prismaMock.giftCardSettings.findUnique.mockResolvedValue(fila())
    const antes = process.env.GIFT_CARD_HMAC_KEY
    delete process.env.GIFT_CARD_HMAC_KEY
    try {
      await expect(assertGiftCardsSellable(VENUE)).rejects.toMatchObject({ code: 'GIFT_CARD_KEYS_MISSING' })
    } finally {
      process.env.GIFT_CARD_HMAC_KEY = antes
    }
  })
})
