/**
 * Barcode Generation Service
 * Uses bwip-js to generate various types of barcodes as PNG buffers
 */

import bwipjs from 'bwip-js'

export type BarcodeFormat =
  | 'code128' // Most versatile (alphanumeric)
  | 'ean13' // 13-digit product codes
  | 'ean8' // 8-digit product codes
  | 'upca' // 12-digit UPC-A
  | 'upce' // 6-digit UPC-E

export interface BarcodeOptions {
  code: string // The text to encode
  format?: BarcodeFormat // Default: code128
  width?: number // Bar width multiplier (default: 50)
  height?: number // Bar height in mm (default: 10)
  includeText?: boolean // Show human-readable text below barcode (default: true)
}

/**
 * Generate a barcode as a PNG buffer
 */
export async function generateBarcode(options: BarcodeOptions): Promise<Buffer> {
  const { code, format = 'code128', height = 10, includeText = true } = options

  try {
    const buffer = await bwipjs.toBuffer({
      bcid: format, // Barcode type
      text: code, // Text to encode
      scale: 3, // 3x scaling
      height, // Bar height in millimeters
      includetext: includeText, // Show human-readable text
      textxalign: 'center', // Center text below barcode
    })

    return buffer
  } catch (error) {
    throw new Error(`Failed to generate barcode: ${error}`)
  }
}

/**
 * Get recommended barcode format based on code characteristics
 */
export function getRecommendedBarcodeFormat(code: string): BarcodeFormat {
  // EAN-13 (13 digits)
  if (/^\d{13}$/.test(code)) {
    return 'ean13'
  }

  // EAN-8 (8 digits)
  if (/^\d{8}$/.test(code)) {
    return 'ean8'
  }

  // UPC-A (12 digits)
  if (/^\d{12}$/.test(code)) {
    return 'upca'
  }

  // UPC-E (6 digits)
  if (/^\d{6}$/.test(code)) {
    return 'upce'
  }

  // Default to Code128 for alphanumeric codes
  return 'code128'
}

/**
 * Validate if a code is compatible with a given barcode format
 */
export function validateBarcodeCode(code: string, format: BarcodeFormat): boolean {
  switch (format) {
    case 'ean13':
      return /^\d{13}$/.test(code)
    case 'ean8':
      return /^\d{8}$/.test(code)
    case 'upca':
      return /^\d{12}$/.test(code)
    case 'upce':
      return /^\d{6}$/.test(code)
    case 'code128':
      // Code128 accepts any printable ASCII
      return /^[\x20-\x7E]+$/.test(code)
    default:
      return false
  }
}
