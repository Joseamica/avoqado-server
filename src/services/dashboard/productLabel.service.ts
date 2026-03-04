/**
 * Product Label Service
 * Generates barcode labels for products from the inventory summary.
 */

import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { renderLabelsPdf, type LabelItem, type LabelConfig } from '../labels/labelPdfRenderer'

interface ProductLabelRequest extends LabelConfig {
  items: Array<{
    productId: string
    quantity: number
  }>
}

export async function generateProductLabels(
  venueId: string,
  config: ProductLabelRequest,
): Promise<{ pdfBuffer: Buffer; totalLabels: number }> {
  const productIds = config.items.map(i => i.productId)

  const products = await prisma.product.findMany({
    where: {
      id: { in: productIds },
      venueId,
    },
    select: {
      id: true,
      name: true,
      sku: true,
      gtin: true,
      price: true,
      unit: true,
    },
  })

  if (products.length === 0) {
    throw new AppError('No se encontraron productos para generar etiquetas', 400)
  }

  // Map products to LabelItem shape, preserving the order and quantity from config
  const labelItems: LabelItem[] = []
  for (const configItem of config.items) {
    const product = products.find(p => p.id === configItem.productId)
    if (!product) continue
    labelItems.push({
      name: product.name,
      sku: product.sku,
      gtin: product.gtin,
      price: product.price?.toString() ?? null,
      unit: product.unit,
      labelQuantity: configItem.quantity,
    })
  }

  if (labelItems.length === 0) {
    throw new AppError('Ninguno de los productos seleccionados pertenece a este venue', 400)
  }

  return renderLabelsPdf(labelItems, config)
}
