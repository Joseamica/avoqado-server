import { prismaMock } from '@tests/__helpers__/setup'
import { cotizacionDelAlta } from '@/services/billing/cotizacionDeLaOferta'
import { verificarCotizacion } from '@/services/billing/comprobanteDeCotizacion'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const ahora = new Date('2026-12-01T12:00:00Z')
const DIA = 86_400_000

const v2 = (opciones: Parameters<typeof definicionDePrueba>[0] = {}) =>
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900 },
    nombres: { FREE: 'Gratis 2', PRO: 'Pro 2', PREMIUM: 'Premium 2' },
    planes: { PRO: { requiresCard: false, trialDays: 14 }, PREMIUM: { trialDays: 0 } },
    ...opciones,
  })

beforeEach(() => {
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
})

describe('cotizacionDelAlta', () => {
  it('sin versiones o con sólo la v1 → null y no firma nada', async () => {
    expect(await cotizacionDelAlta('o1', ahora)).toBeNull()
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    expect(await cotizacionDelAlta('o1', ahora)).toBeNull()
  })

  it('con la v2: versionNumber 2, nombres de la vigente, y un comprobante por plan y periodicidad que verifica con org:o1 y trae su precio y su fin de prueba', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    const oferta = await cotizacionDelAlta('o1', ahora)
    expect(oferta).not.toBeNull()
    expect(oferta!.versionNumber).toBe(2)
    expect(oferta!.free).toEqual({ displayName: 'Gratis 2' })
    expect(oferta!.planes.PRO).toMatchObject({ displayName: 'Pro 2', onSale: true, requiresCard: false, trialDays: 14 })
    expect(oferta!.planes.PREMIUM).toMatchObject({ displayName: 'Premium 2', requiresCard: true, trialDays: 0 })

    const pro = oferta!.planes.PRO.monthly!
    const c = verificarCotizacion(pro.quoteToken, 'org:o1', ahora)
    expect(c).toMatchObject({ versionNumber: 2, tier: 'PRO', interval: 'monthly', precioCents: 92684, firstChargeCents: 0 })
    expect(c.trialEndsAt!.getTime()).toBe(ahora.getTime() + 14 * DIA)
    expect(pro).toMatchObject({
      precioCents: 92684,
      netCents: 79900,
      firstChargeCents: 0,
      trialEndsAt: new Date(ahora.getTime() + 14 * DIA).toISOString(),
    })

    for (const tier of ['PRO', 'PREMIUM'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        const o = oferta!.planes[tier][interval]!
        expect(verificarCotizacion(o.quoteToken, 'org:o1', ahora)).toMatchObject({ tier, interval, versionNumber: 2 })
      }
    }
    const prem = oferta!.planes.PREMIUM.monthly!
    expect(prem).toMatchObject({ firstChargeCents: 197084, trialEndsAt: null })
    expect(() => verificarCotizacion(prem.quoteToken, 'org:otra', ahora)).toThrow()
  })

  it('un plan fuera de venta sale con monthly y annual en null', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2({ planes: { PREMIUM: { onSale: false } } })) as never)
    const oferta = await cotizacionDelAlta('o1', ahora)
    expect(oferta!.planes.PREMIUM).toMatchObject({ onSale: false, monthly: null, annual: null })
    expect(oferta!.planes.PRO.monthly).not.toBeNull()
  })
})
