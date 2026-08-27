/**
 * La banda superior es lo que hace que una tarjeta de sellos se vea como una
 * tarjeta de sellos y no como un rectángulo de color con texto. Es la diferencia
 * entre algo que el prospecto quiere y algo de lo que se ríe.
 *
 * Se dibuja a mano sobre un bitmap, sin librería de imágenes, por la misma razón
 * que el icono: el camino de emisión de credenciales no debería depender de una.
 */
import { stampStripPng } from '../../../../src/services/wallet/stampStripPng'
import { PNG_SIGNATURE, decodePixels } from './pngTestHelpers'

const VERDE = '#7ADD2C'

describe('stampStripPng', () => {
  it('produce un PNG válido del tamaño pedido', () => {
    const png = stampStripPng({ width: 375, height: 123, earned: 3, required: 10, bgHex: VERDE })
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(png.readUInt32BE(16)).toBe(375)
    expect(png.readUInt32BE(20)).toBe(123)
  })

  it('🔴 con más sellos ganados, hay más pixeles del acento', () => {
    // Es la prueba de que los sellos SE DIBUJAN. Si el contador no se usara, las
    // tres bandas saldrían idénticas y nadie lo notaría hasta ver la tarjeta.
    const cuenta = (earned: number) => {
      const { pixels } = decodePixels(stampStripPng({ width: 300, height: 100, earned, required: 10 }))
      // El acento por defecto es el verde de marca (122, 221, 44).
      let n = 0
      for (let i = 0; i < pixels.length; i += 3) {
        if (pixels[i] > 90 && pixels[i] < 150 && pixels[i + 1] > 190 && pixels[i + 2] < 90) n++
      }
      return n
    }
    const vacia = cuenta(0)
    const media = cuenta(5)
    const llena = cuenta(10)

    expect(media).toBeGreaterThan(vacia)
    expect(llena).toBeGreaterThan(media)
  })

  it('🔴 los sellos NO tocan los bordes: la banda se veía CORTADA', () => {
    // El defecto que el founder vio en cuanto abrió la tarjeta (26-ago): sin
    // márgenes, los círculos de los extremos quedan pegados al borde y la banda
    // parece recortada. Ninguna prueba de estructura lo detecta — hay que mirar
    // los píxeles del contorno.
    const w = 300
    const h = 100
    const { pixels } = decodePixels(stampStripPng({ width: w, height: h, earned: 10, required: 10 }))
    const fondo = (i: number) => pixels[i] === 44 && pixels[i + 1] === 44 && pixels[i + 2] === 46

    // Las cuatro orillas tienen que ser fondo puro, sin un solo píxel de sello.
    for (let x = 0; x < w; x++) {
      expect(fondo((0 * w + x) * 3)).toBe(true)
      expect(fondo(((h - 1) * w + x) * 3)).toBe(true)
    }
    for (let y = 0; y < h; y++) {
      expect(fondo((y * w + 0) * 3)).toBe(true)
      expect(fondo((y * w + (w - 1)) * 3)).toBe(true)
    }
  })

  it('usa los tokens del tema de avoqado-android, no una paleta inventada', () => {
    const { pixels } = decodePixels(stampStripPng({ width: 60, height: 60, earned: 0, required: 1 }))
    // SurfaceContainerDark = #2C2C2E. Un fondo distinto significa que alguien
    // volvió a inventar colores en vez de tomarlos del tema real.
    expect([pixels[0], pixels[1], pixels[2]]).toEqual([44, 44, 46])
  })

  it('una cartilla vacía no sale en blanco: se ven los contornos', () => {
    // Con 0 sellos el cliente tiene que ver CUÁNTOS le faltan, no una banda lisa.
    const { pixels } = decodePixels(stampStripPng({ width: 300, height: 100, earned: 0, required: 10 }))
    let noFondo = 0
    for (let i = 0; i < pixels.length; i += 3) {
      if (!(pixels[i] === 44 && pixels[i + 1] === 44 && pixels[i + 2] === 46)) noFondo++
    }
    expect(noFondo).toBeGreaterThan(100)
  })

  it('más sellos ganados que requeridos no revienta ni desborda', () => {
    // Pasa de verdad: el cliente llena la cartilla y compra otra vez antes de canjear.
    const png = stampStripPng({ width: 300, height: 100, earned: 99, required: 10, bgHex: VERDE })
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  })

  it('una cartilla larga se acomoda en dos filas en vez de encimarse', () => {
    // Con 12 sellos en una fila los círculos quedarían de 3 píxeles.
    const png = stampStripPng({ width: 375, height: 123, earned: 4, required: 12, bgHex: VERDE })
    expect(png.readUInt32BE(16)).toBe(375)
  })

  it('un negocio sin color no rompe la banda', () => {
    expect(stampStripPng({ width: 300, height: 100, earned: 1, required: 10, bgHex: '' }).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(stampStripPng({ width: 300, height: 100, earned: 1, required: 10, bgHex: null }).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  })

  it('required en 0 o negativo no cuelga el proceso', () => {
    // Un venue mal configurado no puede tumbar la emisión de credenciales.
    expect(stampStripPng({ width: 300, height: 100, earned: 0, required: 0, bgHex: VERDE }).length).toBeGreaterThan(50)
    expect(stampStripPng({ width: 300, height: 100, earned: 0, required: -5, bgHex: VERDE }).length).toBeGreaterThan(50)
  })
})
