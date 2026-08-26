import { deflateSync } from 'zlib'

/**
 * Primitivas para escribir PNG a mano, compartidas por el icono y la banda de sellos.
 *
 * Existen porque el camino de emisión de credenciales no debería depender de una
 * librería de imágenes: un `.pkpass` necesita PNG obligatoriamente, y meter `sharp`
 * (binarios nativos por plataforma) para pintar círculos y cuadros de color sería
 * pagar un precio alto por algo que `zlib` ya permite.
 */

export type Rgb = [number, number, number]

/** Verde de marca de Avoqado, para negocios sin color propio configurado. */
export const FALLBACK_RGB: Rgb = [122, 221, 44]

/** Tabla de CRC-32 del estándar PNG. */
const CRC_TABLE: number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/**
 * CRC-32 propio en vez de `zlib.crc32`: esa función llegó tarde a la rama 20 de
 * Node y el `package.json` declara `node: 20.x`. Un servidor con un Node 20
 * anterior fallaría en runtime justo al emitir un pase.
 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([len, typeAndData, crc])
}

/** `#7ADD2C` / `7ADD2C` → [122, 221, 44]. Cualquier otra cosa cae al respaldo. */
export function hexToRgb(hex: string | null | undefined, fallback: Rgb = FALLBACK_RGB): Rgb {
  if (!hex) return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Mezcla dos colores. `t` va de 0 (todo `a`) a 1 (todo `b`). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)]
}

/**
 * Empaqueta un búfer de píxeles RGB (3 bytes por píxel, sin relleno) como PNG.
 * Color tipo 2, 8 bits, sin entrelazado, filtro 0 en cada renglón.
 */
export function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 2 // RGB verdadero
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Cada renglón del PNG empieza con su byte de filtro; el búfer de píxeles no
  // lo trae, así que hay que intercalarlo.
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0
    pixels.copy(raw, y * rowSize + 1, y * width * 3, (y + 1) * width * 3)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Lienzo de píxeles RGB con lo mínimo para dibujar una banda de sellos. */
export class Canvas {
  readonly pixels: Buffer

  constructor(
    readonly width: number,
    readonly height: number,
    fill: Rgb,
  ) {
    this.pixels = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) {
      this.pixels[i * 3] = fill[0]
      this.pixels[i * 3 + 1] = fill[1]
      this.pixels[i * 3 + 2] = fill[2]
    }
  }

  private blend(x: number, y: number, color: Rgb, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return
    const i = (y * this.width + x) * 3
    const a = Math.min(1, alpha)
    this.pixels[i] = Math.round(this.pixels[i] * (1 - a) + color[0] * a)
    this.pixels[i + 1] = Math.round(this.pixels[i + 1] * (1 - a) + color[1] * a)
    this.pixels[i + 2] = Math.round(this.pixels[i + 2] * (1 - a) + color[2] * a)
  }

  /**
   * Dibuja un círculo (relleno o de contorno) con bordes suaves.
   *
   * 🔴 El suavizado NO es un lujo: sin él, un círculo de 30 píxeles se ve como una
   * escalera, y una tarjeta con diez escaleras parece rota, no minimalista. Se hace
   * muestreando 3×3 subpuntos por píxel y promediando cuántos caen dentro — más
   * barato que cualquier alternativa y suficiente a este tamaño.
   */
  circle(cx: number, cy: number, radius: number, color: Rgb, opts: { strokeWidth?: number } = {}): void {
    const stroke = opts.strokeWidth ?? 0
    const inner = stroke > 0 ? radius - stroke : 0
    const x0 = Math.max(0, Math.floor(cx - radius - 1))
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + 1))
    const y0 = Math.max(0, Math.floor(cy - radius - 1))
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius + 1))
    const S = 3
    const step = 1 / S

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let hits = 0
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const px = x + (sx + 0.5) * step
            const py = y + (sy + 0.5) * step
            const d = Math.hypot(px - cx, py - cy)
            if (d <= radius && (stroke === 0 || d >= inner)) hits++
          }
        }
        if (hits > 0) this.blend(x, y, color, hits / (S * S))
      }
    }
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.pixels)
  }
}
