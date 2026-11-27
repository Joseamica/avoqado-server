/**
 * Planes editables (B4, Task 1): UNA lectura pública de los planes pagados. Sólo campos públicos (sin `stripePriceId` ni
 * nombre de producto de Stripe) y `offerVersion` sólo si la vigente la publicó el editor (número 2 o más).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import { planesPublicos } from '@/services/billing/planesPublicos'

const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock

beforeEach(() => {
  pointer.mockReset().mockResolvedValue(null)
})

describe('planesPublicos', () => {
  it('sin puntero: el respaldo de hoy y offerVersion null', async () => {
    const r = await planesPublicos()
    expect(r.offerVersion).toBeNull()
    expect(r.FREE).toEqual({ displayName: 'Gratis' })
    expect(r.PRO).toEqual({
      displayName: 'Pro',
      onSale: true,
      requiresCard: true,
      trialDays: 30,
      monthly: { netCents: 99900, grossCents: 115884 },
      annual: { netCents: 999000, grossCents: 1158840 },
    })
    expect(r.PREMIUM.monthly.netCents).toBe(169900)
  })

  it('con la v1: igual que el respaldo y offerVersion null', async () => {
    pointer.mockResolvedValue(punteroA('ver_v1', 1, versionUno()))
    const r = await planesPublicos()
    expect(r.offerVersion).toBeNull()
    expect(r.PRO.monthly).toEqual({ netCents: 99900, grossCents: 115884 })
    expect(r.PRO.trialDays).toBe(30)
    expect(r.PRO.requiresCard).toBe(true)
  })

  it('con la v2 del editor: sus valores, offerVersion 2 y sin datos de Stripe', async () => {
    const def = definicionDePrueba({
      ids: idsDeLaVersion('v2'),
      nombres: { PRO: 'Plus' },
      productos: { PRO: 'Avoqado Plus' },
      netos: { 'PRO:monthly': 79900, 'PRO:annual': 850000 },
      planes: { PRO: { trialDays: 14, requiresCard: false }, PREMIUM: { onSale: false } },
    })
    pointer.mockResolvedValue(punteroA('ver_v2', 2, def))
    const r = await planesPublicos()
    expect(r.offerVersion).toBe(2)
    expect(r.PRO).toMatchObject({
      displayName: 'Plus',
      trialDays: 14,
      requiresCard: false,
      onSale: true,
      monthly: { netCents: 79900, grossCents: 92684 },
      annual: { netCents: 850000, grossCents: 986000 },
    })
    expect(r.PREMIUM.onSale).toBe(false)
    const json = JSON.stringify(r)
    expect(json).not.toContain('stripePriceId')
    expect(json).not.toContain('stripeProductName')
    expect(json).not.toContain('price_v2')
    expect(json).not.toContain('Avoqado Plus')
  })

  it('con la vigente dañada: rechaza con PLAN_NOT_CONFIGURED', async () => {
    pointer.mockResolvedValue(punteroA('ver_v1', 1, { schemaVersion: 1 }))
    await expect(planesPublicos()).rejects.toMatchObject({ code: 'PLAN_NOT_CONFIGURED' })
  })

  describe('B4 (final, S4): una v2 dañada', () => {
    const v2 = (ids: Record<string, string>, planes: Record<string, object> = {}) =>
      pointer.mockResolvedValue(punteroA('ver_v2', 2, definicionDePrueba({ ids, planes })))

    it('v2 con un plan EN VENTA sin el precio de una periodicidad → 503 PLAN_NOT_CONFIGURED', async () => {
      const sinUno: Record<string, string> = { ...idsDeLaVersion('v2') }
      delete sinUno['PRO:annual']
      v2(sinUno)
      await expect(planesPublicos()).rejects.toMatchObject({ code: 'PLAN_NOT_CONFIGURED', statusCode: 503 })
    })

    it('v2 con el plan FUERA de venta y sin ids → 200 (es una versión válida)', async () => {
      const sinPremium: Record<string, string> = { ...idsDeLaVersion('v2') }
      delete sinPremium['PREMIUM:monthly']
      delete sinPremium['PREMIUM:annual']
      v2(sinPremium, { PREMIUM: { onSale: false } })
      const r = await planesPublicos()
      expect(r.offerVersion).toBe(2)
      expect(r.PREMIUM.onSale).toBe(false)
    })

    it('v1 con ids en null → 200, como hoy', async () => {
      pointer.mockResolvedValue(punteroA('ver_v1', 1, definicionDePrueba()))
      const r = await planesPublicos()
      expect(r.offerVersion).toBeNull()
    })
  })
})
