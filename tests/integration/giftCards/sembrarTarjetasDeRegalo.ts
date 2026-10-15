/**
 * Siembra de las pruebas de integración de la Parte B (tarjetas de regalo). Usa las piezas del contrato de la Parte A —código, tender,
 * activación y canje— para que la libreta nazca como en producción, en vez de inventar renglones a mano.
 *
 * 🔴 Sin limpieza de tarjetas: la libreta es de sólo inserción (trigger de A1), así que sus renglones —y los sobres y cobros a los que
 * apuntan— se quedan en la base DESECHABLE `avoqado_tarjetas_test_20261014`. Cada archivo usa su PROPIO negocio con nombre único
 * (`crearNegocioDePrueba`). 🔴 Nunca `setupTestData()`: su `teardownTestData()` borra por NOMBRE («Test Restaurant») en TODA la base,
 * y un sobre que se queda (FK `GiftCard_venueId_fkey`) le revienta la limpieza a cualquier otra suite que la use (medido en B1).
 */
import { Prisma, type Payment } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { activarSobresDeCuentaPagadaEnTx, canjearSobresEnTx, lockGiftCardsForUpdate } from '@/services/giftCards/giftCardLedger'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'

const D = (pesos: number) => new Prisma.Decimal(pesos)
const folio = (prefijo: string) => `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

/** Un negocio propio (organización, sucursal y un cajero) con nombres únicos: ninguna limpieza por nombre de otra suite lo toca. */
export async function crearNegocioDePrueba(prefijo: string): Promise<{ organizationId: string; venueId: string; staffId: string }> {
  const suf = folio(`${prefijo}-${process.pid}`)
  const organizationId = (await prisma.organization.create({ data: { name: suf, email: `${suf}@example.test`, phone: '5500000000' } })).id
  const venueId = (await prisma.venue.create({ data: { organizationId, name: suf, slug: suf } })).id
  const staffId = (
    await prisma.staff.create({ data: { email: `${suf}@staff.test`, firstName: 'Caja', lastName: 'Tarjetas', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER', active: true } })
  return { organizationId, venueId, staffId }
}

export interface VentaDeTarjetasSembrada {
  orderId: string
  giftCardIds: string[]
  pagos: Payment[]
}

/** Una cuenta de tarjetas PAGADA y con sus sobres activados por la función real de A4. */
export async function sembrarVentaDeTarjetas(p: {
  venueId: string
  organizationId: string
  staffId: string
  montos: number[]
  /** Cómo se pagó (nunca con saldo). */
  metodo: 'CASH' | 'CREDIT_CARD'
  /** Reparto del cobro; por default un solo cobro por el total. */
  cobros?: number[]
  /** Fecha del cobro (regla del mismo día). Default: ahora. */
  cobradaEn?: Date
}): Promise<VentaDeTarjetasSembrada> {
  const total = p.montos.reduce((s, m) => s + m, 0)
  const cuando = p.cobradaEn ?? new Date()
  const order = await prisma.order.create({
    data: {
      venueId: p.venueId,
      orderNumber: folio('GC'),
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'COMPLETED',
      completedAt: cuando,
      subtotal: D(total),
      taxAmount: D(0),
      tipAmount: D(0),
      total: D(total),
      paidAmount: D(total),
      remainingBalance: D(0),
      paymentStatus: 'PAID',
      contratoDePrecio: 'IVA_INCLUIDO',
      createdById: p.staffId,
      createdAt: cuando,
    },
  })
  const giftCardIds: string[] = []
  for (const monto of p.montos) {
    const codigo = generateGiftCardCode()
    const sobre = await prisma.giftCard.create({
      data: {
        venueId: p.venueId,
        organizationId: p.organizationId,
        codeHash: hashGiftCardCode(codigo.normalized),
        codeEnc: encryptGiftCardCode(codigo.normalized),
        codeLast4: codigo.last4,
        pageToken: generateOpaqueToken(),
        initialAmount: D(monto),
        balance: D(0),
        status: 'PENDING',
        termsVersion: '2026-10-14',
        deliveryChannel: 'HANDED_TO_BUYER',
      },
    })
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: null,
        productName: 'Tarjeta de regalo',
        quantity: 1,
        unitPrice: D(monto),
        taxAmount: D(0),
        total: D(monto),
        ivaTratamiento: 'NO_OBJETO',
        giftCardId: sobre.id,
      },
    })
    giftCardIds.push(sobre.id)
  }
  const pagos: Payment[] = []
  for (const monto of p.cobros ?? [total]) {
    pagos.push(
      await prisma.payment.create({
        data: {
          venueId: p.venueId,
          orderId: order.id,
          amount: D(monto),
          tipAmount: D(0),
          netAmount: D(monto),
          feePercentage: 0,
          feeAmount: D(0),
          method: p.metodo,
          status: 'COMPLETED',
          type: 'REGULAR',
          splitType: 'FULLPAYMENT',
          source: p.metodo === 'CASH' ? 'POS' : 'TPV',
          fundsFlow: p.metodo === 'CASH' ? 'CASH_DRAWER' : 'AVOQADO_PROCESSED',
          processedById: p.staffId,
          createdAt: cuando,
        },
      }),
    )
  }
  await prisma.$transaction(async tx => {
    await lockExistingOrderForPayment(tx, { venueId: p.venueId, orderId: order.id })
    await activarSobresDeCuentaPagadaEnTx(tx, { venueId: p.venueId, orderId: order.id, staffId: p.staffId })
  }, ORDER_LOCK_WAIT_BUDGET)
  const activos = await prisma.giftCard.findMany({
    where: { id: { in: giftCardIds } },
    select: { status: true, balance: true, initialAmount: true },
    take: giftCardIds.length,
  })
  if (activos.some(s => s.status !== 'ACTIVE' || !s.balance.equals(s.initialAmount))) {
    throw new Error('La siembra esperaba sobres ACTIVE con balance = initialAmount después de activar (convención de A4).')
  }
  return { orderId: order.id, giftCardIds, pagos }
}

/** Una cuenta de mercancía SIN pagar (para cobrarla con saldo dentro de una transacción de la prueba). */
export async function crearCuentaDeMercancia(p: { venueId: string; staffId: string; total: number }): Promise<{ orderId: string }> {
  const order = await prisma.order.create({
    data: {
      venueId: p.venueId,
      orderNumber: folio('MERC'),
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'PENDING',
      subtotal: D(p.total),
      taxAmount: D(0),
      tipAmount: D(0),
      total: D(p.total),
      paidAmount: D(0),
      remainingBalance: D(p.total),
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      createdById: p.staffId,
      items: { create: { productName: 'Playera', quantity: 1, unitPrice: D(p.total), taxAmount: D(0), total: D(p.total) } },
    },
  })
  return { orderId: order.id }
}

/** El `Payment` de un cobro con saldo, con el tender de sistema y su forma SAT 01 (como lo escribe A8). */
export async function crearCobroConSaldoEnTx(
  tx: Prisma.TransactionClient,
  p: { venueId: string; orderId: string; monto: number; staffId: string },
): Promise<Payment> {
  const tender = await ensureGiftCardTender(tx, p.venueId)
  return tx.payment.create({
    data: {
      venueId: p.venueId,
      orderId: p.orderId,
      amount: D(p.monto),
      tipAmount: D(0),
      netAmount: D(p.monto),
      feePercentage: 0,
      feeAmount: D(0),
      method: 'OTHER',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'CUSTOMAMOUNT',
      source: 'POS',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: tender.id,
      tenderRevision: tender.revision,
      tenderLabel: 'Tarjeta de regalo',
      tenderCountsAsCash: false,
      tenderCaptureTip: true,
      tenderSatFormaPago: '01',
      processedById: p.staffId,
    },
  })
}

/** Una cuenta de mercancía pagada con saldo (y, si se pide, el resto en efectivo), canjeada con la función real de A4. */
export async function sembrarCanje(p: {
  venueId: string
  staffId: string
  giftCardIds: string[]
  total: number
  conSaldo: number
  restoEnEfectivo?: number
}): Promise<{ orderId: string; pagoConSaldo: Payment; pagoEnEfectivo: Payment | null }> {
  const resto = p.restoEnEfectivo ?? 0
  if (p.conSaldo + resto !== p.total) throw new Error('La siembra sólo arma cuentas pagadas completas.')
  const { orderId } = await crearCuentaDeMercancia({ venueId: p.venueId, staffId: p.staffId, total: p.total })
  // El tender se asegura con el cliente GLOBAL, fuera de la transacción de dinero (contrato de `ensureGiftCardTender`: su `create`
  // puede chocar en una carrera). Adentro sólo se vuelve a leer.
  await ensureGiftCardTender(prisma, p.venueId)
  return prisma.$transaction(async tx => {
    await lockExistingOrderForPayment(tx, { venueId: p.venueId, orderId })
    const cards = await lockGiftCardsForUpdate(tx, p.giftCardIds)
    const pagoConSaldo = await crearCobroConSaldoEnTx(tx, { venueId: p.venueId, orderId, monto: p.conSaldo, staffId: p.staffId })
    await canjearSobresEnTx(tx, {
      venueId: p.venueId,
      orderId,
      paymentId: pagoConSaldo.id,
      amount: D(p.conSaldo),
      cards,
      staffId: p.staffId,
    })
    const pagoEnEfectivo =
      resto > 0
        ? await tx.payment.create({
            data: {
              venueId: p.venueId,
              orderId,
              amount: D(resto),
              tipAmount: D(0),
              netAmount: D(resto),
              feePercentage: 0,
              feeAmount: D(0),
              method: 'CASH',
              status: 'COMPLETED',
              type: 'REGULAR',
              splitType: 'CUSTOMAMOUNT',
              source: 'POS',
              fundsFlow: 'CASH_DRAWER',
              processedById: p.staffId,
            },
          })
        : null
    await tx.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: D(p.total), remainingBalance: D(0), completedAt: new Date() },
    })
    return { orderId, pagoConSaldo, pagoEnEfectivo }
  }, ORDER_LOCK_WAIT_BUDGET)
}
