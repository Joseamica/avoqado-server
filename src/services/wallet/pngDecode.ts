import { inflateSync } from 'zlib'

/**
 * Abre un PNG y devuelve sus pixeles.
 *
 * 🔴 Existe para que el negocio pueda subir SU propio sello. Hasta aqui los sellos se
 * dibujaban desde cero, y dibujar es facil; meter una imagen ajena en la banda obliga
 * a abrirla de verdad. La alternativa era agregar `sharp` — un binario nativo por
 * plataforma — al camino que emite credenciales, y un fallo de instalacion ahi
 * significa que ningun cliente puede descargar su tarjeta. No vale el atajo.
 *
 * Un PNG es: 8 bytes de firma y luego trozos con nombre. Los que importan son IHDR
 * (medidas y formato), PLTE y tRNS (la paleta, si la hay) e IDAT (los pixeles,
 * comprimidos con zlib). Al descomprimir, cada FILA empieza con un byte que dice con
 * que filtro se codifico — y hay que deshacerlo fila por fila, porque cada una se
 * predice a partir de la anterior.
 *
 * Se soportan las formas que produce cualquier exportador de hoy: color verdadero con
 * y sin alfa, grises con y sin alfa, y paleta. Queda fuera el entrelazado (Adam7),
 * que casi nadie genera y cuesta el doble; se rechaza con un mensaje que dice que
 * hacer, en vez de devolver una imagen corrupta.
 */

export interface DecodedPng {
  width: number
  height: number
  /** RGBA, 4 bytes por pixel, fila por fila. */
  pixels: Buffer
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Predictor de Paeth: elige el vecino que mejor explica el pixel. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export function decodePng(buffer: Buffer): DecodedPng | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let paleta: Buffer | null = null
  let alfaPaleta: Buffer | null = null
  const idat: Buffer[] = []

  let off = 8
  while (off + 8 <= buffer.length) {
    const largo = buffer.readUInt32BE(off)
    const tipo = buffer.subarray(off + 4, off + 8).toString('ascii')
    const datos = buffer.subarray(off + 8, off + 8 + largo)
    // +12 = longitud (4) + nombre (4) + crc (4). El crc no se verifica: lo que
    // importa es que zlib logre descomprimir, que es una comprobación más fuerte.
    off += 12 + largo

    if (tipo === 'IHDR') {
      width = datos.readUInt32BE(0)
      height = datos.readUInt32BE(4)
      bitDepth = datos[8]
      colorType = datos[9]
      interlace = datos[12]
    } else if (tipo === 'PLTE') {
      paleta = Buffer.from(datos)
    } else if (tipo === 'tRNS') {
      alfaPaleta = Buffer.from(datos)
    } else if (tipo === 'IDAT') {
      idat.push(Buffer.from(datos))
    } else if (tipo === 'IEND') {
      break
    }
  }

  if (!width || !height || !idat.length) return null
  // 🔴 Sólo 8 bits por canal y sin entrelazar. Lo demás se rechaza en vez de
  // devolver píxeles equivocados: una imagen mal decodificada sale como ruido en
  // la tarjeta de un cliente y nadie relaciona el defecto con la subida.
  if (bitDepth !== 8 || interlace !== 0) return null

  const canales = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (!canales) return null
  if (colorType === 3 && !paleta) return null

  let crudo: Buffer
  try {
    crudo = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }

  const anchoFila = width * canales
  if (crudo.length < (anchoFila + 1) * height) return null

  // ── Deshacer los filtros ────────────────────────────────────────────────
  const sinFiltro = Buffer.alloc(anchoFila * height)
  for (let y = 0; y < height; y++) {
    const filtro = crudo[y * (anchoFila + 1)]
    const entrada = crudo.subarray(y * (anchoFila + 1) + 1, (y + 1) * (anchoFila + 1))
    const salida = sinFiltro.subarray(y * anchoFila, (y + 1) * anchoFila)
    const arriba = y > 0 ? sinFiltro.subarray((y - 1) * anchoFila, y * anchoFila) : null

    for (let i = 0; i < anchoFila; i++) {
      const izq = i >= canales ? salida[i - canales] : 0
      const arr = arriba ? arriba[i] : 0
      const diag = arriba && i >= canales ? arriba[i - canales] : 0
      const v = entrada[i]
      switch (filtro) {
        case 0:
          salida[i] = v
          break
        case 1:
          salida[i] = (v + izq) & 0xff
          break
        case 2:
          salida[i] = (v + arr) & 0xff
          break
        case 3:
          salida[i] = (v + ((izq + arr) >> 1)) & 0xff
          break
        case 4:
          salida[i] = (v + paeth(izq, arr, diag)) & 0xff
          break
        default:
          return null
      }
    }
  }

  // ── Normalizar a RGBA ───────────────────────────────────────────────────
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * canales
    const d = i * 4
    if (colorType === 6) {
      sinFiltro.copy(pixels, d, s, s + 4)
    } else if (colorType === 2) {
      pixels[d] = sinFiltro[s]
      pixels[d + 1] = sinFiltro[s + 1]
      pixels[d + 2] = sinFiltro[s + 2]
      pixels[d + 3] = 255
    } else if (colorType === 0) {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = sinFiltro[s]
      pixels[d + 3] = 255
    } else if (colorType === 4) {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = sinFiltro[s]
      pixels[d + 3] = sinFiltro[s + 1]
    } else {
      const idx = sinFiltro[s]
      const p = idx * 3
      if (!paleta || p + 2 >= paleta.length) return null
      pixels[d] = paleta[p]
      pixels[d + 1] = paleta[p + 1]
      pixels[d + 2] = paleta[p + 2]
      // tRNS de una paleta trae una transparencia por entrada; las que no vienen
      // listadas son opacas.
      pixels[d + 3] = alfaPaleta && idx < alfaPaleta.length ? alfaPaleta[idx] : 255
    }
  }

  return { width, height, pixels }
}
