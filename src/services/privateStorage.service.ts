import { BadRequestError } from '../errors/AppError'
import { getStorageBucket } from '../config/firebase'
import { getStorageEnvPrefix } from './storage.service'

/**
 * Almacenamiento PRIVADO — la caja fuerte para datos personales.
 *
 * `storage.service.ts` publica todo (`makePublic()`) bajo `{env}/venues/...`, que además
 * tiene reglas `allow read/write: if true`. Eso está bien para logos, fotos de producto y
 * las fotos que sube la PAX — y NO se toca. Pero el INE o el CURP de un empleado no pueden
 * vivir ahí.
 *
 * Este servicio:
 *   1. Escribe bajo `private/...`, un prefijo que las reglas de Storage NO mencionan. Firebase
 *      deniega por defecto lo que no tiene regla, así que ni la PAX ni el navegador pueden
 *      leerlo ni escribirlo directo. Sólo el servidor, con el Admin SDK.
 *   2. Nunca llama a `makePublic()`.
 *   3. Entrega el archivo sólo mediante una URL FIRMADA que caduca en minutos.
 *
 * Nada de esto cambia `storage.rules`: la PAX sigue subiendo igual que hoy.
 */

export const PRIVATE_PREFIX = 'private'

const SIGN_MAX_MINUTES = 60

function requireBucket() {
  const storage = getStorageBucket()
  if (!storage) throw new Error('Firebase Storage no está configurado')
  return storage.bucket()
}

function assertPrivatePath(path: string): void {
  if (!path.startsWith(`${PRIVATE_PREFIX}/`) || path.includes('..')) {
    throw new BadRequestError('Esa ruta no es del almacenamiento privado')
  }
}

/** Sólo letras, números, punto, guion y guion bajo. Cualquier otra cosa (incluido "/") se aplana. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo'
  const cleaned = base.replace(/[^\w.-]/g, '_').replace(/\.{2,}/g, '.')
  return cleaned.replace(/^\.+/, '') || 'archivo'
}

export async function savePrivateFile(params: {
  /** Segmento lógico bajo el prefijo, p. ej. `staff/<venueId>/<staffId>`. */
  scope: string
  fileName: string
  buffer: Buffer
  contentType: string
}): Promise<{ path: string }> {
  const scope = params.scope.replace(/(^\/+|\/+$)/g, '')
  if (scope.includes('..')) throw new BadRequestError('Ámbito inválido')

  const path = `${PRIVATE_PREFIX}/${getStorageEnvPrefix()}/${scope}/${Date.now()}_${safeFileName(params.fileName)}`
  const file = requireBucket().file(path)
  await file.save(params.buffer, {
    contentType: params.contentType,
    resumable: false,
    metadata: { cacheControl: 'private, no-store' },
  })
  // Deliberadamente SIN makePublic().
  return { path }
}

/** URL de lectura que caduca. Se firma en cada lectura: no se guarda nunca. */
export async function signPrivateFileUrl(path: string, expiresInMinutes: number): Promise<string> {
  assertPrivatePath(path)
  const minutes = Math.min(Math.max(1, expiresInMinutes), SIGN_MAX_MINUTES)
  const [url] = await requireBucket()
    .file(path)
    .getSignedUrl({ action: 'read', expires: Date.now() + minutes * 60 * 1000, version: 'v4' })
  return url
}

export async function deletePrivateFile(path: string): Promise<void> {
  assertPrivatePath(path)
  await requireBucket().file(path).delete({ ignoreNotFound: true })
}

/** A caller can durably record this path before sending bytes to Storage. */
export function buildPrivateFilePath(scope: string, name: string): string {
  if (!/^[a-zA-Z0-9_/-]+$/.test(scope) || scope.includes('..') || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.includes('..'))
    throw new BadRequestError('Ámbito inválido')
  return `${PRIVATE_PREFIX}/${getStorageEnvPrefix()}/${scope}/${name}`
}

/** Opt-in create-only writes: never overwrites evidence left by an earlier attempt. */
export async function savePrivateFileAtPath(path: string, buffer: Buffer, contentType: string): Promise<void> {
  assertPrivatePath(path)
  await requireBucket()
    .file(path)
    .save(buffer, {
      contentType,
      resumable: false,
      timeout: 60000,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: 'private, no-store', contentDisposition: 'attachment' },
    })
}

export async function signPrivateAttachmentUrl(path: string): Promise<string> {
  assertPrivatePath(path)
  const [url] = await requireBucket()
    .file(path)
    .getSignedUrl({ action: 'read', version: 'v4', expires: Date.now() + 10 * 60000, responseDisposition: 'attachment' })
  return url
}
