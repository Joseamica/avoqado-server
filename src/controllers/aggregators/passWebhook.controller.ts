import crypto from 'crypto'
import { Request, Response } from 'express'
import logger from '@/config/logger'
import { adapterFor, hasAdapter } from '@/services/aggregators/core/adapterRegistry'
import { persistInboundEvent, resolveConnectionByToken } from '@/services/aggregators/core/inboundEvent.service'
import { processInboundEvent } from '@/services/aggregators/core/eventProcessor.service'
import { PassAdapter, Provider } from '@/services/aggregators/core/types'

const PROVIDERS: Record<string, Provider> = { totalpass: 'TOTALPASS', wellhub: 'WELLHUB' }
const KINDS: Record<string, 'BOOKING' | 'CHECKIN'> = { booking: 'BOOKING', checkin: 'CHECKIN' }

/**
 * La llave del adaptador puede tronar con un JSON válido pero de forma inesperada. Persistir-antes-del-ACK tiene que
 * sostenerse igual: se cae a un hash de los bytes crudos (mismo cuerpo ⇒ misma llave), y el procesador lo marcará luego.
 */
function safeDedupKey(adapter: PassAdapter, provider: Provider, kind: 'BOOKING' | 'CHECKIN', body: unknown, raw: Buffer): string {
  try {
    return adapter.dedupKey(kind, body)
  } catch (err: any) {
    logger.warn(`[PASES] dedupKey de ${provider} falló (${err?.message}); se usa el hash del cuerpo`)
    return `${provider}:${kind}:${crypto.createHash('sha256').update(raw).digest('hex')}`
  }
}

/**
 * POST /api/v1/webhooks/aggregators/:provider/:token/:kind (montada en app.ts con `express.raw({ type: '*\/*' })`).
 * El proveedor no firma: la URL lleva un secreto por conexión — nunca se loguea. Se persiste ANTES de contestar 200
 * y se procesa sin await; si algo falla después, el job lo reintenta (patrón delivery).
 */
export async function handlePassWebhook(req: Request, res: Response): Promise<void> {
  const provider = PROVIDERS[String(req.params.provider)]
  const kind = KINDS[String(req.params.kind)]
  const token = String(req.params.token ?? '')
  if (!provider || !kind || !hasAdapter(provider)) {
    res.status(404).end()
    return
  }
  const conn = await resolveConnectionByToken(provider, token)
  if (!conn) {
    res.status(404).end()
    return
  }
  if (conn.status === 'PAUSED' || conn.status === 'REVOKED') {
    logger.info(`[PASES] webhook ignorado: conexión ${conn.id} en ${conn.status}`)
    res.status(200).end()
    return
  }
  // Sin Buffer no hay bytes crudos (sin cuerpo, o sin Content-Type): guardar `{}` con 200 perdería el evento en silencio.
  if (!Buffer.isBuffer(req.body)) {
    logger.warn(
      `[PASES] webhook de ${provider} sin cuerpo crudo (conexión ${conn.id}, content-type: ${req.headers['content-type'] ?? 'ninguno'})`,
    )
    res.status(415).json({ error: 'se esperaba un cuerpo JSON' })
    return
  }
  const raw = req.body
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    res.status(400).json({ error: 'cuerpo inválido' })
    return
  }
  // `null`, un número o un arreglo son JSON válido pero no un evento (y `null` en la columna Json requerida daría 503 eterno).
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.status(400).json({ error: 'cuerpo inválido' })
    return
  }
  const adapter = adapterFor(provider)
  try {
    const { event, duplicate } = await persistInboundEvent({
      provider,
      connectionId: conn.id,
      venueId: conn.venueId,
      kind,
      dedupKey: safeDedupKey(adapter, provider, kind, body, raw),
      payload: body,
    })
    res.status(200).end()
    if (!duplicate) void processInboundEvent(event.id).catch(err => logger.error(`[PASES] procesar evento ${event.id}: ${err?.message}`))
  } catch (err: any) {
    logger.error(`[PASES] no se pudo guardar el webhook de ${provider}: ${err?.message}`)
    res.status(503).end()
  }
}
