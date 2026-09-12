/**
 * La liga del recibo digital de un pago, para que el POS dibuje el QR al REIMPRIMIR un ticket.
 *
 * 🔴 Un solo handler montado en los DOS namespaces (`/mobile` para android/iOS y `/tpv` para las
 * terminales). Si cada uno tuviera el suyo, acabarían respondiendo distinto — que es exactamente
 * cómo nació el defecto que esto cierra: el ticket del cobro y el de la reimpresión se armaban en
 * funciones separadas y sólo una supo nunca dibujar el QR.
 *
 * Forma de la respuesta: `{ success, receipt }`, la misma que el detalle de transacción
 * (`transaction.mobile.controller.ts:47`) desde el que se reimprime. La entidad va con NOMBRE y no
 * suelta dentro de `data`, porque leer `data` como si fuera la entidad ya dejó una pantalla
 * cargando para siempre una vez.
 */
import { NextFunction, Request, Response } from 'express'
import { getReceiptForPayment } from '../../services/shared/receiptForPayment.service'

/**
 * @route GET /api/v1/mobile/venues/:venueId/payments/:paymentId/receipt
 * @route GET /api/v1/tpv/venues/:venueId/payments/:paymentId/receipt
 */
export const getReceiptLink = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, paymentId } = req.params

    const receipt = await getReceiptForPayment(venueId, paymentId)

    return res.json({
      success: true,
      receipt,
    })
  } catch (error) {
    next(error)
  }
}
