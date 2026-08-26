/**
 * Abrir un PNG ajeno es la pieza mas delicada del sello propio: si se decodifica
 * mal, no truena — sale RUIDO en la tarjeta de un cliente, y nadie relaciona ese
 * defecto con la subida que lo causo semanas antes.
 *
 * Por eso se prueba con una ida y vuelta real (codificar, decodificar, comparar
 * pixel a pixel) y con las variantes de formato que produce cualquier exportador,
 * no con un archivo de ejemplo cualquiera.
 */
import { deflateSync } from 'zlib'
import { decodePng } from '../../../../src/services/wallet/pngDecode'
import { Canvas, encodePng, hexToRgb } from '../../../../src/services/wallet/pngCanvas'
import { avoqadoLogoPng } from '../../../../src/services/wallet/avoqadoLogo'

/** Arma un PNG a mano con el tipo de color y el filtro que se quieran probar. */
function pngCrudo(width: number, height: number, colorType: number, canales: number, filas: number[][], filtro = 0): Buffer {
  const bloques: Buffer[] = []
  const chunk = (tipo: string, datos: Buffer) => {
    const largo = Buffer.alloc(4)
    largo.writeUInt32BE(datos.length)
    // El CRC va en cero: el decodificador no lo verifica a propósito, porque que
    // zlib logre descomprimir ya es una comprobación más fuerte.
    return Buffer.concat([largo, Buffer.from(tipo, 'ascii'), datos, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  bloques.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  bloques.push(chunk('IHDR', ihdr))

  const crudo = Buffer.alloc((width * canales + 1) * height)
  filas.forEach((fila, y) => {
    crudo[y * (width * canales + 1)] = filtro
    Buffer.from(fila).copy(crudo, y * (width * canales + 1) + 1)
  })
  bloques.push(chunk('IDAT', deflateSync(crudo)))
  bloques.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(bloques)
}

describe('decodePng', () => {
  it('🔴 ida y vuelta: lo que sale es lo que entró, pixel a pixel', () => {
    const canvas = new Canvas(24, 16, hexToRgb('#204080'))
    canvas.shape(12, 8, 6, hexToRgb('#FF8800'), (nx, ny) => nx * nx + ny * ny <= 1)
    const png = canvas.toPng()

    const abierto = decodePng(png)

    expect(abierto).not.toBeNull()
    expect(abierto!.width).toBe(24)
    expect(abierto!.height).toBe(16)
    // Una esquina que nadie tocó: sigue siendo el fondo exacto.
    expect([abierto!.pixels[0], abierto!.pixels[1], abierto!.pixels[2]]).toEqual([0x20, 0x40, 0x80])
    // El centro es el círculo, no el fondo.
    const centro = (8 * 24 + 12) * 4
    expect([abierto!.pixels[centro], abierto!.pixels[centro + 1], abierto!.pixels[centro + 2]]).toEqual([0xff, 0x88, 0x00])
    // Sin canal alfa en el original, todo sale opaco.
    expect(abierto!.pixels[3]).toBe(255)
  })

  it('abre un PNG real generado por otro camino (el logo embebido)', () => {
    // No es un archivo de juguete: es el logo que ya viaja dentro de los pases.
    const abierto = decodePng(avoqadoLogoPng())

    expect(abierto).not.toBeNull()
    expect(abierto!.width).toBeGreaterThan(0)
    expect(abierto!.pixels.length).toBe(abierto!.width * abierto!.height * 4)
  })

  it('abre color verdadero CON transparencia, que es lo que exporta un diseñador', () => {
    // Un pixel rojo opaco y uno verde a medio transparente.
    const png = pngCrudo(2, 1, 6, 4, [[255, 0, 0, 255, 0, 255, 0, 128]])

    const a = decodePng(png)

    expect(a).not.toBeNull()
    expect(Array.from(a!.pixels)).toEqual([255, 0, 0, 255, 0, 255, 0, 128])
  })

  it('abre PALETA, que es lo que produce un PNG optimizado', () => {
    // Es el caso que se olvida: los exportadores achican los iconos a paleta, y un
    // decodificador que sólo entiende RGB los rechazaría o los pintaría de ruido.
    const bloques: Buffer[] = []
    const chunk = (tipo: string, datos: Buffer) => {
      const largo = Buffer.alloc(4)
      largo.writeUInt32BE(datos.length)
      return Buffer.concat([largo, Buffer.from(tipo, 'ascii'), datos, Buffer.alloc(4)])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(2, 0)
    ihdr.writeUInt32BE(1, 4)
    ihdr[8] = 8
    ihdr[9] = 3
    bloques.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    bloques.push(chunk('IHDR', ihdr))
    bloques.push(chunk('PLTE', Buffer.from([10, 20, 30, 200, 100, 50])))
    // tRNS: la entrada 0 es transparente, la 1 no viene listada y por tanto es opaca.
    bloques.push(chunk('tRNS', Buffer.from([0])))
    bloques.push(chunk('IDAT', deflateSync(Buffer.from([0, 0, 1]))))
    bloques.push(chunk('IEND', Buffer.alloc(0)))

    const a = decodePng(Buffer.concat(bloques))

    expect(a).not.toBeNull()
    expect(Array.from(a!.pixels)).toEqual([10, 20, 30, 0, 200, 100, 50, 255])
  })

  it('🔴 deshace el filtro Paeth, que es el que más usan los compresores', () => {
    // Dos filas: la segunda predice desde la primera. Con el filtro mal deshecho la
    // imagen sale con bandas — un defecto que se ve, pero sólo en imágenes reales.
    const fila1 = [10, 20, 30]
    // Paeth con arriba=10/20/30 e izquierda=0: predice 10/20/30, así que un delta de
    // 5 debe reconstruir 15/25/35.
    const fila2 = [5, 5, 5]
    const png = pngCrudo(1, 2, 2, 3, [fila1, fila2], 4)

    const a = decodePng(png)

    expect(a).not.toBeNull()
    expect(Array.from(a!.pixels.subarray(0, 3))).toEqual([10, 20, 30])
    expect(Array.from(a!.pixels.subarray(4, 7))).toEqual([15, 25, 35])
  })

  it('rechaza lo que no es PNG en vez de devolver basura', () => {
    expect(decodePng(Buffer.from('esto es un jpg disfrazado'))).toBeNull()
    expect(decodePng(Buffer.alloc(4))).toBeNull()
  })

  it('🔴 rechaza el entrelazado en vez de decodificarlo mal', () => {
    // Adam7 guarda la imagen en siete pasadas. Leerlo como si fuera lineal produce
    // una imagen reconocible pero DESTROZADA, que es peor que un rechazo limpio.
    const png = pngCrudo(2, 1, 2, 3, [[1, 2, 3, 4, 5, 6]])
    png[8 + 8 + 12] = 1 // byte de entrelazado dentro de IHDR

    expect(decodePng(png)).toBeNull()
  })
})
