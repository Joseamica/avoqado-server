// src/services/apk-parser.service.ts
/**
 * APK Parser Service
 *
 * Extracts metadata from Android APK files including:
 * - versionCode (integer version used for updates)
 * - versionName (human-readable version string)
 * - packageName (application ID)
 * - minSdkVersion (minimum Android SDK required)
 *
 * Uses multiple parsers with fallback for better compatibility:
 * 1. adbkit-apkreader (primary)
 * 2. node-apk-parser (fallback for APKs with v2/v3 signatures)
 */

import ApkReader from 'adbkit-apkreader'
import fs from 'fs'
import path from 'path'
import os from 'os'
import logger from '../config/logger'

// node-apk-parser uses default export

const ApkParser = require('node-apk-parser')

export interface ApkMetadata {
  versionCode: number
  versionName: string
  packageName: string
  minSdkVersion: number
}

/**
 * Extract metadata using adbkit-apkreader
 */
async function extractWithAdbkit(tempFilePath: string): Promise<ApkMetadata> {
  const reader = await ApkReader.open(tempFilePath)
  const manifest = await reader.readManifest()

  if (!manifest.versionCode) {
    throw new Error('APK missing versionCode in AndroidManifest.xml')
  }
  if (!manifest.versionName) {
    throw new Error('APK missing versionName in AndroidManifest.xml')
  }
  if (!manifest.package) {
    throw new Error('APK missing package name in AndroidManifest.xml')
  }

  return {
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
    packageName: manifest.package,
    minSdkVersion: manifest.usesSdk?.minSdkVersion || 21,
  }
}

/**
 * Extract metadata using node-apk-parser (fallback)
 */
async function extractWithNodeApkParser(tempFilePath: string): Promise<ApkMetadata> {
  return new Promise((resolve, reject) => {
    try {
      const reader = ApkParser.readFile(tempFilePath)
      const manifest = reader.readManifestSync()

      if (!manifest.versionCode) {
        reject(new Error('APK missing versionCode in AndroidManifest.xml'))
        return
      }
      if (!manifest.versionName) {
        reject(new Error('APK missing versionName in AndroidManifest.xml'))
        return
      }
      if (!manifest.package) {
        reject(new Error('APK missing package name in AndroidManifest.xml'))
        return
      }

      resolve({
        versionCode: parseInt(manifest.versionCode, 10),
        versionName: manifest.versionName,
        packageName: manifest.package,
        minSdkVersion: manifest.usesSdk?.minSdkVersion ? parseInt(manifest.usesSdk.minSdkVersion, 10) : 21,
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Extract metadata from an APK buffer
 *
 * @param apkBuffer - The APK file as a Buffer
 * @returns Metadata extracted from AndroidManifest.xml
 * @throws Error if APK is invalid or metadata cannot be extracted
 */
export async function extractApkMetadata(apkBuffer: Buffer): Promise<ApkMetadata> {
  // Write buffer to temp file (both parsers need file path)
  const tempDir = os.tmpdir()
  const tempFilePath = path.join(tempDir, `apk-parse-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`)

  try {
    // Write buffer to temp file
    fs.writeFileSync(tempFilePath, apkBuffer)

    let metadata: ApkMetadata

    // Try adbkit-apkreader first (more detailed parsing)
    try {
      metadata = await extractWithAdbkit(tempFilePath)
      logger.info(`APK metadata extracted (adbkit): ${metadata.packageName} v${metadata.versionName} (${metadata.versionCode})`)
      return metadata
    } catch (adbkitError) {
      const adbkitMessage = adbkitError instanceof Error ? adbkitError.message : 'Unknown error'
      logger.warn(`adbkit-apkreader failed, trying node-apk-parser: ${adbkitMessage}`)
    }

    // Fallback to node-apk-parser
    try {
      metadata = await extractWithNodeApkParser(tempFilePath)
      logger.info(`APK metadata extracted (node-apk-parser): ${metadata.packageName} v${metadata.versionName} (${metadata.versionCode})`)
      return metadata
    } catch (nodeParserError) {
      const nodeParserMessage = nodeParserError instanceof Error ? nodeParserError.message : 'Unknown error'
      logger.error(`node-apk-parser also failed: ${nodeParserMessage}`)
      throw new Error(`Could not parse APK with any parser: ${nodeParserMessage}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`Failed to extract APK metadata: ${errorMessage}`)
    throw new Error(`Invalid APK file: ${errorMessage}`)
  } finally {
    // Clean up temp file
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath)
      }
    } catch {
      logger.warn(`Failed to clean up temp APK file: ${tempFilePath}`)
    }
  }
}

/**
 * Validate that an APK buffer is a valid APK file
 *
 * @param apkBuffer - The APK file as a Buffer
 * @returns true if valid APK, false otherwise
 */
export async function isValidApk(apkBuffer: Buffer): Promise<boolean> {
  try {
    // Check ZIP signature (APK is a ZIP file)
    if (apkBuffer.length < 4) {
      return false
    }

    // ZIP files start with PK (0x50 0x4B)
    if (apkBuffer[0] !== 0x50 || apkBuffer[1] !== 0x4b) {
      return false
    }

    // Try to extract metadata - if successful, it's a valid APK
    await extractApkMetadata(apkBuffer)
    return true
  } catch {
    return false
  }
}

/**
 * Validate APK package name matches expected pattern
 *
 * @param metadata - Extracted APK metadata
 * @param environment - Target environment (SANDBOX or PRODUCTION)
 * @returns true if package name is valid for environment
 */
export function validatePackageName(metadata: ApkMetadata, environment: 'SANDBOX' | 'PRODUCTION'): { valid: boolean; message?: string } {
  const expectedPackages = {
    SANDBOX: 'com.jaac.avoqado_tpv.sandbox',
    PRODUCTION: 'com.jaac.avoqado_tpv',
  }

  const expected = expectedPackages[environment]

  if (metadata.packageName !== expected) {
    return {
      valid: false,
      message: `Package name mismatch: APK has "${metadata.packageName}" but expected "${expected}" for ${environment} environment`,
    }
  }

  return { valid: true }
}
