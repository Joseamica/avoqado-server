/**
 * La plantilla de la tarjeta de un negocio en Google Wallet (`loyaltyClass`).
 *
 * 🔴 Lógica PURA, igual que `applePassBuilder`: no toca red ni credenciales. El
 * contenido de la tarjeta es donde se cometen los errores caros —un color que Google
 * ignora, el nombre del proveedor en vez del de la cafetería— y así se prueba entero
 * sin tener una cuenta de emisor a la mano.
 */
import { buildLoyaltyClass, googleClassId } from '@/services/wallet/googleClassBuilder.service'
import { DEFAULT_CARD_DESIGN } from '@/services/wallet/cardDesign.service'

const BASE = {
  issuerId: '3388000000023181777',
  venueId: 'venue-abc',
  venueName: 'Testarudo Café',
  design: { ...DEFAULT_CARD_DESIGN },
  rewardLabel: 'Un café gratis',
  // 🔴 Sin logo del diseñador ni del venue por default: así cada prueba deja explícito
  // cuál de los tres niveles de la cadena de respaldo está ejercitando.
  venueLogo: null as string | null,
}

describe('googleClassId', () => {
  it('cuelga del issuer, como exige Google', () => {
    expect(googleClassId('338', 'venue-abc')).toBe('338.venue-venue-abc')
  })
})

describe('buildLoyaltyClass', () => {
  it('🔴 lleva el nombre del NEGOCIO, no el de Avoqado: es marca blanca', () => {
    const c = buildLoyaltyClass(BASE)
    expect(c.issuerName).toBe('Testarudo Café')
    expect(c.programName).toBe('Testarudo Café')
  })

  it('usa el color de fondo del diseño del negocio', () => {
    const c = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, backgroundColor: '#6D4C41' } })
    expect(c.hexBackgroundColor).toBe('#6D4C41')
  })

  it('el id y el issuer viajan en el objeto', () => {
    const c = buildLoyaltyClass(BASE)
    expect(c.id).toBe('3388000000023181777.venue-venue-abc')
    expect(c.issuerId).toBe('3388000000023181777')
  })

  it('🔴 nace en estado UNDER_REVIEW: es lo que Google acepta en modo demo', () => {
    expect(buildLoyaltyClass(BASE).reviewStatus).toBe('UNDER_REVIEW')
  })

  it('el logo del negocio va como programLogo cuando lo subió en el diseñador', () => {
    const c = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: 'https://cdn/logo.png' }, venueLogo: 'https://cdn/venue-logo.png' }) as any
    // 🔴 El del diseñador manda sobre el del venue: es el más específico de la cadena.
    expect(c.programLogo.sourceUri.uri).toBe('https://cdn/logo.png')
  })

  it('🔴 sin logo del diseñador pero con Venue.logo, usa el del venue', () => {
    const c = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: null }, venueLogo: 'https://cdn/venue-logo.jpg' }) as any
    expect(c.programLogo.sourceUri.uri).toBe('https://cdn/venue-logo.jpg')
  })

  it('🔴 sin logo del diseñador NI del venue, cae al logo fijo de Avoqado: programLogo es obligatorio para Google', () => {
    const c = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: null }, venueLogo: null }) as any
    expect(c.programLogo.sourceUri.uri).toMatch(/^https:\/\//)
    expect(c.programLogo.sourceUri.uri).not.toBe('')
  })

  it('🔴 NUNCA se emite una clase sin programLogo: Google la rechaza con un 400 si falta', () => {
    const sinNada = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: null }, venueLogo: null })
    const soloVenue = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: null }, venueLogo: 'https://cdn/venue-logo.png' })
    const soloDiseno = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: 'https://cdn/logo.png' }, venueLogo: null })
    for (const c of [sinNada, soloVenue, soloDiseno]) {
      expect(c).toHaveProperty('programLogo')
      expect((c as any).programLogo.sourceUri.uri).toBeTruthy()
    }
  })

  it('el premio se explica en el reverso, en minúscula a media frase como en el pase de Apple', () => {
    const c = buildLoyaltyClass({ ...BASE, rewardLabel: 'Un café gratis' }) as any
    const textos = JSON.stringify(c.textModulesData)
    // 🔴 Minúscula a propósito: va a media frase («…y obtén un café gratis»), igual que el
    // `backFields` de Apple, cuya prueba exige lo mismo. Si las dos difieren, el mismo premio
    // se lee distinto según el teléfono del cliente.
    expect(textos).toContain('obtén un café gratis')
  })
})
