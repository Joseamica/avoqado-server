/**
 * La tarjeta de UN cliente en Google Wallet (`loyaltyObject`).
 *
 * 🔴 Aquí vive la decisión que sostiene todo el diseño: la franja de sellos se sirve
 * como `heroImage`, y su URL lleva DENTRO la revisión del pase. Google no documenta si
 * refresca una imagen cuando cambia en la misma dirección; versionando la URL no
 * dependemos de su política de caché — cada sello cambia la dirección y obliga a
 * redescargar.
 */
import { buildLoyaltyObject, googleObjectId, stampStripUrl } from '@/services/wallet/googleObjectBuilder.service'

const BASE = {
  issuerId: '338',
  venueId: 'venue-abc',
  walletPassId: 'wp-1',
  serialNumber: 'AVQ-1111',
  qrToken: '0123456789abcdef0123456789abcdef0123456789abcdef',
  revision: 3,
  baseUrl: 'https://api.avoqado.io',
  content: { stampsEarned: 3, stampsRequired: 7, rewardLabel: 'Un café gratis' },
}

describe('googleObjectId', () => {
  it('cuelga del issuer', () => {
    expect(googleObjectId('338', 'wp-1')).toBe('338.pass-wp-1')
  })
})

describe('stampStripUrl', () => {
  it('🔴 la revisión va DENTRO de la URL: es lo que fuerza a Google a redescargar', () => {
    expect(stampStripUrl('https://api.avoqado.io', 'AVQ-1111', 3)).toBe('https://api.avoqado.io/api/v1/public/wallet/stamps/AVQ-1111/3.png')
  })

  it('no duplica la diagonal si la base ya la trae', () => {
    expect(stampStripUrl('https://api.avoqado.io/', 'AVQ-1111', 3)).toBe('https://api.avoqado.io/api/v1/public/wallet/stamps/AVQ-1111/3.png')
  })

  it('🔴 tampoco deja `//` si la base trae MÁS de una diagonal final (env mal configurada)', () => {
    expect(stampStripUrl('https://api.avoqado.io//', 'AVQ-1111', 3)).toBe('https://api.avoqado.io/api/v1/public/wallet/stamps/AVQ-1111/3.png')
  })
})

describe('buildLoyaltyObject', () => {
  it('apunta a la clase de SU negocio', () => {
    const o = buildLoyaltyObject(BASE)
    expect(o.id).toBe('338.pass-wp-1')
    expect(o.classId).toBe('338.venue-venue-abc')
  })

  it('🔴 el código de barras lleva el qrToken, jamás el customerId', () => {
    const o = buildLoyaltyObject(BASE) as any
    expect(o.barcode.value).toBe(BASE.qrToken)
    expect(o.barcode.type).toBe('QR_CODE')
    expect(JSON.stringify(o)).not.toContain('customer')
  })

  it('el avance se lee como en el iPhone: 3/7', () => {
    const o = buildLoyaltyObject(BASE) as any
    expect(o.loyaltyPoints.label).toBe('SELLOS')
    expect(o.loyaltyPoints.balance.string).toBe('3/7')
  })

  it('🔴 el heroImage trae la revisión actual', () => {
    const o = buildLoyaltyObject({ ...BASE, revision: 9 }) as any
    expect(o.heroImage.sourceUri.uri).toContain('/AVQ-1111/9.png')
  })

  it('cambiar de revisión cambia la URL — sin esto Google serviría la franja vieja', () => {
    const a = buildLoyaltyObject({ ...BASE, revision: 1 }) as any
    const b = buildLoyaltyObject({ ...BASE, revision: 2 }) as any
    expect(a.heroImage.sourceUri.uri).not.toBe(b.heroImage.sourceUri.uri)
  })

  it('nace ACTIVE: una tarjeta recién guardada tiene que servir de inmediato', () => {
    expect(buildLoyaltyObject(BASE).state).toBe('ACTIVE')
  })

  it('el premio viaja para que el cliente lo lea sin abrir nada más', () => {
    const o = buildLoyaltyObject(BASE) as any
    expect(JSON.stringify(o.textModulesData)).toContain('Un café gratis')
  })
})
