/**
 * El sello propio del negocio: una imagen suya en lugar de una forma del catálogo.
 *
 * Lo que se prueba es lo que decidió el founder y lo que puede romperse en silencio:
 *
 * 1. **Una sola subida basta.** La versión "todavía no lo ganas" se genera bajándole
 *    la fuerza, no pidiendo un segundo archivo como hace Loyalz.
 * 2. **Se tiene que NOTAR la diferencia.** Si el apagado quedara demasiado fuerte, la
 *    fila entera se leería como ganada y el cliente no podría contar cuántos lleva —
 *    que es lo único que busca en su tarjeta.
 * 3. **La imagen MANDA sobre la forma.** Si no, un negocio sube su sello, no ve
 *    ningún cambio, y no tiene forma de saber por qué.
 */
import { decodePng } from '../../../../src/services/wallet/pngDecode'
import { stampStripPng } from '../../../../src/services/wallet/stampStripPng'
import { Canvas, hexToRgb } from '../../../../src/services/wallet/pngCanvas'

/** Un sello de prueba: un cuadro naranja macizo, fácil de encontrar entre píxeles. */
function selloNaranja(lado = 64) {
  const c = new Canvas(lado, lado, hexToRgb('#FF6600'))
  return decodePng(c.toPng())!
}

/** Cuántos píxeles de la banda se parecen al naranja del sello, y con qué fuerza. */
function medirNaranja(png: Buffer) {
  const img = decodePng(png)!
  let fuertes = 0
  let tenues = 0
  for (let i = 0; i < img.width * img.height; i++) {
    const r = img.pixels[i * 4]
    const g = img.pixels[i * 4 + 1]
    const b = img.pixels[i * 4 + 2]
    // Naranja: rojo dominante, azul bajo.
    if (r > g && g > b && r > 180) fuertes++
    else if (r > g && g >= b && r > 70 && r <= 180) tenues++
  }
  return { fuertes, tenues }
}

describe('sello propio del negocio', () => {
  it('🔴 la imagen se dibuja: la banda deja de ser sólo fondo', () => {
    const sinImagen = stampStripPng({ width: 300, height: 100, earned: 4, required: 4, shape: 'CIRCLE' as any })
    const conImagen = stampStripPng({ width: 300, height: 100, earned: 4, required: 4, stampImage: selloNaranja() })

    expect(medirNaranja(sinImagen).fuertes).toBe(0)
    expect(medirNaranja(conImagen).fuertes).toBeGreaterThan(100)
  })

  it('🔴 con UNA sola imagen, los ganados y los que faltan se distinguen', () => {
    // Es la decisión del founder frente a Loyalz, que obliga a subir dos archivos.
    const png = stampStripPng({ width: 600, height: 160, earned: 2, required: 6, stampImage: selloNaranja() })

    const { fuertes, tenues } = medirNaranja(png)

    // Los dos ganados salen a plena fuerza…
    expect(fuertes).toBeGreaterThan(50)
    // …y los cuatro que faltan, atenuados. Si esto fuera 0, todos se verían iguales
    // y la cartilla entera parecería completa.
    expect(tenues).toBeGreaterThan(50)
    // Cuatro sellos tenues contra dos fuertes: el área tenue tiene que ser mayor.
    expect(tenues).toBeGreaterThan(fuertes)
  })

  it('🔴 la imagen MANDA sobre la forma del catálogo', () => {
    // Sin esto, el negocio sube su sello, la pantalla sigue mostrando estrellas y no
    // tiene ninguna pista de por qué.
    const conForma = stampStripPng({ width: 300, height: 100, earned: 2, required: 2, shape: 'STAR' as any })
    const conAmbos = stampStripPng({ width: 300, height: 100, earned: 2, required: 2, shape: 'STAR' as any, stampImage: selloNaranja() })

    expect(medirNaranja(conForma).fuertes).toBe(0)
    expect(medirNaranja(conAmbos).fuertes).toBeGreaterThan(100)
  })

  it('una imagen que no se pudo abrir no rompe la banda', () => {
    // `fetchDecodedPng` devuelve null ante un archivo ilegible; aquí se comprueba que
    // el dibujo sigue su curso con la forma del catálogo en vez de fallar.
    const png = stampStripPng({ width: 300, height: 100, earned: 1, required: 3, shape: 'CIRCLE' as any, stampImage: null })

    expect(decodePng(png)).not.toBeNull()
  })

  it('respeta la proporción: un sello alargado no se estira', () => {
    // Deformar el logo de un negocio para llenar un cuadro es de las cosas que más
    // molestan a quien cuidó su marca.
    const ancho = new Canvas(120, 40, hexToRgb('#FF6600'))
    const img = decodePng(ancho.toPng())!

    const png = stampStripPng({ width: 400, height: 200, earned: 1, required: 1, stampImage: img })
    const salida = decodePng(png)!

    // El sello ocupa 3 veces más ancho que alto, así que la fila central debe tener
    // muchos más píxeles naranjas que la columna central.
    const filaCentral = Array.from({ length: salida.width }, (_, x) => {
      const i = (Math.floor(salida.height / 2) * salida.width + x) * 4
      return salida.pixels[i] > 180 && salida.pixels[i + 2] < 120
    }).filter(Boolean).length
    const columnaCentral = Array.from({ length: salida.height }, (_, y) => {
      const i = (y * salida.width + Math.floor(salida.width / 2)) * 4
      return salida.pixels[i] > 180 && salida.pixels[i + 2] < 120
    }).filter(Boolean).length

    expect(filaCentral).toBeGreaterThan(columnaCentral * 2)
  })
})
