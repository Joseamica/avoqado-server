// controllers/public/receipt.public.controller.ts
import { NextFunction, Request, Response } from 'express'
import { getDigitalReceiptByAccessKey } from '../../services/tpv/digitalReceipt.tpv.service'
import { generateReceiptHTML } from '../../utils/receiptTemplate'
import { NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'

// Public route to get a receipt by its access key
// GET /api/public/receipt/:accessKey
export async function getPublicReceipt(req: Request<{ accessKey: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { accessKey } = req.params

    logger.info('Accessing digital receipt', { accessKey })

    // Get the receipt using the TPV service (more comprehensive)
    const receipt = await getDigitalReceiptByAccessKey(accessKey)

    if (!receipt) {
      throw new NotFoundError('Receipt not found')
    }

    // Generate HTML template for the receipt
    const htmlContent = generateReceiptHTML(receipt.dataSnapshot as any)

    // Set proper headers for HTML response
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600') // Cache for 1 hour

    // Send the HTML response
    res.status(200).send(htmlContent)
  } catch (error) {
    logger.error('Error accessing digital receipt', { accessKey: req.params.accessKey, error })
    next(error)
  }
}
