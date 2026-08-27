import { Request, Response } from 'express'
import { scanWalletPass } from '../../services/wallet/scanWalletPass.service'

/**
 * La terminal escaneó el QR de la tarjeta de un cliente.
 *
 * 🔴 Va por POST y no por GET a propósito: el código del QR es un secreto, y en una
 * URL quedaría escrito en los registros del servidor, en los del proxy y en cualquier
 * herramienta de monitoreo por la que pase. En el cuerpo no.
 *
 * Un código que no resuelve —de otro negocio, revocado, o basura escaneada— devuelve
 * 200 con `found: false`, no un 404. Todos se ven igual: nada le dice a quien esté
 * probando qué códigos son reales.
 */
export async function scanWalletPassHandler(req: Request, res: Response) {
  const { venueId } = req.params
  const qrToken = String((req.body ?? {}).qrToken ?? '').trim()

  if (!qrToken) return res.status(400).json({ message: 'Falta el código escaneado.' })

  const result = await scanWalletPass(venueId, qrToken)

  return res.status(200).json(result)
}
