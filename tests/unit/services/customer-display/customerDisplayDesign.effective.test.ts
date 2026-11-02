// tests/unit/services/customer-display/customerDisplayDesign.effective.test.ts
import { accentFor, buildEffectiveDesign, THEME_BACKGROUND } from '@/services/customer-display/customerDisplayDesign.effective'
import { FACTORY_DESIGN } from '@/services/customer-display/customerDisplayDesign.validation'

import fondos from '../../../fixtures/customer-display/theme-backgrounds.json'

// Bucket fijo de prueba: la ficha lo recibe por parámetro y no lee el entorno (Task 2).
const BUCKET = 'bucket-de-prueba.appspot.com'
const VENUE = 'venue-1'

const asset = (id: string, kind: 'SLIDE' | 'LOGO', venueId = VENUE) => ({
  id,
  venueId,
  kind,
  objectPath: `dev/customer-display-assets/${venueId}/${id}.png`,
  sha256: (id + '0').repeat(32).slice(0, 64),
})

const base = (over: Record<string, unknown> = {}) =>
  ({
    design: { ...FACTORY_DESIGN },
    terminal: { venueId: VENUE, designVersion: 2 },
    venue: { logo: null, updatedAt: new Date('2026-09-01T00:00:00Z') },
    assets: new Map(),
    entitlements: { slides: true, promotionCards: true },
    bucket: BUCKET,
    ...over,
  }) as Parameters<typeof buildEffectiveDesign>[0]

/** Contraste WCAG escrito APARTE a propósito: una prueba no debe reusar la fórmula que juzga. */
function contraste(a: string, b: string): number {
  const lum = (hex: string) => {
    const canales = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    const [r, g, bb] = canales.map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb
  }
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

describe('el contraste del acento', () => {
  it('los fondos son los del CONTRATO compartido con Android (el archivo que F2 prueba del otro lado)', () => {
    expect(THEME_BACKGROUND).toEqual(fondos)
  })

  it('un amarillo sobre fondo claro se oscurece hasta separarse del fondo', () => {
    const { color } = accentFor('#FFEB3B', 'LIGHT')
    expect(color).not.toBe('#FFEB3B')
    expect(contraste(color, THEME_BACKGROUND.LIGHT)).toBeGreaterThanOrEqual(3)
  })

  it('un azul marino sobre fondo oscuro se aclara hasta separarse del fondo', () => {
    const { color } = accentFor('#0D1B2A', 'DARK')
    expect(contraste(color, THEME_BACKGROUND.DARK)).toBeGreaterThanOrEqual(3)
  })

  it('un color que YA contrasta no se toca', () => {
    expect(accentFor('#3FB950', 'DARK').color).toBe('#3FB950')
  })

  it('«on» es el que MÁS contrasta con el acento, no siempre blanco', () => {
    expect(accentFor('#FFEB3B', 'DARK').on).toBe('#000000')
    expect(accentFor('#1B3A57', 'DARK').on).toBe('#FFFFFF')
  })
})

describe('buildEffectiveDesign', () => {
  it('sin diseño entrega la fábrica, y la fábrica NO tiene acento propio', () => {
    const { ficha } = buildEffectiveDesign(base({ design: null }))
    expect(ficha).toMatchObject({
      schemaVersion: 1,
      theme: 'LIGHT',
      accent: { custom: false },
      logo: null,
      welcomeText: null,
      slides: [],
      promotionCards: { enabled: false },
      poweredBy: true,
    })
    expect(ficha.fingerprint).toMatch(/^[0-9a-f]{32}$/)
  })

  it('un activo de OTRO venue se omite y se reporta', () => {
    const { ficha, assetRejected } = buildEffectiveDesign(
      base({
        design: { ...FACTORY_DESIGN, slides: [{ assetId: 'ajeno' }] },
        assets: new Map([['ajeno', asset('ajeno', 'SLIDE', 'venue-2')]]),
      }),
    )
    expect(ficha.slides).toEqual([])
    expect(assetRejected).toEqual(['ajeno'])
  })

  it('un activo del KIND equivocado se omite (un logo no puede entrar al carrusel)', () => {
    const { ficha, assetRejected } = buildEffectiveDesign(
      base({ design: { ...FACTORY_DESIGN, slides: [{ assetId: 'l1' }] }, assets: new Map([['l1', asset('l1', 'LOGO')]]) }),
    )
    expect(ficha.slides).toEqual([])
    expect(assetRejected).toEqual(['l1'])
  })

  it('con designVersion 1 el aparato no recibe carrusel ni promos', () => {
    const { ficha } = buildEffectiveDesign(
      base({
        terminal: { venueId: VENUE, designVersion: 1 },
        design: { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }], showPromotions: true },
        assets: new Map([['s1', asset('s1', 'SLIDE')]]),
      }),
    )
    expect(ficha.slides).toEqual([])
    expect(ficha.promotionCards).toEqual({ enabled: false })
  })

  it('sin el plan, las imágenes se recortan aunque estén guardadas', () => {
    const { ficha } = buildEffectiveDesign(
      base({
        design: { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }], showPromotions: true },
        assets: new Map([['s1', asset('s1', 'SLIDE')]]),
        entitlements: { slides: false, promotionCards: false },
      }),
    )
    expect(ficha.slides).toEqual([])
    expect(ficha.promotionCards).toEqual({ enabled: false })
  })

  // Lo que prueba esta función es que las tarjetas siguen a SU propio derecho, no al de las imágenes. Que ese derecho
  // exija CUSTOMER_DISPLAY_PROMOS **y** PROMOTIONS lo calcula quien llama (Task 5), no esta función.
  it('las tarjetas siguen a su PROPIO derecho: con imágenes permitidas y tarjetas no, no salen', () => {
    const { ficha } = buildEffectiveDesign(
      base({ design: { ...FACTORY_DESIGN, showPromotions: true }, entitlements: { slides: true, promotionCards: false } }),
    )
    expect(ficha.promotionCards).toEqual({ enabled: false })
  })

  it('el logo propio viaja con su sha256; el heredado, con su versión', () => {
    const propio = buildEffectiveDesign(
      base({ design: { ...FACTORY_DESIGN, logoAssetId: 'lg' }, assets: new Map([['lg', asset('lg', 'LOGO')]]) }),
    ).ficha
    expect(propio.logo).toEqual({
      source: 'asset',
      url: `https://storage.googleapis.com/${BUCKET}/dev/customer-display-assets/${VENUE}/lg.png`,
      sha256: asset('lg', 'LOGO').sha256,
    })

    const heredado = buildEffectiveDesign(
      base({
        venue: { logo: `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo.jpg`, updatedAt: new Date('2026-09-01T00:00:00Z') },
      }),
    ).ficha
    expect(heredado.logo).toMatchObject({ source: 'venue', version: '2026-09-01T00:00:00.000Z' })
  })

  // El logo propio que no pasa la propiedad NO deja la pantalla sin logo: cae al del negocio (lo que significa
  // `logoAssetId = null`), y el id rechazado se reporta.
  it('un logo propio rechazado (de otro venue) cae al logo heredado del negocio y se reporta', () => {
    const { ficha, assetRejected } = buildEffectiveDesign(
      base({
        design: { ...FACTORY_DESIGN, logoAssetId: 'lg-ajeno' },
        assets: new Map([['lg-ajeno', asset('lg-ajeno', 'LOGO', 'venue-2')]]),
        venue: { logo: `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo.jpg`, updatedAt: new Date('2026-09-01T00:00:00Z') },
      }),
    )
    expect(ficha.logo).toEqual({
      source: 'venue',
      url: `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo.jpg`,
      version: '2026-09-01T00:00:00.000Z',
    })
    expect(assetRejected).toEqual(['lg-ajeno'])
  })

  it('un logo heredado de un host ajeno se descarta: se verá el nombre, como hoy', () => {
    const { ficha } = buildEffectiveDesign(base({ venue: { logo: 'https://evil.test/logo.png', updatedAt: new Date() } }))
    expect(ficha.logo).toBeNull()
  })

  it('las URLs de los activos se arman con el bucket RECIBIDO', () => {
    const { ficha } = buildEffectiveDesign(
      base({ design: { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }] }, assets: new Map([['s1', asset('s1', 'SLIDE')]]) }),
    )
    expect(ficha.slides[0].url).toBe(`https://storage.googleapis.com/${BUCKET}/dev/customer-display-assets/${VENUE}/s1.png`)
  })

  // Auditoría de Codex, 7ª ronda (P1-6): la v1 armaba `https://storage.googleapis.com//…` con el bucket vacío.
  it('sin bucket NO se entrega ninguna imagen (ni propia ni heredada): nunca una URL inválida', () => {
    const { ficha } = buildEffectiveDesign(
      base({
        bucket: null,
        design: { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }], logoAssetId: 'lg' },
        assets: new Map([
          ['s1', asset('s1', 'SLIDE')],
          ['lg', asset('lg', 'LOGO')],
        ]),
        venue: { logo: `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo.jpg`, updatedAt: new Date() },
      }),
    )
    expect(ficha.slides).toEqual([])
    expect(ficha.logo).toBeNull()
  })

  // La de arriba nunca llega al logo heredado (su diseño trae `logoAssetId`, y el propio válido corta el camino). Ésta
  // sí: sin logo propio, con un `Venue.logo` que BAJO el bucket de prueba se aceptaría, y sin bucket.
  it('sin bucket tampoco sale el logo HEREDADO, aunque con bucket se habría aceptado', () => {
    const logoDelNegocio = `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo.jpg`
    const conBucket = buildEffectiveDesign(base({ venue: { logo: logoDelNegocio, updatedAt: new Date() } })).ficha
    expect(conBucket.logo).toMatchObject({ source: 'venue' })

    const sinBucket = buildEffectiveDesign(base({ bucket: null, venue: { logo: logoDelNegocio, updatedAt: new Date() } })).ficha
    expect(sinBucket.logo).toBeNull()
  })

  // 🔴 La ficha sale de filas YA GUARDADAS y la base no tiene CHECK sobre `accentColor`: sólo lo cuida la validación
  // al escribir. Un valor que no es #RRGGBB (escrito por otro camino) llegaría a la tablet como `#NANNANNAN`, y el
  // parser de color de Android lanza con eso. Se entrega la fábrica del acento, que es lo que ya sabe pintar.
  it('un acento guardado que no es #RRGGBB no viaja: se ven los colores de hoy', () => {
    for (const malo of ['verde', '#12345', '#GGGGGG', '']) {
      const { ficha } = buildEffectiveDesign(base({ design: { ...FACTORY_DESIGN, accentColor: malo } }))
      expect(ficha.accent).toEqual({ custom: false })
    }
  })

  it('la huella se calcula sobre la ficha YA recortada: con y sin plan son distintas', () => {
    const conAssets = {
      design: { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }] },
      assets: new Map([['s1', asset('s1', 'SLIDE')]]),
    }
    const conPlan = buildEffectiveDesign(base(conAssets)).ficha
    const sinPlan = buildEffectiveDesign(base({ ...conAssets, entitlements: { slides: false, promotionCards: false } })).ficha
    expect(conPlan.fingerprint).not.toBe(sinPlan.fingerprint)
  })

  it('la huella sólo depende de lo que SE VE: sin logo heredado, la fecha del venue no entra', () => {
    const a = buildEffectiveDesign(base()).ficha
    const b = buildEffectiveDesign(base({ venue: { logo: null, updatedAt: new Date('2027-01-01T00:00:00Z') } })).ficha
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('cambiar la VERSIÓN del aparato cambia la huella: dos tablets distintas no comparten sobre', () => {
    const conSlide = {
      design: { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }] },
      assets: new Map([['s1', asset('s1', 'SLIDE')]]),
    }
    const v2 = buildEffectiveDesign(base(conSlide)).ficha
    const v1 = buildEffectiveDesign(base({ ...conSlide, terminal: { venueId: VENUE, designVersion: 1 } })).ficha
    expect(v2.fingerprint).not.toBe(v1.fingerprint)
  })

  // Spec §12: la huella se prueba por plan, logo heredado, versión y PROMOTIONS. Cada campo que la tablet pinta tiene
  // que moverla; si uno se queda fuera del hash, la tablet se queda con lo viejo sin enterarse.
  describe('la huella se mueve con todo lo que la tablet pinta', () => {
    const logoDelNegocio = `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo.jpg`

    it('con logo heredado, otra fecha del venue cambia la huella (el objeto legado es mutable: su versión cuenta)', () => {
      const antes = buildEffectiveDesign(base({ venue: { logo: logoDelNegocio, updatedAt: new Date('2026-09-01T00:00:00Z') } })).ficha
      const despues = buildEffectiveDesign(base({ venue: { logo: logoDelNegocio, updatedAt: new Date('2026-09-02T00:00:00Z') } })).ficha
      expect(antes.logo).toMatchObject({ source: 'venue' })
      expect(antes.fingerprint).not.toBe(despues.fingerprint)
    })

    it('con logo heredado, otra URL del logo del negocio cambia la huella', () => {
      const fecha = new Date('2026-09-01T00:00:00Z')
      const a = buildEffectiveDesign(base({ venue: { logo: logoDelNegocio, updatedAt: fecha } })).ficha
      const b = buildEffectiveDesign(
        base({ venue: { logo: `https://storage.googleapis.com/${BUCKET}/prod/venues/cafe/logo-nuevo.jpg`, updatedAt: fecha } }),
      ).ficha
      expect(b.logo).toMatchObject({ source: 'venue' })
      expect(a.fingerprint).not.toBe(b.fingerprint)
    })

    it('PROMOTIONS: sin imágenes, prender o apagar las tarjetas cambia la huella', () => {
      const design = { ...FACTORY_DESIGN, showPromotions: true }
      const con = buildEffectiveDesign(base({ design, entitlements: { slides: true, promotionCards: true } })).ficha
      const sin = buildEffectiveDesign(base({ design, entitlements: { slides: true, promotionCards: false } })).ficha
      expect(con.promotionCards).toEqual({ enabled: true })
      expect(sin.promotionCards).toEqual({ enabled: false })
      expect(con.fingerprint).not.toBe(sin.fingerprint)
    })

    it('otro sha256 en una imagen del carrusel cambia la huella aunque la URL sea la misma', () => {
      const design = { ...FACTORY_DESIGN, slides: [{ assetId: 's1' }] }
      const a = buildEffectiveDesign(base({ design, assets: new Map([['s1', asset('s1', 'SLIDE')]]) })).ficha
      const b = buildEffectiveDesign(base({ design, assets: new Map([['s1', { ...asset('s1', 'SLIDE'), sha256: 'f'.repeat(64) }]]) })).ficha
      expect(a.slides[0].url).toBe(b.slides[0].url)
      expect(a.fingerprint).not.toBe(b.fingerprint)
    })

    it('otro sha256 en el logo propio cambia la huella aunque la URL sea la misma', () => {
      const design = { ...FACTORY_DESIGN, logoAssetId: 'lg' }
      const a = buildEffectiveDesign(base({ design, assets: new Map([['lg', asset('lg', 'LOGO')]]) })).ficha
      const b = buildEffectiveDesign(base({ design, assets: new Map([['lg', { ...asset('lg', 'LOGO'), sha256: 'f'.repeat(64) }]]) })).ficha
      expect(a.logo).toMatchObject({ source: 'asset' })
      expect(a.fingerprint).not.toBe(b.fingerprint)
    })
  })
})
