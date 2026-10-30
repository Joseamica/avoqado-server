/**
 * Mobile Order Controller
 *
 * Order management endpoints for mobile apps (iOS, Android).
 * Supports the dual-mode payment flow where iOS creates an order
 * with items, then sends orderId to TPV for payment processing.
 */

import { NextFunction, Request, Response } from 'express'
import { customerAttributionActor } from '../../middlewares/customerAttribution.middleware'
import logger from '../../config/logger'
import * as orderMobileService from '../../services/mobile/order.mobile.service'
import * as orderTpvService from '../../services/tpv/order.tpv.service'
import { BadRequestError, ForbiddenError, UnauthorizedError } from '@/errors/AppError'
import { parseHttpOperation, manifestSchema, executeHttpOperation } from '@/services/mobile/http-operation.mobile.service'
import { sendHttpOperationReply } from './http-operation.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { tieneCortesiaAutorizada } from '@/middlewares/cortesiaPidePermiso.middleware'
import { versionAlMenos } from '@/services/dashboard/receiptLayout/readiness.service'
import { cuerpoMesaAjena, MesaAjenaSoloRecuperacion } from '@/services/shared/cuentaCancelada'
import { payLaterDesdeMetodoDePago } from '@/services/shared/porCobrar'
import { revisarCortesiaPendiente } from '@/services/mobile/cortesia-pendiente.mobile.service'
import { parseCourtesyReviewPublicInput, toCourtesyReviewPublicReply } from '@/services/mobile/cortesia-pendiente.public'
import { avisarBeneficiosCortesiaPendiente } from '@/services/mobile/cortesia-pendiente-notice.mobile.service'

/** La ruta ya validó shape/permiso; identidad y contexto siempre vienen de la sesión autenticada. */
export async function reviewPendingCourtesy(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.authContext as (NonNullable<Request['authContext']> & { overrideAuthorizedBy?: string }) | undefined
    if (!auth?.userId) throw new UnauthorizedError('Autenticación requerida')
    const input =
      (res.locals.courtesyReviewInput as ReturnType<typeof parseCourtesyReviewPublicInput> | undefined) ??
      parseCourtesyReviewPublicInput(req.body)
    const reply = await revisarCortesiaPendiente(
      req.params.venueId,
      {
        actorId: auth.userId,
        isImpersonating: auth.isImpersonating === true,
        ...(auth.overrideAuthorizedBy ? { overrideAuthorizedBy: auth.overrideAuthorizedBy } : {}),
      },
      input,
    )
    avisarBeneficiosCortesiaPendiente(req.params.venueId, reply)
    return res.json({ success: true, data: toCourtesyReviewPublicReply(reply) })
  } catch (error) {
    next(error)
  }
}

/**
 * List orders for a venue (paginated)
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route GET /api/v1/mobile/venues/:venueId/orders
 */
export const listOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { page = '1', pageSize = '20', search, status, paymentStatus } = req.query

    const result = await orderMobileService.listOrders(venueId, {
      page: Number(page),
      pageSize: Number(pageSize),
      search: search as string | undefined,
      status: status as string | undefined,
      paymentStatus: paymentStatus as string | undefined,
    })

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  } catch (error) {
    logger.error('Error in listOrders controller:', error)
    next(error)
  }
}

/**
 * «Cobrar sin red» (D4): `shiftIdDeLaVenta`, el turno en que se VENDIÓ. Sólo cuenta en un replay de la cola (`isOfflineReplay` true
 * literal); sin esa marca se ignora y todo queda como hoy. Misma forma que en `/tpv` (`recordPaymentBodySchema`): texto de hasta 64.
 * Otra cosa es un 400 (como el 400 de Zod de `/tpv`): visible para la cola, y nunca un valor sin tope en la bitácora.
 * `''` y `null` son «no viene».
 */
function turnoDeLaVentaDelCuerpo(body: Record<string, unknown>): { valido: false } | { valido: true; turno: string | null } {
  const id = idDeLaColaDelCuerpo(body, 'shiftIdDeLaVenta')
  return id.valido ? { valido: true, turno: id.id } : id
}

/**
 * S3 «Efectivo sin red en el turno correcto»: `cashDrawerSessionId`, la caja que el POS (ANDROID/iOS) tenía abierta al cobrar. Misma
 * frontera que `shiftIdDeLaVenta`: sólo en un replay de la cola, texto de hasta 64, otra cosa es un 400. El servicio la convierte en
 * el turno de la venta por la liga 1:1 caja↔turno.
 */
function cajaDeLaVentaDelCuerpo(body: Record<string, unknown>): { valido: false } | { valido: true; caja: string | null } {
  const id = idDeLaColaDelCuerpo(body, 'cashDrawerSessionId')
  return id.valido ? { valido: true, caja: id.id } : id
}

function idDeLaColaDelCuerpo(body: Record<string, unknown>, campo: string): { valido: false } | { valido: true; id: string | null } {
  const valor = body[campo]
  if (valor === undefined || valor === null || valor === '') return { valido: true, id: null }
  if (typeof valor !== 'string' || valor.length > 64) return { valido: false }
  return { valido: true, id: body.isOfflineReplay === true ? valor : null }
}

const TURNO_DE_LA_VENTA_INVALIDO = 'shiftIdDeLaVenta debe ser texto de hasta 64 caracteres'
const CAJA_DE_LA_VENTA_INVALIDA = 'cashDrawerSessionId debe ser texto de hasta 64 caracteres'

/**
 * La validación y el armado de `CreateOrderInput` de una venta de mostrador (antes, el cuerpo de `createOrder`; extraído sin
 * cambiarlo, S2b). La usan `createOrder` (`conPropinaDeOrden: true`, como siempre) y `pay-new-order` (`false`: ahí `tip` es la
 * propina DEL COBRO en pesos y la lee esa ruta aparte). `usuario` es el de la sesión: el vendedor por omisión (Q76).
 */
export function leerVentaDeMostrador(
  body: any,
  opciones: { conPropinaDeOrden: boolean; venueId: string; usuario?: string },
): { input: orderMobileService.CreateOrderInput } | { error: string } {
  const {
    items,
    staffId,
    orderType,
    source,
    tableId,
    customerId,
    customerName,
    customerPhone,
    specialRequests,
    discount,
    orderDiscountId,
    tip,
    note,
    splitType,
    reservationId,
    externalId,
    stampRewardId,
    stampRewardAware,
    stampRewardExpectedDiscount,
    isOfflineReplay,
    createdAtLocal,
    paymentMethod,
  } = body
  const turnoDeLaVenta = turnoDeLaVentaDelCuerpo(body)
  if (!turnoDeLaVenta.valido) return { error: TURNO_DE_LA_VENTA_INVALIDO }
  const cajaDeLaVenta = cajaDeLaVentaDelCuerpo(body)
  if (!cajaDeLaVenta.valido) return { error: CAJA_DE_LA_VENTA_INVALIDA }

  // Validate required fields
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { error: 'Se requiere al menos un item' }
  }

  // Validate each item has required fields.
  // Accepts either a product item (with productId), a custom line item
  // (no productId, but must have name + unitPrice — e.g. "Otro importe"),
  // or a promotion line (promotionRef).
  for (const item of items) {
    if (item?.isCortesia !== undefined && typeof item.isCortesia !== 'boolean') {
      return { error: 'isCortesia debe ser true o false' }
    }
    if (item?.isCortesia === true) {
      if (typeof item.cortesiaReason !== 'string' || !item.cortesiaReason.trim()) {
        return { error: 'La razón de cortesía es requerida.' }
      }
      if (item.discountId) return { error: 'Un ítem no puede tener cortesía y descuento al mismo tiempo.' }
      if (item.promotionRef) return { error: 'Una promoción no puede darse de cortesía al crear la cuenta' }
    }
    // Una línea de promoción no trae productId ni precio: trae QUÉ promoción
    // tocó el cajero y QUÉ eligió la persona (el cliente NUNCA manda precios
    // de promoción — el server resuelve sus líneas), así que las reglas de
    // abajo —quantity, productId o (name + unitPrice)— no le aplican.
    //
    // 🔴 El criterio es el MISMO que el del servicio y el de la ruta: basta
    // que `promotionRef` venga. Y si viene, su FORMA se valida aquí, en la
    // frontera — un promotionRef a medias que pasara de largo entraría al
    // motor con ids undefined y reventaría como 500 DESPUÉS de crear la
    // orden, en vez de decirle al POS qué mandó mal.
    if (item?.promotionRef) {
      const ref = item.promotionRef
      const formaValida =
        typeof ref.promotionId === 'string' &&
        ref.promotionId.length > 0 &&
        typeof ref.promotionInstanceId === 'string' &&
        ref.promotionInstanceId.length > 0 &&
        Array.isArray(ref.selections)
      if (!formaValida) {
        return { error: 'promotionRef requiere promotionId, promotionInstanceId y selections' }
      }
      // 🔴 Una línea es promoción O producto, nunca las dos. El servicio manda
      // al motor todo lo que traiga promotionRef, así que un item mixto
      // perdería su producto EN SILENCIO: se cobraría el combo y no la
      // hamburguesa que el cajero también capturó. Es subcobro, así que se
      // rechaza en vez de adivinar cuál de los dos quiso decir.
      const traeLineaNormal =
        (typeof item.productId === 'string' && item.productId.length > 0) ||
        (typeof item.name === 'string' && item.name.length > 0) ||
        typeof item.unitPrice === 'number'
      if (traeLineaNormal) {
        return { error: 'Un item no puede ser producto y promoción a la vez: manda la promoción en su propia línea' }
      }
      // 🔴 El motor cobra UNA instancia por `promotionRef` y la cantidad se
      // ignora: 3 combos entraban al ticket como 1 — subcobro de 2/3 del
      // valor. El contrato es una instancia por combo. Se tolera `quantity: 1`
      // porque es lo que emite un carrito normal (su modelo de línea trae
      // quantity=1 por default) y no cambia un centavo.
      if (item.quantity != null && item.quantity !== 1) {
        return { error: 'Una promoción no lleva cantidad: manda una línea por combo, cada una con su propio promotionInstanceId' }
      }
      continue
    }
    if (!item.quantity || item.quantity < 1) {
      return { error: 'Cada item requiere quantity >= 1' }
    }
    const hasProductId = typeof item.productId === 'string' && item.productId.length > 0
    const hasCustomFields = typeof item.name === 'string' && item.name.length > 0 && typeof item.unitPrice === 'number'
    if (!hasProductId && !hasCustomFields) {
      return { error: 'Cada item requiere productId o (name + unitPrice)' }
    }
    // 🔴 Un «Otro importe» negativo bajaba la venta sin el permiso de descuentos
    // (falda $500 + «Otro importe» −$300 = $200). Igual que la terminal (tpv.schema.ts).
    if (!hasProductId && item.unitPrice < 0) {
      return { error: 'El precio de un «Otro importe» no puede ser negativo' }
    }
    if (item.discountId != null && typeof item.discountId !== 'string') {
      return { error: 'discountId debe ser un string' }
    }
  }

  if (orderDiscountId != null && (typeof orderDiscountId !== 'string' || orderDiscountId.length === 0)) {
    return { error: 'orderDiscountId debe ser el id de un descuento' }
  }

  // 🔴 Propina NEGATIVA = descuento disfrazado. El servicio suma la propina al
  // total SIN clamp (`tipDecimal = tip/100`), así que un tip de -500 rebajaba
  // el total en silencio. El descuento sí se clampa (`max(0, discount)`); la
  // propina debe recibir el mismo trato en la frontera. La ruta /fast ya lo
  // valida por Zod (`tip: min(0)`, tpv.schema.ts) — estos dos endpoints eran
  // los únicos sin la regla. Medido en full-testingv2 2026-08-09: tip -500
  // aceptado con 200 dejó la orden inconciliable (paidAmount ≠ suma de pagos).
  if (opciones.conPropinaDeOrden && tip !== undefined && (typeof tip !== 'number' || !Number.isFinite(tip) || tip < 0)) {
    return { error: 'tip no puede ser negativo (en centavos)' }
  }

  // Use authenticated user's ID if staffId not provided
  const effectiveStaffId = staffId || opciones.usuario

  if (!effectiveStaffId) {
    return { error: 'staffId es requerido' }
  }

  if (typeof stampRewardId === 'string' && stampRewardAware !== true) {
    // Nada se ignora en silencio: si esto aparece, hay una caja vieja ofreciendo premios.
    logger.warn('Premio de cartilla ignorado: la caja no declara que lo descuenta (versión vieja)', {
      venueId: opciones.venueId,
      stampRewardId,
    })
  }

  return {
    input: {
      items,
      staffId: effectiveStaffId,
      orderType: orderType || 'TAKEOUT',
      source: source || 'AVOQADO_IOS',
      tableId,
      customerId,
      customerName,
      customerPhone,
      specialRequests,
      discount: typeof discount === 'number' ? discount : 0,
      // Descuento de catálogo de la cuenta (como `/tpv/with-items`); validado arriba.
      orderDiscountId: typeof orderDiscountId === 'string' ? orderDiscountId : null,
      tip: opciones.conPropinaDeOrden && typeof tip === 'number' ? tip : 0,
      note,
      splitType,
      reservationId: typeof reservationId === 'string' ? reservationId : null,
      externalId: typeof externalId === 'string' ? externalId : null,
      // «Pagar después» (fiado) como Toast: el POS manda `PAY_LATER` sólo desde su botón «Pagar después»; un cobro normal
      // manda su método (CARD, CASH…) y, si falla, la cuenta NO es deuda del cliente. Sin método: null, la regla de antes.
      payLater: payLaterDesdeMetodoDePago(paymentMethod),
      // 🔴 Premio de cartilla a aplicar EN LA CREACIÓN — pero SÓLO para una caja que
      // declara `stampRewardAware: true`, o sea, que resta el premio de lo que cobra.
      // Hasta Android 2.19.1 / iOS 1.12.0 la caja mandaba el premio y cobraba el precio
      // completo: se quemaba el premio y el cliente pagaba de más. A esas versiones se
      // les ignora: cobran completo, pero el premio no se gasta.
      stampRewardId: typeof stampRewardId === 'string' && stampRewardAware === true ? stampRewardId : null,
      // Cuánto descontó la caja al cobrar (centavos): si el servidor no lo confirma igual, queda rastro.
      stampRewardExpectedDiscount:
        typeof stampRewardExpectedDiscount === 'number' && Number.isFinite(stampRewardExpectedDiscount)
          ? stampRewardExpectedDiscount
          : null,
      // «Se cobra el precio que vio el cliente»: la cola sin red («la venta ya ocurrió») nunca recibe el 409 de precio
      // cambiado. Sólo el `true` literal cuenta. La hora de captura la interpreta el servicio; los campos de línea, también.
      isOfflineReplay: isOfflineReplay === true,
      createdAtLocal: typeof createdAtLocal === 'number' || typeof createdAtLocal === 'string' ? createdAtLocal : null,
      // «Cobrar sin red» (D4): el turno en que se vendió, sólo en un replay de la cola. Sólo puede dejar la orden sin turno.
      shiftIdDeLaVenta: turnoDeLaVenta.turno,
      // S3: la caja que el POS tenía abierta al vender, sólo en un replay de la cola. El servicio la convierte en el turno de la venta.
      cashDrawerSessionId: cajaDeLaVenta.caja,
    },
  }
}

/**
 * Lo que la venta de mostrador toma de la SESIÓN, nunca del cuerpo. Lo comparten `createOrder` y `pay-new-order` (una venta
 * pagada con saldo también nace con cortesías o descuentos de catálogo): la autoridad de cortesía (S9) y la terminal del token
 * (S6). Va después de `leerVentaDeMostrador`, así el 400 de un cuerpo inválido sigue saliendo antes que el 403.
 */
export async function autoridadDeLaVenta(
  req: Request,
  venta: orderMobileService.CreateOrderInput,
): Promise<Pick<orderMobileService.CreateOrderInput, 'canCompItems' | 'performedBy' | 'terminalSerialNumber'>> {
  const hasCortesias = venta.items.some(item => item.isCortesia === true)
  // El catálogo puede pasar de FIXED a COMP después del middleware. Transportar autoridad incluso si la prelectura no vio COMP;
  // el escritor decide si la necesita sobre la fila que realmente calcula. Nunca tomarla del vendedor ni del body.
  const needsCompAuthority = hasCortesias || !!venta.orderDiscountId || venta.items.some(item => !!item.discountId)
  const canCompItems = needsCompAuthority && (tieneCortesiaAutorizada(req) || (await tienePermisoEnVenue(req, 'orders:comp')))
  if (hasCortesias && !canCompItems) throw new ForbiddenError('No tienes permiso para dar cortesías')
  return {
    ...(needsCompAuthority ? { canCompItems, performedBy: req.authContext?.userId } : {}),
    // S6: la terminal que vende, del TOKEN (nunca del body): orden con su `terminalId` y fuente `TPV`.
    terminalSerialNumber: req.authContext?.terminalSerialNumber ?? null,
  }
}

/**
 * Create order with items
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * Creates an order with products/items. Returns the orderId which
 * should be sent to the TPV via BLE for payment processing.
 *
 * @route POST /api/v1/mobile/venues/:venueId/orders
 */
export const createOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const venta = leerVentaDeMostrador(req.body, { conPropinaDeOrden: true, venueId, usuario: req.authContext?.userId })
    if ('error' in venta) {
      return res.status(400).json({
        success: false,
        message: venta.error,
      })
    }

    const order = await orderMobileService.createOrderWithItems(venueId, { ...venta.input, ...(await autoridadDeLaVenta(req, venta.input)) })

    res.status(201).json({
      success: true,
      order,
    })
  } catch (error) {
    logger.error('Error in createOrder controller:', error)
    next(error)
  }
}

/**
 * Get order details
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route GET /api/v1/mobile/venues/:venueId/orders/:orderId
 */
export const getOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params

    const order = await orderMobileService.getOrder(venueId, orderId)

    res.status(200).json({
      success: true,
      order,
    })
  } catch (error) {
    logger.error('Error in getOrder controller:', error)
    next(error)
  }
}

/**
 * 🔴 H1 — la cola de cobros de Android ≤ 2.23 (y de su app de Windows, el mismo código: `x-device-platform: ANDROID`,
 * `x-app-version` «2.23.0-escritorio») reenvía el TOTAL de la cuenta aunque el aparato sólo cobró su parte del split
 * (`queueCashPayment(orderRequest = buildOrderRequest(cart))` ⇒ `amountCents = total − propina`; arreglado en avoqado-android
 * `8c21d450`, que entra en `v2.24.0-64` y `tienda-windows/v2.24.0`). Antes de S1/S2 el recorte al saldo lo tapaba por accidente;
 * con S1/S2 se registrarían $100 por $50 cobrados y el cajero firmaría un faltante falso. Para ESA cola, `payCashOrder` se porta
 * como antes (`colaConDefectoH1`). Una versión ilegible de Android cuenta como vieja. El intent `PAY_CASH` de esas versiones sí
 * manda la parte correcta: no pasa por aquí.
 *
 * Se puede QUITAR cuando no quede flota ≤ 2.23 (POS_ANDROID con latido en los últimos 30 días; medido el 17-oct-2026: 10 aparatos
 * en 7 negocios con 2.22.2–2.23.0).
 */
export function esColaConDefectoH1(plataforma: unknown, version: unknown): boolean {
  if (typeof plataforma !== 'string' || plataforma.trim().toUpperCase() !== 'ANDROID') return false
  return !versionAlMenos(typeof version === 'string' ? version : null, '2.24.0')
}

/**
 * Pay order with cash
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * Records a cash payment for an order. No TPV terminal involved.
 * Payment goes directly to backend.
 *
 * @route POST /api/v1/mobile/venues/:venueId/orders/:orderId/pay
 */
export const payCash = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { amount, tip, staffId, idempotencyKey, method, externalSource, tenderTypeId, tenderRevision } = req.body
    const turnoDeLaVenta = turnoDeLaVentaDelCuerpo(req.body)
    if (!turnoDeLaVenta.valido) {
      return res.status(400).json({ success: false, message: TURNO_DE_LA_VENTA_INVALIDO })
    }
    const cajaDeLaVenta = cajaDeLaVentaDelCuerpo(req.body)
    if (!cajaDeLaVenta.valido) {
      return res.status(400).json({ success: false, message: CAJA_DE_LA_VENTA_INVALIDA })
    }

    // Métodos que el POS puede registrar a mano. NO incluye los que Avoqado
    // procesa de verdad (DIGITAL_WALLET, CRYPTOCURRENCY): esos los escribe el
    // flujo del procesador, y dejar que un cliente los declare aquí
    // inventaría ingresos procesados que nunca pasaron por nosotros.
    // 🔴 XOR: o un método fijo de siempre, o un tender del catálogo — nunca los dos.
    // Mandar ambos deja al server eligiendo cuál gana, que es justo la ambigüedad que
    // la auditoría marcó como P0. Mejor un 400 explícito que una precedencia silenciosa.
    if (tenderTypeId !== undefined && method !== undefined) {
      return res.status(400).json({
        success: false,
        message: 'Manda `method` o `tenderTypeId`, no ambos.',
      })
    }
    if (tenderTypeId !== undefined && typeof tenderRevision !== 'number') {
      return res.status(400).json({
        success: false,
        message: '`tenderRevision` es requerido junto con `tenderTypeId`.',
      })
    }

    const MANUAL_METHODS = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'OTHER'] as const
    if (method !== undefined && !MANUAL_METHODS.includes(method)) {
      return res.status(400).json({
        success: false,
        message: `method inválido. Permitidos: ${MANUAL_METHODS.join(', ')}`,
      })
    }

    // Validate required fields
    //
    // 🔴 `amount === 0` SÍ es válido, y es el único caso nuevo: una cuenta
    // cortesiada al 100% (o con un descuento que se come el total) vale $0 y
    // tiene que poder CERRARSE. Antes se rechazaba junto con los negativos, y
    // esas cuentas se quedaban abiertas para siempre: `compWholeOrder` deja los
    // artículos en 0 pero nunca marca la orden como pagada, y este endpoint era
    // la única salida. Medido: ORD-1785877370147 llevaba 5 días abierta en $0.
    //
    // Quien decide si el 0 es legítimo es el SERVICIO, comparando contra el
    // saldo real de la orden — aquí sólo se deja pasar el tipo.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        message: 'amount es requerido y no puede ser negativo (en centavos)',
      })
    }

    // 🔴 Propina NEGATIVA = descuento disfrazado (y peor: inconciliable).
    // payCashOrder suma `previousTips + tip/100` al total sin clamp: un tip de
    // -500 con 200 dejó una orden PAID con total mutado 45→40 y
    // `paidAmount (40) ≠ suma de pagos (45)` — medido en full-testingv2
    // 2026-08-09, la consulta de integridad subió 947→948 con UNA orden.
    // /fast ya lo rechaza por Zod; este endpoint era el único agujero de pago.
    if (tip !== undefined && (typeof tip !== 'number' || !Number.isFinite(tip) || tip < 0)) {
      return res.status(400).json({
        success: false,
        message: 'tip no puede ser negativo (en centavos)',
      })
    }

    // Use authenticated user's staff ID if not provided
    const effectiveStaffId = staffId || req.authContext?.userId

    const result = await orderMobileService.payCashOrder(venueId, orderId, {
      amount,
      tip: tip || 0,
      staffId: effectiveStaffId,
      // 🛡️ Antes se descartaba: los clientes SIEMPRE la mandan y su cola offline
      // espera un 409-duplicado para marcar el pago como sincronizado.
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      // Opcionales y ADITIVOS: sin ellos el cobro sigue siendo efectivo, así
      // que las versiones viejas de la app no cambian de comportamiento.
      method,
      externalSource: typeof externalSource === 'string' ? externalSource : undefined,
      tenderTypeId: typeof tenderTypeId === 'string' ? tenderTypeId : undefined,
      tenderRevision: typeof tenderRevision === 'number' ? tenderRevision : undefined,
      // 🔴 "Esta venta YA OCURRIÓ y viene de mi cola." Sólo lo manda la cola de
      // reintentos del POS. Con un tipo del catálogo se honra la revisión que el cajero
      // tenía enfrente al cobrar: si el negocio le subió la comisión el martes, las
      // ventas del lunes que no habían sincronizado NO pueden quedar atoradas para
      // siempre. Un desenlace ya ocurrido es un hecho, no se re-litiga.
      isOfflineReplay: req.body.isOfflineReplay === true,
      colaConDefectoH1:
        req.body.isOfflineReplay === true && esColaConDefectoH1(req.headers?.['x-device-platform'], req.headers?.['x-app-version']),
      // R2-6: la propiedad de mesa dejó pasar dinero ya capturado sobre una mesa ajena (`checkTableOwnership`, ruta de cobro).
      mesaAjena: res.locals?.mesaAjena,
      // R5-1: la propiedad de mesa sólo autorizó RECUPERAR el pago de esta llave (`checkTableOwnership`, ruta de cobro).
      soloRecuperarPago: res.locals?.soloRecuperarPago,
      // R6-3: la propiedad de mesa estaba encendida; el cobro la vuelve a revisar bajo el candado (`checkTableOwnership`, ruta de cobro).
      propiedadDeMesa: res.locals?.propiedadDeMesa,
      // «Cobrar sin red» (D4): el turno en que se vendió, sólo en un replay de la cola. Sólo puede dejar el pago sin turno.
      shiftIdDeLaVenta: turnoDeLaVenta.turno ?? undefined,
      // S3: la caja que el POS tenía abierta al cobrar, sólo en un replay de la cola.
      cashDrawerSessionId: cajaDeLaVenta.caja ?? undefined,
      // S6: la hora en que se cobró (sólo cuenta en un replay) y la terminal del TOKEN: pago de terminal y comanda tardía.
      createdAtLocal:
        typeof req.body.createdAtLocal === 'number' || typeof req.body.createdAtLocal === 'string' ? req.body.createdAtLocal : null,
      // Reloj monótono del aparato (ms desde la venta); sólo número: el servicio decide si es válido.
      edadDeLaVentaMs: typeof req.body.edadDeLaVentaMs === 'number' ? req.body.edadDeLaVentaMs : undefined,
      terminalSerialNumber: req.authContext?.terminalSerialNumber ?? null,
      // D1 «fotocopia del ticket»: los renglones que imprimió este cobro, opcional. El servicio la guarda sólo si cuadra con lo cobrado.
      lineasDelTicket: req.body.lineasDelTicket,
    })

    res.status(200).json({
      success: true,
      payment: result,
    })
  } catch (error) {
    // R5-1: el MISMO 403 que responde `checkTableOwnership` a una mesa ajena (el pago que sólo podía recuperarse ya no está).
    // R6-3: también cuando la cuenta resultó ajena hasta la relectura bajo el candado.
    if (error instanceof MesaAjenaSoloRecuperacion) {
      logger.info(`payCash: mesa ajena — el pago de la llave ya no existe; no se crea otro (${(error as Error).message})`)
      return res.status(403).json(cuerpoMesaAjena(error.dueno))
    }
    // Un rechazo de NEGOCIO (4xx: "ya está pagada", saldo, permisos) no es una falla del server:
    // logueado como `error:` ensuciaba el barrido de errores del log (/full-testing 2026-08-18).
    // El errorHandler ya lo registra con su nivel por status; aquí sólo se marca el 5xx real.
    const status = (error as any)?.statusCode
    if (typeof status === 'number' && status < 500) {
      logger.warn(`payCash rechazado (${status}): ${(error as Error)?.message}`)
    } else {
      logger.error('Error in payCash controller:', error)
    }
    next(error)
  }
}

/**
 * Cancel an unpaid order
 * AUTHENTICATED endpoint - requires valid JWT
 *
 * @route DELETE /api/v1/mobile/venues/:venueId/orders/:orderId
 */
export const cancelOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { reason } = req.body
    const performedBy = (req as any).authContext?.userId as string | undefined

    const operation = parseHttpOperation(req.body)
    if (!operation) {
      await orderMobileService.cancelOrder(venueId, orderId, reason, performedBy)
      res.status(200).json({ success: true, message: 'Orden cancelada exitosamente' })
      return
    }
    if (!performedBy) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'cancelOrder', refs: { orderId }, payload: { reason: reason ?? null } })
    if (!parsed.success || parsed.data.action !== 'cancelOrder')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    const reply = await executeHttpOperation({ venueId, actorId: performedBy, operation, manifest }, async tx => {
      const result = await orderMobileService.cancelOrderInTransaction(
        tx,
        venueId,
        orderId,
        manifest.payload.reason ?? undefined,
        performedBy,
      )
      return {
        response: { status: 200, body: { success: true, message: 'Orden cancelada exitosamente' } },
        affectedRefs: result.affectedRefs,
        cancelEffects: {
          version: 1 as const,
          phase: 'PENDING' as const,
          orderId,
          staffId: performedBy,
          reason: manifest.payload.reason,
          tableIds: result.tables.map(table => table.id),
          valesSoltados: result.valesSoltados ?? null,
        },
      }
    })
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    logger.error('Error in cancelOrder controller:', error)
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/items
 * TABLE_SERVICE (PRO) — add a round of items to an OPEN order (table service).
 * Delegates to the same upsert-with-optimistic-concurrency service the TPV
 * uses: body carries { items: AddOrderItemInput[], version: number } and a
 * stale `version` answers 409 so the client refetches before retrying.
 */
export const addItemsToOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { items, version } = req.body ?? {}

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items es requerido y no puede estar vacío' })
    }
    if (typeof version !== 'number') {
      return res.status(400).json({ success: false, message: 'version (número) es requerida para concurrencia optimista' })
    }

    // Mesas mandan RONDAS (deltas): cada Enviar crea sus propias filas (modelo Square).
    const updatedOrder = await orderTpvService.addItemsToOrder(venueId, orderId, items, version, true)

    // Cobros automáticos por comensales: al crecer el subtotal la regla puede
    // empezar a aplicar (el recompute del TPV ya refresca los % existentes).
    try {
      const { syncAutomaticServiceCharges } = await import('../../services/mobile/service-charge.mobile.service')
      await syncAutomaticServiceCharges(venueId, orderId)
    } catch {
      // no-fatal: el cargo se aplicará en el siguiente recálculo
    }

    return res.status(200).json({
      success: true,
      data: updatedOrder,
      message: `Added ${items.length} item(s) to order`,
    })
  } catch (error) {
    logger.error('Error in addItemsToOrder controller:', error)
    next(error)
  }
}

/**
 * Comp an order item ("Dar de cortesía") with a mandatory reason.
 * @route POST /api/v1/mobile/venues/:venueId/orders/:orderId/items/:itemId/comp
 */
export const compOrderItem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, itemId } = req.params
    const { reason } = req.body
    const staffId = (req as any).authContext?.userId as string | undefined

    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const { compOrderItem: compItem } = await import('../../services/mobile/comp-item.mobile.service')
      const result = await compItem({ venueId, orderId, itemId, reason, staffId })

      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'compItem', refs: { orderId, itemId }, payload: { reason } })
    if (!parsed.success || parsed.data.action !== 'compItem')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const { compOrderItemInTransaction } = await import('../../services/mobile/comp-item.mobile.service')
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await compOrderItemInTransaction(tx, {
        venueId,
        orderId,
        itemId,
        reason: manifest.payload.reason,
        staffId,
        captureBenefits: true,
      })
      auditData = {
        orderId,
        reason: manifest.payload.reason,
        productName: r.item.productName,
        amount: Number(r.item.total),
        ...(r.recorte.retiradas.length ? { descuentosRetirados: r.recorte.retiradas } : {}),
      }
      if (!r.recorte.benefits) throw new Error('Missing in-transaction benefit capture')
      return {
        response: { status: 200, body: { success: true, data: { itemId, reason: manifest.payload.reason, ...r.totals } } },
        effects: { discountBenefits: r.recorte.benefits },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          { kind: 'OrderItem', id: itemId },
          ...r.recorte.retiradas.map(d => ({ kind: 'OrderDiscount' as const, id: d.id })),
          ...r.recorte.benefits.flatMap(b => [
            ...(b.loyaltyRefund
              ? [
                  { kind: 'Customer' as const, id: b.loyaltyRefund.customerId },
                  { kind: 'LoyaltyTransaction' as const, id: b.loyaltyRefund.transactionId },
                ]
              : []),
            ...(b.stampRefund
              ? [
                  { kind: 'Customer' as const, id: b.stampRefund.customerId },
                  { kind: 'StampReward' as const, id: b.stampRefund.rewardId },
                ]
              : []),
          ]),
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({ action: 'ORDER_ITEM_COMPED', entity: 'OrderItem', entityId: itemId, staffId, venueId, data: auditData })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/comp
 * TABLE_SERVICE — "Cortesía en la cuenta": comps EVERY line of the open
 * order with one reason. Body: { reason: string }
 */
export const compWholeOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { reason } = req.body
    const staffId = (req as any).authContext?.userId as string | undefined

    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const { compWholeOrder: compAll } = await import('../../services/mobile/comp-item.mobile.service')
      const result = await compAll({ venueId, orderId, reason, staffId })

      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'compWholeOrder', refs: { orderId }, payload: { reason } })
    if (!parsed.success || parsed.data.action !== 'compWholeOrder')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const { compWholeOrderInTransaction } = await import('../../services/mobile/comp-item.mobile.service')
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await compWholeOrderInTransaction(tx, { venueId, orderId, reason: manifest.payload.reason, staffId, captureBenefits: true })
      auditData = {
        reason: manifest.payload.reason,
        items: r.items.length,
        amount: r.compedAmount,
        orderNumber: r.order.orderNumber,
        ...(r.recorte.retiradas.length ? { descuentosRetirados: r.recorte.retiradas } : {}),
      }
      if (!r.recorte.benefits) throw new Error('Missing in-transaction benefit capture')
      return {
        response: {
          status: 200,
          body: {
            success: true,
            data: { itemsComped: r.items.length, compedAmount: r.compedAmount, reason: manifest.payload.reason, ...r.totals },
          },
        },
        effects: { discountBenefits: r.recorte.benefits },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          ...r.items.map(x => ({ kind: 'OrderItem' as const, id: x.id })),
          ...r.recorte.retiradas.map(d => ({ kind: 'OrderDiscount' as const, id: d.id })),
          ...r.recorte.benefits.flatMap(b => [
            ...(b.loyaltyRefund
              ? [
                  { kind: 'Customer' as const, id: b.loyaltyRefund.customerId },
                  { kind: 'LoyaltyTransaction' as const, id: b.loyaltyRefund.transactionId },
                ]
              : []),
            ...(b.stampRefund
              ? [
                  { kind: 'Customer' as const, id: b.stampRefund.customerId },
                  { kind: 'StampReward' as const, id: b.stampRefund.rewardId },
                ]
              : []),
          ]),
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({ action: 'ORDER_COMPED', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/details
 * TABLE_SERVICE — partial update of the check's metadata (never money):
 * Body: { name?, notes?, covers?, customerId? }
 */
export const updateOrderDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { name, notes, covers, customerId, orderType } = req.body || {}

    const operation = parseHttpOperation(req.body)
    // 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A»): cambiar el cliente de una venta COBRADA exige `payments:create`
    // (el servicio decide bajo el candado de la venta). Sólo se resuelve si la petición trae un `customerId` (null = sin cambio).
    const opciones =
      customerId !== undefined && customerId !== null
        ? {
            puedeCambiarClienteEnVentaCobrada: await puedeCambiarClienteEnVentaCobrada(req),
            customerAttribution: await customerAttributionActor(req),
          }
        : {}
    if (!operation) {
      const result = await orderMobileService.updateOrderDetails(venueId, orderId, { name, notes, covers, customerId, orderType }, opciones)
      return res.json({ success: true, data: result })
    }
    const actorId = (req as any).authContext?.userId as string | undefined
    if (!actorId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({
      action: 'updateOrderDetails',
      refs: { orderId },
      payload: { name, notes, covers, customerId, orderType },
    })
    if (!parsed.success || parsed.data.action !== 'updateOrderDetails')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    const reply = await executeHttpOperation({ venueId, actorId, operation, manifest }, async tx => {
      const r = await orderMobileService.updateOrderDetailsInTransaction(tx, venueId, orderId, manifest.payload, opciones)
      return {
        response: { status: 200, body: { success: true, data: r.data } },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          ...r.affectedServiceChargeIds.map(id => ({ kind: 'OrderServiceCharge' as const, id })),
          ...(manifest.payload.customerId ? [{ kind: 'Customer' as const, id: manifest.payload.customerId }] : []),
        ],
      }
    })
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * ¿Quien edita el detalle de la cuenta tiene `payments:create`? Con el resolvedor EFECTIVO de siempre (`tienePermisoEnVenue`:
 * el de `checkPermission`, con personalizaciones del negocio y conjuntos de permisos). Falla CERRADO: si no se puede resolver,
 * no se cambia el cliente de una venta cobrada (403) y queda en el log.
 */
async function puedeCambiarClienteEnVentaCobrada(req: Request): Promise<boolean> {
  try {
    return await tienePermisoEnVenue(req, 'payments:create')
  } catch (error) {
    logger.warn('[ORDER.MOBILE] No se pudo resolver payments:create para cambiar el cliente: se trata como sin permiso', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/discounts
 * TABLE_SERVICE — applies an ORDER-scope catalog discount to the open check.
 * Body: { discountId: string }
 */
export const applyOrderDiscount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { discountId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    if (!discountId || typeof discountId !== 'string') {
      return res.status(400).json({ success: false, message: 'discountId is required' })
    }
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const result = await orderMobileService.applyOrderDiscount(venueId, orderId, discountId, staffId)
      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'applyOrderDiscount', refs: { orderId, discountId }, payload: {} })
    if (!parsed.success || parsed.data.action !== 'applyOrderDiscount')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await orderMobileService.applyOrderDiscountInTransaction(tx, venueId, orderId, manifest.refs.discountId, staffId)
      auditData = { discountId: manifest.refs.discountId, name: r.row.name, amount: Number(r.row.amount) }
      return {
        response: {
          status: 200,
          body: { success: true, data: { orderDiscountId: r.row.id, name: r.row.name, amount: Number(r.row.amount), ...r.totals } },
        },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          { kind: 'OrderDiscount', id: r.row.id },
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({ action: 'ORDER_DISCOUNT_APPLIED', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/merge
 * "Fusionar cuentas": vuelca los artículos de sourceOrderId en esta cuenta.
 */
export const mergeOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { sourceOrderId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    if (!sourceOrderId || typeof sourceOrderId !== 'string') {
      return res.status(400).json({ success: false, message: 'sourceOrderId is required' })
    }
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const result = await orderMobileService.mergeOrders(venueId, orderId, sourceOrderId, staffId)
      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'mergeOrders', refs: { orderId, sourceOrderId }, payload: {} })
    if (!parsed.success || parsed.data.action !== 'mergeOrders')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let result: Awaited<ReturnType<typeof orderMobileService.mergeOrdersInTransaction>> | undefined
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      result = await orderMobileService.mergeOrdersInTransaction(tx, venueId, orderId, manifest.refs.sourceOrderId, staffId)
      return { response: { status: 200, body: { success: true, data: result.data } }, affectedRefs: result.affectedRefs }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow && result) {
      try {
        await orderMobileService.publishMergedOrders(venueId, result, staffId)
      } catch (error) {
        logger.error('mergeOrders committed; notification failed', error)
      }
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/split-by-seat
 * "Dividir por puesto": un cheque por asiento, en una sola transacción.
 */
export const splitOrderBySeat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const result = await orderMobileService.splitOrderBySeat(venueId, orderId, staffId)
      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'splitOrderBySeat', refs: { orderId }, payload: {} })
    if (!parsed.success || parsed.data.action !== 'splitOrderBySeat')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    let auditData: Parameters<typeof logAction>[0]['data']
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest: parsed.data }, async tx => {
      const r = await orderMobileService.splitOrderBySeatInTransaction(tx, venueId, orderId, staffId)
      auditData = { seats: r.seatsToMove, created: r.results.length }
      return {
        response: {
          status: 200,
          body: {
            success: true,
            data: {
              source: { id: r.source.id, orderNumber: r.source.orderNumber, total: r.sourceTotals.total, seat: r.seats[0] },
              created: r.results,
            },
          },
        },
        affectedRefs: [
          { kind: 'Order', id: r.source.id },
          ...r.results.map(x => ({ kind: 'Order' as const, id: x.id })),
          ...r.movedItemIds.map(id => ({ kind: 'OrderItem' as const, id })),
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow)
      void logAction({ action: 'ORDER_SPLIT_BY_SEAT', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /mobile/venues/:venueId/orders/:orderId/discounts/:orderDiscountId
 * TABLE_SERVICE — removes one applied order discount.
 */
export const removeOrderDiscount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, orderDiscountId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const result = await orderMobileService.removeOrderDiscount(venueId, orderId, orderDiscountId, staffId)
      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'removeOrderDiscount', refs: { orderId, orderDiscountId }, payload: {} })
    if (!parsed.success || parsed.data.action !== 'removeOrderDiscount')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await orderMobileService.removeOrderDiscountInTransaction(tx, venueId, orderId, manifest.refs.orderDiscountId, staffId)
      auditData = {
        orderDiscountId: manifest.refs.orderDiscountId,
        name: r.row.name,
        pointsRefunded: r.refund?.pointsRefunded ?? 0,
        stampRewardReturned: r.stampRefund?.rewardId ?? null,
        taxReturned: Number(r.row.taxReduction ?? 0),
      }
      return {
        response: { status: 200, body: { success: true, data: r.totals } },
        effects: { loyaltyRefund: r.refund, stampRefund: r.stampRefund },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          { kind: 'OrderDiscount', id: r.row.id },
          ...(r.refund
            ? [
                { kind: 'Customer' as const, id: r.refund.customerId },
                { kind: 'LoyaltyTransaction' as const, id: r.refund.transactionId },
              ]
            : []),
          ...(r.stampRefund
            ? [
                { kind: 'StampReward' as const, id: r.stampRefund.rewardId },
                { kind: 'Customer' as const, id: r.stampRefund.customerId },
              ]
            : []),
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({ action: 'ORDER_DISCOUNT_REMOVED', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/split
 * TABLE_SERVICE — separates selected items into a NEW check on the same
 * table (Square's separate checks). Body: { itemIds: string[] }
 */
export const splitOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { itemIds } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const result = await orderMobileService.splitOrderItems(venueId, orderId, itemIds, staffId)
      return res.json({ success: true, data: result })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'splitOrder', refs: { orderId }, payload: { itemIds } })
    if (!parsed.success || parsed.data.action !== 'splitOrder')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await orderMobileService.splitOrderItemsInTransaction(tx, venueId, orderId, manifest.payload.itemIds, staffId, true)
      auditData = { newOrderId: r.newOrder.id, newOrderNumber: r.newOrder.orderNumber, items: r.movedCount }
      return {
        response: {
          status: 200,
          body: {
            success: true,
            data: {
              source: { id: r.source.id, orderNumber: r.source.orderNumber, total: r.sourceTotals.total, version: r.sourceTotals.version },
              created: { id: r.newOrder.id, orderNumber: r.newOrder.orderNumber, total: r.newTotals.total, version: r.newTotals.version },
            },
          },
        },
        affectedRefs: [
          { kind: 'Order', id: r.source.id },
          { kind: 'Order', id: r.newOrder.id },
          ...r.movedItemIds.map(id => ({ kind: 'OrderItem' as const, id })),
          ...r.movedPromotionIds.map(id => ({ kind: 'OrderPromotion' as const, id })),
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow)
      void logAction({ action: 'ORDER_SPLIT', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}
