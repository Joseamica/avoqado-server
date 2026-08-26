import { deflateSync } from 'zlib'

/**
 * Genera un PNG de color sólido, sin dependencias externas.
 *
 * 🔴 Existe por un requisito de Apple que cuesta caro descubrir: todo `.pkpass`
 * DEBE incluir `icon.png`. Sin él el pase se firma bien, la cadena de certificados
 * valida, y aun así el iPhone no lo abre en Wallet — lo degrada a una vista previa
 * de archivo genérica, sin mensaje de error ni pista de la causa.
 *
 * Se genera con el color del NEGOCIO en vez de embeber un icono de Avoqado: así la
 * marca blanca se mantiene hasta en la notificación de la pantalla de bloqueo, donde
 * el cliente ve el color de su cafetería y no el de su proveedor de punto de venta.
 *
 * Se hace a mano con zlib (que ya viene en Node) en vez de agregar una librería de
 * imágenes: el camino de emisión de credenciales no debería depender de una.
 */

/** Verde de marca de Avoqado, para negocios sin color propio configurado. */
const FALLBACK_RGB: [number, number, number] = [122, 221, 44]

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
 * Node, y el `package.json` de este repo declara `node: 20.x`. Un servidor con un
 * Node 20 anterior fallaría en runtime al emitir un pase.
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
function hexToRgb(hex: string | null | undefined): [number, number, number] {
  if (!hex) return FALLBACK_RGB
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return FALLBACK_RGB
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function solidPng(width: number, height: number, hexColor: string | null | undefined): Buffer {
  const [r, g, b] = hexToRgb(hexColor)

  // IHDR: 8 bits por canal, tipo 2 (RGB verdadero), sin compresión especial,
  // sin filtros adicionales, sin entrelazado.
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Datos crudos: cada renglón empieza con su byte de filtro (0 = ninguno),
  // seguido de los pixeles en RGB.
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    const off = y * rowSize
    raw[off] = 0
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
