import { createHash } from 'crypto'
import logger from '../../config/logger'
import { decodePng, type DecodedPng } from './pngDecode'
import { reducirImagen } from './pngCanvas'

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
 * El lado mayor con el que se guarda el sello del negocio ya abierto.
 *
 * El sello nunca se pinta a más de ~156 px: es el caso de UN solo sello en la banda de 750×246,
 * la más grande que existe (pase de Apple @2x, franja de Google y vista previa del dashboard).
 * 480 es el triple. Medido con el sello REAL de Testarudo, la franja sale idéntica con 320, 480 o
 * 640 (0.00% de canales cambian más de 16 niveles); se eligió 480 por margen para sellos con
 * letras o líneas finas, que son los que más se alejan. Cuesta 13.5 ms dibujar las dos franjas
 * del pase, contra ~600 ms desde el original.
 */
export const MAX_LADO_SELLO = 480

/**
 * Cuántos sellos distintos se recuerdan. Cada uno pesa como mucho 480×480×4 ≈ 920 KB, así que
 * el tope son ~15 MB. Hoy hay dos negocios con sello propio; esto aguanta de sobra el crecimiento
 * sin convertirse en una fuga de memoria.
 */
export const CACHE_SELLOS_MAX = 16

/** Huella del archivo → sello ya abierto y reducido. El orden del `Map` es el de uso (LRU). */
const cacheDeSellos = new Map<string, DecodedPng>()

/** Sólo para las pruebas: cada una debe empezar sin nada recordado. */
export function limpiarCacheDeSellos(): void {
  cacheDeSellos.clear()
}

/**
 * Trae una imagen del negocio y la ABRE, lista para componerla — ya reducida a
 * `MAX_LADO_SELLO`, que es a lo que de verdad se pinta.
 *
 * Devuelve null ante cualquier tropiezo — red, formato, un PNG entrelazado — y el
 * dibujo cae a la forma del catálogo. La credencial de un cliente no puede depender
 * de que el archivo del negocio esté impecable.
 *
 * 🔴 Abrir y reducir se hace UNA vez por archivo, no en cada descarga. Antes, bajar la tarjeta de
 * Apple de Testarudo congelaba el servidor 2.2–2.5 s (medido en producción): abrir su sello de
 * 2225×2550 eran 358 ms y pegarlo 16 veces en las franjas otros 242 ms, todo en el hilo que
 * atiende los cobros. Bajar el archivo sigue ocurriendo en cada llamada, pero eso es red y no
 * congela nada.
 *
 * 🔴 La llave es la HUELLA DEL CONTENIDO, no la URL. El sello se guarda siempre en la misma
 * dirección (`.../wallet/stamp.png`) y subir otro la sobrescribe: un caché por URL le seguiría
 * mostrando al negocio —y a sus clientes— la imagen anterior para siempre.
 *
 * Un archivo que no abre NO se recuerda: la siguiente descarga lo vuelve a intentar.
 */
export async function fetchDecodedPng(url: string | null | undefined): Promise<DecodedPng | null> {
  const buffer = await fetchPng(url)
  if (!buffer) return null

  const huella = createHash('sha1').update(buffer).digest('hex')
  const recordado = cacheDeSellos.get(huella)
  if (recordado) {
    // Se mueve al final: es el más recién usado.
    cacheDeSellos.delete(huella)
    cacheDeSellos.set(huella, recordado)
    return recordado
  }

  const abierto = decodePng(buffer)
  if (!abierto) {
    logger.warn('El PNG llegó pero no se pudo abrir; se usa la forma del catálogo', { url })
    return null
  }

  const listo = reducirImagen(abierto, MAX_LADO_SELLO)
  cacheDeSellos.set(huella, listo)
  if (cacheDeSellos.size > CACHE_SELLOS_MAX) {
    // El primero del `Map` es el que lleva más tiempo sin usarse.
    cacheDeSellos.delete(cacheDeSellos.keys().next().value as string)
  }
  return listo
}
