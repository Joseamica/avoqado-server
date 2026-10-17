// src/services/giftCards/giftCardLedger.ts
/**
 * La libreta de las tarjetas de regalo (spec 2026-10-14 § 4.2 y § 6): la ÚNICA forma de mover saldo.
 *  - Todas reciben la transacción del llamador y NO abren otra.
 *  - El saldo se mueve con escrituras CONDICIONADAS (la condición va en el WHERE) bajo el candado de los sobres.
 *  - Cada movimiento inserta su renglón en `GiftCardActivity`; la base no deja editarlo ni borrarlo.
 *  - Jerarquía de candados: Order → Payment (si aplica) → GiftCard → Shift. Un reverso bloquea los sobres ANTES de
 *    `writeRefundInTx` (que reclama el turno): ver `sobresDelCanje`.
 */
import { Prisma, type GiftCardReason, type GiftCardStatus } from '@prisma/client'
import { addDays, addMonths } from 'date-fns'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { operationHash } from '@/utils/operationHash'
import { recordGiftCardAnomaly } from './giftCardAnomaly'
import {
  decryptGiftCardCode,
  encryptGiftCardCode,
  formatGiftCardCode,
  generateGiftCardCode,
  generateOpaqueToken,
  hashGiftCardCode,
} from './giftCardCode'
import { GiftCardError } from './giftCardErrors'
import { MAX_SOBRES_POR_CUENTA, MAXIMO_POR_SOBRE, formatoPesos } from './giftCardLimits'

type Tx = Prisma.TransactionClient
const CERO = () => new Prisma.Decimal(0)
const DIAS_DE_GRACIA_TRAS_REVERSO = 90
const LLAVE_DE_OPERACION = /^[A-Za-z0-9_:-]{8,128}$/

export interface LockedGiftCard {
  id: string
  venueId: string
  /** r1 (A-1): la huella VIGENTE del código, leída bajo el candado; el cobro la compara con la prueba presentada. */
  codeHash: string
  status: GiftCardStatus
  balance: Prisma.Decimal
  initialAmount: Prisma.Decimal
  expiresAt: Date | null
  activatedAt: Date | null
  validityMonths: number | null
  customerId: string | null
}

export type OperacionDeGerente =
  | { tipo: 'AJUSTE'; direccion: 'INCREMENT' | 'DECREMENT'; amount: Prisma.Decimal; reason: GiftCardReason; note?: string }
  | { tipo: 'BLOQUEAR' | 'DESBLOQUEAR'; reason: GiftCardReason; note?: string }
  | { tipo: 'REEMPLAZAR_CODIGO'; reason: 'LOST_CARD'; note?: string }

function esUsable(c: { status: GiftCardStatus; expiresAt: Date | null }, ahora: Date): boolean {
  return c.status === 'ACTIVE' && (c.expiresAt === null || c.expiresAt.getTime() > ahora.getTime())
}

export function saldoUsable(
  cards: Array<{ status: GiftCardStatus; balance: Prisma.Decimal; expiresAt: Date | null }>,
  ahora: Date,
): Prisma.Decimal {
  return cards.reduce((suma, c) => (esUsable(c, ahora) ? suma.plus(c.balance) : suma), CERO())
}

function noEncontrada(): GiftCardError {
  return new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404)
}

function saldoInsuficiente(disponible: Prisma.Decimal): GiftCardError {
  return new GiftCardError('GIFT_CARD_INSUFFICIENT_BALANCE', `Quedan ${formatoPesos(disponible)} en la tarjeta de regalo.`, 409, {
    saldoDisponible: disponible.toNumber(),
  })
}

/** `null` al final; las fechas, de la más próxima a la más lejana. */
const fechaAscNullsLast = (a: Date | null, b: Date | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.getTime() - b.getTime()

/**
 * El candado de los sobres (todos los que toman sobres pasan por aquí). ⭐ (A4 menor 2): el `FOR UPDATE` va en orden de `id`, la
 * única clave que nadie cambia; ordenarlo por `expiresAt`/`activatedAt` —que la activación y el reverso escriben— dejaba que dos
 * transacciones vieran el mismo par en orden distinto (40P01). El orden de CONSUMO (vencen antes → activados antes → id), el que
 * usa el canje, se aplica en memoria con lo leído bajo el candado.
 */
export async function lockGiftCardsForUpdate(tx: Tx, ids: string[]): Promise<LockedGiftCard[]> {
  const unicos = [...new Set(ids)]
  if (unicos.length === 0) return []
  const filas = await tx.$queryRaw<
    Array<{
      id: string
      venueId: string
      codeHash: string
      status: string
      balance: Prisma.Decimal
      initialAmount: Prisma.Decimal
      expiresAt: Date | null
      activatedAt: Date | null
      validityMonths: number | null
      customerId: string | null
    }>
  >`
    SELECT id, "venueId", "codeHash", status::text AS status, balance, "initialAmount", "expiresAt", "activatedAt", "validityMonths", "customerId"
    FROM "GiftCard"
    WHERE id IN (${Prisma.join(unicos)})
    ORDER BY id ASC
    FOR UPDATE`
  const bloqueados = filas.map(f => ({
    id: f.id,
    venueId: f.venueId,
    codeHash: f.codeHash,
    status: f.status as GiftCardStatus,
    balance: new Prisma.Decimal(f.balance),
    initialAmount: new Prisma.Decimal(f.initialAmount),
    expiresAt: f.expiresAt,
    activatedAt: f.activatedAt,
    validityMonths: f.validityMonths,
    customerId: f.customerId,
  }))
  return bloqueados.sort(
    (a, b) =>
      fechaAscNullsLast(a.expiresAt, b.expiresAt) ||
      fechaAscNullsLast(a.activatedAt, b.activatedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** Los sobres que un cobro con saldo descontó: un reverso los bloquea ANTES de `writeRefundInTx`. */
export async function sobresDelCanje(tx: Tx, p: { venueId: string; paymentId: string }): Promise<string[]> {
  const filas = await tx.giftCardActivity.findMany({
    where: { venueId: p.venueId, paymentId: p.paymentId, type: 'REDEEM' },
    select: { giftCardId: true },
    orderBy: { id: 'asc' },
    take: MAX_SOBRES_POR_CUENTA,
  })
  return [...new Set(filas.map(f => f.giftCardId))]
}

/**
 * El dinero de la cuenta, sólo el importe de venta (la propina nunca entra a los sobres): lo cobrado sin REFUND, lo
 * devuelto y lo que el negocio conservó. r1 (F8): los REFUND se guardan NEGATIVOS (`summarizeRefunds`,
 * src/services/shared/orderBalance.ts); se toma su valor absoluto. La revisión nocturna (B7) mide con esta MISMA función.
 */
export async function dineroDeLaCuenta(
  tx: Tx,
  p: { venueId: string; orderId: string },
): Promise<{ cobrado: Prisma.Decimal; reembolsado: Prisma.Decimal; conservado: Prisma.Decimal }> {
  const cobros = await tx.payment.aggregate({
    where: { venueId: p.venueId, orderId: p.orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    _sum: { amount: true },
  })
  const cobrado = cobros._sum.amount ?? CERO()
  const devoluciones = await tx.payment.aggregate({
    where: { venueId: p.venueId, orderId: p.orderId, status: 'COMPLETED', type: 'REFUND' },
    _sum: { amount: true },
  })
  const reembolsado = (devoluciones._sum.amount ?? CERO()).abs()
  return { cobrado, reembolsado, conservado: cobrado.minus(reembolsado) }
}

/**
 * Ruling del coordinador (A6): llega dinero a una cuenta de tarjetas que se CANCELÓ y cuyos sobres ya están DEACTIVATED
 * —la reabre `reabrirSiRecibeDinero`, un `PAY_CASH` reproducido de la cola o un cobro tardío de la terminal— y la cuenta
 * queda PAGADA sin ningún sobre PENDING. Los sobres NUNCA se reactivan: uno desactivado pudo cancelarse por fraude o por
 * un reembolso, y revivirlo en silencio regalaría saldo. Tampoco se deja pasar callado: el negocio se quedó con ese
 * dinero sin tarjetas vivas que lo respalden, así que queda un MoneyAnomaly para que el gerente devuelva o vuelva a vender.
 * Si el dinero ya se devolvió completo (la cancelación con reembolso de R2) o lo que queda ya se entregó en mercancía con esos sobres
 * antes de desactivarlos (B7 r1, `medirDineroSinRespaldo`), no hay nada que avisar.
 */
async function avisarSiCobraSobresDesactivados(tx: Tx, p: { venueId: string; orderId: string }): Promise<void> {
  const m = await medirDineroSinRespaldo(tx, p)
  if (!m?.sinRespaldo) return
  await recordGiftCardAnomaly(tx, {
    check: 'PAID_WITH_DEACTIVATED',
    id: p.orderId,
    venueId: p.venueId,
    detail: { motivo: 'COBRO_CON_SOBRES_DESACTIVADOS', orderId: p.orderId, ...dineroSinRespaldoEnTexto(m) },
  })
}

export interface DineroSinRespaldo {
  cobrado: Prisma.Decimal
  reembolsado: Prisma.Decimal
  conservado: Prisma.Decimal
  /** Lo que los sobres DESACTIVADOS alcanzaron a entregar en mercancía: sus REDEEM menos sus REDEEM_REVERSAL. */
  canjeado: Prisma.Decimal
  /** Lo que respalda lo conservado: `initialAmount` de cada sobre NO desactivado + `canjeado`. */
  respaldo: Prisma.Decimal
  sobres: Array<{ id: string; status: GiftCardStatus }>
  /** `conservado > respaldo`: el negocio se quedó dinero que ni un sobre vivo ni una mercancía entregada respaldan. */
  sinRespaldo: boolean
}

/**
 * B7 r1 (Important #1): ¿el dinero que el negocio conservó de una cuenta de tarjetas con sobres DESACTIVADOS tiene qué lo respalde?
 * Un sobre vivo respalda su monto; uno desactivado, lo que alcanzó a gastarse antes (E1: tarjeta de $500, se gastan $300, la terminal
 * devuelve $200 y la cuenta entera se desactiva ⇒ los $300 conservados ya salieron como mercancía, no son «dinero sin tarjeta»).
 * 🔴 Una sola definición: la usan el cobro (A6, `avisarSiCobraSobresDesactivados`) y la revisión nocturna (B7).
 * `null` = ningún sobre desactivado: cada sobre respalda su monto y ni se consulta el dinero (el segundo cierre de una venta normal).
 */
export async function medirDineroSinRespaldo(tx: Tx, p: { venueId: string; orderId: string }): Promise<DineroSinRespaldo | null> {
  const sobres = await tx.giftCard.findMany({
    where: { venueId: p.venueId, orderItem: { is: { orderId: p.orderId } } },
    select: { id: true, status: true, initialAmount: true },
    orderBy: { id: 'asc' },
    take: MAX_SOBRES_POR_CUENTA + 1,
  })
  const desactivados = sobres.filter(s => s.status === 'DEACTIVATED').map(s => s.id)
  if (desactivados.length === 0) return null
  const dinero = await dineroDeLaCuenta(tx, p)
  const movimientos = await tx.giftCardActivity.groupBy({
    by: ['type'],
    where: { venueId: p.venueId, giftCardId: { in: desactivados }, type: { in: ['REDEEM', 'REDEEM_REVERSAL'] } },
    _sum: { amount: true },
  })
  const sumaDe = (tipo: 'REDEEM' | 'REDEEM_REVERSAL') => movimientos.find(m => m.type === tipo)?._sum.amount ?? CERO()
  const canjeado = Prisma.Decimal.max(CERO(), sumaDe('REDEEM').minus(sumaDe('REDEEM_REVERSAL')))
  const respaldo = sobres.filter(s => s.status !== 'DEACTIVATED').reduce((suma, s) => suma.plus(s.initialAmount), canjeado)
  return {
    ...dinero,
    canjeado,
    respaldo,
    sobres: sobres.map(s => ({ id: s.id, status: s.status })),
    sinRespaldo: dinero.conservado.greaterThan(respaldo),
  }
}

/** El `detail` de `PAID_WITH_DEACTIVATED` (cobro y noche): pesos con dos decimales y cada sobre con su estado (nunca el código). */
export function dineroSinRespaldoEnTexto(m: DineroSinRespaldo) {
  return {
    cobrado: m.cobrado.toFixed(2),
    reembolsado: m.reembolsado.toFixed(2),
    conservado: m.conservado.toFixed(2),
    canjeado: m.canjeado.toFixed(2),
    respaldo: m.respaldo.toFixed(2),
    sobres: m.sobres,
  }
}

/**
 * Una sola función activa los sobres (R8), llamada junto a CADA `createSalePostingInTx` que salda por primera vez y por
 * la revisión nocturna. Comprueba que lo cobrado (sin propina) sea EXACTAMENTE la suma de los sobres y (r1, F8) que el
 * dinero CONSERVADO —cobros menos reembolsos de la cuenta— la cubra: `computeOrderBalance` no resta los reembolsos, así
 * que una venta con un abono devuelto por la terminal puede quedar «pagada» con menos dinero del que vale. Si algo no
 * cuadra, no activa y deja un MoneyAnomaly (spec § 5.1.6). Idempotente: sólo pasa a ACTIVE lo que bajo candado sigue PENDING.
 * Sin sobres PENDING y con alguno DEACTIVATED (cuenta cancelada que recibió dinero), no reactiva y avisa (ruling A6).
 */
export async function activarSobresDeCuentaPagadaEnTx(
  tx: Tx,
  p: { venueId: string; orderId: string; staffId?: string | null; items?: ReadonlyArray<{ giftCardId?: string | null }> },
): Promise<{ activated: string[] }> {
  if (p.items && !p.items.some(item => item.giftCardId != null)) return { activated: [] }

  const pendientes = await tx.giftCard.findMany({
    where: { venueId: p.venueId, status: 'PENDING', orderItem: { is: { orderId: p.orderId } } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_SOBRES_POR_CUENTA + 1,
  })
  if (pendientes.length === 0) {
    await avisarSiCobraSobresDesactivados(tx, p)
    return { activated: [] }
  }

  const renglones = await tx.orderItem.findMany({
    where: { orderId: p.orderId },
    select: { id: true, giftCardId: true, total: true },
    orderBy: { id: 'asc' },
    take: MAX_SOBRES_POR_CUENTA + 1,
  })
  const esperado = renglones.reduce((suma, r) => suma.plus(r.total), CERO())
  const { cobrado, reembolsado, conservado } = await dineroDeLaCuenta(tx, p)
  const mixta = renglones.length === 0 || renglones.length > MAX_SOBRES_POR_CUENTA || renglones.some(r => r.giftCardId == null)
  const dineroDevuelto = conservado.lessThan(esperado)
  if (mixta || dineroDevuelto || !cobrado.equals(esperado)) {
    await recordGiftCardAnomaly(tx, {
      check: 'ACTIVATION_AMOUNT_MISMATCH',
      id: p.orderId,
      venueId: p.venueId,
      detail: {
        motivo: mixta ? 'CUENTA_MIXTA' : dineroDevuelto ? 'DINERO_DEVUELTO' : 'COBRADO_DISTINTO',
        cobrado: cobrado.toFixed(2),
        reembolsado: reembolsado.toFixed(2),
        esperado: esperado.toFixed(2),
        sobres: pendientes.map(s => s.id),
      },
    })
    return { activated: [] }
  }

  const bloqueados = await lockGiftCardsForUpdate(
    tx,
    pendientes.map(s => s.id),
  )
  // Cada sobre se activa con SU monto (`initialAmount`), así que su renglón debe haber cobrado exactamente eso: si un
  // descuento se coló en un renglón, lo cobrado cuadra con los renglones pero el sobre regalaría la diferencia.
  const totalDelRenglon = new Map(renglones.map(r => [r.giftCardId, r.total]))
  const distinto = bloqueados.find(c => c.status === 'PENDING' && !totalDelRenglon.get(c.id)?.equals(c.initialAmount))
  if (distinto) {
    await recordGiftCardAnomaly(tx, {
      check: 'ACTIVATION_AMOUNT_MISMATCH',
      id: p.orderId,
      venueId: p.venueId,
      detail: {
        motivo: 'MONTO_DE_SOBRE_DISTINTO',
        sobre: distinto.id,
        montoDelSobre: distinto.initialAmount.toFixed(2),
        cobradoEnSuRenglon: totalDelRenglon.get(distinto.id)?.toFixed(2) ?? null,
        sobres: pendientes.map(s => s.id),
      },
    })
    return { activated: [] }
  }
  const ahora = new Date()
  const activated: string[] = []
  for (const card of bloqueados) {
    if (card.status !== 'PENDING' || card.venueId !== p.venueId) continue
    const expiresAt = card.validityMonths ? addMonths(ahora, card.validityMonths) : null
    const r = await tx.giftCard.updateMany({
      where: { id: card.id, venueId: p.venueId, status: 'PENDING' },
      data: { status: 'ACTIVE', balance: card.initialAmount, activatedAt: ahora, expiresAt },
    })
    if (r.count !== 1) continue
    await tx.giftCardActivity.create({
      data: {
        giftCardId: card.id,
        venueId: p.venueId,
        type: 'ACTIVATE',
        amount: card.initialAmount,
        balanceAfter: card.initialAmount,
        orderId: p.orderId,
        staffId: p.staffId ?? null,
      },
    })
    activated.push(card.id)
  }
  return { activated }
}

/** Descuenta `amount` (venta + propina) de los sobres ya bloqueados, en el orden del candado. Un REDEEM por sobre. */
export async function canjearSobresEnTx(
  tx: Tx,
  p: {
    venueId: string
    orderId: string
    paymentId: string
    amount: Prisma.Decimal
    cards: LockedGiftCard[]
    staffId?: string | null
    deviceId?: string | null
  },
): Promise<Array<{ giftCardId: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal }>> {
  if (!p.amount.greaterThan(0) || p.amount.decimalPlaces() > 2) {
    throw new GiftCardError(
      'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      'El monto a cobrar con saldo debe ser mayor a cero y con centavos exactos.',
      422,
    )
  }
  if (p.cards.some(c => c.venueId !== p.venueId)) throw noEncontrada()
  const ahora = new Date()
  const disponible = saldoUsable(p.cards, ahora)
  if (disponible.lessThan(p.amount)) throw saldoInsuficiente(disponible)

  let falta = p.amount
  const resultado: Array<{ giftCardId: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal }> = []
  for (const card of p.cards) {
    if (falta.isZero()) break
    if (!esUsable(card, ahora) || !card.balance.greaterThan(0)) continue
    const toma = Prisma.Decimal.min(card.balance, falta)
    // ⭐ (A4 menor 3): CAS sobre el saldo LEÍDO bajo el candado, el mismo con que se escribe `balanceAfter`. Si la foto es vieja
    // (no salió del candado de ESTA transacción), no se escribe un saldo inventado: 409 y se reintenta con la misma llave.
    const r = await tx.giftCard.updateMany({
      where: {
        id: card.id,
        venueId: p.venueId,
        status: 'ACTIVE',
        balance: card.balance,
        OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }],
      },
      data: { balance: { decrement: toma } },
    })
    if (r.count !== 1) {
      throw new ConflictError(
        'El saldo de la tarjeta de regalo cambió mientras se cobraba. Vuelve a intentar con la MISMA llave.',
        'ORDER_PAYMENT_CONFLICT',
      )
    }
    const balanceAfter = card.balance.minus(toma)
    await tx.giftCardActivity.create({
      data: {
        giftCardId: card.id,
        venueId: p.venueId,
        type: 'REDEEM',
        amount: toma,
        balanceAfter,
        paymentId: p.paymentId,
        orderId: p.orderId,
        staffId: p.staffId ?? null,
        deviceId: p.deviceId ?? null,
      },
    })
    resultado.push({ giftCardId: card.id, amount: toma, balanceAfter })
    falta = falta.minus(toma)
  }
  return resultado
}

/** El texto de un reembolso (B1). `cuales` = las terminaciones separadas por coma; `cuantos` = cuántos sobres. */
function mensajeDeSobreDesactivadoEnReembolso(cuales: string, cuantos: number): string {
  return cuantos === 1
    ? `La tarjeta de regalo terminación ${cuales} ya fue cancelada: lo pagado con ella no puede regresar a su saldo. Pide al gerente que lo revise.`
    : `Las tarjetas de regalo terminación ${cuales} ya fueron canceladas: lo pagado con ellas no puede regresar a su saldo. Pide al gerente que lo revise.`
}

/**
 * B1 (nota 1; ruling 7 de A8): un sobre DEACTIVATED nunca recibe saldo de vuelta. Sumarle saldo a una tarjeta muerta lo
 * dejaría fuera de la vista de todos: se rechaza con su terminación ANTES de escribir, y el gerente decide. Recibe los
 * sobres ya BLOQUEADOS (su estado se leyó bajo candado); sólo consulta las terminaciones si hay alguno desactivado.
 * Una sola regla para los dos que regresan saldo (r1, fix 5): `revertirCanjeEnTx` y «regresar el saldo y cancelar» de A8, que
 * sólo cambia el texto (allí el cajero cobra lo que falta con otro medio).
 */
export async function rechazarSiRegresaASobreDesactivado(
  tx: Tx,
  venueId: string,
  cards: ReadonlyArray<{ id: string; status: GiftCardStatus }>,
  mensaje: (cuales: string, cuantos: number) => string = mensajeDeSobreDesactivadoEnReembolso,
): Promise<void> {
  const desactivados = [...new Set(cards.filter(c => c.status === 'DEACTIVATED').map(c => c.id))]
  if (desactivados.length === 0) return
  const terminaciones = await tx.giftCard.findMany({
    where: { venueId, id: { in: desactivados } },
    select: { id: true, codeLast4: true },
    orderBy: { id: 'asc' },
    take: desactivados.length,
  })
  throw new GiftCardError(
    'GIFT_CARD_TENDER_NOT_ALLOWED',
    mensaje(terminaciones.map(t => t.codeLast4).join(', '), desactivados.length),
    409,
    { motivo: 'SOBRE_DESACTIVADO', giftCardIds: desactivados },
  )
}

/** Regresa al saldo lo de un cobro con saldo (spec § 5.5). Idempotente por `refundPaymentId`; nunca pasa de lo canjeado. */
export async function revertirCanjeEnTx(
  tx: Tx,
  p: { venueId: string; originalPaymentId: string; refundPaymentId: string; amount: Prisma.Decimal; staffId?: string | null },
): Promise<Array<{ giftCardId: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal }>> {
  const reversoYaEscrito = async () => {
    const filas = await tx.giftCardActivity.findMany({
      where: { venueId: p.venueId, refundPaymentId: p.refundPaymentId, type: 'REDEEM_REVERSAL' },
      select: { giftCardId: true, amount: true, balanceAfter: true },
      orderBy: { id: 'asc' },
      take: MAX_SOBRES_POR_CUENTA,
    })
    return filas.map(r => ({ giftCardId: r.giftCardId, amount: r.amount, balanceAfter: r.balanceAfter }))
  }
  const yaEscrito = await reversoYaEscrito()
  if (yaEscrito.length > 0) return yaEscrito
  if (!p.amount.greaterThan(0) || p.amount.decimalPlaces() > 2) {
    throw new GiftCardError(
      'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      'El monto a regresar al saldo debe ser mayor a cero y con centavos exactos.',
      422,
    )
  }

  const canjes = await tx.giftCardActivity.findMany({
    where: { venueId: p.venueId, paymentId: p.originalPaymentId, type: 'REDEEM' },
    select: { id: true, giftCardId: true, amount: true, orderId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_SOBRES_POR_CUENTA,
  })
  if (canjes.length === 0) {
    throw new GiftCardError('GIFT_CARD_NOT_FOUND', 'Este cobro no tiene saldo de tarjeta de regalo que regresar.', 409)
  }
  const bloqueados = await lockGiftCardsForUpdate(
    tx,
    canjes.map(c => c.giftCardId),
  )
  // B1 (nota 4): la idempotencia por `refundPaymentId` se vuelve a mirar BAJO el candado. La primera lectura sólo es un atajo:
  // un duplicado simultáneo del MISMO reembolso la pasa vacía, espera el candado y, sin esta segunda, en un cobro de dos sobres
  // acreditaría el canje que el primero no tocó (doble saldo con la misma devolución).
  const escritoMientrasEsperaba = await reversoYaEscrito()
  if (escritoMientrasEsperaba.length > 0) return escritoMientrasEsperaba
  // Lo ya regresado se lee DESPUÉS del candado: todo REDEEM_REVERSAL se escribe con el sobre bloqueado, así que dos
  // reembolsos simultáneos del mismo cobro se serializan aquí y el segundo ve lo que regresó el primero.
  const previos = await tx.giftCardActivity.groupBy({
    by: ['reversesActivityId'],
    where: { venueId: p.venueId, type: 'REDEEM_REVERSAL', reversesActivityId: { in: canjes.map(c => c.id) } },
    _sum: { amount: true },
  })
  const yaRegresado = new Map(previos.map(r => [r.reversesActivityId as string, r._sum.amount ?? CERO()]))
  const porId = new Map(bloqueados.map(c => [c.id, c]))
  const ahora = new Date()

  // Se rechaza ANTES de escribir: si un llamador atrapara el error, no quedaría un reverso a medias.
  const porRegresar = canjes.reduce(
    (suma, canje) => suma.plus(Prisma.Decimal.max(CERO(), canje.amount.minus(yaRegresado.get(canje.id) ?? CERO()))),
    CERO(),
  )
  if (p.amount.greaterThan(porRegresar)) {
    throw new GiftCardError(
      'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      `El reembolso excede lo cobrado con saldo de tarjeta de regalo (sobran ${formatoPesos(p.amount.minus(porRegresar))}).`,
      422,
    )
  }

  // Se PLANEA todo antes de escribir (qué canje regresa cuánto a qué sobre): así un sobre ajeno o uno desactivado se rechaza
  // sin dejar medio reverso, aunque el llamador atrape el error.
  const plan: Array<{ canje: (typeof canjes)[number]; card: LockedGiftCard; toma: Prisma.Decimal }> = []
  let falta = p.amount
  for (const canje of canjes) {
    if (falta.isZero()) break
    const pendiente = canje.amount.minus(yaRegresado.get(canje.id) ?? CERO())
    if (!pendiente.greaterThan(0)) continue
    const card = porId.get(canje.giftCardId)
    if (!card || card.venueId !== p.venueId) throw noEncontrada()
    const toma = Prisma.Decimal.min(pendiente, falta)
    plan.push({ canje, card, toma })
    falta = falta.minus(toma)
  }
  // B1 (nota 1; ruling 7 de A8): sólo los sobres que de verdad recibirían saldo. Uno DEACTIVATED se rechaza con su terminación.
  await rechazarSiRegresaASobreDesactivado(
    tx,
    p.venueId,
    plan.map(x => x.card),
  )

  const resultado: Array<{ giftCardId: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal }> = []
  for (const { canje, card, toma } of plan) {
    const vencida = card.expiresAt !== null && card.expiresAt.getTime() <= ahora.getTime()
    const nuevaVigencia = vencida ? addDays(ahora, DIAS_DE_GRACIA_TRAS_REVERSO) : null
    const r = await tx.giftCard.updateMany({
      where: { id: card.id, venueId: p.venueId },
      data: { balance: { increment: toma }, ...(nuevaVigencia ? { expiresAt: nuevaVigencia } : {}) },
    })
    if (r.count !== 1) throw noEncontrada()
    const balanceAfter = card.balance.plus(toma)
    card.balance = balanceAfter
    if (nuevaVigencia) card.expiresAt = nuevaVigencia
    await tx.giftCardActivity.create({
      data: {
        giftCardId: card.id,
        venueId: p.venueId,
        type: 'REDEEM_REVERSAL',
        amount: toma,
        balanceAfter,
        refundPaymentId: p.refundPaymentId,
        reversesActivityId: canje.id,
        orderId: canje.orderId,
        staffId: p.staffId ?? null,
      },
    })
    resultado.push({ giftCardId: card.id, amount: toma, balanceAfter })
  }
  return resultado
}

async function codigoVigente(tx: Tx, venueId: string, giftCardId: string): Promise<{ display: string; last4: string }> {
  const s = await tx.giftCard.findFirst({ where: { id: giftCardId, venueId }, select: { codeEnc: true, codeLast4: true } })
  if (!s) throw noEncontrada()
  return { display: formatGiftCardCode(decryptGiftCardCode(s.codeEnc)), last4: s.codeLast4 }
}

/**
 * Ajustar, bloquear, desbloquear y reponer (spec § 5.7). Idempotente por `operationKey` con huella del contenido:
 * la misma llave con el mismo contenido devuelve el renglón original (`replay: true`); con otro contenido, 409
 * IDEMPOTENCY_KEY_REUSED. La llave se revisa DESPUÉS del candado del sobre: dos reintentos simultáneos se serializan y el
 * segundo ve el renglón. `replay` es la única fuente de «nuevo o repetición» para la bitácora (r1, F9).
 */
export async function operarSobreDeGerenteEnTx(
  tx: Tx,
  p: { venueId: string; giftCardId: string; staffId: string; operationKey: string; op: OperacionDeGerente },
): Promise<{ activityIds: string[]; nuevoCodigo?: { display: string; last4: string }; replay: boolean }> {
  if (!LLAVE_DE_OPERACION.test(p.operationKey ?? '')) {
    throw new BadRequestError(
      'La llave de la operación debe tener de 8 a 128 caracteres (letras, números, guion, guion bajo o dos puntos).',
    )
  }
  const note = p.op.note?.trim() || null
  if (p.op.reason === 'OTHER' && !note) throw new BadRequestError('Con el motivo «Otro» la nota es obligatoria.')
  const huella = operationHash({
    giftCardId: p.giftCardId,
    tipo: p.op.tipo,
    direccion: p.op.tipo === 'AJUSTE' ? p.op.direccion : null,
    amount: p.op.tipo === 'AJUSTE' ? p.op.amount.toFixed(2) : null,
    reason: p.op.reason,
    note,
  })

  const [card] = await lockGiftCardsForUpdate(tx, [p.giftCardId])
  if (!card || card.venueId !== p.venueId) throw noEncontrada()

  const previa = await tx.giftCardActivity.findUnique({
    where: { venueId_operationKey: { venueId: p.venueId, operationKey: p.operationKey } },
    select: { id: true, operationHash: true, type: true },
  })
  if (previa) {
    if (previa.operationHash !== huella) {
      throw new GiftCardError(
        'IDEMPOTENCY_KEY_REUSED',
        'Esta operación ya se registró con otros datos. Cierra el diálogo y vuelve a intentarlo.',
        409,
      )
    }
    // r1 (F9): «repetición» se decide AQUÍ, bajo el candado del sobre; C3 escribe la bitácora sólo con `replay: false`.
    return previa.type === 'CODE_REPLACED'
      ? { activityIds: [previa.id], nuevoCodigo: await codigoVigente(tx, p.venueId, p.giftCardId), replay: true }
      : { activityIds: [previa.id], replay: true }
  }

  const base = {
    giftCardId: card.id,
    venueId: p.venueId,
    reason: p.op.reason,
    note,
    staffId: p.staffId,
    operationKey: p.operationKey,
    operationHash: huella,
  }

  if (p.op.tipo === 'AJUSTE') {
    if (card.status !== 'ACTIVE' && card.status !== 'BLOCKED') {
      throw new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta de regalo no está activa: no admite ajustes.', 409)
    }
    const monto = p.op.amount
    if (!monto.greaterThan(0) || monto.decimalPlaces() > 2) {
      throw new GiftCardError('GIFT_CARD_AMOUNT_OUT_OF_RANGE', 'El ajuste debe ser mayor a cero y con centavos exactos.', 422)
    }
    if (p.op.direccion === 'INCREMENT') {
      // r1 (F7): el techo cuenta también lo que los canjes de este sobre todavía pueden regresar con un reembolso; así un
      // reverso legítimo nunca lo rebasa y nunca hay que rechazarlo. Ej.: $10,000 → canje $5,000 → ajuste +$5,000 se rechaza.
      const movimientos = await tx.giftCardActivity.groupBy({
        by: ['type'],
        where: { venueId: p.venueId, giftCardId: card.id, type: { in: ['REDEEM', 'REDEEM_REVERSAL'] } },
        _sum: { amount: true },
      })
      const sumaDe = (tipo: 'REDEEM' | 'REDEEM_REVERSAL') => movimientos.find(m => m.type === tipo)?._sum.amount ?? CERO()
      const reversibles = Prisma.Decimal.max(CERO(), sumaDe('REDEEM').minus(sumaDe('REDEEM_REVERSAL')))
      const nuevo = card.balance.plus(monto)
      if (nuevo.plus(reversibles).greaterThan(MAXIMO_POR_SOBRE)) {
        throw new GiftCardError(
          'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
          reversibles.isZero()
            ? `Con este ajuste la tarjeta pasaría de ${formatoPesos(MAXIMO_POR_SOBRE)}, el máximo por tarjeta.`
            : `Con este ajuste la tarjeta podría pasar de ${formatoPesos(MAXIMO_POR_SOBRE)}, el máximo por tarjeta: ${formatoPesos(reversibles)} de sus canjes todavía pueden regresar a su saldo con un reembolso.`,
          422,
        )
      }
      const r = await tx.giftCard.updateMany({ where: { id: card.id, venueId: p.venueId }, data: { balance: { increment: monto } } })
      if (r.count !== 1) throw noEncontrada()
      const fila = await tx.giftCardActivity.create({
        data: { ...base, type: 'ADJUST_INCREMENT', amount: monto, balanceAfter: nuevo },
        select: { id: true },
      })
      return { activityIds: [fila.id], replay: false }
    }
    if (card.balance.lessThan(monto)) throw saldoInsuficiente(card.balance)
    const r = await tx.giftCard.updateMany({
      where: { id: card.id, venueId: p.venueId, balance: { gte: monto } },
      data: { balance: { decrement: monto } },
    })
    if (r.count !== 1) throw saldoInsuficiente(card.balance)
    const fila = await tx.giftCardActivity.create({
      data: { ...base, type: 'ADJUST_DECREMENT', amount: monto, balanceAfter: card.balance.minus(monto) },
      select: { id: true },
    })
    return { activityIds: [fila.id], replay: false }
  }

  if (p.op.tipo === 'BLOQUEAR') {
    if (card.status !== 'ACTIVE') {
      throw new GiftCardError(
        'GIFT_CARD_BLOCKED',
        card.status === 'BLOCKED'
          ? 'Esta tarjeta de regalo ya está bloqueada.'
          : 'Esta tarjeta de regalo no está activa: no se puede bloquear.',
        409,
      )
    }
    const r = await tx.giftCard.updateMany({ where: { id: card.id, venueId: p.venueId, status: 'ACTIVE' }, data: { status: 'BLOCKED' } })
    if (r.count !== 1) throw noEncontrada()
    const fila = await tx.giftCardActivity.create({
      data: { ...base, type: 'BLOCK', amount: CERO(), balanceAfter: card.balance },
      select: { id: true },
    })
    return { activityIds: [fila.id], replay: false }
  }

  if (p.op.tipo === 'DESBLOQUEAR') {
    if (card.status !== 'BLOCKED') throw new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta de regalo no está bloqueada.', 409)
    const ultimoBloqueo = await tx.giftCardActivity.findFirst({
      where: { venueId: p.venueId, giftCardId: card.id, type: 'BLOCK' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { reason: true },
    })
    if (ultimoBloqueo?.reason === 'CANCEL_IN_PROGRESS' && p.op.reason !== 'CANCEL_IN_PROGRESS') {
      throw new GiftCardError(
        'GIFT_CARD_BLOCKED',
        'Esta tarjeta tiene una cancelación de venta en curso: se libera desde «Cancelar venta».',
        409,
      )
    }
    const r = await tx.giftCard.updateMany({ where: { id: card.id, venueId: p.venueId, status: 'BLOCKED' }, data: { status: 'ACTIVE' } })
    if (r.count !== 1) throw noEncontrada()
    const fila = await tx.giftCardActivity.create({
      data: { ...base, type: 'UNBLOCK', amount: CERO(), balanceAfter: card.balance },
      select: { id: true },
    })
    return { activityIds: [fila.id], replay: false }
  }

  // REEMPLAZAR_CODIGO (spec § 5.7): sólo un sobre sin guardar y nunca usado. Se reemplazan código y pageToken del MISMO
  // sobre; saldo, vigencia y compra se conservan; el código anterior deja de servir.
  if (card.status !== 'ACTIVE' && card.status !== 'BLOCKED') {
    throw new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta de regalo no está activa: no se puede reponer.', 409)
  }
  if (card.customerId) {
    throw new GiftCardError(
      'GIFT_CARD_ALREADY_USED',
      'Esta tarjeta ya está guardada en la cartera de un cliente: su dueño la recupera con su teléfono.',
      409,
    )
  }
  const usos = await tx.giftCardActivity.count({ where: { venueId: p.venueId, giftCardId: card.id, type: 'REDEEM' } })
  if (usos > 0) throw new GiftCardError('GIFT_CARD_ALREADY_USED', 'Esta tarjeta ya se usó: no se puede reponer.', 409)
  const codigo = generateGiftCardCode()
  const r = await tx.giftCard.updateMany({
    where: { id: card.id, venueId: p.venueId },
    data: {
      codeHash: hashGiftCardCode(codigo.normalized),
      codeEnc: encryptGiftCardCode(codigo.normalized),
      codeLast4: codigo.last4,
      pageToken: generateOpaqueToken(),
    },
  })
  if (r.count !== 1) throw noEncontrada()
  const fila = await tx.giftCardActivity.create({
    data: { ...base, type: 'CODE_REPLACED', amount: CERO(), balanceAfter: card.balance },
    select: { id: true },
  })
  return { activityIds: [fila.id], nuevoCodigo: { display: codigo.display, last4: codigo.last4 }, replay: false }
}

/**
 * Cancelar la venta de una cuenta de tarjetas (R2): todos sus sobres deben estar BLOCKED por CANCEL_IN_PROGRESS y
 * NINGUNO puede tener un REDEEM. Los deja DEACTIVATED en saldo 0 con su DEACTIVATE ligado al reembolso.
 * Enmienda E1: con `dineroYaDevuelto` (sólo `recordRefund`: la terminal YA devolvió el dinero) no se valida R2 —rechazar
 * dejaría el dinero fuera sin asiento—: cada sobre que siga vivo (ACTIVE, BLOCKED o PENDING) pasa a DEACTIVATED con lo
 * que le quedaba. La anomalía `REFUND_WITHOUT_CANCEL` la escribe el gancho de B1.
 */
export async function desactivarSobresDeCuentaEnTx(
  tx: Tx,
  p: {
    venueId: string
    orderId: string
    refundPaymentId: string
    reason: 'SALE_CANCELLED' | 'CASHIER_ERROR' | 'ONLINE_REVOCATION'
    staffId?: string | null
    dineroYaDevuelto?: boolean
  },
): Promise<void> {
  const sobres = await tx.giftCard.findMany({
    where: { venueId: p.venueId, orderItem: { is: { orderId: p.orderId } } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_SOBRES_POR_CUENTA,
  })
  if (sobres.length === 0) throw noEncontrada()
  const bloqueados = await lockGiftCardsForUpdate(
    tx,
    sobres.map(s => s.id),
  )
  if (bloqueados.every(c => c.status === 'DEACTIVATED')) return

  if (!p.dineroYaDevuelto) {
    const usos = await tx.giftCardActivity.count({
      where: { venueId: p.venueId, giftCardId: { in: bloqueados.map(c => c.id) }, type: 'REDEEM' },
    })
    if (usos > 0)
      throw new GiftCardError('GIFT_CARD_ALREADY_USED', 'Una tarjeta de esta venta ya se usó: la venta ya no se puede cancelar.', 409)
    for (const card of bloqueados) {
      const ultimo = await tx.giftCardActivity.findFirst({
        where: { venueId: p.venueId, giftCardId: card.id, type: { in: ['BLOCK', 'UNBLOCK'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { type: true, reason: true },
      })
      if (card.status !== 'BLOCKED' || ultimo?.type !== 'BLOCK' || ultimo.reason !== 'CANCEL_IN_PROGRESS') {
        throw new GiftCardError(
          'GIFT_CARD_CANCEL_NOT_STARTED',
          'Primero inicia «Cancelar venta»: las tarjetas se bloquean antes de devolver el dinero.',
          409,
        )
      }
    }
  }
  const ahora = new Date()
  for (const card of bloqueados) {
    if (card.status === 'DEACTIVATED') continue
    const r = await tx.giftCard.updateMany({
      where: { id: card.id, venueId: p.venueId, status: card.status },
      data: { status: 'DEACTIVATED', balance: CERO(), deactivatedAt: ahora },
    })
    if (r.count !== 1) throw noEncontrada()
    await tx.giftCardActivity.create({
      data: {
        giftCardId: card.id,
        venueId: p.venueId,
        type: 'DEACTIVATE',
        amount: card.balance,
        balanceAfter: CERO(),
        reason: p.reason,
        refundPaymentId: p.refundPaymentId,
        orderId: p.orderId,
        staffId: p.staffId ?? null,
      },
    })
  }
}

/** Spec § 5.1.8: una cuenta de tarjetas que se cancela ANTES de cobrarse deja sus sobres DEACTIVATED sin activarse. */
export async function desactivarSobresPendientesDeCuentaEnTx(
  tx: Tx,
  p: { venueId: string; orderId: string; staffId?: string | null },
): Promise<{ desactivados: string[] }> {
  const pendientes = await tx.giftCard.findMany({
    where: { venueId: p.venueId, status: 'PENDING', orderItem: { is: { orderId: p.orderId } } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_SOBRES_POR_CUENTA,
  })
  if (pendientes.length === 0) return { desactivados: [] }
  const bloqueados = await lockGiftCardsForUpdate(
    tx,
    pendientes.map(s => s.id),
  )
  const ahora = new Date()
  const desactivados: string[] = []
  for (const card of bloqueados) {
    if (card.status !== 'PENDING' || card.venueId !== p.venueId) continue
    const r = await tx.giftCard.updateMany({
      where: { id: card.id, venueId: p.venueId, status: 'PENDING' },
      data: { status: 'DEACTIVATED', deactivatedAt: ahora },
    })
    if (r.count !== 1) continue
    await tx.giftCardActivity.create({
      data: {
        giftCardId: card.id,
        venueId: p.venueId,
        type: 'DEACTIVATE',
        amount: CERO(),
        balanceAfter: card.balance,
        reason: 'SALE_CANCELLED',
        orderId: p.orderId,
        staffId: p.staffId ?? null,
      },
    })
    desactivados.push(card.id)
  }
  return { desactivados }
}
