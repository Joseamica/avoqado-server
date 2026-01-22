/**
 * Barcode Generator Service
 * Uses bwip-js to generate barcodes for labels
 */

import bwipjs from 'bwip-js'

export interface BarcodeOptions {
  code: string // The code to encode (SKU, GTIN, etc.)
  format?: 'code128' | 'code39' | 'ean13' | 'upca' // Barcode format
  width?: number // Width in mm
  height?: number // Height in mm
  includeText?: boolean // Show text below barcode
}

/**
 * Generate barcode as PNG buffer
 */
export async function generateBarcode(options: BarcodeOptions): Promise<Buffer> {
  const { code, format = 'code128', width = 50, height = 10, includeText = true } = options

  try {
    const buffer = await bwipjs.toBuffer({
      bcid: format, // Barcode type
      text: code, // Text to encode
      scale: 3, // Scaling factor
      height, // Bar height in mm
      includetext: includeText, // Show text below barcode
      textxalign: 'center', // Center text
    })

    return buffer
  } catch (error) {
    console.error('Error generating barcode:', error)
    throw new Error(`Failed to generate barcode: ${error}`)
  }
}

/**
 * Validate barcode code based on format
 */
export function validateBarcodeCode(code: string, format: string): boolean {
  if (!code || code.trim() === '') {
    return false
  }

  switch (format) {
    case 'code128':
      // Code128 can encode alphanumeric characters
      return /^[A-Za-z0-9\-_.]+$/.test(code)

    case 'code39':
      // Code39 supports uppercase letters, numbers, and some symbols
      return /^[A-Z0-9\-. $/+%]+$/.test(code)

    case 'ean13':
      // EAN13 must be exactly 13 digits
      return /^\d{13}$/.test(code)

    case 'upca':
      // UPC-A must be exactly 12 digits
      return /^\d{12}$/.test(code)

    default:
      return true
  }
}

/**
 * Get recommended barcode format for a code
 */
export function getRecommendedBarcodeFormat(code: string): 'code128' | 'ean13' | 'upca' {
  if (/^\d{13}$/.test(code)) {
    return 'ean13'
  }

  if (/^\d{12}$/.test(code)) {
    return 'upca'
  }

  // Default to Code128 (most versatile)
  return 'code128'
}
