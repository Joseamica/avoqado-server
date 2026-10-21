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
import { lookupGiftCards } from '@/services/giftCards/giftCardLookup.service'
import type { PruebaDePosesion } from '@/services/giftCards/giftCardProof'
import {
  getGiftCardPaymentByKey,
  payGiftCardBalanceOnOrder,
  payGiftCardOnNewOrder,
  returnGiftBalanceAndCancelOrder,
} from '@/services/mobile/order.mobile.service'
import { leerVentaDeMostrador } from '@/controllers/mobile/order.mobile.controller'
import { auditarReenvio, auditarTarjetas, registrarSalidaDelSecreto } from '@/services/giftCards/giftCardSurface.service'
import {
  TEXTO_SIN_SECRETO,
  cambiarDestinoDeTarjeta,
  getCuentaDeTarjetasPos,
  leerNuevoDestino,
  reenviarTarjeta,
  revelarCodigo,
  revelarCodigosDeLaCuenta,
  type QuienPregunta,
  type ResultadoDeReenvio,
} from '@/services/giftCards/giftCardCuenta.service'
import { entregarTarjetas } from '@/services/giftCards/giftCardDelivery.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { BadRequestError, ServiceUnavailableError } from '@/errors/AppError'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { aparatoDe, origenDe, segunElAparato, staffDe } from '@/utils/giftCardRequest'

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
      // Q110: la venta es de la sesión; si el aparato dice que la empezó otra persona, va como nota.
      data: { idempotencyKey: req.body.idempotencyKey, sobres: data.sobres.length, total: data.total, ...segunElAparato(req) },
      ...origenDe(req),
    })
  else {
    // Q36 + Q102: el reenvío que entrega el código (o la liga) de un sobre es una salida del secreto, esté como esté el sobre
    // (M1 de S4: un BLOCKED o un PENDING de hoy también lo trae). Lo decide lo que se devuelve, no el estado. Su renglón se guarda
    // ANTES de responder; si no, 503 y la venta no se responde (la app reintenta con la misma llave). La creación no escribe aquí.
    const salidas = data.sobres
      .filter(s => s.codigo !== null || s.pageToken !== null)
      .map(s => ({
        venueId,
        staffId,
        action: 'GIFT_CARD_CODE_REVEALED' as const,
        entity: 'GiftCard' as const,
        entityId: s.id,
        data: { motivo: 'REPLAY', idempotencyKey: req.body.idempotencyKey },
        ...origenDe(req),
      }))
    try {
      await registrarSalidaDelSecreto(prisma, salidas)
    } catch (error) {
      logger.error('🎁 [tarjetas de regalo] no se guardó la salida del código del reenvío de la venta: no se responde', {
        venueId,
        orderId: data.orderId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new ServiceUnavailableError(TEXTO_SIN_SECRETO)
    }
  }
  res.status(data.replay ? 200 : 201).json({ success: true, data })
}

export async function lookup(req: Request, res: Response) {
  const { venueId } = req.params
  // El esquema ya exige exactamente uno: el código o la liga (1b S2).
  const { code, pageToken } = req.body as { code?: string; pageToken?: string }
  const prueba = pageToken !== undefined ? { pageToken } : { code: String(code) }
  const data = await lookupGiftCards(venueId, prueba, { deviceId: aparatoDe(req) ?? undefined, ip: req.ip })
  res.json({ success: true, data })
}

export async function payWithBalance(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const staffId = staffDe(req)
  const { idempotencyKey, proof, amount, tip } = req.body as {
    idempotencyKey: string
    proof: PruebaDePosesion
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
        // Q110: el cobro es SIEMPRE de la sesión (`staffId`); si el aparato dice que lo empezó otra persona, va como nota.
        ...segunElAparato(req),
      },
      ...origenDe(req),
    })
  res.json({ success: true, data })
}

/**
 * S2b (Q58): `POST …/gift-cards/pay-new-order` — la venta de mostrador nace y se cobra con saldo en una sola transacción. La venta
 * se lee como en `POST /orders` (`leerVentaDeMostrador`, sin la propina de orden): su vendedor es el `staffId` del cuerpo o la
 * sesión (Q76). El cobro es SIEMPRE de la sesión (Q110); `iniciadoPor` sólo va como nota en la bitácora, nunca en un `replay`.
 */
export async function payNewOrder(req: Request, res: Response) {
  const { venueId } = req.params
  const staffId = staffDe(req)
  const lectura = leerVentaDeMostrador(req.body, { conPropinaDeOrden: false, venueId, usuario: staffId })
  if ('error' in lectura) {
    res.status(400).json({ success: false, message: lectura.error })
    return
  }
  const { idempotencyKey, proof, amount, tip } = req.body as {
    idempotencyKey: string
    proof: PruebaDePosesion
    amount: Prisma.Decimal
    tip?: Prisma.Decimal
  }
  const data = await payGiftCardOnNewOrder(venueId, {
    ...lectura.input,
    idempotencyKey,
    proof,
    amount,
    tip: tip ?? new Prisma.Decimal(0),
    deviceId: aparatoDe(req),
    procesadoPor: staffId,
  })
  if (data.replay !== true)
    auditarTarjetas({
      venueId,
      staffId,
      action: 'GIFT_CARD_REDEEMED',
      entity: 'Payment',
      entityId: data.paymentId,
      data: {
        orderId: data.orderId,
        cuentaNueva: true,
        idempotencyKey,
        amount: data.amount,
        tipAmount: data.tipAmount,
        cards: data.redeemed.map(r => ({ giftCardId: r.giftCardId, amount: r.amount })),
        // Q110: el cobro es SIEMPRE de la sesión (`staffId`); si el aparato dice que lo empezó otra persona, va como nota.
        ...segunElAparato(req),
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

// ─── 1b S4: el detalle de la cuenta, reenviar, cambiar el destino y mostrar el código ───

/** Las rutas tal cual las monta `mobile.routes.ts` (van a la bitácora como `ruta`). */
const RUTA = {
  resend: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/resend',
  changeDestination: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/change-destination',
  reveal: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/reveal',
  revealManager: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/reveal-manager',
  revealCuenta: 'POST /mobile/venues/:venueId/gift-cards/orders/:orderId/reveal',
} as const

const autorizoElGerente = (req: Request): string | null => (req as any).authContext?.overrideAuthorizedBy ?? null

/** Q16: qué puede QUIEN PREGUNTA, de verdad (sin PIN: `tienePermisoEnVenue` no lo honra). */
async function quienPregunta(req: Request): Promise<QuienPregunta> {
  const [puedeVender, puedeGestionar] = await Promise.all([
    tienePermisoEnVenue(req, 'giftCards:sell'),
    tienePermisoEnVenue(req, 'giftCards:manage'),
  ])
  return { staffId: staffDe(req), puedeVender, puedeGestionar, overrideAuthorizedBy: autorizoElGerente(req) }
}

/**
 * Lo que la RUTA ya garantizó, sin otra consulta: `giftCards:sell` (o `giftCards:manage`, ya autorizado por `checkPermission` o el
 * PIN, que no se vuelve a preguntar: Q16). Para las acciones cuya regla no depende de quién pregunta.
 */
function segunLaRuta(req: Request, gerente: boolean): QuienPregunta {
  return { staffId: staffDe(req), puedeVender: true, puedeGestionar: gerente, overrideAuthorizedBy: autorizoElGerente(req) }
}

/** Q17: la entrega inmediata, sin esperarla. El trabajo de cada minuto cubre lo que esta patada no alcance. */
function patear(ids: string[]): void {
  if (ids.length === 0) return
  void entregarTarjetas({ ids }).catch(error =>
    logger.error('🎁 [tarjetas de regalo] la entrega inmediata falló; la toma el trabajo de cada minuto', {
      giftCardIds: ids,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

/** Q36: el GET del detalle es la patada de la entrega (las apps lo consultan para salir de «Activando…»). */
export async function getCuenta(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const data = await getCuentaDeTarjetasPos(venueId, orderId, await quienPregunta(req))
  res.json({ success: true, data })
  patear(
    data.sobres
      .filter(
        s => s.status === 'ACTIVE' && (s.deliveryChannel === 'WHATSAPP' || s.deliveryChannel === 'EMAIL') && s.deliveryStatus === 'PENDING',
      )
      .map(s => s.id),
  )
}

/** Responde `{ giftCardId, deliveryStatus, repuesta, ultimos4 }`; la bitácora la traduce `auditarReenvio`; un reenvío nuevo patea. */
async function responderReenvio(req: Request, res: Response, ruta: string, operar: () => Promise<ResultadoDeReenvio>) {
  const { venueId, giftCardId } = req.params
  const { operationKey } = req.body as { operationKey: string }
  const comun = {
    venueId,
    staffId: staffDe(req),
    giftCardId,
    operationKey,
    ruta,
    overrideAuthorizedBy: autorizoElGerente(req),
    ...origenDe(req),
  }
  let r: ResultadoDeReenvio
  try {
    r = await operar()
  } catch (error) {
    if (error instanceof GiftCardError || error instanceof BadRequestError) auditarReenvio({ ...comun, rechazo: error })
    throw error
  }
  auditarReenvio({ ...comun, resultado: r })
  res.json({
    success: true,
    data: { giftCardId: r.giftCardId, deliveryStatus: r.deliveryStatus, repuesta: r.repuesta, ultimos4: r.ultimos4 },
  })
  if (!r.replay) patear([r.giftCardId])
}

export async function resend(req: Request, res: Response) {
  const { venueId, giftCardId } = req.params
  await responderReenvio(req, res, RUTA.resend, async () =>
    reenviarTarjeta(venueId, giftCardId, segunLaRuta(req, false), {
      operationKey: req.body.operationKey,
      destino: leerNuevoDestino(req.body),
    }),
  )
}

export async function changeDestination(req: Request, res: Response) {
  const { venueId, giftCardId } = req.params
  await responderReenvio(req, res, RUTA.changeDestination, async () => {
    const destino = leerNuevoDestino(req.body)
    // El esquema exige el canal: sin él, `leerNuevoDestino` no devuelve destino.
    if (!destino) throw new BadRequestError('Para cambiar el destino elige WhatsApp o correo', 'GIFT_CARD_DESTINATION_CHANNEL_INVALID')
    return cambiarDestinoDeTarjeta(venueId, giftCardId, segunLaRuta(req, true), { operationKey: req.body.operationKey, destino })
  })
}

/** RF3: el 403 de otro día deja su `GIFT_CARD_REVEAL_DENIED` (de mejor esfuerzo) y se relanza. */
async function revelarConBitacora<T>(req: Request, ruta: string, entity: 'GiftCard' | 'Order', entityId: string, operar: () => Promise<T>) {
  try {
    return await operar()
  } catch (error) {
    if (error instanceof GiftCardError && error.code === 'GIFT_CARD_REVEAL_NOT_ALLOWED') {
      auditarTarjetas({
        venueId: req.params.venueId,
        staffId: staffDe(req),
        action: 'GIFT_CARD_REVEAL_DENIED',
        entity,
        entityId,
        data: { code: error.code, operationKey: req.body.operationKey, ruta },
        ...origenDe(req),
      })
    }
    throw error
  }
}

const auditoriaDe = (req: Request, ruta: string) => ({
  staffId: staffDe(req),
  ruta,
  overrideAuthorizedBy: autorizoElGerente(req),
  ...origenDe(req),
})

export async function reveal(req: Request, res: Response) {
  const { venueId, giftCardId } = req.params
  const { operationKey, motivo } = req.body as { operationKey: string; motivo: 'REPRINT' | 'SHOW_QR' }
  const quien = await quienPregunta(req)
  const data = await revelarConBitacora(req, RUTA.reveal, 'GiftCard', giftCardId, () =>
    revelarCodigo(venueId, giftCardId, quien, { operationKey, motivo, comoGerente: false, auditoria: auditoriaDe(req, RUTA.reveal) }),
  )
  res.json({ success: true, data })
}

export async function revealManager(req: Request, res: Response) {
  const { venueId, giftCardId } = req.params
  const { operationKey, motivo } = req.body as { operationKey: string; motivo: 'REPRINT' | 'SHOW_QR' }
  const data = await revelarCodigo(venueId, giftCardId, segunLaRuta(req, true), {
    operationKey,
    motivo,
    comoGerente: true,
    auditoria: auditoriaDe(req, RUTA.revealManager),
  })
  res.json({ success: true, data })
}

/** Q42: imprimir o mostrar el QR de la cuenta entera, siempre con el código vigente. */
export async function revealCuenta(req: Request, res: Response) {
  const { venueId, orderId } = req.params
  const { operationKey } = req.body as { operationKey: string }
  // Q42: la cuenta entera sólo se muestra el mismo día, sea quien sea (otro día, tarjeta por tarjeta con `reveal-manager`).
  const data = await revelarConBitacora(req, RUTA.revealCuenta, 'Order', orderId, () =>
    revelarCodigosDeLaCuenta(venueId, orderId, segunLaRuta(req, false), { operationKey, auditoria: auditoriaDe(req, RUTA.revealCuenta) }),
  )
  res.json({ success: true, data })
}
