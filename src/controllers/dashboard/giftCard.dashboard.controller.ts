/**
 * Tarjetas de regalo — controller del dashboard. Delgado: el esquema ya validó (pesos → `Prisma.Decimal`, estados en lista,
 * números ya coaccionados); aquí se llama al servicio, se escribe la bitácora de cada mutación FUERA de la transacción
 * (nunca en un reintento con la misma llave, nunca con un código) y se responde `{ success: true, data }`.
 */
import type { NextFunction, Request, Response } from 'express'
import logger from '@/config/logger'
import { BadRequestError, ServiceUnavailableError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { getGiftCardSettings, updateGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import {
  getGiftCardDetail,
  getGiftCardLiabilityAging,
  getGiftCardSummary,
  listGiftCards,
  listPendingAccountingReview,
  streamGiftCardBalancesCsv,
  type EstadoDeListaDeTarjetas,
} from '@/services/giftCards/giftCardReports.service'
import {
  auditarReenvio,
  auditarTarjetas,
  estadoDeVentaDeTarjetas,
  negocioTieneTarjetas,
  operarSobreDeGerente,
  registrarSalidaDelSecreto,
  type GiftCardAuditAction,
  type OperacionDeGerenteHttp,
} from '@/services/giftCards/giftCardSurface.service'
import {
  TEXTO_SIN_SECRETO,
  cambiarDestinoDeTarjeta,
  leerNuevoDestino,
  reenviarTarjeta,
  type QuienPregunta,
  type ResultadoDeReenvio,
} from '@/services/giftCards/giftCardCuenta.service'
import { entregarTarjetas } from '@/services/giftCards/giftCardDelivery.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { origenDe, staffDe } from '@/utils/giftCardRequest'

const ACCION_DE_GERENTE: Record<OperacionDeGerenteHttp['tipo'], GiftCardAuditAction> = {
  AJUSTE: 'GIFT_CARD_ADJUSTED',
  BLOQUEAR: 'GIFT_CARD_BLOCKED',
  DESBLOQUEAR: 'GIFT_CARD_UNBLOCKED',
  REEMPLAZAR_CODIGO: 'GIFT_CARD_CODE_REPLACED',
}

/**
 * Ajustes del dashboard: los de A5 + el estado de venta + `hasCards` (decisión 1 del coordinador: sin plan y sin ninguna
 * tarjeta vendida, el panel enseña el cartel; con tarjetas, la lista). El POS usa la ruta compartida, sin `hasCards`.
 */
export async function getSettings(req: Request, res: Response) {
  const { venueId } = req.params
  const [settings, sale, hasCards] = await Promise.all([
    getGiftCardSettings(venueId),
    estadoDeVentaDeTarjetas(venueId),
    negocioTieneTarjetas(venueId),
  ])
  res.json({ success: true, data: { ...settings, sale, hasCards } })
}

/** A5 valida (montos, vigencia, términos al prender, plan) y escribe `GIFT_CARD_SETTINGS_UPDATED` con antes y después. */
export async function updateSettings(req: Request, res: Response) {
  const { venueId } = req.params
  const data = await updateGiftCardSettings(venueId, req.body, staffDe(req))
  // La misma forma que el GET, para que el panel pueda reemplazar su caché con esta respuesta.
  const [sale, hasCards] = await Promise.all([estadoDeVentaDeTarjetas(venueId), negocioTieneTarjetas(venueId)])
  res.json({ success: true, data: { ...data, sale, hasCards } })
}

export async function list(req: Request, res: Response) {
  const q = req.query as unknown as { page?: number; pageSize?: number; search?: string; status?: EstadoDeListaDeTarjetas[] }
  const data = await listGiftCards(req.params.venueId, { page: q.page, pageSize: q.pageSize, search: q.search, status: q.status })
  res.json({ success: true, data })
}

export async function detail(req: Request, res: Response) {
  const q = req.query as unknown as { cursor?: string; limit?: number }
  const data = await getGiftCardDetail(req.params.venueId, req.params.giftCardId, { cursor: q.cursor, limit: q.limit })
  res.json({ success: true, data })
}

export async function operate(req: Request, res: Response, next: NextFunction) {
  const { venueId, giftCardId } = req.params
  const staffId = staffDe(req)
  const body = req.body as OperacionDeGerenteHttp
  const r = await operarSobreDeGerente(venueId, giftCardId, staffId, body)
  // 🔴 Q104 (Q102): el reintento de «Reponer código» devuelve el código VIGENTE (aunque otra reposición lo haya cambiado): es una
  // salida del secreto. Su renglón se guarda ANTES de responder y con `await`; si no se guarda, 503 y el código no sale. Sin el
  // código, sin `pageToken` y sin el destino en `data`. La primera reposición sigue con su bitácora de mejor esfuerzo, abajo.
  if (r.replayed && r.nuevoCodigo) {
    try {
      await registrarSalidaDelSecreto(prisma, [
        {
          venueId,
          staffId,
          action: 'GIFT_CARD_CODE_REVEALED',
          entity: 'GiftCard',
          entityId: giftCardId,
          data: { operationKey: body.operationKey, motivo: 'REPLACE_REPLAY', ruta: 'dashboard:operate' },
          ...origenDe(req),
        },
      ])
    } catch (error) {
      logger.error('🎁 [tarjetas de regalo] no se guardó la salida del código del reintento de «Reponer código»: no se responde', {
        venueId,
        giftCardId,
        error: error instanceof Error ? error.message : String(error),
      })
      return next(new ServiceUnavailableError(TEXTO_SIN_SECRETO))
    }
  }
  // F9: `replayed` es el `replay` que la libreta decidió bajo el candado del sobre; ninguna lectura previa aquí.
  if (!r.replayed)
    auditarTarjetas({
      venueId,
      staffId,
      action: ACCION_DE_GERENTE[body.tipo],
      entity: 'GiftCard',
      entityId: giftCardId,
      data: {
        operationKey: body.operationKey,
        tipo: body.tipo,
        reason: body.reason,
        note: body.note ?? null,
        ...(body.tipo === 'AJUSTE' ? { direccion: body.direccion, amount: Number(body.amount.toFixed(2)) } : {}),
        activityIds: r.activityIds,
      },
      ...origenDe(req),
    })
  res.json({ success: true, data: { activityIds: r.activityIds, ...(r.nuevoCodigo ? { nuevoCodigo: r.nuevoCodigo } : {}) } })
}

// ─── 1b S7: reenviar o cambiar el destino desde el panel (Q16, P-2, D3) ───

/** La ruta tal cual la monta `dashboard.routes.ts` (va a la bitácora como `ruta`). */
const RUTA_REENVIO = 'POST /dashboard/venues/:venueId/gift-cards/:giftCardId/resend'

/** Q17: la entrega inmediata, sin esperarla. El trabajo de cada minuto cubre lo que esta patada no alcance. */
function patear(giftCardId: string): void {
  void entregarTarjetas({ ids: [giftCardId] }).catch(error =>
    logger.error('🎁 [tarjetas de regalo] la entrega inmediata falló; la toma el trabajo de cada minuto', {
      giftCardIds: [giftCardId],
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

/**
 * `POST …/gift-cards/:giftCardId/resend` del panel. La ruta exige `giftCards:manage`, así que quien llama es gerente (Q16).
 * Sin destino ⇒ `reenviarTarjeta`; CON destino ⇒ siempre `cambiarDestinoDeTarjeta`, que ya trata el mismo destino como reenvío
 * (D3: aquí no se comparan destinos). El negocio es el de la RUTA: una tarjeta de otro negocio responde lo mismo que una que no
 * existe. La misma respuesta que el POS y la MISMA traducción a bitácora (`auditarReenvio`, S4); un reenvío nuevo patea la entrega.
 */
export async function resend(req: Request, res: Response) {
  const { venueId, giftCardId } = req.params
  const staffId = staffDe(req)
  const { operationKey } = req.body as { operationKey: string }
  const quien: QuienPregunta = { staffId, puedeVender: true, puedeGestionar: true }
  const comun = { venueId, staffId, giftCardId, operationKey, ruta: RUTA_REENVIO, ...origenDe(req) }
  let r: ResultadoDeReenvio
  try {
    const destino = leerNuevoDestino(req.body)
    r = destino
      ? await cambiarDestinoDeTarjeta(venueId, giftCardId, quien, { operationKey, destino })
      : await reenviarTarjeta(venueId, giftCardId, quien, { operationKey })
  } catch (error) {
    if (error instanceof GiftCardError || error instanceof BadRequestError) auditarReenvio({ ...comun, rechazo: error })
    throw error
  }
  auditarReenvio({ ...comun, resultado: r })
  res.json({
    success: true,
    data: { giftCardId: r.giftCardId, deliveryStatus: r.deliveryStatus, repuesta: r.repuesta, ultimos4: r.ultimos4 },
  })
  if (!r.replay) patear(r.giftCardId)
}

export async function summary(req: Request, res: Response) {
  const { from, to } = req.query as { from: string; to: string }
  res.json({ success: true, data: await getGiftCardSummary(req.params.venueId, { from, to }) })
}

export async function aging(req: Request, res: Response) {
  res.json({ success: true, data: await getGiftCardLiabilityAging(req.params.venueId, String(req.query.at)) })
}

export async function pendingAccounting(req: Request, res: Response) {
  const q = req.query as unknown as { from: string; to: string; page?: number; pageSize?: number }
  const data = await listPendingAccountingReview(req.params.venueId, { from: q.from, to: q.to, page: q.page, pageSize: q.pageSize })
  res.json({ success: true, data })
}

/**
 * Nota 7 del coordinador (C4 r1): el servicio escribe y termina la respuesta él solo; si el cliente ya se fue, regresa sin
 * mandar nada. Por eso aquí no se escribe NADA después del `await`. Si lanza con cabeceras ya enviadas (parte del CSV ya
 * salió) o con la respuesta destruida, ya no hay a quién responderle un error: se corta la conexión —un archivo a medias
 * nunca parece completo— y queda el rastro en el log.
 */
export async function exportCsv(req: Request, res: Response, next: NextFunction) {
  try {
    await streamGiftCardBalancesCsv(req.params.venueId, res)
  } catch (error) {
    if (!res.headersSent && !res.destroyed) return next(error)
    logger.error('Falló la exportación del CSV de saldos de tarjetas de regalo a media respuesta', {
      venueId: req.params.venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    if (!res.destroyed) res.destroy()
  }
}
