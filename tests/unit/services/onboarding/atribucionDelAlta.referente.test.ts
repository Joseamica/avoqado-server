/**
 * D12 (28-oct-2026): el aviso «Nuevo registro directo» no distinguía a quien llegó desde la portada (avoqado.io) de quien
 * escribió dashboard.avoqado.io a mano. El panel ahora manda el HOST de la página anterior (`referrer`); se guarda junto a
 * los UTMs en `acquisitionUtm.referrer`. Uno mal formado se descarta en silencio: la atribución vale menos que la cuenta.
 */
import { resolverAtribucionDelAlta } from '@/services/onboarding/nuevoNegocio'
import { referenteLegible, utmLegible } from '@/services/onboarding/atribucionLegible'

describe('resolverAtribucionDelAlta — referente', () => {
  it('guarda el host junto a los UTMs', async () => {
    const r = await resolverAtribucionDelAlta({ referrer: 'avoqado.io', utm: { utm_source: 'x' } })
    expect(r.utm).toEqual({ utm_source: 'x', referrer: 'avoqado.io' })
  })

  it('sin UTMs, el referente solo también se guarda', async () => {
    const r = await resolverAtribucionDelAlta({ referrer: 'avoqado.io' })
    expect(r.utm).toEqual({ referrer: 'avoqado.io' })
  })

  it.each([
    ['https://www.avoqado.io/precios?x=1', 'www.avoqado.io'],
    ['AVOQADO.IO', 'avoqado.io'],
    ['localhost:4321', 'localhost'],
  ])('normaliza %s → %s', async (entrada, esperado) => {
    const r = await resolverAtribucionDelAlta({ referrer: entrada })
    expect(r.utm).toEqual({ referrer: esperado })
  })

  it.each(['<script>', '', '   ', 'a'.repeat(150)])('descarta %p sin tocar lo demás', async entrada => {
    const r = await resolverAtribucionDelAlta({ referrer: entrada, utm: { utm_source: 'x' } })
    expect(r.utm).toEqual({ utm_source: 'x' })
  })
})

describe('textos de la atribución', () => {
  it('referenteLegible: el host, o «Origen no disponible» (vacío NO prueba que escribió la dirección)', () => {
    expect(referenteLegible({ referrer: 'avoqado.io' })).toBe('avoqado.io')
    expect(referenteLegible({ utm_source: 'google' })).toBe('Origen no disponible')
    expect(referenteLegible(null)).toBe('Origen no disponible')
  })

  it('utmLegible sigue como antes', () => {
    expect(utmLegible({ utm_source: 'google', utm_medium: 'cpc', referrer: 'avoqado.io' })).toBe('utm_source=google · utm_medium=cpc')
    expect(utmLegible({ referrer: 'avoqado.io' })).toBeNull()
  })
})
