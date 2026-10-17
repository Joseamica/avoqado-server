/**
 * Siembra de PRUEBA para el cuadre al centavo del MCP con tarjetas de regalo (auditoría r1 C-1): un negocio con dos tarjetas
 * cargadas (una cancelada y devuelta el mismo día), un cobro con saldo con propina, su reverso parcial y efectivo normal, todo el
 * 12-oct-2026 en la zona del negocio. Así `mcp-money-reconcile.ts` cuadra cifras de verdad, no sólo ceros. Auditoría r2 #3: un
 * cobro en efectivo a las 23:55 hora del negocio (05:55 UTC del 13) debe caer en el día 12; un `Date` suelto lo sacaría.
 * ⭐ (C5 menor 1) Las dos reglas de B5 r1 y la frontera del resumen: una cuenta de tarjetas PARTIAL con un abono de $200 (dinero en
 * gross CASH; ni venta en net ni carga en giftCardLoads), un REFUND sobre una carga PAGADA que no se canceló (resta en el dinero y
 * no cuenta como carga) y una tarjeta activada a las 23:55 del negocio (su libreta cae en el día 12).
 * 🔴 Sólo en la base desechable de integración: aborta si `current_database()` no es `avoqado_tarjetas_test_20261014`.
 * Escribe las filas con Prisma, sin pasar por los servicios (lo que se mide aquí es el CUADRE, no el cobro: el cobro lo prueban
 * las integraciones de A y B). Imprime el venueId en la última línea.
 *
 *   DATABASE_URL="$TEST_DATABASE_URL" DOTENV_CONFIG_PATH=/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.env \
 *     npx tsx -r dotenv/config scripts/sembrar-cuadre-tarjetas.ts
 */
import { randomUUID } from 'crypto'
import { Prisma, type GiftCardActivityType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'

const BASE_PERMITIDA = 'avoqado_tarjetas_test_20261014'
const D = (v: number) => new Prisma.Decimal(v)
/** 12-oct-2026 a la `hora` LOCAL del negocio (CDMX, UTC-6 todo el año). */
const el12 = (hora: string) => new Date(`2026-10-12T${hora}:00-06:00`)

async function main() {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db')
  if (db !== BASE_PERMITIDA) throw new Error(`Sólo siembro en ${BASE_PERMITIDA}; esta conexión es ${db}. No se escribió nada.`)

  const stamp = `${Date.now()}${process.pid}`
  const organizationId = (
    await prisma.organization.create({
      data: { name: `cuadre-gc-${stamp}`, email: `cuadre-gc-${stamp}@example.test`, phone: '5550000000' },
    })
  ).id
  // TRIAL = negocio de demostración: exento de candados de plan (las herramientas de ventas del MCP piden ADVANCED_REPORTS),
  // igual que el negocio por defecto del cuadre.
  const venueId = (
    await prisma.venue.create({
      data: { name: `cuadre-gc-${stamp}`, slug: `cuadre-gc-${stamp}`, organizationId, timezone: 'America/Mexico_City', status: 'TRIAL' },
    })
  ).id
  const staffId = (await prisma.staff.create({ data: { email: `cuadre-gc-${stamp}@example.test`, firstName: 'Caja', lastName: 'Cuadre' } }))
    .id
  const tender = await ensureGiftCardTender(prisma, venueId)

  let n = 0
  const sobre = (
    datos: Pick<Prisma.GiftCardUncheckedCreateInput, 'initialAmount' | 'balance' | 'status' | 'activatedAt' | 'deactivatedAt'>,
  ) => {
    n++
    return prisma.giftCard.create({
      data: {
        venueId,
        organizationId,
        codeHash: `cuadre-${stamp}-${n}`,
        codeEnc: 'no-se-descifra-en-el-cuadre',
        codeLast4: `Q${String(n).padStart(3, '0')}`,
        pageToken: `cuadre-page-${stamp}-${n}`,
        termsVersion: '2026-10-14',
        deliveryChannel: 'PRINTED',
        ...datos,
      },
    })
  }
  // `estado`: la cuenta de tarjetas PAGADA es la que carga (B5 r1, `WHERE_CUENTA_DE_TARJETAS_PAGADA`); la devuelta entera queda
  // CANCELLED con `paymentStatus` PAID, como la deja B2 (ningún reembolso escribe `paymentStatus`).
  const orden = async (
    total: number,
    giftCardId?: string,
    estado: Pick<Prisma.OrderUncheckedCreateInput, 'status' | 'paymentStatus' | 'remainingBalance'> = {},
  ) => {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `cuadre-${randomUUID()}`,
        source: 'TPV',
        createdById: staffId,
        subtotal: D(total),
        taxAmount: D(0),
        total: D(total),
        remainingBalance: D(0),
        ...estado,
      },
    })
    const renglonDeCuenta = giftCardId
      ? { productName: 'Tarjeta de regalo', ivaTratamiento: 'NO_OBJETO' as const, giftCardId }
      : { productName: 'Mercancía de prueba' }
    await prisma.orderItem.create({
      data: { orderId: o.id, quantity: 1, unitPrice: D(total), taxAmount: D(0), total: D(total), ...renglonDeCuenta },
    })
    return o.id
  }
  const pago = (orderId: string, amount: number, extra: Partial<Prisma.PaymentUncheckedCreateInput>) =>
    prisma.payment.create({
      data: {
        venueId,
        orderId,
        amount: D(amount),
        method: 'CASH',
        status: 'COMPLETED',
        feePercentage: D(0),
        feeAmount: D(0),
        netAmount: D(amount),
        processedById: staffId,
        ...extra,
      },
    })
  const renglon = (
    giftCardId: string,
    type: GiftCardActivityType,
    amount: number,
    balanceAfter: number,
    createdAt: Date,
    extra: Partial<Prisma.GiftCardActivityUncheckedCreateInput> = {},
  ) =>
    prisma.giftCardActivity.create({
      data: { giftCardId, venueId, type, amount: D(amount), balanceAfter: D(balanceAfter), createdAt, staffId, ...extra },
    })

  // 1) Carga de $1,000 en efectivo: el sobre A queda activo (termina en $680 tras el canje y el reverso de abajo).
  const A = await sobre({ initialAmount: D(1000), balance: D(680), status: 'ACTIVE', activatedAt: el12('10:00') })
  const cargaA = await orden(1000, A.id, { status: 'COMPLETED', paymentStatus: 'PAID' })
  await pago(cargaA, 1000, { createdAt: el12('10:00') })
  await renglon(A.id, 'ACTIVATE', 1000, 1000, el12('10:00'), { orderId: cargaA })
  // 2) Carga de $500 en efectivo, cancelada en tienda el mismo día: la cuenta queda CANCELLED, así que no es carga; en el dinero
  //    (grossCollected) entra y sale en efectivo.
  const B = await sobre({
    initialAmount: D(500),
    balance: D(0),
    status: 'DEACTIVATED',
    activatedAt: el12('10:30'),
    deactivatedAt: el12('11:00'),
  })
  const cargaB = await orden(500, B.id, { status: 'CANCELLED', paymentStatus: 'PAID' })
  await pago(cargaB, 500, { createdAt: el12('10:30') })
  const devolucionB = await pago(cargaB, -500, { type: 'REFUND', createdAt: el12('11:00') })
  await renglon(B.id, 'ACTIVATE', 500, 500, el12('10:30'), { orderId: cargaB })
  await renglon(B.id, 'DEACTIVATE', 500, 0, el12('11:00'), { orderId: cargaB, refundPaymentId: devolucionB.id, reason: 'SALE_CANCELLED' })
  // 3) Compra de $600: $400 + $20 de propina con saldo de A (tender de sistema) y $200 en efectivo.
  const compra = await orden(600)
  const conSaldo = await pago(compra, 400, {
    method: 'OTHER',
    tenderTypeId: tender.id,
    fundsFlow: 'EXTERNAL_RECORDED',
    tipAmount: D(20),
    createdAt: el12('12:00'),
  })
  const canje = await renglon(A.id, 'REDEEM', 420, 580, el12('12:00'), { paymentId: conSaldo.id, orderId: compra })
  await pago(compra, 200, { createdAt: el12('12:01') })
  // 4) Reverso de $100 del cobro con saldo (el REFUND hereda el tender): regresa al saldo de A.
  const reverso = await pago(compra, -100, {
    method: 'OTHER',
    tenderTypeId: tender.id,
    fundsFlow: 'EXTERNAL_RECORDED',
    type: 'REFUND',
    createdAt: el12('13:00'),
  })
  await renglon(A.id, 'REDEEM_REVERSAL', 100, 680, el12('13:00'), {
    refundPaymentId: reverso.id,
    reversesActivityId: canje.id,
    orderId: compra,
  })
  // 5) Auditoría r2 #3: venta de $50 en efectivo a las 23:55 del negocio (05:55 UTC del 13): cuenta en el día 12.
  const noche = await orden(50)
  await pago(noche, 50, { createdAt: el12('23:55') })
  // 6) ⭐ Cuenta de tarjetas PARTIAL: tarjeta de $500 sin activar (PENDING) con un abono de $200 en efectivo. Es dinero que entró
  //    (gross CASH), pero no es venta (net) ni carga (giftCardLoads sólo cuenta cuentas PAGADAS).
  const C = await sobre({ initialAmount: D(500), balance: D(0), status: 'PENDING' })
  const parcial = await orden(500, C.id, { status: 'CONFIRMED', paymentStatus: 'PARTIAL', remainingBalance: D(300) })
  await pago(parcial, 200, { createdAt: el12('14:00') })
  // 7) ⭐ REFUND sobre una carga PAGADA que NO se canceló (enmienda E1: la terminal devolvió $100 de una tarjeta de $400 y la cuenta
  //    entera se desactivó; la cuenta sigue PAID y abierta). En el dinero resta en CASH; en giftCardLoads no cuenta como carga.
  const E = await sobre({
    initialAmount: D(400),
    balance: D(0),
    status: 'DEACTIVATED',
    activatedAt: el12('15:00'),
    deactivatedAt: el12('15:30'),
  })
  const cargaE = await orden(400, E.id, { status: 'COMPLETED', paymentStatus: 'PAID' })
  await pago(cargaE, 400, { createdAt: el12('15:00') })
  const devolucionE = await pago(cargaE, -100, { type: 'REFUND', createdAt: el12('15:30') })
  await renglon(E.id, 'ACTIVATE', 400, 400, el12('15:00'), { orderId: cargaE })
  await renglon(E.id, 'DEACTIVATE', 400, 0, el12('15:30'), { orderId: cargaE, refundPaymentId: devolucionE.id, reason: 'SALE_CANCELLED' })
  // 8) ⭐ Frontera del resumen: tarjeta de $250 cobrada y activada a las 23:55 del negocio (05:55 UTC del 13): su ACTIVATE es del 12.
  const F = await sobre({ initialAmount: D(250), balance: D(250), status: 'ACTIVE', activatedAt: el12('23:55') })
  const cargaF = await orden(250, F.id, { status: 'COMPLETED', paymentStatus: 'PAID' })
  await pago(cargaF, 250, { createdAt: el12('23:55') })
  await renglon(F.id, 'ACTIVATE', 250, 250, el12('23:55'), { orderId: cargaF })

  console.log(
    'Sembrado el 12-oct-2026: cargas $1,500 (una cancelada: −$500), saldo $400 + $20 de propina, reverso −$100, efectivo $200 y $50 a las 23:55; ' +
      'cuenta de tarjetas PARCIAL con $200, carga de $400 con REFUND −$100 sin cancelar y carga de $250 a las 23:55.',
  )
  console.log(venueId)
}

main()
  .catch(e => {
    console.error('siembra fallida:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
