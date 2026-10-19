/**
 * Tarjetas de regalo — controller del POS (`/api/v1/mobile`). Delgado: el esquema ya validó y convirtió los pesos a
 * `Prisma.Decimal`; aquí se arma la entrada del servicio, se escribe la bitácora FUERA de la transacción (y no en un
 * reintento con la misma llave) y se responde `{ success: true, data }`. El código de la tarjeta NUNCA va a la bitácora.
 *
 * Crear la cuenta de tarjetas se reintenta con su `idempotencyKey`: A5 devuelve la misma cuenta con `replay: true` y la
 * bitácora no se repite. Su respuesta trae el código de cada sobre (A5: sólo a quien vende, para el QR o el certificado):
 * va al POS y NUNCA a la bitácora ni al log.
 */
import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { lookupGiftCardsByCode } from '@/services/giftCards/giftCardLookup.service'
import { getGiftCardPaymentByKey, payGiftCardBalanceOnOrder, returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { auditarTarjetas } from '@/services/giftCards/giftCardSurface.service'
import { aparatoDe, origenDe, staffDe } from '@/utils/giftCardRequest'

export async function createOrder(req: Request, res: Response) {
  const { venueId } = req.params
  const staffId = staffDe(req)
  const data = await createGiftCardOrder(venueId, staffId, req.body)
  if (!data.replay)
    auditarTarjetas({
      venueId,
      staffId,
      action: 'GIFT_CARD_SALE_CREATED',
      entity: 'Order',
      entityId: data.orderId,
      data: { idempotencyKey: req.body.idempotencyKey, sobres: data.sobres.length, total: data.total },
      ...origenDe(req),
    })
  res.status(data.replay ? 200 : 201).json({ success: true, data })
}

export async function lookup(req: Request, res: Response) {
  const { venueId } = req.params
  const data = await lookupGiftCardsByCode(venueId, String(req.body.code), { deviceId: aparatoDe(req) ?? undefined, ip: req.ip })
  res.json({ success: true, data })
}

export async function payWithBalance(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const staffId = staffDe(req)
  const { idempotencyKey, proof, amount, tip } = req.body as {
    idempotencyKey: string
    proof: { kind: 'CODE'; code: string }
    amount: Prisma.Decimal
    tip?: Prisma.Decimal
  }
  const data = await payGiftCardBalanceOnOrder(venueId, orderId, {
    idempotencyKey,
    proof,
    amount,
    tip: tip ?? new Prisma.Decimal(0),
    staffId,
    deviceId: aparatoDe(req),
  })
  // F9: «nuevo o reintento» lo decide A8 bajo candado (`replay`), nunca una lectura previa aquí.
  if (data.replay !== true)
    auditarTarjetas({
      venueId,
      staffId,
      action: 'GIFT_CARD_REDEEMED',
      entity: 'Payment',
      entityId: data.paymentId,
      data: {
        orderId,
        idempotencyKey,
        amount: data.amount,
        tipAmount: data.tipAmount,
        cards: data.redeemed.map(r => ({ giftCardId: r.giftCardId, amount: r.amount })),
      },
      ...origenDe(req),
    })
  res.json({ success: true, data })
}

export async function getPaymentByKey(req: Request, res: Response) {
  const payment = await getGiftCardPaymentByKey(req.params.venueId, req.params.idempotencyKey)
  res.json({ success: true, data: payment ? { found: true, payment } : { found: false } })
}

export async function returnBalanceAndCancel(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const staffId = staffDe(req)
  const { operationKey } = req.body as { operationKey: string }
  // F9: A8 ya no escribe esta bitácora; el dueño único es esta capa, y sólo si la operación fue nueva.
  const { replay } = await returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey })
  if (!replay)
    auditarTarjetas({
      venueId,
      staffId,
      action: 'GIFT_CARD_BALANCE_RETURNED_ORDER_CANCELLED',
      entity: 'Order',
      entityId: orderId,
      data: { operationKey },
      ...origenDe(req),
    })
  res.json({ success: true, data: { cancelled: true } })
}
