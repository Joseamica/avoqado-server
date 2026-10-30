// src/services/giftCards/giftCardCuenta.service.ts
/**
 * La cuenta de tarjetas vista desde el POS (1b S4; índice Q16, Q17, Q36, Q42, Q102, S-4, S-7, P-2, P-3): el detalle de cada
 * tarjeta SIN código, reenviar al mismo destino, cambiar el destino (repone código y liga) y volver a mostrar el código.
 *
 * - Las acciones bloquean el sobre (`lockGiftCardsForUpdate`) antes de decidir y releen lo que el candado no trae (A18).
 * - Lo de gerente lo decide la RUTA (`checkPermission`, que honra el PIN): aquí no se vuelve a preguntar `giftCards:manage` en
 *   `change-destination` ni en `reveal-manager`.
 * - 🔴 Q102: el código, el `pageToken` o la liga sólo salen hacia quien llama con su renglón `GIFT_CARD_CODE_REVEALED` YA
 *   guardado en la misma transacción (`registrarSalidaDelSecreto`); se descifra DESPUÉS del commit. Si no se guarda: 503 sin
 *   secreto.
 */
import { type GiftCardDeliveryChannel, type GiftCardDeliveryStatus, type GiftCardStatus, Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import logger from '@/config/logger'
import AppError, { BadRequestError, ServiceUnavailableError } from '@/errors/AppError'
import { normalizeEmail } from '@/lib/otp'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { estadoDeCancelacionDeVenta, mismoDiaDelVenue, type CancelacionDeVenta } from './giftCardCancel.service'
import { decryptGiftCardCode, formatGiftCardCode } from './giftCardCode'
import { enmascararDestino, telefonoDeTarjeta, textoDeFalloDeEntrega, urlDeLaPagina } from './giftCardEntrega'
import { GiftCardError } from './giftCardErrors'
import { lockGiftCardsForUpdate, operarSobreDeGerenteEnTx, type LockedGiftCard } from './giftCardLedger'
import { MAX_SOBRES_POR_CUENTA } from './giftCardLimits'
import { WHERE_RENGLON_DE_TARJETA, esCuentaDeTarjetasSeleccionada } from './giftCardMarks'
import { registrarSalidaDelSecreto, type AuditoriaDeTarjetas } from './giftCardSurface.service'

type Tx = Prisma.TransactionClient

export const TEXTO_SIN_SECRETO = 'No se pudo mostrar el código. Intenta otra vez.'
const NOTA_DE_CAMBIO_DE_DESTINO = 'Cambio de destino de la entrega'

export interface QuienPregunta {
  staffId: string
  puedeVender: boolean
  puedeGestionar: boolean
  overrideAuthorizedBy?: string | null
}

export interface AccionesSobreLaTarjeta {
  puedeReenviar: boolean
  puedeCambiarDestino: boolean
  puedeRevelar: boolean
  cambiarDestinoPideGerente: boolean
  revelarPideGerente: boolean
}

/** WhatsApp y correo son los únicos canales que la entrega manda (S3). */
const seEntregaPorMensaje = (canal: GiftCardDeliveryChannel) => canal === 'WHATSAPP' || canal === 'EMAIL'

/**
 * Q16: `puede*` dicen si la TARJETA lo admite; `*PideGerente` si QUIEN PREGUNTA necesita gerente. Las acciones rechazan con lo
 * mismo (el detalle nunca ofrece algo que la acción rechace).
 */
export function accionesSobreLaTarjeta(
  quien: QuienPregunta,
  t: {
    status: GiftCardStatus
    expiresAt: Date | null
    activatedAt: Date | null
    deliveryChannel: GiftCardDeliveryChannel
    usada: boolean
    customerId: string | null
  },
  ahora: Date,
  timezone: string,
): AccionesSobreLaTarjeta {
  const vigente = t.status === 'ACTIVE' && (t.expiresAt === null || t.expiresAt.getTime() > ahora.getTime())
  const mismoDia = t.activatedAt !== null && mismoDiaDelVenue(t.activatedAt, ahora, timezone)
  return {
    puedeReenviar: vigente && seEntregaPorMensaje(t.deliveryChannel),
    puedeCambiarDestino: vigente && !t.usada && t.customerId === null,
    puedeRevelar: vigente,
    cambiarDestinoPideGerente: !quien.puedeGestionar,
    revelarPideGerente: !quien.puedeGestionar && !(quien.puedeVender && mismoDia),
  }
}

export type SobreDeLaCuentaPos = {
  id: string
  ultimos4: string
  monto: number
  saldo: number
  status: GiftCardStatus
  venceEl: string | null
  deliveryChannel: GiftCardDeliveryChannel
  deliveryStatus: GiftCardDeliveryStatus
  deliveredAt: string | null
  deliveryErrorCode: string | null
  deliveryError: string | null
  destino: string | null
  recipientName: string | null
  usada: boolean
} & AccionesSobreLaTarjeta

export interface CuentaDeTarjetasPos {
  orderId: string
  orderNumber: string
  total: number
  paymentStatus: string
  orderStatus: string
  purchaserName: string | null
  sobres: SobreDeLaCuentaPos[]
  cancel: CancelacionDeVenta
}

const ventaNoEncontrada = () =>
  new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa venta de tarjetas de regalo en este negocio.', 404)
const tarjetaNoEncontrada = () => new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404)
const revelarNoPermitido = () =>
  new GiftCardError('GIFT_CARD_REVEAL_NOT_ALLOWED', 'Volver a imprimir o enseñar el código otro día lo hace un gerente.', 403)

/** S-11: la fecha en la zona del negocio, sin hora. */
const venceEl = (expiresAt: Date | null, timezone: string) => (expiresAt ? formatInTimeZone(expiresAt, timezone, 'yyyy-MM-dd') : null)

async function zonaDelNegocio(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return venue?.timezone || DEFAULT_TIMEZONE
}

const SELECT_SOBRE_DEL_DETALLE = {
  id: true,
  codeLast4: true,
  initialAmount: true,
  balance: true,
  status: true,
  expiresAt: true,
  activatedAt: true,
  customerId: true,
  deliveryChannel: true,
  deliveryStatus: true,
  deliveredAt: true,
  deliveryErrorCode: true,
  recipientPhone: true,
  recipientEmail: true,
  recipientName: true,
  purchaserName: true,
} satisfies Prisma.GiftCardSelect

/** Los renglones de tarjeta de UNA cuenta y la otra mitad de R11 (cuántos SIN tarjeta), con el tope de A5 + 1 para no truncar. */
function selectDeLaCuenta<S extends Prisma.GiftCardSelect>(sobre: S) {
  return {
    items: {
      where: WHERE_RENGLON_DE_TARJETA,
      orderBy: [{ sequence: 'asc' as const }, { id: 'asc' as const }],
      take: MAX_SOBRES_POR_CUENTA + 1,
      select: { giftCard: { select: sobre } },
    },
    _count: { select: { items: { where: { giftCardId: null } } } },
  }
}

function sobresDe<T>(orden: { items: Array<{ giftCard: T | null }>; _count: { items: number } } | null): T[] {
  if (!esCuentaDeTarjetasSeleccionada(orden)) throw ventaNoEncontrada()
  // A5 nunca deja más de MAX_SOBRES_POR_CUENTA: si pasa, la cuenta está rota y no se pinta a medias.
  if (orden!.items.length > MAX_SOBRES_POR_CUENTA) throw new Error(`La cuenta tiene más de ${MAX_SOBRES_POR_CUENTA} tarjetas.`)
  return orden!.items.map(i => i.giftCard).filter((s): s is T => s != null)
}

/** El detalle de la cuenta para el POS: cada tarjeta SIN código ni liga, con su destino enmascarado, su fallo y sus banderas. */
export async function getCuentaDeTarjetasPos(
  venueId: string,
  orderId: string,
  quien: QuienPregunta,
  ahora: Date = new Date(),
): Promise<CuentaDeTarjetasPos> {
  const [orden, timezone] = await Promise.all([
    prisma.order.findFirst({
      where: { id: orderId, venueId },
      select: {
        id: true,
        orderNumber: true,
        total: true,
        paymentStatus: true,
        status: true,
        ...selectDeLaCuenta(SELECT_SOBRE_DEL_DETALLE),
      },
    }),
    zonaDelNegocio(venueId),
  ])
  const sobres = sobresDe(orden)
  const [usos, cancel] = await Promise.all([
    prisma.giftCardActivity.groupBy({
      by: ['giftCardId'],
      where: { venueId, giftCardId: { in: sobres.map(s => s.id) }, type: 'REDEEM' },
      _count: { _all: true },
    }),
    estadoDeCancelacionDeVenta(venueId, orderId, ahora),
  ])
  const usadas = new Set(usos.map(u => u.giftCardId))
  return {
    orderId: orden!.id,
    orderNumber: orden!.orderNumber,
    total: Number(orden!.total),
    paymentStatus: orden!.paymentStatus,
    orderStatus: orden!.status,
    purchaserName: sobres[0]?.purchaserName ?? null,
    cancel,
    sobres: sobres.map(s => {
      const usada = usadas.has(s.id)
      return {
        id: s.id,
        ultimos4: s.codeLast4,
        monto: Number(s.initialAmount),
        saldo: Number(s.balance),
        status: s.status,
        venceEl: venceEl(s.expiresAt, timezone),
        deliveryChannel: s.deliveryChannel,
        deliveryStatus: s.deliveryStatus,
        deliveredAt: s.deliveredAt?.toISOString() ?? null,
        deliveryErrorCode: s.deliveryErrorCode,
        deliveryError: textoDeFalloDeEntrega(s.deliveryErrorCode),
        destino: enmascararDestino(s),
        recipientName: s.recipientName,
        usada,
        ...accionesSobreLaTarjeta(quien, { ...s, usada }, ahora, timezone),
      }
    }),
  }
}

// ─── Reenviar y cambiar el destino ───

export type NuevoDestino = { deliveryChannel: 'WHATSAPP'; recipientPhone: string } | { deliveryChannel: 'EMAIL'; recipientEmail: string }

export interface ResultadoDeReenvio {
  giftCardId: string
  /** El estado REAL al responder (en una repetición puede ser SENT). */
  deliveryStatus: GiftCardDeliveryStatus
  repuesta: boolean
  ultimos4: string
  /** Para la bitácora del controller; nunca se responden. */
  replay: boolean
  destinoAnterior: string | null
  destinoNuevo: string | null
}

/**
 * El destino que trae un cuerpo (`resend` o `change-destination`). Sin canal = el mismo destino (`undefined`). Impresa o en
 * mano no es un destino al que se mande (C5): 400 con su `code`, antes de tocar nada.
 */
export function leerNuevoDestino(b: {
  deliveryChannel?: GiftCardDeliveryChannel
  recipientPhone?: string
  recipientEmail?: string
}): NuevoDestino | undefined {
  if (!b.deliveryChannel) return undefined
  if (b.deliveryChannel === 'WHATSAPP' && b.recipientPhone) return { deliveryChannel: 'WHATSAPP', recipientPhone: b.recipientPhone }
  if (b.deliveryChannel === 'EMAIL' && b.recipientEmail) return { deliveryChannel: 'EMAIL', recipientEmail: b.recipientEmail }
  if (b.deliveryChannel === 'WHATSAPP' || b.deliveryChannel === 'EMAIL') {
    throw new BadRequestError('Falta el teléfono o el correo del nuevo destino.')
  }
  throw new BadRequestError('Para cambiar el destino elige WhatsApp o correo', 'GIFT_CARD_DESTINATION_CHANNEL_INVALID')
}

/** S-4: sólo una tarjeta ACTIVE y vigente admite reenviar, cambiar el destino o mostrar el código. Bajo el candado del sobre. */
async function bloquearVigente(tx: Tx, venueId: string, giftCardId: string, ahora: Date): Promise<LockedGiftCard> {
  const [card] = await lockGiftCardsForUpdate(tx, [giftCardId])
  if (!card || card.venueId !== venueId || card.status === 'DEACTIVATED') throw tarjetaNoEncontrada()
  if (card.status === 'PENDING') {
    throw new GiftCardError('GIFT_CARD_SALE_NOT_PAID', 'Esta tarjeta todavía no se cobra: se envía sola al quedar pagada.', 409)
  }
  if (card.status === 'BLOCKED') {
    throw new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta de regalo está bloqueada. Pide al gerente que la revise.', 409)
  }
  if (card.expiresAt && card.expiresAt.getTime() <= ahora.getTime()) {
    throw new GiftCardError('GIFT_CARD_EXPIRED', 'Esta tarjeta de regalo ya venció.', 409)
  }
  return card
}

/** A18: lo que `LockedGiftCard` no trae, releído bajo el candado. */
async function releerEntrega(tx: Tx, giftCardId: string) {
  const f = await tx.giftCard.findUnique({
    where: { id: giftCardId },
    select: { recipientEmail: true, deliveryOperationKey: true, deliveryStatus: true, codeLast4: true },
  })
  if (!f) throw tarjetaNoEncontrada()
  return f
}

type Destino = { deliveryChannel: GiftCardDeliveryChannel; recipientPhone: string | null; recipientEmail: string | null }

/** P-2: el teléfono se compara canónico (Q25) y el correo sin mayúsculas ni espacios. */
function esElDestinoActual(actual: Destino, d: NuevoDestino): boolean {
  if (actual.deliveryChannel !== d.deliveryChannel) return false
  if (d.deliveryChannel === 'WHATSAPP') {
    const pedido = telefonoDeTarjeta(d.recipientPhone)
    return pedido !== null && telefonoDeTarjeta(actual.recipientPhone) === pedido
  }
  return actual.recipientEmail !== null && normalizeEmail(actual.recipientEmail) === normalizeEmail(d.recipientEmail)
}

/** La llave ya sirvió para OTRA operación (o para el mismo cambio con otro destino): el mismo 409 que la libreta. */
const llaveReusada = () =>
  new GiftCardError(
    'IDEMPOTENCY_KEY_REUSED',
    'Esta operación ya se registró con otros datos. Cierra el diálogo y vuelve a intentarlo.',
    409,
  )

/** Reenviar = la entrega vuelve a empezar con su llave (S3 la toma: intentos en 0, sin espera y sin reclamo). */
const reinicioDeEntrega = (operationKey: string) => ({
  deliveryStatus: 'PENDING' as const,
  deliveryAttempts: 0,
  deliveryNextAttemptAt: null,
  deliveryClaimedAt: null,
  deliveryErrorCode: null,
  deliveryMessageId: null,
  deliveryOperationKey: operationKey,
})

/** El reenvío al MISMO destino, bajo el candado. La misma llave que el último reenvío es su repetición: no toca nada. */
async function reenviarEnTx(
  tx: Tx,
  card: LockedGiftCard,
  f: Awaited<ReturnType<typeof releerEntrega>>,
  operationKey: string,
): Promise<ResultadoDeReenvio> {
  const base = { giftCardId: card.id, repuesta: false, ultimos4: f.codeLast4, destinoAnterior: null, destinoNuevo: null }
  if (f.deliveryOperationKey === operationKey) return { ...base, deliveryStatus: f.deliveryStatus, replay: true }
  if (!seEntregaPorMensaje(card.deliveryChannel)) {
    throw new GiftCardError(
      'GIFT_CARD_NOT_DELIVERABLE',
      'Esta tarjeta se entregó en papel o en mano. Para mandarla por WhatsApp o correo, cambia el destino.',
      409,
    )
  }
  await tx.giftCard.update({ where: { id: card.id }, data: reinicioDeEntrega(operationKey), select: { id: true } })
  return { ...base, deliveryStatus: 'PENDING', replay: false }
}

/** Mismo destino. `destino`, si viene, debe ser el actual: para otro teléfono o correo está «Cambiar destino» (400, C2). */
export async function reenviarTarjeta(
  venueId: string,
  giftCardId: string,
  _quien: QuienPregunta,
  p: { operationKey: string; destino?: NuevoDestino },
): Promise<ResultadoDeReenvio> {
  return prisma.$transaction(async tx => {
    const card = await bloquearVigente(tx, venueId, giftCardId, new Date())
    const f = await releerEntrega(tx, giftCardId)
    // m2 (revisión de S7): una llave = una operación. La de un cambio de destino (o de cualquier operación de la libreta) no
    // sirve para reenviar. Bajo el candado del sobre: el cambio escribe su renglón con ese mismo candado tomado.
    const deLaLibreta = await tx.giftCardActivity.findUnique({
      where: { venueId_operationKey: { venueId, operationKey: p.operationKey } },
      select: { id: true },
    })
    if (deLaLibreta) throw llaveReusada()
    if (p.destino && !esElDestinoActual({ ...card, recipientEmail: f.recipientEmail }, p.destino)) {
      throw new BadRequestError('Para mandarla a otro teléfono o correo usa «Cambiar destino».', 'GIFT_CARD_USE_CHANGE_DESTINATION')
    }
    return reenviarEnTx(tx, card, f, p.operationKey)
  }, ORDER_LOCK_WAIT_BUDGET)
}

/**
 * Destino nuevo: repone código y liga (P-3, `CODE_REPLACED` con la nota fija) y, en la MISMA transacción, deja sólo el destino
 * nuevo (borrar el teléfono viejo corta teléfono + código del destino anterior, E16) y reinicia la entrega. El mismo destino se
 * porta como `reenviarTarjeta`. La autoridad de gerente la dio la ruta.
 */
export async function cambiarDestinoDeTarjeta(
  venueId: string,
  giftCardId: string,
  quien: QuienPregunta,
  p: { operationKey: string; destino: NuevoDestino },
): Promise<ResultadoDeReenvio> {
  const telefono = p.destino.deliveryChannel === 'WHATSAPP' ? telefonoDeTarjeta(p.destino.recipientPhone) : null
  if (p.destino.deliveryChannel === 'WHATSAPP' && telefono === null) {
    throw new BadRequestError('El teléfono no es válido.', 'GIFT_CARD_PHONE_INVALID')
  }
  return prisma.$transaction(async tx => {
    const card = await bloquearVigente(tx, venueId, giftCardId, new Date())
    const f = await releerEntrega(tx, giftCardId)
    const actual: Destino = { ...card, recipientEmail: f.recipientEmail }
    // B-S4 3: la nota es fija, así que la huella de la libreta no distingue destinos; la repetición se reconoce aquí, bajo el
    // candado: la misma llave con el destino que ya quedó es la misma respuesta; con otro, la llave ya se usó.
    const previa = await tx.giftCardActivity.findUnique({
      where: { venueId_operationKey: { venueId, operationKey: p.operationKey } },
      select: { giftCardId: true, type: true },
    })
    if (previa) {
      if (previa.giftCardId !== giftCardId || previa.type !== 'CODE_REPLACED' || !esElDestinoActual(actual, p.destino)) {
        throw llaveReusada()
      }
      return {
        giftCardId,
        deliveryStatus: f.deliveryStatus,
        repuesta: true,
        ultimos4: f.codeLast4,
        replay: true,
        destinoAnterior: null,
        destinoNuevo: null,
      }
    }
    // m2 (revisión de S7): la llave de un reenvío queda en la entrega, no en la libreta. Hacia el MISMO destino es su repetición
    // (abajo, como reenvío); hacia otro, la llave ya se usó. Leída bajo el mismo candado que la escribe (`reinicioDeEntrega`).
    const esElMismo = esElDestinoActual(actual, p.destino)
    if (f.deliveryOperationKey === p.operationKey && !esElMismo) throw llaveReusada()
    if (esElMismo) return reenviarEnTx(tx, card, f, p.operationKey)

    // La libreta rechaza con los textos de la 1a una tarjeta usada o guardada en la cartera de un cliente.
    const { nuevoCodigo } = await operarSobreDeGerenteEnTx(tx, {
      venueId,
      giftCardId,
      staffId: quien.staffId,
      operationKey: p.operationKey,
      op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'CUSTOMER_REQUEST', note: NOTA_DE_CAMBIO_DE_DESTINO },
    })
    const nuevo: Destino = {
      deliveryChannel: p.destino.deliveryChannel,
      recipientPhone: telefono,
      recipientEmail: p.destino.deliveryChannel === 'EMAIL' ? normalizeEmail(p.destino.recipientEmail) : null,
    }
    await tx.giftCard.update({ where: { id: giftCardId }, data: { ...nuevo, ...reinicioDeEntrega(p.operationKey) }, select: { id: true } })
    return {
      giftCardId,
      deliveryStatus: 'PENDING',
      repuesta: true,
      ultimos4: nuevoCodigo?.last4 ?? f.codeLast4,
      replay: false,
      destinoAnterior: enmascararDestino(actual),
      destinoNuevo: enmascararDestino(nuevo),
    }
  }, ORDER_LOCK_WAIT_BUDGET)
}

// ─── Mostrar el código (Q42, Q102) ───

export interface AuditoriaDeLaSalida {
  staffId: string
  ruta: string
  overrideAuthorizedBy?: string | null
  ipAddress?: string
  userAgent?: string
}

export interface CertificadoDeTarjeta {
  codigo: string
  pageToken: string
  pageUrl: string
  ultimos4: string
  monto: number
  saldo: number
  venceEl: string | null
  termsVersion: string
  recipientName: string | null
  purchaserName: string | null
  message: string | null
}

const SELECT_DEL_CERTIFICADO = {
  id: true,
  codeEnc: true,
  pageToken: true,
  codeLast4: true,
  initialAmount: true,
  balance: true,
  expiresAt: true,
  termsVersion: true,
  recipientName: true,
  purchaserName: true,
  message: true,
} satisfies Prisma.GiftCardSelect

type FilaDelCertificado = Prisma.GiftCardGetPayload<{ select: typeof SELECT_DEL_CERTIFICADO }>

/** Se llama DESPUÉS del commit: el código se descifra sólo cuando su renglón ya está guardado. */
function certificado(f: FilaDelCertificado, timezone: string): CertificadoDeTarjeta {
  return {
    codigo: formatGiftCardCode(decryptGiftCardCode(f.codeEnc)),
    pageToken: f.pageToken,
    pageUrl: urlDeLaPagina(f.pageToken),
    ultimos4: f.codeLast4,
    monto: Number(f.initialAmount),
    saldo: Number(f.balance),
    venceEl: venceEl(f.expiresAt, timezone),
    termsVersion: f.termsVersion,
    recipientName: f.recipientName,
    purchaserName: f.purchaserName,
    message: f.message,
  }
}

type MotivoDeSalida = 'REPRINT' | 'SHOW_QR' | 'PRINT'

/** El renglón de UNA salida del secreto. Su `data` nunca lleva el código, la liga ni el destino. */
function renglonDeSalida(
  venueId: string,
  giftCardId: string,
  a: AuditoriaDeLaSalida,
  p: { operationKey: string; motivo: MotivoDeSalida },
): AuditoriaDeTarjetas & { action: 'GIFT_CARD_CODE_REVEALED' } {
  return {
    venueId,
    staffId: a.staffId,
    action: 'GIFT_CARD_CODE_REVEALED',
    entity: 'GiftCard',
    entityId: giftCardId,
    data: {
      operationKey: p.operationKey,
      motivo: p.motivo,
      ruta: a.ruta,
      ...(a.overrideAuthorizedBy ? { overrideAuthorizedBy: a.overrideAuthorizedBy } : {}),
    },
    ipAddress: a.ipAddress,
    userAgent: a.userAgent,
  }
}

/** Q102: un rechazo de negocio (4xx) sale como siempre; cualquier otro fallo de la transacción del secreto es 503 sin secreto. */
async function sinSecretoSiFalla<T>(venueId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500) throw error
    logger.error('🎁 [tarjetas de regalo] no se guardó la salida del código: no se muestra', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ServiceUnavailableError(TEXTO_SIN_SECRETO)
  }
}

/**
 * Q42: las tarjetas ACTIVE de la cuenta con su código VIGENTE, para imprimir o mostrar el QR. Sólo el mismo día del negocio de la
 * venta (la activación de sus tarjetas); otro día ⇒ 403 y se va tarjeta por tarjeta con `reveal-manager`.
 */
export async function revelarCodigosDeLaCuenta(
  venueId: string,
  orderId: string,
  _quien: QuienPregunta,
  p: { operationKey: string; auditoria: AuditoriaDeLaSalida },
  ahora: Date = new Date(),
): Promise<{ orderId: string; tarjetas: Array<CertificadoDeTarjeta & { id: string }> }> {
  const timezone = await zonaDelNegocio(venueId)
  const filas = await sinSecretoSiFalla(venueId, () =>
    prisma.$transaction(async tx => {
      const orden = await tx.order.findFirst({ where: { id: orderId, venueId }, select: selectDeLaCuenta({ id: true } as const) })
      const ids = sobresDe(orden).map(s => s.id)
      const activas = (await lockGiftCardsForUpdate(tx, ids)).filter(c => c.venueId === venueId && c.status === 'ACTIVE')
      if (activas.length === 0) return []
      if (activas.some(c => c.activatedAt === null || !mismoDiaDelVenue(c.activatedAt, ahora, timezone))) throw revelarNoPermitido()
      const leidas = await tx.giftCard.findMany({
        where: { id: { in: activas.map(c => c.id) }, venueId },
        select: SELECT_DEL_CERTIFICADO,
        take: activas.length,
      })
      const enOrden = ids.flatMap(id => leidas.filter(f => f.id === id))
      await registrarSalidaDelSecreto(
        tx,
        enOrden.map(f => renglonDeSalida(venueId, f.id, p.auditoria, { operationKey: p.operationKey, motivo: 'PRINT' })),
      )
      return enOrden
    }, ORDER_LOCK_WAIT_BUDGET),
  )
  return { orderId, tarjetas: filas.map(f => ({ id: f.id, ...certificado(f, timezone) })) }
}

/**
 * `comoGerente=false` (ruta `reveal`): el mismo día de la venta con `giftCards:sell`, o quien tiene `giftCards:manage` de
 * verdad; si no, 403. `comoGerente=true` (ruta `reveal-manager`, ya autorizada por `checkPermission` o el PIN): cualquier día.
 */
export async function revelarCodigo(
  venueId: string,
  giftCardId: string,
  quien: QuienPregunta,
  p: { operationKey: string; motivo: 'REPRINT' | 'SHOW_QR'; comoGerente: boolean; auditoria: AuditoriaDeLaSalida },
  ahora: Date = new Date(),
): Promise<CertificadoDeTarjeta> {
  const timezone = await zonaDelNegocio(venueId)
  const fila = await sinSecretoSiFalla(venueId, () =>
    prisma.$transaction(async tx => {
      const card = await bloquearVigente(tx, venueId, giftCardId, ahora)
      // `usada` no cambia `revelarPideGerente`.
      if (!p.comoGerente && accionesSobreLaTarjeta(quien, { ...card, usada: false }, ahora, timezone).revelarPideGerente) {
        throw revelarNoPermitido()
      }
      const f = await tx.giftCard.findUnique({ where: { id: giftCardId }, select: SELECT_DEL_CERTIFICADO })
      if (!f) throw tarjetaNoEncontrada()
      await registrarSalidaDelSecreto(tx, [renglonDeSalida(venueId, giftCardId, p.auditoria, p)])
      return f
    }, ORDER_LOCK_WAIT_BUDGET),
  )
  return certificado(fila, timezone)
}
