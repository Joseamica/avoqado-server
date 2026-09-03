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

  it('el logo del negocio va como programLogo cuando lo subió', () => {
    const c = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: 'https://cdn/logo.png' } }) as any
    expect(c.programLogo.sourceUri.uri).toBe('https://cdn/logo.png')
  })

  it('🔴 sin logo propio NO se manda programLogo vacío: Google rechaza un uri nulo', () => {
    const c = buildLoyaltyClass({ ...BASE, design: { ...DEFAULT_CARD_DESIGN, logoUrl: null } })
    expect(c).not.toHaveProperty('programLogo')
  })

  it('el premio se explica en el reverso, con el texto que configuró el negocio', () => {
    const c = buildLoyaltyClass({ ...BASE, rewardLabel: 'Un café gratis' }) as any
    const textos = JSON.stringify(c.textModulesData)
    expect(textos).toContain('Un café gratis')
  })
})
