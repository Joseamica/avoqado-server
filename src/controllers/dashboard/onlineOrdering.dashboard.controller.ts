import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import { cardRefundKey } from '@/schemas/online-ordering.schema'
import { listCardRefunds, refundCardOnlineOrder, resolveReversedCardRefund } from '@/services/online-ordering/card/refund.service'
import { getInboxOrder } from '@/services/online-ordering/inbox.service'
import { getOnlineMenuSummary, listOnlineMenuProducts } from '@/services/online-ordering/menuAdmin.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { settingsView } from '@/services/online-ordering/settingsView.service'

const staffOf = (req: Request): string | null => (req as any).authContext?.userId ?? null
/** Mover dinero exige saber quién: sin usuario autenticado no hay devolución. */
const requireStaff = (req: Request): string => {
  const staffId = staffOf(req)
  if (!staffId) throw new UnauthorizedError('Inicia sesión para devolver un cobro')
  return staffId
}

/** 1b: además de los ajustes, el estado de la tienda (el mismo cálculo que `/info`) y qué falta para poder encenderla (R18). */
export const getSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ success: true, data: await settingsView(req.params.venueId) })
  } catch (e) {
    return next(e)
  }
}

/** Ronda final (C1): responde la MISMA vista que el GET; el panel guarda esta respuesta en la caché del GET. */
export const updateSettingsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const saved = await updateSettings(venueId, req.body, staffOf(req))
    return res.json({ success: true, data: await settingsView(venueId, saved) })
  } catch (e) {
    return next(e)
  }
}

export const setMenuAvailabilityHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { availableOnline, productIds, categoryIds, allProducts } = req.body
    const data = await setOnlineAvailability({
      venueId: req.params.venueId,
      availableOnline,
      productIds,
      categoryIds,
      allProducts,
      actorStaffId: staffOf(req),
    })
    return res.json({ success: true, data })
  } catch (e) {
    return next(e)
  }
}

/** 1b: el «menú en línea» del panel: conteos por categoría. */
export const getMenuCategoriesHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ success: true, data: await getOnlineMenuSummary(req.params.venueId) })
  } catch (e) {
    return next(e)
  }
}

/** 1b: una página de platillos vendibles. El query ya viene validado por `menuProductsSchema` (`limit` como número). */
export const listMenuProductsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { categoryId, search, cursor, limit } = req.query as { categoryId?: string; search?: string; cursor?: string; limit?: number }
    return res.json({
      success: true,
      data: await listOnlineMenuProducts({ venueId: req.params.venueId, categoryId, search, cursor, limit }),
    })
  } catch (e) {
    return next(e)
  }
}

/** Fase 2 (T10): las devoluciones a la tarjeta de un pedido (estado, y si falló después, «Devolver por otro medio»). */
/**
 * S3 (clientes, Codex plan r1 #2): UN pedido en línea por el id de su cuenta, con la forma de la bandeja. El detalle de la cuenta del
 * panel lo usa para «Devolver a la tarjeta» después de que la bandeja (24 h) ya no lo muestra. 404 si no es pedido en línea.
 */
export const getOnlineOrderHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const data = await getInboxOrder({ venueId, orderId })
    if (!data) throw new NotFoundError('Esta cuenta no es un pedido en línea.')
    return res.json({ success: true, data })
  } catch (e) {
    return next(e)
  }
}

export const listCardRefundsHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    return res.json({ success: true, data: await listCardRefunds(venueId, orderId) })
  } catch (e) {
    return next(e)
  }
}

/**
 * F1: la llave de la devolución, del encabezado `Idempotency-Key` (lo normal, como la TPV) o del cuerpo (compatibilidad). Si llegan
 * las dos y no coinciden, 400: no se adivina cuál es la repetición.
 */
function cardRefundIdempotencyKey(req: Request): string {
  const header = req.header('Idempotency-Key')?.trim() || undefined
  const fromBody = req.body.idempotencyKey as string | undefined
  if (header && fromBody && header !== fromBody) {
    throw new BadRequestError('La llave del encabezado Idempotency-Key y la del cuerpo no coinciden.', 'IDEMPOTENCY_KEY_MISMATCH')
  }
  const key = header ?? fromBody
  if (!key) throw new BadRequestError('Falta la llave de idempotencia (encabezado Idempotency-Key).', 'IDEMPOTENCY_KEY_REQUIRED')
  const parsed = cardRefundKey.safeParse(key)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message, 'IDEMPOTENCY_KEY_INVALID')
  return parsed.data
}

/** Fase 2 (T10): devolver a la tarjeta. El cuerpo ya viene validado por `cardRefundSchema` (monto en PESOS, no centavos). */
export const refundCardHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { amount, reason, note } = req.body
    const idempotencyKey = cardRefundIdempotencyKey(req)
    const data = await refundCardOnlineOrder({
      venueId,
      orderId,
      amount: new Prisma.Decimal(amount),
      reason,
      staffId: requireStaff(req),
      idempotencyKey,
      note: note ?? null,
    })
    return res.json({ success: true, data })
  } catch (e) {
    return next(e)
  }
}

/** Fase 2 (T10): «Devolver por otro medio» (efectivo con caja abierta, o transferencia). */
export const resolveCardRefundHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, refundId } = req.params
    const data = await resolveReversedCardRefund({
      venueId,
      orderId,
      cardRefundId: refundId,
      method: req.body.method,
      staffId: requireStaff(req),
      note: req.body.note ?? null,
    })
    return res.json({ success: true, data })
  } catch (e) {
    return next(e)
  }
}
