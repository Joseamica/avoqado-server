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

    // Check if client wants JSON response
    const acceptHeader = req.get('Accept')
    const wantsJson = acceptHeader && (acceptHeader.includes('application/json') || acceptHeader.includes('*/*'))
    
    if (wantsJson && !acceptHeader.includes('text/html')) {
      // Return JSON data for API clients (like React frontend)
      res.json({
        success: true,
        data: {
          id: receipt.id,
          accessKey: receipt.accessKey,
          paymentId: receipt.paymentId,
          status: receipt.status,
          dataSnapshot: receipt.dataSnapshot,
          createdAt: receipt.createdAt,
          sentAt: receipt.sentAt,
          viewedAt: receipt.viewedAt,
        }
      })
      return
    }

    // Transform dataSnapshot to include missing receiptInfo property
    if (!receipt.dataSnapshot || typeof receipt.dataSnapshot !== 'object') {
      throw new NotFoundError('Invalid receipt data')
    }

    const dataSnapshot = receipt.dataSnapshot as any

    // Transform and validate data snapshot with proper fallbacks
    const receiptData = {
      payment: {
        id: dataSnapshot.payment?.id || '',
        amount: dataSnapshot.payment?.amount || 0,
        tipAmount: dataSnapshot.payment?.tipAmount || 0,
        totalAmount: dataSnapshot.payment?.totalAmount || dataSnapshot.payment?.amount + dataSnapshot.payment?.tipAmount || 0,
        method: dataSnapshot.payment?.method || 'CASH',
        status: dataSnapshot.payment?.status || 'COMPLETED',
        createdAt: dataSnapshot.payment?.createdAt || new Date().toISOString(),
        ...dataSnapshot.payment,
      },
      venue: {
        id: dataSnapshot.venue?.id || '',
        name: dataSnapshot.venue?.name || 'Establecimiento',
        address: dataSnapshot.venue?.address || '',
        city: dataSnapshot.venue?.city || '',
        state: dataSnapshot.venue?.state || '',
        phone: dataSnapshot.venue?.phone || '',
        email: dataSnapshot.venue?.email || '',
        logo: dataSnapshot.venue?.logo,
        primaryColor: dataSnapshot.venue?.primaryColor || '#2563eb', // Default blue color
        currency: dataSnapshot.venue?.currency || 'MXN',
        ...dataSnapshot.venue,
      },
      order: {
        id: dataSnapshot.order?.id || '',
        orderNumber: dataSnapshot.order?.number || 'N/A',
        type: dataSnapshot.order?.type || 'DINE_IN',
        source: dataSnapshot.order?.source || 'POS',
        subtotal: dataSnapshot.order?.subtotal || 0,
        taxAmount: dataSnapshot.order?.taxAmount || dataSnapshot.order?.tax || 0, // Handle both field names
        tipAmount: dataSnapshot.order?.tipAmount || 0,
        total: dataSnapshot.order?.total || 0,
        table: dataSnapshot.order?.table,
        ...dataSnapshot.order,
      },
      items: dataSnapshot.order?.items || [],
      processedBy: dataSnapshot.processedBy,
      receiptInfo: {
        generatedAt: new Date().toISOString(),
        currency: dataSnapshot.venue?.currency || 'MXN',
        taxRate:
          dataSnapshot.order?.taxAmount && dataSnapshot.order?.subtotal ? dataSnapshot.order.taxAmount / dataSnapshot.order.subtotal : 0.16, // Default 16% tax rate for Mexico
      },
    }

    // Log basic receipt access info
    logger.info('Generating receipt HTML', {
      accessKey,
      itemsCount: receiptData.items?.length || 0,
      orderTotal: dataSnapshot.order?.total,
    })

    // Generate HTML template for the receipt
    const htmlContent = generateReceiptHTML(receiptData as any)

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
