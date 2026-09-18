/**
 * S6 — la lista de UTMs es UNA sola para los dos caminos de alta (spec 2026-09-17 § 3.5).
 */
import { optionalLaunchCampaignCode, UTM_KEYS, utmSchema } from '@/schemas/acquisition.schema'

describe('utmSchema', () => {
  it('🔴 la lista permitida queda IDÉNTICA a la que tenía la landing', () => {
    // Si alguien agrega una llave aquí y no en la landing (o al revés), la atribución de los dos
    // caminos deja de ser comparable y nadie se entera. Esta lista es la que había en
    // `public.routes.ts` antes de moverla, copiada a mano a propósito.
    expect([...UTM_KEYS]).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'gclid',
      'gbraid',
      'wbraid',
      'fbclid',
      'msclkid',
    ])
  })

  it('descarta en silencio lo que no está en la lista y recorta a 200', () => {
    const r = utmSchema.parse({ utm_source: ' google ', pwned: '<script>', utm_term: 'x'.repeat(500) })
    expect(r).toEqual({ utm_source: 'google', utm_term: 'x'.repeat(200) })
  })

  it('sin UTMs devuelve undefined, no un objeto vacío', () => {
    expect(utmSchema.parse(undefined)).toBeUndefined()
    expect(utmSchema.parse({ pwned: 'x' })).toBeUndefined()
  })
})

describe('optionalLaunchCampaignCode', () => {
  it('normaliza a mayúsculas y recorta', () => {
    expect(optionalLaunchCampaignCode.parse(' pos22 ')).toBe('POS22')
  })

  it('🔴 un código mal formado se DESCARTA, no tumba el alta con un 400', () => {
    // 🔴 'a'.repeat(40) SALIÓ de esta lista a propósito: desde que el alta acepta también el SLUG
    // del anuncio, 40 minúsculas son un slug con forma válida (`landingSlug` admite hasta 60). Lo que
    // sigue sin ser ni código ni slug: demasiado corto, con espacios, con acentos, o pasado de 60.
    for (const malo of ['no', 'con espacio', 'a'.repeat(70), '¡ñ!', '-empieza-con-guion']) {
      expect(optionalLaunchCampaignCode.parse(malo)).toBeUndefined()
    }
    expect(optionalLaunchCampaignCode.parse(undefined)).toBeUndefined()
  })

  it('🔴 acepta el SLUG del anuncio, que es lo que manda el CTA de /oferta/<slug>', () => {
    expect(optionalLaunchCampaignCode.parse('POS22')).toBe('POS22')
    // 🔴 `pos-22` en mayúsculas SÍ tiene forma de código (`POS-22`), así que la puerta lo normaliza
    // así — y está bien: lo que importa es que NO se descarte. Quien lo resuelve es
    // `findClaimableByCodeOrSlug`, que prueba `POS-22` como código, falla, y da con el slug
    // `pos-22`. Esa mitad la fija `launchCampaign.service.test.ts`.
    expect(optionalLaunchCampaignCode.parse('pos-22')).toBe('POS-22')
    // y un slug largo ya NO se descarta en la puerta: antes moría por el tope de 32 del código
    expect(optionalLaunchCampaignCode.parse('pos-22-verano-monterrey-y-saltillo')).toBe('pos-22-verano-monterrey-y-saltillo')
  })
})
