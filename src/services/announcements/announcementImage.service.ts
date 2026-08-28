import { randomUUID } from 'crypto'
import { BadRequestError } from '../../errors/AppError'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'

/**
 * Sube una foto de un anuncio de plataforma.
 *
 * 🔴 Va por el storage PÚBLICO a propósito. Estas fotos las ve cualquier negocio que
 * reciba el anuncio, y las apps las cargan sin sesión — no son datos personales. El
 * carril `privateStorage` es para INE, CURP, NSS y contratos; mezclarlos sería el error
 * inverso del que ya se corrigió en el expediente del personal.
 */

const TIPOS_PERMITIDOS = ['image/png', 'image/jpeg', 'image/webp'] as const

/** Firmas reales de cada formato. El `Content-Type` lo pone el cliente y se puede mentir. */
const FIRMAS: Array<{ tipo: string; bytes: number[] }> = [
  { tipo: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { tipo: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { tipo: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
]

function pareceImagenDeVerdad(buffer: Buffer): boolean {
  return FIRMAS.some(f => f.bytes.every((b, i) => buffer[i] === b))
}

export async function uploadAnnouncementImage(buffer: Buffer, contentType: string, nombreOriginal: string): Promise<string> {
  if (!buffer || buffer.length === 0) {
    throw new BadRequestError('El archivo llegó vacío')
  }

  if (!TIPOS_PERMITIDOS.includes(contentType as (typeof TIPOS_PERMITIDOS)[number])) {
    throw new BadRequestError('Sólo se aceptan imágenes PNG, JPG o WEBP')
  }

  // 🔴 Se comprueban los BYTES, no el `Content-Type`: ese lo manda el cliente y se puede
  // falsificar. Sin esto, cualquiera con el permiso podría subir un archivo arbitrario
  // con extensión de imagen a un bucket público.
  if (!pareceImagenDeVerdad(buffer)) {
    throw new BadRequestError('El archivo no es una imagen válida')
  }

  // El nombre que manda el cliente NO se usa para construir la ruta: sólo se conserva su
  // extensión. Un nombre como "../../../etc/passwd.png" escaparía de la carpeta.
  const extension =
    nombreOriginal
      .split('.')
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'png'
  const ruta = buildStoragePath(`announcements/${randomUUID()}.${extension}`)

  return uploadFileToStorage(buffer, ruta, contentType)
}
