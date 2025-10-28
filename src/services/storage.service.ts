// src/services/storage.service.ts
import { getStorageBucket } from '../config/firebase'
import logger from '../config/logger'
import { v4 as uuidv4 } from 'uuid'

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

    const folderPath = `venues/${venueSlug}/`

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
