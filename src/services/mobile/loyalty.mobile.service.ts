import { bloquearCuentaParaEditar } from '../shared/cuentaCancelada'
/**
 * Loyalty for the mobile POS ("Recompensas" in the check panel).
 *
 * The loyalty ENGINE already lives in `dashboard/loyalty.dashboard.service.ts`
 * (config, earn, balance, expiry) and is reused here — this module only adds
 * what the POS needs and what the dashboard path never did:
 *
 * 🔴 MONEY: redeeming points MUST move money on the check in the SAME
 * transaction that burns the points. The dashboard's `redeemPoints` only
 * decrements the balance and returns an amount for someone else to apply, so a
 * caller that forgets leaves the customer with fewer points and no discount.
 * Here the REDEEM transaction and its OrderDiscount are created together and
 * linked (OrderDiscount.loyaltyTransactionId), so the reverse is symmetric:
 * removing that discount always refunds the points.
 */

import { LoyaltyTransactionType, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { getOrCreateLoyaltyConfig } from '../dashboard/loyalty.dashboard.service'
import { ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import { assertCardOrderMoneyFrozenInTx } from '../online-ordering/card/guards'
import { rechazarSiEsImportada } from '../shared/ordenImportada'
import { rechazarSiEsCuentaDeTarjetas } from '../giftCards/cuentaDeTarjetas'
import { comoJson, nuevoRepartoDeCuenta } from '../shared/repartoDescuento'
import { conservarDescuentoHistorico } from '../shared/repartoDescuentoTx'

/** Rounds to cents the way every other money path here does. */
function money(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * La regla del canje de puntos (la usa `redeemPointsToOrderInTransaction`, y la cotización de la tienda para decir cuántos se
 * usarían de verdad): el valor de `puntos` topado a lo que queda por descontar (`base` = subtotal − descuentos); si se topó, sólo se
 * queman los que se usan (`puntosQueCubren`). `monto` 0 = el canje lo rechaza.
 */
export function puntosQueSeCanjean(puntos: number, valorPorPunto: number, base: number): { puntos: number; monto: number } {
  const rawValue = money(puntos * valorPorPunto)
  // 🔴 Tope contra la BASE (subtotal − descuentos), NO contra total: el total incluye cobros por servicio que el descuento no puede
  // compensar — topar contra total quemaría puntos sin bajar la cuenta (auditoría 2026-07-18).
  const monto = money(Math.min(rawValue, Math.max(0, base)))
  // If the value was capped, only burn the points actually used.
  return { puntos: monto < rawValue && valorPorPunto > 0 ? puntosQueCubren(monto, valorPorPunto, puntos) : puntos, monto }
}

/**
 * D2 (12-nov): los MENOS puntos cuyo valor a centavos (`money(p × valor)`, como lo valora el canje) cubre `monto`, sin pasar de
 * `maximo`. `⌈monto / valor⌉` en flotante se pasaba: $0.14 a $0.01 por punto = ⌈14.000000000000002⌉ = 15 y la clienta perdía un punto.
 */
export function puntosQueCubren(monto: number, valorPorPunto: number, maximo: number): number {
  if (!(valorPorPunto > 0) || !(monto > 0) || maximo <= 0) return 0
  let p = Math.min(maximo, Math.max(0, Math.ceil(monto / valorPorPunto)))
  while (p > 0 && money((p - 1) * valorPorPunto) >= monto) p--
  while (p < maximo && money(p * valorPorPunto) < monto) p++
  return p
}

/** Código del candado de la oferta (409). */
export const OFERTA_DE_CANJE_CAMBIO = 'LOYALTY_OFFER_CHANGED'

/**
 * Candado de la oferta (D18, 12-nov): quien manda el monto que enseñó (`expectedDiscountAmount`) sólo canjea exactamente eso. Si la
 * cuenta cambió, este 409 dice la oferta de ahora y no se quema nada. Hereda de `BadRequestError` a propósito: la operación HTTP
 * (`executeHttpOperation`) guarda los rechazos de dominio como resultado final (`DomainRejected`) y conserva este 409.
 */
export class OfertaDeCanjeCambio extends BadRequestError {
  constructor(puntos: number, monto: number) {
    super(
      `La cuenta cambió: ahora se canjearían ${puntos} puntos por $${monto.toFixed(2)}. Revisa los puntos y vuelve a canjear.`,
      OFERTA_DE_CANJE_CAMBIO,
      { pointsRedeemable: puntos, discountAmount: monto },
    )
    this.statusCode = 409
  }
}

/**
 * 🔴 `LoyaltyTransaction.createdById` and `OrderDiscount.appliedById` FK to
 * StaffVenue.id, but the mobile auth context carries a Staff.id. Writing the
 * Staff.id straight through raises P2003 and rolls the WHOLE redemption back —
 * points and discount silently never persist. Resolve the row first; if the
 * caller has no assignment to this venue we store null rather than fail: the
 * audit attribution is nice to have, the money movement is not optional.
 */
async function resolveStaffVenueId(
  db: Pick<Prisma.TransactionClient, 'staffVenue'>,
  venueId: string,
  staffId?: string,
): Promise<string | undefined> {
  if (!staffId) return undefined
  const sv = await db.staffVenue.findUnique({
    where: { staffId_venueId: { staffId, venueId } },
    select: { id: true },
  })
  return sv?.id
}

/**
 * hz:ce654971:D18 (Codex r1): los puntos MÁS que se pueden ofrecer sin que el canje los tope: el mayor `p ≤ saldo` cuyo valor, redondeado
 * a centavos como lo redondea el canje (`money`), no pasa de `valor`. Un `floor(valor / tasa)` se queda corto con tasas como 0.0149
 * (101 × 0.0149 = 1.5049 → $1.50 sí cabe en $1.50) y, en flotante, con 0.3 / 0.1 = 2.9999999999999996. Y de esos, el mayor cuya
 * cifra en la pantalla del POS no promete más de lo que el canje descuenta (puede quedar bajo el mínimo: el botón se apaga).
 */
export function puntosQueCaben(valor: number, valorPorPunto: number, saldo: number): number {
  if (!(valorPorPunto > 0) || !(valor > 0) || saldo <= 0) return 0
  let p = Math.min(saldo, Math.max(0, Math.ceil((valor + 0.005) / valorPorPunto) - 1))
  while (p > 0 && money(p * valorPorPunto) > valor) p--
  while (p < saldo && money((p + 1) * valorPorPunto) <= valor) p++
  // Codex r2/r3: el POS arranca en este número y pinta `puntos × tasa` con `%.2f`, que redondea el decimal escrito; el canje
  // redondea el binario. En un empate de medio centavo pueden diferir en 1 centavo hacia los dos lados (50 × 0.0201: pinta $1.01 y
  // descuenta $1.00; 250 × 0.0059: pinta $1.47 y descuenta $1.48). Se baja cuando la pantalla prometería MÁS de lo que se
  // descuenta, también por debajo del mínimo del negocio (12-nov): con la regla B (`minimoParaCanjear`) ese número honesto pasa a
  // ser el mínimo de la cuenta, en vez de pintar un centavo que no se descuenta. De menos en pantalla se deja: el cliente recibe el centavo. (La pantalla de ANDROID es la que debe
  // redondear como el canje: tarjeta aparte en el pizarrón.)
  while (p > 0 && comoLoPintaElPos(p * valorPorPunto) > money(p * valorPorPunto)) p--
  return p
}

/**
 * Regla «B · todo lo que queda» (founder, 12-nov, hz:ce654971:D18): el mínimo de puntos para canjear en ESTA cuenta. Si el saldo
 * llega al mínimo del negocio pero la cuenta vale menos que ese mínimo, el mínimo es lo que la llena (los puntos que se ofrecen,
 * `puntosQueCaben`): la clienta paga con puntos toda la cuenta, como ya pasaba cuando el canje recortaba, y la pantalla dice lo que
 * se descuenta. El mínimo del negocio sólo evita canjes chiquitos cuando la cuenta da para más. Una sola regla para lo que ofrece la
 * caja (`getCustomerLoyalty`), el canje y la vista previa del MCP.
 */
export function minimoParaCanjear(minNegocio: number, saldo: number, valorPorPunto: number, base: number): number {
  if (saldo < minNegocio) return minNegocio
  // Sólo cuando es la CUENTA la que no da para el mínimo (los puntos del mínimo valen más de lo que queda por descontar). Si lo que
  // limita es el saldo o un empate de centavo en pantalla, el mínimo no baja (Codex r3 #1: cuenta de $100, saldo justo de 50).
  // A centavos los dos lados (Codex r4 #1: $1.13 − $0.13 = 0.9999999999999999 en flotante, y $1.00 del mínimo sí cabe).
  if (money(minNegocio * valorPorPunto) <= money(base)) return minNegocio
  const llenan = puntosQueCaben(puntosQueSeCanjean(saldo, valorPorPunto, base).monto, valorPorPunto, saldo)
  return llenan > 0 ? Math.min(minNegocio, llenan) : minNegocio
}

/** `String.format("%.2f", x)` de ANDROID (`RewardsDialog`): redondea a la mitad hacia arriba el decimal más corto que escribe `x`. */
function comoLoPintaElPos(x: number): number {
  return new Prisma.Decimal(String(x)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
}

/** D650: el texto con el que el canje, la caja y la previa del MCP rechazan a un cliente que no está en la cuenta. */
export const CLIENTE_FUERA_DE_LA_CUENTA = 'Este cliente no está en esta cuenta: agrégalo a la cuenta antes de canjear sus puntos.'

/**
 * D650 (Codex android r5 #1): ¿el cliente está en ESTA cuenta? Es su cliente (`Order.customerId`, lo que pone el POS) o tiene su liga
 * (`OrderCustomer`, lo que pone la TPV, varios por cuenta). Sin esto, una caja que volvió de estar sin red con el cliente viejo
 * quemaba sus puntos en la cuenta que otra caja ya había pasado a otro cliente.
 */
async function estaEnLaCuenta(
  db: Pick<Prisma.TransactionClient, 'orderCustomer'>,
  orderId: string,
  clienteDeLaCuenta: string | null,
  customerId: string,
): Promise<boolean> {
  if (clienteDeLaCuenta === customerId) return true
  return !!(await db.orderCustomer.findUnique({ where: { orderId_customerId: { orderId, customerId } }, select: { id: true } }))
}

/**
 * Lo que el canje haría con `puntos` sobre la cuenta que describe `vista` (la respuesta de `getCustomerLoyalty`), sin escribir: la
 * vista previa del MCP. Las mismas negativas que el canje (mínimo, saldo) y la misma regla (`puntosQueSeCanjean`) contra el tope de
 * la vista, que para `puntos ≤ saldo` es la base del canje.
 */
export function previaDelCanje(
  puntos: number,
  vista: { balance: number; redemptionRate: number; minPointsRedeem: number; maxRedeemableValue: number },
): { ok: true; puntos: number; monto: number } | { ok: false; error: string } {
  if (puntos < vista.minPointsRedeem) return { ok: false, error: `Se requieren al menos ${vista.minPointsRedeem} puntos para canjear` }
  if (puntos > vista.balance) return { ok: false, error: `Puntos insuficientes: el cliente tiene ${vista.balance}` }
  const r = puntosQueSeCanjean(puntos, vista.redemptionRate, vista.maxRedeemableValue)
  if (r.monto <= 0) return { ok: false, error: 'El canje no genera descuento sobre esta cuenta' }
  return { ok: true, ...r }
}

/**
 * La vista previa del MCP (`redeem_loyalty_on_check`) sobre una cuenta: las negativas del canje que no dependen de escribir (programa
 * apagado, cuenta que no existe, anulada o ya pagada; luego mínimo, saldo y sin descuento) con sus mismos textos, y la cifra con
 * `previaDelCanje`. Lo que el canje revisa además bajo candado (importada, cuenta de tarjetas, pedido con tarjeta apartada) lo
 * contesta él al confirmar.
 */
export async function previaDelCanjeEnCuenta(
  venueId: string,
  customerId: string,
  orderId: string,
  puntos: number,
): Promise<
  { ok: true; puntos: number; monto: number; vista: Awaited<ReturnType<typeof getCustomerLoyalty>> } | { ok: false; error: string }
> {
  const vista = await getCustomerLoyalty(venueId, customerId, orderId)
  const cuenta = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { status: true, paymentStatus: true, customerId: true },
  })
  if (!cuenta) return { ok: false, error: 'Orden no encontrada' }
  if (cuenta.status === 'CANCELLED' || cuenta.status === 'DELETED') {
    return { ok: false, error: 'Esta venta está cancelada: no se pueden canjear puntos.' }
  }
  if (cuenta.paymentStatus === 'PAID' || cuenta.paymentStatus === 'PARTIAL') {
    return { ok: false, error: 'No se puede modificar una orden ya pagada' }
  }
  if (!(await estaEnLaCuenta(prisma, orderId, cuenta.customerId, customerId))) return { ok: false, error: CLIENTE_FUERA_DE_LA_CUENTA }
  if (!vista.active) return { ok: false, error: 'El programa de lealtad no está activo en esta sucursal' }
  const r = previaDelCanje(puntos, vista)
  return r.ok ? { ...r, vista } : r
}

/**
 * Balance + program rules for the customer attached to a check, plus how much
 * the POS may redeem RIGHT NOW against this order.
 *
 * 🔴 hz:ce654971:D18: el tope usa la MISMA regla (`puntosQueSeCanjean`) y la MISMA base que el canje
 * (`redeemPointsToOrderInTransaction`): subtotal − descuentos, NUNCA `order.total` (que trae cargos por servicio y el IVA que va
 * aparte). Con el total, la caja ofrecía puntos que el canje no iba a usar.
 */
export async function getCustomerLoyalty(venueId: string, customerId: string, orderId?: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, firstName: true, lastName: true, loyaltyPoints: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const config = await getOrCreateLoyaltyConfig(venueId)
  const redemptionRate = Number(config.redemptionRate)
  const balance = customer.loyaltyPoints

  // Lo que el canje puede descontar en esta cuenta: la misma base que lee `redeemPointsToOrderInTransaction`.
  let redeemableBase: number | null = null
  if (orderId) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, venueId },
      select: { subtotal: true, discountAmount: true, status: true, paymentStatus: true, customerId: true },
    })
    // Codex r4: una cuenta con abono, pagada o anulada no admite canjes (el canje la rechaza): no hay nada que ofrecer en ella.
    // D650: tampoco a un cliente que no está en la cuenta (otra caja ya la pasó a otro cliente).
    const admiteCanje =
      order !== null &&
      order.status !== 'CANCELLED' &&
      order.status !== 'DELETED' &&
      order.paymentStatus !== 'PAID' &&
      order.paymentStatus !== 'PARTIAL' &&
      (await estaEnLaCuenta(prisma, orderId, order.customerId, customerId))
    redeemableBase = order ? (admiteCanje ? Math.max(0, Number(order.subtotal) - Number(order.discountAmount || 0)) : 0) : null
  }

  const balanceValue = money(balance * redemptionRate)
  const maxRedeemableValue = redeemableBase === null ? balanceValue : puntosQueSeCanjean(balance, redemptionRate, redeemableBase).monto
  // Points that produce that value — never more than the customer owns, and never more than the canje would use: with these points
  // the canje is not capped, so it discounts `money(points × rate)` and burns exactly them.
  const maxRedeemablePoints = puntosQueCaben(maxRedeemableValue, redemptionRate, balance)
  // Regla B: en una cuenta más chica que el mínimo, el mínimo es lo que la llena. Va en el MISMO campo `minPointsRedeem` (otro valor,
  // no otro campo): las apps viejas muestran [mínimo, máximo] = [lo que llena, lo que llena] y mandan ese número, que el canje acepta.
  const minimo =
    redeemableBase === null ? config.minPointsRedeem : minimoParaCanjear(config.minPointsRedeem, balance, redemptionRate, redeemableBase)

  return {
    customerId: customer.id,
    customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || null,
    active: config.active,
    balance,
    pointsPerDollar: Number(config.pointsPerDollar),
    redemptionRate,
    minPointsRedeem: minimo,
    balanceValue,
    maxRedeemablePoints,
    maxRedeemableValue,
    // Codex r5: con mínimo 0, «0 puntos» no es un canje (el canje exige un entero positivo).
    canRedeem: config.active && balance >= config.minPointsRedeem && maxRedeemablePoints >= minimo && maxRedeemablePoints > 0,
  }
}

/**
 * Redeem points onto an OPEN check: burns the points and applies the matching
 * discount atomically, then recalculates the order the same way cortesía and
 * catalog discounts do.
 *
 * 🔴 Order lock FIRST (before the Customer burn), cap/base from the locked read, and
 * burn + discount + totals in ONE transaction: a failure after the burn gives the
 * points back with the rollback, and a concurrent writer can never interleave
 * between the discount and the totals.
 */
export async function redeemPointsToOrderInTransaction(
  tx: TxConReintento,
  venueId: string,
  orderId: string,
  customerId: string,
  points: number,
  staffId?: string,
  config?: Awaited<ReturnType<typeof getOrCreateLoyaltyConfig>>,
  /** El monto que enseñó quien canjea (la tablet, la previa del MCP). Con él, sólo se canjea exactamente eso (candado de la oferta). */
  montoEsperado?: number,
) {
  if (!Number.isInteger(points) || points <= 0) {
    throw new BadRequestError('points debe ser un entero positivo')
  }
  const { recalculateOrderTotals } = await import('./comp-item.mobile.service')
  if (!(await bloquearCuentaParaEditar(tx, { venueId, orderId }))) throw new NotFoundError('Orden no encontrada')
  // Pedidos en línea fase 2: un pedido de tarjeta sin cobrar tiene un total fijo (el de la tarjeta apartada).
  await assertCardOrderMoneyFrozenInTx(tx, { venueId, orderId })
  const order = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      total: true,
      subtotal: true,
      discountAmount: true,
      paymentStatus: true,
      paidAmount: true,
      originSystem: true,
      status: true,
      customerId: true,
    },
  })
  if (!order) throw new NotFoundError('Orden no encontrada')
  // 🔴 LEALTAD (hz:a8104ac8:D1, Codex r1 #2): una venta anulada ya devolvió sus puntos y es final; no recibe canjes nuevos.
  if (order.status === 'CANCELLED' || order.status === 'DELETED') {
    throw new BadRequestError('Esta venta está cancelada: no se pueden canjear puntos.')
  }
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(order)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'canje de puntos')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError('No se puede modificar una orden ya pagada')
  }
  // D650: sólo los puntos de un cliente que está en la cuenta, leído bajo su candado (tomado arriba).
  if (!(await estaEnLaCuenta(tx, orderId, order.customerId, customerId))) throw new BadRequestError(CLIENTE_FUERA_DE_LA_CUENTA)

  const effectiveConfig = config ?? (await getOrCreateLoyaltyConfig(venueId, tx))
  if (!effectiveConfig.active) throw new BadRequestError('El programa de lealtad no está activo en esta sucursal')
  if (points < effectiveConfig.minPointsRedeem) {
    // Regla B (`minimoParaCanjear`): abajo del mínimo del negocio sólo pasa lo que llena una cuenta más chica que ese mínimo, con el
    // saldo y la base leídos bajo el candado de la cuenta (lo mismo que la caja ofreció).
    const saldo = (await tx.customer.findFirst({ where: { id: customerId, venueId }, select: { loyaltyPoints: true } }))?.loyaltyPoints ?? 0
    const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount || 0))
    const minimo = minimoParaCanjear(effectiveConfig.minPointsRedeem, saldo, Number(effectiveConfig.redemptionRate), base)
    if (points < minimo) throw new BadRequestError(`Se requieren al menos ${minimo} puntos para canjear`)
  }

  const customer = await tx.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, loyaltyPoints: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')
  if (customer.loyaltyPoints < points) {
    throw new BadRequestError(`Puntos insuficientes: el cliente tiene ${customer.loyaltyPoints}`)
  }

  const redemptionRate = Number(effectiveConfig.redemptionRate)
  const redeemableBase = Math.max(0, Number(order.subtotal) - Number(order.discountAmount || 0))
  const { monto: discountAmount, puntos: pointsToBurn } = puntosQueSeCanjean(points, redemptionRate, redeemableBase)
  if (discountAmount <= 0) {
    throw new BadRequestError('El canje no genera descuento sobre esta cuenta')
  }
  // Candado de la oferta (D18, 12-nov): con lo que se enseñó, la cuenta (leída bajo su candado) tiene que dar exactamente eso; si no,
  // nada se quema y el 409 dice la oferta de ahora. Sin el monto (apps viejas, tienda, panel), recorta como siempre.
  if (montoEsperado !== undefined && (pointsToBurn !== points || discountAmount !== money(montoEsperado))) {
    throw new OfertaDeCanjeCambio(pointsToBurn, discountAmount)
  }

  const staffVenueId = await resolveStaffVenueId(tx, venueId, staffId)

  const transaction = await tx.loyaltyTransaction.create({
    data: {
      customerId,
      type: LoyaltyTransactionType.REDEEM,
      points: -pointsToBurn,
      orderId,
      reason: `Canje de ${pointsToBurn} puntos por $${discountAmount.toFixed(2)} de descuento`,
      createdById: staffVenueId,
    },
  })

  // 🔴 Carrera de doble canje: el saldo leído arriba no reserva nada, así que el
  // decremento debe ser CONDICIONAL — dos canjes concurrentes (sobre órdenes
  // distintas) no pueden quemar los mismos puntos (auditoría 2026-07-18).
  // Codex r3 #2 / r4 #2: canjear exige un saldo de al menos el mínimo del negocio, también en el instante de quemar: si otra caja ya
  // gastó parte (dos cuentas a la vez, con la regla B o con una petición grande que el canje recorta), la quema no encuentra la fila y
  // se rechaza aquí, igual que en fila. Nunca exige más que la fila: en fila, este canje ya pedía saldo ≥ puntos pedidos ≥ ese mínimo.
  const saldoParaQuemar = Math.max(pointsToBurn, effectiveConfig.minPointsRedeem)
  const burned = await tx.customer.updateMany({
    where: { id: customerId, loyaltyPoints: { gte: saldoParaQuemar } },
    data: { loyaltyPoints: { decrement: pointsToBurn } },
  })
  if (burned.count === 0) {
    throw new BadRequestError('Puntos insuficientes (otro canje se procesó al mismo tiempo)')
  }

  const balance = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true } })
  const newBalance = balance.loyaltyPoints

  // Codex r1 P1: lo que la cabecera trae fuera de toda fila (orden anterior a B2…) queda en su fila antes de crear ésta.
  await conservarDescuentoHistorico(tx, orderId, order.discountAmount)
  const row = await tx.orderDiscount.create({
    data: {
      orderId,
      type: 'FIXED_AMOUNT',
      name: `Recompensas — ${pointsToBurn} puntos`,
      value: new Prisma.Decimal(discountAmount),
      amount: new Prisma.Decimal(discountAmount),
      isManual: true,
      appliedById: staffVenueId,
      loyaltyTransactionId: transaction.id,
      // B2: fijo topado a subtotal − descuentos (con promociones) ⇒ fila de CUENTA; el recálculo de abajo la reparte.
      reparto: comoJson(nuevoRepartoDeCuenta({ conPromociones: true })),
    },
  })

  const totals = await recalculateOrderTotals(orderId, 0, Number(order.paidAmount || 0), tx)
  return { pointsToBurn, discountAmount, newBalance, transaction, row, totals }
}

export async function redeemPointsToOrder(
  venueId: string,
  orderId: string,
  customerId: string,
  points: number,
  staffId?: string,
  montoEsperado?: number,
) {
  if (!Number.isInteger(points) || points <= 0) {
    throw new BadRequestError('points debe ser un entero positivo')
  }

  // Venue configuration is not Order data: read before the lock; its checks keep their original order below.
  const config = await getOrCreateLoyaltyConfig(venueId)
  const { pointsToBurn, discountAmount, newBalance, totals } = await withDeadlockRetry(
    tx => redeemPointsToOrderInTransaction(tx, venueId, orderId, customerId, points, staffId, config, montoEsperado),
    { etiqueta: 'redeemPointsToOrder', ...ORDER_LOCK_WAIT_BUDGET },
  )

  void (await import('../dashboard/activity-log.service')).logAction({
    action: 'LOYALTY_POINTS_REDEEMED',
    entity: 'Order',
    entityId: orderId,
    staffId,
    venueId,
    data: { customerId, points: pointsToBurn, discountAmount },
  })

  return {
    pointsRedeemed: pointsToBurn,
    discountAmount,
    newBalance,
    order: totals,
  }
}

/**
 * Refunds the points behind an OrderDiscount that came from a redemption.
 * Runs INSIDE the caller's transaction so the discount row and the points move
 * together. No-op for ordinary discounts.
 */
export async function refundLoyaltyForOrderDiscount(
  tx: TxConReintento,
  venueId: string,
  row: { id: string; loyaltyTransactionId: string | null },
  staffId?: string,
): Promise<{ pointsRefunded: number; customerId: string; transactionId: string } | null> {
  if (!row.loyaltyTransactionId) return null

  // Same FK caveat as the redeem path (see resolveStaffVenueId).
  const sv = staffId
    ? await tx.staffVenue.findUnique({
        where: { staffId_venueId: { staffId, venueId } },
        select: { id: true },
      })
    : null

  const original = await tx.loyaltyTransaction.findUnique({
    where: { id: row.loyaltyTransactionId },
    select: { id: true, customerId: true, points: true, orderId: true },
  })
  if (!original) return null

  const pointsRefunded = Math.abs(original.points)

  const adjustment = await tx.loyaltyTransaction.create({
    data: {
      customerId: original.customerId,
      type: LoyaltyTransactionType.ADJUST,
      points: pointsRefunded,
      orderId: original.orderId,
      reason: `Devolución de ${pointsRefunded} puntos (se quitó la recompensa de la cuenta)`,
      createdById: sv?.id,
    },
  })

  await tx.customer.update({
    where: { id: original.customerId },
    data: { loyaltyPoints: { increment: pointsRefunded } },
  })

  return { pointsRefunded, customerId: original.customerId, transactionId: adjustment.id }
}
