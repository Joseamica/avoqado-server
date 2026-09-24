/**
 * Avisos de Facturapi — POST /api/v1/webhooks/facturapi/:emisorId
 *
 * Montado con express.raw(): la firma (`Facturapi-Signature`) es un HMAC del cuerpo CRUDO, así que no se
 * puede parsear antes. Cada emisor (organización de Facturapi) tiene su URL y su secreto.
 *
 * Respuestas: 401 firma inválida · 404 emisor desconocido · 200 procesado o ignorado · 503 si no pudimos
 * consultar al PAC — para que Facturapi reintente; el barrido horario del job lo recoge de todos modos.
 */
import { Request, Response } from 'express'

import logger from '@/config/logger'
import { defaultProcesarAvisoDeps, procesarAvisoDeFacturapi } from '@/services/fiscal/facturapiWebhook.service'

export async function handleFacturapiWebhook(req: Request, res: Response): Promise<void> {
  const emisorId = req.params.emisorId
  const firma = req.get('facturapi-signature') ?? undefined
  const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)

  try {
    const r = await procesarAvisoDeFacturapi({ emisorId, cuerpo, firma }, defaultProcesarAvisoDeps())
    if (r.http >= 400) logger.warn(`[facturapi-webhook] aviso rechazado para el emisor ${emisorId}: ${r.resultado}`)
    else logger.info(`[facturapi-webhook] aviso del emisor ${emisorId}: ${r.resultado}`)
    res.status(r.http).json({ received: r.http < 400, resultado: r.resultado })
  } catch (err: unknown) {
    logger.error(
      `[facturapi-webhook] no se pudo procesar el aviso del emisor ${emisorId}: ${err instanceof Error ? err.message : String(err)}`,
    )
    res.status(503).json({ received: false })
  }
}
