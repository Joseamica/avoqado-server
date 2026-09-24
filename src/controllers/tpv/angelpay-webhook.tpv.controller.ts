/**
 * AngelPay TPV Webhook Controller — HTTP adapter for the receiver endpoint.
 *
 * Responsibilities:
 *   1. Read merchantAccountId from URL param, look up MerchantAccount + per-row secret
 *   2. Read raw Buffer body (HMAC verification needs exact bytes)
 *   3. Read real AngelPay headers: X-Webhook-Event-Id, X-Webhook-Signature,
 *      X-Webhook-Timestamp, X-Webhook-Event (Express lowercases all header names)
 *   4. Verify HMAC-SHA256 signature:
 *        key  = full secret string including "whsec_" prefix, as raw UTF-8 bytes
 *        body = raw request body bytes exactly as received
 *        output = lowercase hex digest (64 chars)
 *   5. Hand off to the service for matching + reconciliation
 *   6. Map AngelPayWebhookResult → HTTP response (always 200 if signature ok, except 404/503 errors). 🔴 503 también cuando
 *      el aviso NO se pudo guardar (Codex, pasada final P1-2): el servicio sólo lanza antes del ingreso durable.
 *
 * See: docs/angelpay/WEBHOOK_RECEIVER_SPEC.md §7
 */

import crypto from 'crypto'

import { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { AngelPayWebhookPayload } from '@/services/tpv/angelpay-webhook.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'
import { registrarAvisoNoGuardado, reingresarMasTarde, TOPE_DE_CUERPO_PARA_REINGRESO } from '@/services/tpv/avisosNoGuardados'
import { llaveDeIntento } from '@/services/tpv/candadoDeIntento'
import { clasificarEstadoBancario } from '@/services/tpv/estadoBancario'

const ID_DE_COMERCIO_POSIBLE = /^[A-Za-z0-9_-]{1,64}$/

/** Lo que llegó por HTTP, sin `req`/`res`: así el reingreso procesa EXACTAMENTE la misma entrada. */
type AvisoCrudo = { merchantAccountId: string | undefined; rawBody: Buffer; eventId: string | undefined; signature: string | undefined }
type Respuesta = { status: number; body: unknown; noGuardado?: true }

const NO_GUARDADO: Respuesta = { status: 503, body: { error: 'webhook not stored, retry later' }, noGuardado: true }

export async function handleAngelPayWebhook(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const r = await procesarAviso({
    merchantAccountId: req.params.merchantAccountId,
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})),
    // Real AngelPay header names (Express lowercases them)
    eventId: req.header('x-webhook-event-id'),
    signature: req.header('x-webhook-signature'),
  })
  res.status(r.status).json(r.body)
}

async function procesarAviso(aviso: AvisoCrudo): Promise<Respuesta> {
  const { merchantAccountId, rawBody, eventId, signature } = aviso
  if (!merchantAccountId) return { status: 400, body: { error: 'missing merchantAccountId path param' } }
  // Un id que no puede existir no toca la base: con un byte nulo la búsqueda REVIENTA en Postgres (22021, medido) y caería
  // en la rama «la base falló», que marca el canal de un comercio inexistente con cada request basura. Todos los ids reales
  // son cuid (34 de 34 en producción, 23-sep); el patrón es más amplio a propósito.
  if (!ID_DE_COMERCIO_POSIBLE.test(merchantAccountId)) return { status: 404, body: { error: 'unknown merchant' } }

  let merchantAccount: { id: string; externalMerchantId: string; angelpayWebhookSecret: string | null } | null
  try {
    merchantAccount = await prisma.merchantAccount.findFirst({
      where: { id: merchantAccountId, provider: { code: 'ANGELPAY' } },
      select: {
        id: true,
        externalMerchantId: true,
        angelpayWebhookSecret: true,
      },
    })
  } catch (err) {
    // 🔴 Codex pasada final (P1-2): la base falló antes de poder verificar la firma. Sólo se marca el CANAL de ese comercio
    // (su silencio deja de probar nada un rato); un cuerpo sin firma verificada nunca crea un veto. El reingreso sí se programa:
    // al reintentar, la firma se verifica como siempre.
    registrarAvisoNoGuardado({ merchantAccountId, attemptId: null, posibleDinero: false })
    reingresar(aviso, false)
    logger.error('🚨 [AngelPay webhook] No se pudo buscar el comercio: el aviso NO se guardó — 503 y reingreso propio', {
      err,
      merchantAccountId,
    })
    return NO_GUARDADO
  }

  if (!merchantAccount) return { status: 404, body: { error: 'unknown merchant' } }
  if (!merchantAccount.angelpayWebhookSecret) return { status: 503, body: { error: 'webhook not provisioned for this merchant' } }
  if (!signature || !eventId) return { status: 401, body: { error: 'missing signature headers' } }

  // HMAC-SHA256 with the full secret string (including "whsec_" prefix) as raw UTF-8 key.
  // This is NOT Svix: the key is NOT base64-decoded, NOT stripped. Pass the full string.
  const expected = crypto.createHmac('sha256', merchantAccount.angelpayWebhookSecret).update(rawBody).digest('hex')

  const valid = expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))

  if (!valid) {
    logger.warn('🚫 [AngelPay webhook] invalid signature', { merchantAccountId, eventId })
    return { status: 401, body: { error: 'invalid signature' } }
  }

  let payload: AngelPayWebhookPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as AngelPayWebhookPayload
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } }
  }

  try {
    const result = await processAngelPayWebhook({
      payload,
      eventId: eventId,
      merchantAccount: {
        id: merchantAccount.id,
        externalMerchantId: merchantAccount.externalMerchantId,
      },
    })
    return { status: 200, body: result }
  } catch (err) {
    // 🔴 Codex pasada final (P1-2): el servicio lanza SÓLO si el aviso no quedó guardado (lo que falla después del ingreso
    // durable lo recupera el worker y ya contestó). Un 200 aquí le decía a AngelPay «recibido» por una aprobación que no existe
    // en ningún lado. 503 ⇒ AngelPay puede reintentar; el servidor reingresa él mismo; y la firma YA está verificada: el aviso
    // es auténtico.
    const datos = (payload as { payload?: { integratorReference?: unknown; status?: unknown } } | null)?.payload
    registrarAvisoNoGuardado({
      merchantAccountId: merchantAccount.id,
      attemptId: llaveDeIntento(datos?.integratorReference),
      posibleDinero: clasificarEstadoBancario(datos?.status) !== 'RECHAZADO',
    })
    reingresar(aviso, true)
    logger.error('🚨 [AngelPay webhook] El aviso firmado NO se pudo guardar — 503 y reingreso propio', {
      err,
      eventId,
      merchantAccountId: merchantAccount.id,
    })
    return NO_GUARDADO
  }
}

/**
 * El reingreso propio (ver `avisosNoGuardados.ts`). Sólo con las cabeceras de firma —sin ellas el aviso acabaría en 401 igual— y
 * con un cuerpo del tamaño de un aviso real: en la búsqueda caída el cuerpo llega SIN verificar y la memoria no se llena de basura.
 */
function reingresar(aviso: AvisoCrudo, verificado: boolean): void {
  if (!aviso.merchantAccountId || !aviso.eventId || !aviso.signature) return
  if (aviso.rawBody.length > TOPE_DE_CUERPO_PARA_REINGRESO) return
  // 🔴 Hermano del P1 de Codex final-3 (hallado antes de mandárselo): la clave es la de ESTA entrega (firma + cuerpo), no sólo
  // comercio/eventId. Con la búsqueda caída no se puede verificar a nadie, y con la clave compartida el primero en llegar —quizá
  // un falso— le quitaba el lugar al auténtico. Dos entregas idénticas (el reintento de AngelPay firma el mismo cuerpo) siguen
  // compartiendo clave.
  const huella = crypto.createHash('sha256').update(aviso.signature).update('\n').update(aviso.rawBody).digest('hex')
  reingresarMasTarde(
    `${aviso.merchantAccountId}:${aviso.eventId}:${huella}`,
    async () => !(await procesarAviso(aviso)).noGuardado,
    verificado,
  )
}

export function angelpayWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    message: 'AngelPay TPV webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
}
