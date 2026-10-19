/**
 * Tarjetas de regalo — controller del dashboard. Delgado: el esquema ya validó (pesos → `Prisma.Decimal`, estados en lista,
 * números ya coaccionados); aquí se llama al servicio, se escribe la bitácora de cada mutación FUERA de la transacción
 * (nunca en un reintento con la misma llave, nunca con un código) y se responde `{ success: true, data }`.
 */
import type { NextFunction, Request, Response } from 'express'
import logger from '@/config/logger'
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
  auditarTarjetas,
  estadoDeVentaDeTarjetas,
  negocioTieneTarjetas,
  operarSobreDeGerente,
  type GiftCardAuditAction,
  type OperacionDeGerenteHttp,
} from '@/services/giftCards/giftCardSurface.service'
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

export async function operate(req: Request, res: Response) {
  const { venueId, giftCardId } = req.params
  const staffId = staffDe(req)
  const body = req.body as OperacionDeGerenteHttp
  const r = await operarSobreDeGerente(venueId, giftCardId, staffId, body)
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
