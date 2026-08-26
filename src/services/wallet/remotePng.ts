import logger from '../../config/logger'
import { decodePng, type DecodedPng } from './pngDecode'

/**
 * Trae una imagen que el negocio subió, para meterla en su pase.
 *
 * 🔴 Dos reglas que existen por el mismo defecto que ya nos costó una prueba en un
 * iPhone real:
 *
 * 1. **Verifica que sea PNG de verdad, por los BYTES.** Apple sólo acepta PNG dentro
 *    de un pase, y un JPG renombrado a `.png` no produce ningún error: el pase se
 *    firma bien y el iPhone simplemente NO lo abre en Wallet. Confiar en la
 *    extensión repetiría ese fallo silencioso, esta vez con datos del cliente.
 * 2. **Nunca bloquea la emisión.** Un fallo de red, un 404 o un archivo corrupto
 *    devuelven `null` y el pase sale con la imagen de respaldo. Que la tarjeta de un
 *    cliente no se emita porque el logo del negocio no cargó sería cambiar un
 *    problema estético por uno de operación.
 */

/** Los 8 bytes con los que empieza TODO archivo PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Tope de tamaño: un pase entero debería pesar kilobytes, no megabytes. */
const MAX_BYTES = 3 * 1024 * 1024

/** La emisión es interactiva — el cliente está esperando su tarjeta. */
const TIMEOUT_MS = 4000

export function isPng(buffer: Buffer): boolean {
  return buffer.length > PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

export async function fetchPng(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) {
      logger.warn('No se pudo traer una imagen del pase', { url, status: response.status })
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_BYTES) {
      logger.warn('La imagen del pase excede el tope de tamaño', { url, bytes: buffer.length })
      return null
    }
    if (!isPng(buffer)) {
      // El caso que de verdad pasa: alguien sube un JPG con el nombre cambiado.
      logger.warn('La imagen del pase no es un PNG real; se usa el respaldo', { url })
      return null
    }

    return buffer
  } catch (error) {
    logger.warn('Falló la descarga de una imagen del pase; se usa el respaldo', {
      url,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export interface PngSize {
  width: number
  height: number
}

/**
 * Ancho y alto de un PNG, leidos de su cabecera.
 *
 * 🔑 Un PNG declara sus dimensiones en el chunk IHDR, que por especificacion es
 * SIEMPRE el primero: 8 bytes de firma + 4 de longitud + 4 del nombre, y ahi vienen
 * dos enteros de 32 bits. Son 24 bytes de lectura, sin decodificar un solo pixel y
 * sin depender de ninguna libreria de imagenes.
 *
 * Sirve para lo que de verdad importa: decirle al negocio EN EL MOMENTO que su logo
 * es demasiado chico, en vez de que lo descubra semanas despues viendo una tarjeta
 * borrosa en el telefono de un cliente.
 */
export function readPngSize(buffer: Buffer): PngSize | null {
  if (!isPng(buffer) || buffer.length < 24) return null
  // El nombre del chunk vive en los bytes 12..16 y debe decir 'IHDR'.
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Trae una imagen del negocio y la ABRE, lista para componerla.
 *
 * Devuelve null ante cualquier tropiezo — red, formato, un PNG entrelazado — y el
 * dibujo cae a la forma del catálogo. La credencial de un cliente no puede depender
 * de que el archivo del negocio esté impecable.
 */
export async function fetchDecodedPng(url: string | null | undefined): Promise<DecodedPng | null> {
  const buffer = await fetchPng(url)
  if (!buffer) return null
  const abierto = decodePng(buffer)
  if (!abierto) logger.warn('El PNG llegó pero no se pudo abrir; se usa la forma del catálogo', { url })
  return abierto
}
