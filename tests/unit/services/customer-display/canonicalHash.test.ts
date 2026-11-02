// tests/unit/services/customer-display/canonicalHash.test.ts
import { Prisma } from '@prisma/client'
import { canonicalJson, fingerprintOf } from '@/services/customer-display/canonicalHash'
import { buildEffectiveDesign } from '@/services/customer-display/customerDisplayDesign.effective'
import { FACTORY_DESIGN } from '@/services/customer-display/customerDisplayDesign.validation'

describe('canonicalJson', () => {
  it('ordena las llaves: el mismo objeto escrito en otro orden da el MISMO texto', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('omite las llaves undefined pero conserva null (null es un valor, ausente no)', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('los arreglos conservan su orden', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })

  // 🔴 La razón de este módulo.
  it('una fecha se serializa por su VALOR: dos fechas distintas nunca dan el mismo texto', () => {
    expect(canonicalJson({ at: new Date('2026-09-01T00:00:00.000Z') })).toBe('{"at":"2026-09-01T00:00:00.000Z"}')
    expect(fingerprintOf({ at: new Date('2026-09-01T00:00:00.000Z') })).not.toBe(
      fingerprintOf({ at: new Date('2026-09-02T00:00:00.000Z') }),
    )
  })

  it('una fecha inválida es null, no «Invalid Date» ni una excepción', () => {
    expect(canonicalJson({ at: new Date('no') })).toBe('{"at":null}')
  })

  it('un decimal de Prisma se serializa por su valor', () => {
    expect(canonicalJson({ p: new Prisma.Decimal('10.50') })).toBe('{"p":"10.5"}')
    expect(canonicalJson({ p: new Prisma.Decimal('10.50') })).not.toBe(canonicalJson({ p: new Prisma.Decimal('10.51') }))
  })

  it('un bigint no truena', () => {
    expect(canonicalJson({ n: BigInt(7) })).toBe('{"n":"7"}')
  })
})

describe('fingerprintOf', () => {
  it('son 32 caracteres hexadecimales, estables para el mismo valor', () => {
    expect(fingerprintOf({ a: 1 })).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprintOf({ a: 1 })).toBe(fingerprintOf({ a: 1 }))
  })
})

describe('la huella de la ficha NO cambia al mudarse a canonicalHash (F0-A ya la entrega)', () => {
  it('una ficha fija conserva su huella DORADA', () => {
    const { ficha } = buildEffectiveDesign({
      design: { ...FACTORY_DESIGN, slides: [], theme: 'DARK', accentColor: '#3FB950', welcomeText: 'Hola, pasa' },
      terminal: { venueId: 'venue-dorado', designVersion: 2 },
      venue: { logo: null, updatedAt: new Date('2026-09-01T00:00:00.000Z') },
      assets: new Map(),
      entitlements: { slides: true, promotionCards: true },
      bucket: null,
    })
    // Se fija en el Step 2 contra el código de F0-A, ANTES de tocar effective.ts.
    expect(ficha.fingerprint).toBe('9852ac5818d279cca2f6db0a1d71ceb9')
  })
})
