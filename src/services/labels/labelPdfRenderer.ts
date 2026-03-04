/**
 * Shared Label PDF Renderer
 * Generic PDF label generation used by both purchase order labels and product labels.
 */

import PDFDocument from 'pdfkit'
import { getLabelTemplate, calculateLabelPosition } from './labelTemplates'
import { generateBarcode, getRecommendedBarcodeFormat } from './barcodeGenerator'
import logger from '@/config/logger'
import { Unit } from '@prisma/client'

export interface LabelItem {
  name: string
  sku?: string | null
  gtin?: string | null
  price?: string | number | null
  unit?: string | null
  variantName?: string | null
  labelQuantity: number
}

export interface LabelConfig {
  labelType: string
  barcodeFormat: 'SKU' | 'GTIN' | 'NONE'
  details: {
    sku: boolean
    gtin: boolean
    variantName: boolean
    price: boolean
    itemName: boolean
    unitAbbr: boolean
  }
}

/**
 * Get unit abbreviation for labels
 */
export function getUnitAbbreviation(unit: Unit): string {
  const abbreviations: Record<Unit, string> = {
    // Weight units
    GRAM: 'g',
    KILOGRAM: 'kg',
    MILLIGRAM: 'mg',
    POUND: 'lb',
    OUNCE: 'oz',
    TON: 't',
    // Volume units - Liquid
    MILLILITER: 'ml',
    LITER: 'L',
    GALLON: 'gal',
    QUART: 'qt',
    PINT: 'pt',
    CUP: 'cup',
    FLUID_OUNCE: 'fl oz',
    TABLESPOON: 'tbsp',
    TEASPOON: 'tsp',
    // Count units
    UNIT: 'ud',
    PIECE: 'pz',
    DOZEN: 'dz',
    CASE: 'caja',
    BOX: 'caja',
    BAG: 'bolsa',
    BOTTLE: 'bot',
    CAN: 'lata',
    JAR: 'frasco',
    // Length units
    METER: 'm',
    CENTIMETER: 'cm',
    MILLIMETER: 'mm',
    INCH: 'in',
    FOOT: 'ft',
    // Temperature units
    CELSIUS: '°C',
    FAHRENHEIT: '°F',
    // Time units
    MINUTE: 'min',
    HOUR: 'h',
    DAY: 'd',
  }
  return abbreviations[unit] || unit
}

/**
 * Render labels to a PDF buffer.
 * Accepts a generic list of LabelItems and a LabelConfig.
 */
export async function renderLabelsPdf(items: LabelItem[], config: LabelConfig): Promise<{ pdfBuffer: Buffer; totalLabels: number }> {
  const labelTemplate = getLabelTemplate(config.labelType)

  const doc = new PDFDocument({
    size: labelTemplate.pageSize,
    margin: 0,
  })

  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))

  let labelIndex = 0
  let totalLabelsGenerated = 0

  for (const item of items) {
    for (let i = 0; i < item.labelQuantity; i++) {
      const position = calculateLabelPosition(labelIndex, labelTemplate)

      let yOffset = position.y + 5

      // Generate barcode
      if (config.barcodeFormat !== 'NONE') {
        const barcodeData = config.barcodeFormat === 'GTIN' ? item.gtin : item.sku

        if (barcodeData && barcodeData.trim() !== '') {
          try {
            const barcodeFormat = getRecommendedBarcodeFormat(barcodeData)
            const barcodePNG = await generateBarcode({
              code: barcodeData,
              format: barcodeFormat,
              width: Math.floor(labelTemplate.width / 2.83465),
              height: 10,
              includeText: true,
            })

            doc.image(barcodePNG, position.x + 5, yOffset, {
              fit: [labelTemplate.width - 10, 30],
            })

            yOffset += 35
          } catch (error) {
            logger.error('Error generating barcode:', error)
          }
        }
      }

      // Add details based on config
      if (config.details.itemName) {
        doc
          .fontSize(8)
          .font('Helvetica-Bold')
          .text(item.name, position.x + 5, yOffset, {
            width: labelTemplate.width - 10,
            ellipsis: true,
          })
        yOffset += 10
      }

      if (config.details.sku && item.sku) {
        doc
          .fontSize(7)
          .font('Helvetica')
          .text(`SKU: ${item.sku}`, position.x + 5, yOffset)
        yOffset += 9
      }

      if (config.details.gtin && item.gtin) {
        doc
          .fontSize(7)
          .font('Helvetica')
          .text(`GTIN: ${item.gtin}`, position.x + 5, yOffset)
        yOffset += 9
      }

      if (config.details.variantName && item.variantName) {
        doc
          .fontSize(7)
          .font('Helvetica')
          .text(item.variantName, position.x + 5, yOffset)
        yOffset += 9
      }

      if (config.details.price && item.price != null) {
        doc
          .fontSize(9)
          .font('Helvetica-Bold')
          .text(`$${item.price}`, position.x + 5, yOffset)
        yOffset += 10
      }

      if (config.details.unitAbbr && item.unit) {
        const unitText = getUnitAbbreviation(item.unit as Unit)
        doc
          .fontSize(7)
          .font('Helvetica')
          .text(unitText, position.x + 5, yOffset)
      }

      labelIndex++
      totalLabelsGenerated++

      // Add new page if needed
      if (labelIndex % labelTemplate.labelsPerPage === 0 && i < item.labelQuantity - 1) {
        doc.addPage()
        labelIndex = 0
      }
    }
  }

  doc.end()

  const pdfBuffer = await new Promise<Buffer>(resolve => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
  })

  return {
    pdfBuffer,
    totalLabels: totalLabelsGenerated,
  }
}
