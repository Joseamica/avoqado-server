// src/services/customer-display/customerDisplayAsset.service.ts
import { createHash, randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { buildStoragePath, uploadFileToStorage } from '@/services/storage.service'
import { invalidateCustomerDisplayCache, loadTerminalForCustomerDisplay, readEntitlements } from './customerDisplayDesign.service'
import { MAX_ASSET_BYTES } from './customerDisplayDesign.validation'

/**
 * Sube una imagen del diseño de la pantalla del cliente (spec §5.4).
 *
 * 🔴 Cuatro cosas no negociables, y cada una cierra un hueco distinto:
 * 1. La AUTORIZACIÓN va antes de leer el archivo (la ruta corre `authorizeAssetTerminal` y `authorizeAssetPlan`, con
 *    el permiso en medio, antes de multer) y se repite aquí dentro con `authorizeAssetUpload`: terminal de ESTE
 *    negocio, `POS_ANDROID`, y plan de promos si es una slide.
 * 2. El tipo y las medidas salen de los BYTES, nunca del `Content-Type` ni del nombre: los dos los manda el cliente.
 *    Por eso el servicio ni siquiera recibe el nombre del archivo.
 * 3. La ruta se arma con un uuid bajo `customer-display-assets/{venueId}/`, un prefijo que `storage.rules` NO menciona
 *    ⇒ el SDK del navegador no puede escribir ahí. `venueId` y no el slug: la llave sobrevive a un cambio de nombre.
 * 4. Se guarda el `sha256`: la ficha lo lleva y la tablet rechaza un archivo que no coincida.
 *
 * Declarado y NO hecho aquí: los HUÉRFANOS — quitar una imagen del diseño no borra el activo; una limpieza futura puede
 * borrar los que lleven 90 días sin referencia.
 */

// El tope vive en el módulo PURO de validación: lo leen la ruta (multer, antes de cargar este servicio) y este servicio.
// Re-exportado para quien ya lo importa de aquí.
export { MAX_ASSET_BYTES }
export const MIN_SIDE = 400
export const MAX_SIDE = 4096

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  ext: 'png' | 'jpg' | 'webp'
  width: number
  height: number
}

function leerPng(b: Buffer): ImageInfo | null {
  if (b.length < 24) return null
  const firma = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!firma.every((v, i) => b[i] === v)) return null
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null
  return { mime: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function leerJpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  // `i + 9 < length`: lo más lejos que se lee de un segmento es el ancho del SOF, en `i + 7` e `i + 8`.
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marcador = b[i + 1]
    const largo = b.readUInt16BE(i + 2)
    // SOF0-SOF15 traen las medidas; C4 (Huffman), C8 y CC no son SOF.
    if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
      return { mime: 'image/jpeg', ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    if (largo < 2) return null // un segmento que no avanza sería un bucle infinito
    i += 2 + largo
  }
  return null
}

function leerWebp(b: Buffer): ImageInfo | null {
  if (b.length < 30) return null
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null
  const tipo = b.toString('ascii', 12, 16)
  const base = { mime: 'image/webp', ext: 'webp' } as const
  // Cada variante trae su propia firma DENTRO del contenedor: sin revisarla, un RIFF/WEBP con cualquier cosa adentro
  // daría medidas al azar y se subiría como imagen.
  if (tipo === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null // código de inicio del cuadro
    return { ...base, width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  if (tipo === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (tipo === 'VP8X') return { ...base, width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  return null
}

/** PURA: devuelve el tipo y las medidas, o null si los bytes no son una imagen que aceptemos. */
export function inspectImage(buffer: Buffer): ImageInfo | null {
  if (!buffer || buffer.length === 0) return null
  const info = leerPng(buffer) ?? leerJpeg(buffer) ?? leerWebp(buffer)
  if (!info || info.width <= 0 || info.height <= 0) return null
  return info
}

export type AssetKind = 'SLIDE' | 'LOGO'

/**
 * 🔴 FALLA CERRADO: el candado del plan de abajo sólo corre para el literal `'SLIDE'`. Sin esta revisión, cualquier otro
 * valor —la consulta cruda `'slide'` en minúsculas, un tipo inventado, `undefined`— se saltaba el candado del plan. Va
 * ANTES de consultar nada: un tipo inválido no cuesta ni una lectura.
 *
 * 400 y no 422: es una ENTRADA mal formada, y es el mismo código con el mismo estado que da la ruta (`assetKindFromQuery`,
 * revisión de la Task 11, hallazgo menor 2). El 422 de este servicio es para «el dispositivo no tiene pantalla del
 * cliente»: un caso del negocio, no de la forma.
 */
function exigirTipoDeActivo(kind: unknown): asserts kind is AssetKind {
  if (kind !== 'SLIDE' && kind !== 'LOGO') {
    throw new BadRequestError('El tipo de imagen tiene que ser SLIDE o LOGO', 'INVALID_ASSET_KIND')
  }
}

/*
 * El orden del spec §5.4: amarrar la terminal al venue (404 idéntico para ajena e inexistente; 422 sin pantalla del
 * cliente) → permiso → sólo para slides, el plan (403). El logo es marca: gratis. El derecho a las slides sale de
 * `readEntitlements`, la MISMA respuesta que usan guardar, copiar y la ficha: no se re-deriva aquí.
 *
 * El PERMISO va en medio y lo corre la ruta (`checkPermission`), por eso la autorización está partida en dos mitades.
 */

/**
 * Mitad 1 — amarrar la terminal al negocio: 404 idéntico para ajena e inexistente; 422 si es del negocio pero no tiene
 * pantalla del cliente. La ruta la corre ANTES del permiso (spec §5.4), así que no consulta el plan.
 */
export async function authorizeAssetTerminal(input: { venueId: string; terminalId: string }): Promise<void> {
  await loadTerminalForCustomerDisplay(input.venueId, input.terminalId)
}

/**
 * Mitad 2 — el plan, sólo para slides (el logo es marca: gratis). La ruta la corre DESPUÉS del permiso. Falla cerrado
 * con un tipo inválido aunque la ruta ya lo haya revisado: cualquier llamador directo pasa por la misma regla.
 */
export async function authorizeAssetPlan(input: { venueId: string; kind: AssetKind }): Promise<void> {
  exigirTipoDeActivo(input.kind)
  if (input.kind === 'SLIDE' && !(await readEntitlements(input.venueId)).slides) {
    throw new ForbiddenError('Las promociones en reposo son del plan PRO.', 'FEATURE_REQUIRES_PRO')
  }
}

/** Las dos mitades juntas, para quien no tiene un permiso que revisar en medio (la subida misma, por dentro). */
export async function authorizeAssetUpload(input: { venueId: string; terminalId: string; kind: AssetKind }): Promise<void> {
  exigirTipoDeActivo(input.kind) // antes de consultar nada: un tipo inválido no cuesta ni una lectura
  await authorizeAssetTerminal(input)
  await authorizeAssetPlan(input)
}

export async function uploadCustomerDisplayAsset(input: {
  venueId: string
  terminalId: string
  kind: AssetKind
  buffer: Buffer
  staffId: string
}): Promise<{ assetId: string; url: string; sha256: string; width: number; height: number }> {
  const { venueId, terminalId, kind, buffer, staffId } = input

  // Otra vez aquí dentro: la ruta ya lo hizo antes de multer, pero ningún otro llamador puede saltárselo.
  await authorizeAssetUpload({ venueId, terminalId, kind })

  if (buffer.length > MAX_ASSET_BYTES) throw new BadRequestError('La imagen no puede pesar más de 5 MB', 'ASSET_TOO_LARGE')

  const info = inspectImage(buffer)
  if (!info) throw new BadRequestError('El archivo no es una imagen PNG, JPG o WEBP válida', 'ASSET_NOT_AN_IMAGE')

  if (info.width < MIN_SIDE || info.height < MIN_SIDE || info.width > MAX_SIDE || info.height > MAX_SIDE) {
    throw new BadRequestError(`La imagen debe medir entre ${MIN_SIDE} y ${MAX_SIDE} píxeles de cada lado`, 'ASSET_BAD_DIMENSIONS')
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const objectPath = buildStoragePath(`customer-display-assets/${venueId}/${randomUUID()}.${info.ext}`)
  const url = await uploadFileToStorage(buffer, objectPath, info.mime)

  const fila = await prisma.customerDisplayAsset.create({
    data: {
      venueId,
      kind,
      objectPath,
      sha256,
      mime: info.mime,
      width: info.width,
      height: info.height,
      bytes: buffer.length,
      createdById: staffId,
    },
    select: { id: true },
  })

  // Spec §5.3: la caché se invalida en cada escritura de diseño, de ACTIVO o de traslado del mismo proceso.
  invalidateCustomerDisplayCache(terminalId)
  // Fuera de toda transacción y `logAction` nunca lanza: la auditoría no puede tumbar una subida ya hecha.
  await logAction({
    staffId,
    venueId,
    action: 'CUSTOMER_DISPLAY_ASSET_UPLOADED',
    entity: 'CustomerDisplayAsset',
    entityId: fila.id,
    data: { terminalId, kind, sha256, bytes: buffer.length, width: info.width, height: info.height },
  })

  return { assetId: fila.id, url, sha256, width: info.width, height: info.height }
}
