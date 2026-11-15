/**
 * Foto de entrada del checador («Foto de Entrada (Anti-fraude)» en Ajustes del negocio).
 *
 * Una selfie de un empleado es dato personal: va a la caja fuerte privada (`privateStorage`, prefijo `private/`,
 * sólo URL firmada), nunca al árbol público de Firebase donde sube la PAX. La TPV sigue mandando su URL pública como
 * hoy; esta pieza sólo cubre la foto que llega en bytes (POS de ANDROID) y cómo se enseña en Asistencia.
 *
 * Promesa y mapa de entradas: workspace `docs/audit/2026-11-15-foto-de-entrada-checador/promesa.md`.
 */
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { PRIVATE_PREFIX, savePrivateFile, signPrivateFileUrl } from '../privateStorage.service'
import { getStorageEnvPrefix } from '../storage.service'

/**
 * Tope de la foto ya decodificada. La app manda ~100 KB (720 px, JPEG 80). En base64 pesa 4/3: 600 KB ≈ 800 KB de JSON,
 * dentro del límite de cuerpo del servidor (`BODY_JSON_LIMIT`, 1 MB por default). Con 2 MB el cuerpo se rechazaba con
 * 413 antes de llegar aquí (Codex r1 #3).
 */
export const MAX_SELFIE_BYTES = 600 * 1024
const MINUTOS_DE_FIRMA = 10

/** ¿El negocio prendió «Foto de Entrada»? Sin fila de ajustes = apagado (es el default de la columna). */
export async function negocioPideFotoDeEntrada(venueId: string): Promise<boolean> {
  const settings = await prisma.venueSettings.findUnique({ where: { venueId }, select: { requireClockInPhoto: true } })
  return settings?.requireClockInPhoto === true
}

/** Base64 (con o sin `data:image/jpeg;base64,`) → bytes de un JPEG. Lanza 400 si no es una foto JPEG o pesa de más. */
export function decodificarSelfie(base64: unknown): Buffer {
  if (typeof base64 !== 'string' || base64.length === 0) throw new BadRequestError('La foto de entrada no es válida.')
  const limpio = base64.replace(/^data:image\/jpeg;base64,/, '')
  // Un base64 de N bytes ocupa ~4N/3: se corta antes de decodificar para no reservar memoria de más.
  if (limpio.length > Math.ceil((MAX_SELFIE_BYTES * 4) / 3) + 4) throw new BadRequestError('La foto de entrada es demasiado grande.')
  const bytes = Buffer.from(limpio, 'base64')
  if (bytes.length > MAX_SELFIE_BYTES) throw new BadRequestError('La foto de entrada es demasiado grande.')
  const esJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (!esJpeg) throw new BadRequestError('La foto de entrada no es válida.')
  return bytes
}

/**
 * Una app no puede mandar una ruta del almacén privado como «URL de su foto»: el panel la firmaría y cualquiera con un
 * PIN podría hacer que un gerente abra el INE de otra persona. La foto privada sólo la escribe el servidor.
 */
export function assertFotoNoPrivada(url: unknown): void {
  if (typeof url !== 'string') return
  if (url.trim().replace(/^\/+/, '').startsWith(`${PRIVATE_PREFIX}/`)) {
    throw new BadRequestError('La foto de entrada no es válida.')
  }
}

function carpetaDeAsistencia(venueId: string): string {
  return `${PRIVATE_PREFIX}/${getStorageEnvPrefix()}/attendance/${venueId}/`
}

/**
 * Guarda la selfie y devuelve su ruta privada. Si el almacén falla devuelve null: la entrada se registra igual (sin
 * foto, y Asistencia lo dice) — perder la checada de alguien por un tropiezo de Storage le cuesta su día de pago.
 */
export async function guardarSelfieDeEntrada(params: { venueId: string; staffId: string; foto: Buffer }): Promise<string | null> {
  try {
    const { path } = await savePrivateFile({
      scope: `attendance/${params.venueId}/${params.staffId}`,
      fileName: 'entrada.jpg',
      buffer: params.foto,
      contentType: 'image/jpeg',
    })
    return path
  } catch (error) {
    logger.warn('[FOTO-ENTRADA] No se pudo guardar la selfie; la entrada se registra sin foto', {
      venueId: params.venueId,
      staffId: params.staffId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Lo que Asistencia puede pintar de la foto de una checada:
 * - ruta privada de ESTE negocio (y de este ambiente) → URL firmada de 10 min;
 * - URL `https://` pública (la que sube la TPV) → tal cual;
 * - cualquier otra cosa → null (no se enseña).
 */
export async function fotoParaVer(venueId: string, valor: string | null | undefined): Promise<string | null> {
  if (!valor) return null
  if (valor.startsWith(`${PRIVATE_PREFIX}/`)) {
    if (!valor.startsWith(carpetaDeAsistencia(venueId)) || valor.includes('..')) return null
    try {
      return await signPrivateFileUrl(valor, MINUTOS_DE_FIRMA)
    } catch (error) {
      logger.warn('[FOTO-ENTRADA] No se pudo firmar la foto de una checada', {
        venueId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
  return valor.startsWith('https://') ? valor : null
}
