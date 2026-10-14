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
      // Hoja llena → página nueva ANTES de dibujar (antes sólo saltaba dentro del mismo
      // artículo, y con cantidad 1 cada etiqueta siguiente caía fuera de la hoja).
      if (labelIndex === labelTemplate.labelsPerPage) {
        doc.addPage()
        labelIndex = 0
      }

      const position = calculateLabelPosition(labelIndex, labelTemplate)

      let yOffset = position.y + 5
      const labelBottom = position.y + labelTemplate.height

      // Un renglón por línea y SÓLO si cabe: un texto que pasa del borde hace que PDFKit
      // abra páginas solas (en Zebra 1.2x0.85 salían 2 páginas por etiqueta).
      // La letra se encoge (hasta 5 pt) antes de cortar: en una Zebra de 1.2" la talla es lo
      // que se perdía con el «…».
      const line = (text: string, size: number, font: 'Helvetica' | 'Helvetica-Bold') => {
        const width = labelTemplate.width - 10
        doc.font(font).fontSize(size)
        while (size > 5 && doc.widthOfString(text) > width) doc.fontSize((size -= 0.5))
        const advance = size * 1.15
        if (yOffset + advance > labelBottom) return
        doc.text(text, position.x + 5, yOffset, { width, height: advance, ellipsis: true })
        yOffset += advance
      }

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

            // Proporcional a la etiqueta: 30 pt fijos se comían la mitad de una Zebra chica.
            const maxWidth = labelTemplate.width - 10
            const maxHeight = Math.min(30, labelTemplate.height * 0.4)
            // Alto real dibujado (el código suele limitarse por el ancho), para no dejar hueco.
            // Ancho y alto del PNG viven en su cabecera IHDR (bytes 16-23).
            const pngWidth = barcodePNG.readUInt32BE(16)
            const pngHeight = barcodePNG.readUInt32BE(20)
            const drawnHeight = Math.min(maxHeight, (maxWidth * pngHeight) / pngWidth)
            doc.image(barcodePNG, position.x + 5, yOffset, { fit: [maxWidth, drawnHeight] })

            yOffset += drawnHeight + 2
          } catch (error) {
            logger.error('Error generating barcode:', error)
          }
        }
      }

      // Add details based on config
      if (config.details.itemName) line(item.name, 8, 'Helvetica-Bold')
      if (config.details.sku && item.sku) line(`SKU: ${item.sku}`, 7, 'Helvetica')
      if (config.details.gtin && item.gtin) line(`GTIN: ${item.gtin}`, 7, 'Helvetica')
      if (config.details.variantName && item.variantName) line(item.variantName, 7, 'Helvetica')
      if (config.details.price && item.price != null) line(`$${item.price}`, 9, 'Helvetica-Bold')
      if (config.details.unitAbbr && item.unit) line(getUnitAbbreviation(item.unit as Unit), 7, 'Helvetica')

      labelIndex++
      totalLabelsGenerated++
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
