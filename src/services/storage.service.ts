// src/services/storage.service.ts
import { getStorageBucket } from '../config/firebase'
import logger from '../config/logger'
import { v4 as uuidv4 } from 'uuid'
import { env } from '../config/env'

/**
 * Get the storage prefix based on environment
 * - production → 'prod'
 * - everything else → 'dev'
 */
export function getStorageEnvPrefix(): 'prod' | 'dev' {
  return env.NODE_ENV === 'production' ? 'prod' : 'dev'
}

/**
 * Build a storage path with environment prefix
 * @param path - Path without env prefix (e.g., 'venues/my-venue/kyc/file.pdf')
 * @returns Path with env prefix (e.g., 'prod/venues/my-venue/kyc/file.pdf')
 */
export function buildStoragePath(path: string): string {
  const prefix = getStorageEnvPrefix()
  // Remove leading slash if present
  const cleanPath = path.startsWith('/') ? path.slice(1) : path
  return `${prefix}/${cleanPath}`
}

/**
 * Extract file path from Firebase Storage URL
 * Example: https://firebasestorage.googleapis.com/v0/b/bucket/o/venues%2Fslug%2Fdocuments%2Ffile.pdf?alt=media
 * Returns: venues/slug/documents/file.pdf
 */
export function extractFilePathFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url)

    // Check if it's a Firebase Storage URL
    if (!urlObj.hostname.includes('firebasestorage.googleapis.com')) {
      logger.warn(`⚠️  URL is not a Firebase Storage URL: ${url}`)
      return null
    }

    // Extract path from /o/ segment
    const pathMatch = urlObj.pathname.match(/\/o\/(.+)/)
    if (!pathMatch || !pathMatch[1]) {
      logger.warn(`⚠️  Could not extract path from URL: ${url}`)
      return null
    }

    // Decode URI component (e.g., %2F -> /)
    const decodedPath = decodeURIComponent(pathMatch[1])
    return decodedPath
  } catch (error) {
    logger.error(`❌ Error parsing storage URL: ${url}`, error)
    return null
  }
}

/**
 * Delete a single file from Firebase Storage
 * @param fileUrl - Full Firebase Storage URL
 * @returns true if deleted, false if skipped/failed
 */
export async function deleteFileFromStorage(fileUrl: string | null | undefined): Promise<boolean> {
  if (!fileUrl) {
    return false
  }

  try {
    const bucket = getStorageBucket()

    // If Firebase is not initialized, skip deletion
    if (!bucket) {
      logger.warn('⚠️  Firebase not initialized. Skipping file deletion.')
      return false
    }

    // Extract file path from URL
    const filePath = extractFilePathFromUrl(fileUrl)
    if (!filePath) {
      logger.warn(`⚠️  Could not extract file path from URL: ${fileUrl}`)
      return false
    }

    // Delete file from Firebase Storage
    const file = bucket.bucket().file(filePath)
    await file.delete()

    logger.info(`🗑️  Deleted file from storage: ${filePath}`)
    return true
  } catch (error: any) {
    // If file doesn't exist (404), that's okay - it's already gone
    if (error.code === 404) {
      logger.info(`ℹ️  File already deleted or doesn't exist: ${fileUrl}`)
      return true
    }

    // Log error but don't throw - we don't want to block deletion if storage cleanup fails
    logger.error(`❌ Failed to delete file from storage: ${fileUrl}`, error)
    return false
  }
}

/**
 * Delete multiple files from Firebase Storage
 * @param fileUrls - Array of Firebase Storage URLs
 * @returns Count of successfully deleted files
 */
export async function deleteFilesFromStorage(fileUrls: (string | null | undefined)[]): Promise<number> {
  const validUrls = fileUrls.filter((url): url is string => !!url)

  if (validUrls.length === 0) {
    return 0
  }

  logger.info(`🗑️  Deleting ${validUrls.length} files from storage...`)

  const results = await Promise.allSettled(validUrls.map(url => deleteFileFromStorage(url)))

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length

  logger.info(`✅ Successfully deleted ${successCount}/${validUrls.length} files from storage`)

  return successCount
}

/**
 * Upload a file to Firebase Storage
 * @param buffer - File buffer from multer
 * @param filePath - Full path where to store the file (e.g., 'venues/my-venue/kyc/ine.pdf')
 * @param contentType - MIME type of the file
 * @returns Public download URL
 */
export async function uploadFileToStorage(buffer: Buffer, filePath: string, contentType: string): Promise<string> {
  try {
    const bucket = getStorageBucket()

    if (!bucket) {
      throw new Error('Firebase Storage not initialized')
    }

    // Upload file to Firebase Storage
    const file = bucket.bucket().file(filePath)
    await file.save(buffer, {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: uuidv4(), // Generate download token
      },
    })

    // Make file publicly accessible
    await file.makePublic()

    // Get public URL
    const publicUrl = `https://storage.googleapis.com/${bucket.bucket().name}/${filePath}`

    logger.info(`📤 Uploaded file to storage: ${filePath}`)
    return publicUrl
  } catch (error) {
    logger.error(`❌ Failed to upload file to storage: ${filePath}`, error)
    throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Delete all files in a venue folder
 * Useful when deleting an entire venue
 * @param venueSlug - Venue slug (folder name)
 */
export async function deleteVenueFolder(venueSlug: string): Promise<boolean> {
  try {
    const bucket = getStorageBucket()

    if (!bucket) {
      logger.warn('⚠️  Firebase not initialized. Skipping folder deletion.')
      return false
    }

    const folderPath = buildStoragePath(`venues/${venueSlug}/`)

    logger.info(`🗑️  Deleting entire venue folder: ${folderPath}`)

    // List all files in the folder
    const [files] = await bucket.bucket().getFiles({
      prefix: folderPath,
    })

    if (files.length === 0) {
      logger.info(`ℹ️  No files found in folder: ${folderPath}`)
      return true
    }

    // Delete all files
    await Promise.all(files.map(file => file.delete()))

    logger.info(`✅ Deleted ${files.length} files from venue folder: ${folderPath}`)
    return true
  } catch (error) {
    logger.error(`❌ Failed to delete venue folder: venues/${venueSlug}/`, error)
    return false
  }
}

// ─── Descarga SEGURA de objetos de nuestro Storage ─────────────────────────────

export class StorageFetchError extends Error {}

/** Hosts desde los que el servidor acepta descargar (logo del venue, PDF/XML de CFDI). Nada más. */
const STORAGE_HOSTS = new Set(['storage.googleapis.com', 'firebasestorage.googleapis.com'])

/**
 * Descarga un objeto de NUESTRO Storage con las cuatro defensas que faltaban (Codex, 21-sep-2026):
 * sólo hosts de Google Storage y sólo https (una URL arbitraria en `Venue.logo` no puede volver al
 * servidor un proxy hacia la red interna), sin seguir redirecciones, con timeout, y con tope de bytes
 * —comprobado en `Content-Length` y otra vez sobre el cuerpo— para no cargar en memoria lo que sea.
 * `fetchImpl` se inyecta para probarlo sin red.
 */
export async function fetchStorageObject(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number; contentTypePrefix?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new StorageFetchError('URL de Storage inválida')
  }
  if (parsed.protocol !== 'https:' || !STORAGE_HOSTS.has(parsed.hostname)) {
    throw new StorageFetchError(`Sólo se descargan objetos de nuestro Storage (host rechazado: ${parsed.hostname})`)
  }
  const res = await fetchImpl(parsed.toString(), { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) })
  if (!res.ok) throw new StorageFetchError(`Storage respondió ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > opts.maxBytes) throw new StorageFetchError(`El archivo (${declared} bytes) excede el tope de ${opts.maxBytes} bytes`)
  if (opts.contentTypePrefix) {
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith(opts.contentTypePrefix)) throw new StorageFetchError(`El archivo no es del tipo esperado (${type || 'sin tipo'})`)
  }
  // Lectura por trozos: se corta en cuanto se rebasa el tope, sin cargar el resto en memoria.
  const body: any = (res as any).body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new StorageFetchError(`El archivo excede el tope de ${opts.maxBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > opts.maxBytes)
    throw new StorageFetchError(`El archivo (${bytes.length} bytes) excede el tope de ${opts.maxBytes} bytes`)
  return bytes
}
