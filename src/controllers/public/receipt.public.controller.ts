// controllers/public/receipt.public.controller.ts
import { NextFunction, Request, Response } from 'express'
import { generateReceiptUrl, getDigitalReceiptByAccessKey } from '../../services/tpv/digitalReceipt.tpv.service'
import { NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'

// Public route to get a receipt by its access key
// GET /api/public/receipt/:accessKey
//
// 🔴 ESTA RUTA TIENE DOS RAMAS. Lee esto antes de borrar nada.
//
//   • Rama JSON (`Accept: application/json` o `*/*`) — **VIVA Y EN USO.** Es de donde el
//     dashboard saca los datos del recibo público (`ReceiptViewer.tsx` →
//     `GET /api/v1/public/receipt/:accessKey`). Si la quitas, tumbas la página
//     de recibo del cliente final por completo.
//   • Rama del navegador (`Accept: text/html`, o sin Accept: un QR escaneado) — redirige a esa
//     página nueva (`${FRONTEND_URL}/receipts/public/:accessKey`), que además tiene calificación y
//     AUTOFACTURA. Sólo la alcanzan los QR que ANDROID e iOS imprimieron del 22-jul al 4-ago-2026;
//     la página HTML vieja que antes se pintaba aquí se quitó (D21, 31-oct-2026).
//
// Sus hermanas `/:accessKey/review*` y `/:accessKey/cfdi*` (public.routes.ts)
// también están VIVAS: son justamente las que hacen funcionar la página nueva.
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
        },
      })
      return
    }

    // 302 y no 301: el navegador no lo guarda para siempre, por si un día cambia FRONTEND_URL.
    res.redirect(302, generateReceiptUrl(receipt.accessKey, process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'))
  } catch (error) {
    logger.error('Error accessing digital receipt', { accessKey: req.params.accessKey, error })
    next(error)
  }
}
