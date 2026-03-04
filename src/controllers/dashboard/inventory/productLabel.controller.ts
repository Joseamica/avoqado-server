import { Request, Response, NextFunction } from 'express'
import * as productLabelService from '../../../services/dashboard/productLabel.service'

/**
 * Generate barcode labels for products
 */
export async function generateProductLabels(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const config = req.body

    const { pdfBuffer, totalLabels } = await productLabelService.generateProductLabels(venueId, config)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="etiquetas-productos-${Date.now()}.pdf"`)
    res.setHeader('X-Total-Labels', totalLabels.toString())

    res.send(pdfBuffer)
  } catch (error) {
    next(error)
  }
}
