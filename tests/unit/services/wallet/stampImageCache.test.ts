/**
 * El sello propio del negocio se procesa UNA vez, no en cada descarga.
 *
 * 🔴 El defecto (medido en producción, 12 y 13-sep-2026): bajar la tarjeta de Apple de
 * Testarudo congelaba el servidor 2.2–2.5 s. El aviso `[event-loop] hilo retenido` tenía una
 * sola petición en curso: `GET .../wallet/apple/...`. Con las imágenes reales de Testarudo:
 *
 *   decodificar su sello (2225×2550 px) ........ 358 ms   58%
 *   pegarlo 8 veces en la franja, dos tamaños ... 242 ms   39%
 *   firmar con node-forge ........................  ~30 ms    5%
 *
 * Todo síncrono, en el hilo que atiende los cobros. Y el sello nunca se pinta a más de ~156 px
 * (un solo sello en la banda de 750×246): se abrían 5.6 millones de píxeles para dibujar una
 * estampita, y `drawImage` los recorría completos en cada uno de los 16 sellos.
 *
 * Lo que se prueba:
 *
 * 1. **Se ve IGUAL.** La imagen se reduce con el MISMO promedio ponderado por alfa que usa
 *    `drawImage`, así que la franja sale prácticamente idéntica. Una optimización que cambia el
 *    dibujo del negocio no es una optimización.
 * 2. **Nunca muestra la imagen vieja.** La imagen se guarda siempre en la MISMA dirección
 *    (`.../wallet/stamp.png`): subir otra la sobrescribe. Por eso la llave es el CONTENIDO,
 *    no la URL — un caché por URL enseñaría el sello anterior para siempre.
 * 3. **Tiene tope.** Un caché sin límite es una fuga de memoria con otro nombre.
 */
import { createHash } from 'crypto'
import { decodePng, type DecodedPng } from '../../../../src/services/wallet/pngDecode'
import * as pngDecodeModule from '../../../../src/services/wallet/pngDecode'
import { Canvas, hexToRgb, reducirImagen } from '../../../../src/services/wallet/pngCanvas'
import { stampStripPng } from '../../../../src/services/wallet/stampStripPng'
import { CACHE_SELLOS_MAX, fetchDecodedPng, limpiarCacheDeSellos, MAX_LADO_SELLO } from '../../../../src/services/wallet/remotePng'

// ---------------------------------------------------------------- imágenes de prueba

/** RGBA a mano, para poder poner transparencia (el lienzo del proyecto sólo hace RGB). */
function rgba(width: number, height: number, pinta: (x: number, y: number) => [number, number, number, number]): DecodedPng {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pinta(x, y)
      const i = (y * width + x) * 4
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = a
    }
  }
  return { width, height, pixels }
}

/**
 * Un sello como los que suben los negocios: fondo transparente, una taza de borde suave
 * (antialias), un aro grueso, un degradado y un trazo tipo letra. Mismas proporciones que el de
 * Testarudo (2225×2550), a escala.
 */
function selloRealista(width = 1335, height = 1530): DecodedPng {
  const cx = width / 2
  const cy = height / 2
  const R = Math.min(width, height) * 0.45
  const suave = (v: number) => Math.max(0, Math.min(1, v + 0.5))
  return rgba(width, height, (x, y) => {
    const d = Math.hypot(x - cx, y - cy)
    const disco = suave(R - d)
    if (disco <= 0) return [0, 0, 0, 0]
    const aro = suave(R * 0.08 - Math.abs(d - R * 0.8)) // aro grueso
    const trazo = suave(R * 0.06 - Math.abs(x - cx - (y - cy) * 0.3)) // una diagonal tipo letra
    const k = Math.max(aro, trazo)
    const base: [number, number, number] = [110, Math.round(60 + (y / height) * 80), 40] // café en degradado
    const tinta: [number, number, number] = [250, 240, 220]
    const mezcla = base.map((c, i) => Math.round(c + (tinta[i] - c) * k))
    return [mezcla[0], mezcla[1], mezcla[2], Math.round(disco * 255)]
  })
}

/**
 * El caso tortura: rayas de 9 px, casi del tamaño del bloque que promedia `drawImage` al pintar un
 * solo sello (~10 px). Genera moiré, y el moiré cae distinto al reducir en dos pasos que en uno.
 */
function selloDeRayasFinas(width = 1335, height = 1530): DecodedPng {
  const cx = width / 2
  const cy = height / 2
  const R = Math.min(width, height) * 0.45
  return rgba(width, height, (x, y) => {
    const cobertura = Math.max(0, Math.min(1, R - Math.hypot(x - cx, y - cy) + 0.5))
    if (cobertura <= 0) return [0, 0, 0, 0]
    const raya = Math.floor(y / 9) % 2 === 0
    return [raya ? 240 : 120, Math.round((x / width) * 255), Math.round((y / height) * 200), Math.round(cobertura * 255)]
  })
}

/** Bytes PNG de un color liso: sirven para que `fetch` devuelva algo distinto por prueba. */
function pngLiso(hex: string, lado = 4): Buffer {
  return new Canvas(lado, lado, hexToRgb(hex)).toPng()
}

function simularFetch(...respuestas: Buffer[]) {
  let i = 0
  const mock = jest.fn(async () => {
    const bytes = respuestas[Math.min(i++, respuestas.length - 1)]
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })
  ;(global as any).fetch = mock
  return mock
}

/** Cuánto difieren dos franjas, píxel por píxel y canal por canal. */
function diferencia(a: Buffer, b: Buffer) {
  const A = decodePng(a)!
  const B = decodePng(b)!
  expect([A.width, A.height]).toEqual([B.width, B.height])
  let suma = 0
  let grandes = 0
  let maxima = 0
  const canales = A.width * A.height * 3
  for (let p = 0; p < A.width * A.height; p++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.pixels[p * 4 + c] - B.pixels[p * 4 + c])
      suma += d
      if (d > 16) grandes++
      if (d > maxima) maxima = d
    }
  }
  return { media: suma / canales, proporcionGrandes: grandes / canales, maxima }
}

const URL_SELLO = 'https://storage.example/prod/venues/testarudo-cafe/wallet/stamp.png'

// ------------------------------------------------------------------------- pruebas

describe('reducirImagen — el sello se achica al tamaño en que de verdad se pinta', () => {
  it('una imagen que ya cabe se devuelve tal cual, sin copiarla', () => {
    const chica = rgba(100, 80, () => [10, 20, 30, 255])
    expect(reducirImagen(chica, 320)).toBe(chica)
  })

  it('una imagen grande queda con su lado mayor igual al tope y conserva la proporción', () => {
    const grande = rgba(2225, 2550, () => [10, 20, 30, 255])
    const reducida = reducirImagen(grande, 320)
    expect(reducida.height).toBe(320)
    expect(reducida.width).toBe(279) // 2225 × 320 / 2550 = 279.2
    expect(reducida.pixels.length).toBe(279 * 320 * 4)
  })

  it('🔴 PROMEDIA los píxeles de cada bloque — no toma uno solo (eso cambiaría el dibujo)', () => {
    // Tablero de 1 px, negro y blanco. Promediar cada bloque de 4×4 da gris; tomar un píxel
    // (vecino más cercano) daría negro o blanco puro, y un sello con letras finas se vería dentado.
    const tablero = rgba(400, 400, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    const r = reducirImagen(tablero, 100)
    for (let p = 0; p < r.width * r.height; p++) {
      expect(Math.abs(r.pixels[p * 4] - 128)).toBeLessThanOrEqual(1)
      expect(r.pixels[p * 4 + 3]).toBe(255)
    }
  })

  it('🔴 lo transparente sigue transparente y el borde NO se oscurece (sin halo negro)', () => {
    // Transparente —y en negro, como lo dejan casi todos los exportadores— hasta x=202, rojo macizo
    // después. De 400 a 100 cada bloque mide 4 px, así que el bloque 50 (x 200..203) queda MITAD
    // transparente y MITAD rojo: justo el píxel donde un promedio sin ponderar por alfa mete el negro.
    const img = rgba(400, 400, x => (x < 202 ? [0, 0, 0, 0] : [255, 0, 0, 255]))
    const r = reducirImagen(img, 100)
    for (let y = 0; y < r.height; y++) {
      const borde = (y * r.width + 50) * 4
      expect(r.pixels[borde + 3]).toBe(128) // mitad cubierto
      expect(r.pixels[borde]).toBe(255) // y ROJO puro, no 128
      for (let x = 0; x < 50; x++) expect(r.pixels[(y * r.width + x) * 4 + 3]).toBe(0)
    }
  })

  const base = { width: 750, height: 246, bgHex: '#1f2937', filledHex: '#84cc16', emptyHex: '#374151' }

  it.each([
    ['un solo sello (el más grande posible)', 1, 1],
    ['cartilla de 8, a medias (la de Testarudo)', 8, 3],
    ['cartilla de 24, llena', 24, 24],
  ])('🔴 la franja se ve IGUAL con el sello reducido que con el original — %s', (_n, required, earned) => {
    const original = selloRealista()
    const reducida = reducirImagen(original, MAX_LADO_SELLO)

    const d = diferencia(
      stampStripPng({ ...base, earned, required, stampImage: original }),
      stampStripPng({ ...base, earned, required, stampImage: reducida }),
    )

    // Medio nivel de 255 en promedio, y casi ningún canal se aleja más de 16: la misma franja.
    // (Con el sello REAL de Testarudo, medido: media 0.025 y 0.00% por encima de 16.)
    expect(d.media).toBeLessThan(0.5)
    expect(d.proporcionGrandes).toBeLessThan(0.005)
  })

  it('con rayas casi del tamaño del muestreo, el tono promedio se conserva aunque el moiré cambie', () => {
    // 🔴 Esta prueba NO exige el 0.5% de arriba, y es a propósito. Medido con este patrón y un solo
    // sello: 1.34% de canales cambian más de 16 niveles con tope 320, 0.93% con 480 y 0.82% con 640
    // — NO converge a cero subiendo el tope. No es detalle perdido: es el moiré de un patrón que
    // cae justo en la frecuencia del muestreo, y ninguna reducción previa lo reproduce idéntico.
    // Lo que sí debe mantenerse es cómo se ve de conjunto.
    const original = selloDeRayasFinas()
    const d = diferencia(
      stampStripPng({ ...base, earned: 1, required: 1, stampImage: original }),
      stampStripPng({ ...base, earned: 1, required: 1, stampImage: reducirImagen(original, MAX_LADO_SELLO) }),
    )
    expect(d.media).toBeLessThan(1)
    expect(d.proporcionGrandes).toBeLessThan(0.02)
  })
})

describe('fetchDecodedPng — el sello se abre UNA vez, no en cada descarga', () => {
  beforeEach(() => {
    limpiarCacheDeSellos()
    jest.restoreAllMocks()
  })

  it('los mismos bytes dos veces se decodifican UNA sola vez', async () => {
    simularFetch(pngLiso('#FF6600'))
    const abrir = jest.spyOn(pngDecodeModule, 'decodePng')

    const primera = await fetchDecodedPng(URL_SELLO)
    const segunda = await fetchDecodedPng(URL_SELLO)

    expect(primera).not.toBeNull()
    expect(segunda).toBe(primera)
    expect(abrir).toHaveBeenCalledTimes(1)
  })

  it('🔴 si el negocio sube OTRA imagen a la MISMA dirección, se usa la nueva — nunca la vieja', async () => {
    // `.../wallet/stamp.png` se sobrescribe al subir: la URL no cambia, los bytes sí.
    simularFetch(pngLiso('#FF0000'), pngLiso('#0000FF'))
    const abrir = jest.spyOn(pngDecodeModule, 'decodePng')

    const vieja = await fetchDecodedPng(URL_SELLO)
    const nueva = await fetchDecodedPng(URL_SELLO)

    expect([vieja!.pixels[0], vieja!.pixels[2]]).toEqual([255, 0])
    expect([nueva!.pixels[0], nueva!.pixels[2]]).toEqual([0, 255])
    expect(abrir).toHaveBeenCalledTimes(2)
  })

  it('devuelve el sello ya reducido al tope', async () => {
    simularFetch(new Canvas(1000, 1200, hexToRgb('#336699')).toPng())

    const sello = await fetchDecodedPng(URL_SELLO)

    expect(Math.max(sello!.width, sello!.height)).toBe(MAX_LADO_SELLO)
  })

  it('una imagen que no se pudo abrir NO se guarda: la siguiente descarga lo vuelve a intentar', async () => {
    // Firma PNG válida y basura después: pasa `isPng` pero no abre.
    const rota = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('basura')])
    simularFetch(rota)
    const abrir = jest.spyOn(pngDecodeModule, 'decodePng')

    expect(await fetchDecodedPng(URL_SELLO)).toBeNull()
    expect(await fetchDecodedPng(URL_SELLO)).toBeNull()
    expect(abrir).toHaveBeenCalledTimes(2)
  })

  it('🔴 el caché tiene tope: no crece sin límite', async () => {
    const colores = Array.from({ length: CACHE_SELLOS_MAX + 1 }, (_, i) => `#${(i * 7919 + 4096).toString(16).padStart(6, '0').slice(-6)}`)
    const bytes = colores.map(c => pngLiso(c))
    expect(new Set(bytes.map(b => createHash('sha1').update(b).digest('hex'))).size).toBe(bytes.length)
    simularFetch(...bytes, bytes[0])
    const abrir = jest.spyOn(pngDecodeModule, 'decodePng')

    for (let i = 0; i < bytes.length; i++) await fetchDecodedPng(`${URL_SELLO}?n=${i}`)
    await fetchDecodedPng(`${URL_SELLO}?n=0`) // el primero ya salió del caché

    expect(abrir).toHaveBeenCalledTimes(bytes.length + 1)
  })

  it('sin URL no baja nada', async () => {
    const mock = simularFetch(pngLiso('#FF6600'))
    expect(await fetchDecodedPng(null)).toBeNull()
    expect(mock).not.toHaveBeenCalled()
  })
})
