import { inflateSync } from 'zlib'

/**
 * Decodificador mínimo de PNG para las pruebas.
 *
 * Existe para que las pruebas puedan mirar los PIXELES y no sólo la estructura del
 * archivo. Sin esto, una prueba sólo podría afirmar "es un PNG del tamaño correcto"
 * — y esa afirmación pasa igual con una banda completamente lisa en la que los
 * sellos nunca se dibujaron.
 *
 * Sólo entiende lo que produce nuestro generador: color tipo 2 (RGB), 8 bits, sin
 * entrelazado, con filtro 0 por renglón. No pretende ser un decodificador general.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePixels(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)

  // Recorrer los bloques y juntar los IDAT (nuestro generador emite uno solo,
  // pero concatenar es lo correcto y cuesta lo mismo).
  const idat: Buffer[] = []
  let off = 8
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len))
    if (type === 'IEND') break
    off += 12 + len
  }

  const raw = inflateSync(Buffer.concat(idat))
  const rowSize = 1 + width * 3
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    // Salta el byte de filtro de cada renglón. Nuestro generador siempre usa 0
    // (sin filtro), así que no hay que deshacer ninguna predicción.
    raw.copy(pixels, y * width * 3, y * rowSize + 1, y * rowSize + 1 + width * 3)
  }
  return { width, height, pixels }
}
