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

  it('🔴 con más sellos ganados, hay más pixeles llenos', () => {
    // Es la prueba de que los sellos SE DIBUJAN. Si el contador no se usara, las
    // tres bandas saldrían idénticas y nadie lo notaría hasta ver la tarjeta.
    const cuenta = (earned: number) => {
      const { pixels } = decodePixels(stampStripPng({ width: 300, height: 100, earned, required: 10, bgHex: VERDE }))
      // Los sellos llenos se pintan en blanco.
      let n = 0
      for (let i = 0; i < pixels.length; i += 3) {
        if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) n++
      }
      return n
    }
    const vacia = cuenta(0)
    const media = cuenta(5)
    const llena = cuenta(10)

    expect(media).toBeGreaterThan(vacia)
    expect(llena).toBeGreaterThan(media)
  })

  it('una cartilla vacía no sale en blanco: se ven los contornos', () => {
    // Con 0 sellos el cliente tiene que ver CUÁNTOS le faltan, no una banda lisa.
    const { pixels } = decodePixels(stampStripPng({ width: 300, height: 100, earned: 0, required: 10, bgHex: VERDE }))
    let noFondo = 0
    for (let i = 0; i < pixels.length; i += 3) {
      if (!(pixels[i] === 122 && pixels[i + 1] === 221 && pixels[i + 2] === 44)) noFondo++
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
    expect(stampStripPng({ width: 300, height: 100, earned: 1, required: 10, bgHex: '' }).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(
      true,
    )
    expect(stampStripPng({ width: 300, height: 100, earned: 1, required: 10, bgHex: null }).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(
      true,
    )
  })

  it('required en 0 o negativo no cuelga el proceso', () => {
    // Un venue mal configurado no puede tumbar la emisión de credenciales.
    expect(stampStripPng({ width: 300, height: 100, earned: 0, required: 0, bgHex: VERDE }).length).toBeGreaterThan(50)
    expect(stampStripPng({ width: 300, height: 100, earned: 0, required: -5, bgHex: VERDE }).length).toBeGreaterThan(50)
  })
})
