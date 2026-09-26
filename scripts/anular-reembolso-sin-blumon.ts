/**
 * Anula UN reembolso que Avoqado anotó sin que Blumon lo hiciera (PAX de pruebas, 25-sep-2026).
 *
 * Qué pasó: el chip de una VISA contestó «aprobado offline» a un reembolso de $254 y la app de la PAX lo anotó en Avoqado
 * SIN llamar a Blumon (autorización «OFFLINE»). Blumon no tiene reembolsos offline: la venta (operación 25238796) sigue
 * cobrada en la tarjeta, pero Avoqado la da por reembolsada y la terminal ya no deja reembolsarla. Los reembolsos sólo se
 * pueden hacer desde la TPV (el portal de Blumon no reembolsa), así que primero hay que quitar el reembolso falso.
 *
 * Qué deshace (medido en producción ese día; cualquier diferencia aborta sin escribir):
 *   1. El reembolso (Payment REFUND −254) → status FAILED con el motivo. NO se borra: es el ancla de la bitácora.
 *   2. El pago original → se le quitan los 7 campos que escribió el reembolso (vuelve a su forma de venta).
 *   3. El turno abierto → +$254 (el reembolso le había restado sus ventas).
 *   4. La transacción del comercio (VenueTransaction REFUND −254) y el recibo de devolución → se borran.
 *   5. La bitácora → se AGREGA «REFUND_VOIDED»; la entrada «REFUND_CREATED» se conserva.
 * No toca: el efecto de referidos (DONE, no hizo nada: la orden no tiene referidos), comisiones, sellos ni inventario
 * (no existen para esta orden), ni la orden (sigue COMPLETED/PAID, que es lo cierto).
 *
 * Uso (sólo simula si no lleva --apply):
 *   npx tsx scripts/anular-reembolso-sin-blumon.ts --base render
 *   npx tsx scripts/anular-reembolso-sin-blumon.ts --base render --apply --confirm-host <host>
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'

const VENUE = 'cmhvejgq300ad2gtxbrawgh7w'
const REEMBOLSO = 'cmuhberc1086jma29yyf7sk0r'
const ORIGINAL = 'cmuhba5tn085hma29p6bqlw7k'
const TURNO = 'cmrn3u367003yo42aohvzvxzs'
const TRANSACCION = 'cmuhbercg086lma290n8f05mw'
const RECIBO = 'cmuhberfc086rma29tu5kw76r'
const MOTIVO =
  'Reembolso anotado sin pasar por Blumon: el chip de la VISA dijo «aprobado offline» y la app lo dio por hecho ' +
  '(defecto corregido el 25-sep-2026). Blumon no tiene reembolsos offline: el dinero NO se devolvió.'
const CAMPOS_DEL_REEMBOLSO = [
  'refunds',
  'refundHistory',
  'refundedAmount',
  'refundedAmountCents',
  'isFullyRefunded',
  'lastRefundId',
  'lastRefundAt',
]

class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

const leerValor = (bandera: string): string | undefined => {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Elige la base ANTES de que exista el cliente de Prisma; ninguna URL se imprime. */
function elegirBase(): void {
  const base = leerValor('--base')
  if (base === undefined || base === 'local') return
  if (base !== 'render') {
    console.error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
    throw new Rechazo(2)
  }
  if (!process.env.RENDER_DATABASE_URL) {
    console.error('--base render: falta RENDER_DATABASE_URL en el entorno.')
    throw new Rechazo(2)
  }
  process.env.DATABASE_URL = process.env.RENDER_DATABASE_URL
}

function hostDeLaBase(): string {
  try {
    const host = new URL(process.env.DATABASE_URL ?? '').hostname
    if (host) return host
  } catch {
    /* se reporta abajo */
  }
  console.error('DATABASE_URL no es una URL con host (su valor no se imprime).')
  throw new Rechazo(2)
}

function fallar(motivo: string): never {
  console.error(`🔴 ${motivo} — no se escribió nada.`)
  throw new Rechazo(3)
}

async function main(): Promise<void> {
  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  if (aplicar && leerValor('--confirm-host') !== host) {
    console.error(`Para escribir repite el host exacto de la base: --confirm-host ${host}`)
    throw new Rechazo(2)
  }
  const { default: prisma } = await import('../src/utils/prismaClient')
  try {
    // ── Lo que se espera encontrar (medido el 25-sep). Cualquier diferencia aborta. ──
    const reembolso = await prisma.payment.findUnique({ where: { id: REEMBOLSO } })
    const original = await prisma.payment.findUnique({ where: { id: ORIGINAL } })
    const turno = await prisma.shift.findUnique({ where: { id: TURNO } })
    const transaccion = await prisma.venueTransaction.findUnique({ where: { id: TRANSACCION } })
    const recibo = await prisma.digitalReceipt.findUnique({ where: { id: RECIBO } })
    const otrosReembolsos = await prisma.payment.count({
      where: { venueId: VENUE, type: 'REFUND', processorData: { path: ['originalPaymentId'], equals: ORIGINAL } },
    })
    const pdReembolso = (reembolso?.processorData ?? {}) as Record<string, unknown>
    const pdOriginal = (original?.processorData ?? {}) as Record<string, unknown>

    if (!reembolso || reembolso.venueId !== VENUE || reembolso.type !== 'REFUND') fallar('El reembolso no existe o no es de este negocio')
    if (reembolso.status !== 'COMPLETED') fallar(`El reembolso ya no está COMPLETED (está ${reembolso.status})`)
    if (!new Prisma.Decimal(reembolso.amount).equals(-254)) fallar(`El reembolso no es de −254 (es ${reembolso.amount})`)
    if (reembolso.authorizationNumber !== 'OFFLINE') fallar('El reembolso sí trae autorización de Blumon: NO se toca')
    if (pdReembolso.originalPaymentId !== ORIGINAL) fallar('El reembolso no apunta al pago original esperado')
    if (!original || original.status !== 'COMPLETED' || original.venueId !== VENUE) fallar('El pago original no está COMPLETED')
    if (pdOriginal.lastRefundId !== REEMBOLSO || Number(pdOriginal.refundedAmountCents) !== 25400)
      fallar('El pago original no refleja ESTE reembolso')
    if (otrosReembolsos !== 1) fallar(`Hay ${otrosReembolsos} reembolsos sobre el pago original (se esperaba 1)`)
    if (!turno || turno.status !== 'OPEN' || reembolso.shiftId !== TURNO) fallar('El turno del reembolso no está abierto')
    if (!transaccion || transaccion.paymentId !== REEMBOLSO) fallar('La transacción del comercio no es la del reembolso')
    if (!recibo || recibo.paymentId !== REEMBOLSO) fallar('El recibo no es el del reembolso')

    console.log(`Base: ${host}  ·  modo: ${aplicar ? 'ESCRIBIR' : 'SIMULACIÓN (no escribe nada)'}`)
    console.log(`1. Reembolso ${REEMBOLSO}: COMPLETED → FAILED (${reembolso.amount}, autorización ${reembolso.authorizationNumber})`)
    console.log(`2. Pago original ${ORIGINAL}: se quitan ${CAMPOS_DEL_REEMBOLSO.join(', ')}`)
    console.log(`3. Turno ${TURNO}: ventas ${turno.totalSales} → ${new Prisma.Decimal(turno.totalSales).plus(254)}`)
    console.log(`4. Se borran la transacción del comercio ${TRANSACCION} (${transaccion.grossAmount}) y el recibo ${RECIBO}`)
    console.log(`5. Bitácora: se agrega REFUND_VOIDED (la entrada REFUND_CREATED se conserva)`)
    if (!aplicar) return

    await prisma.$transaction(async tx => {
      const pdNuevo = { ...pdOriginal }
      for (const campo of CAMPOS_DEL_REEMBOLSO) delete pdNuevo[campo]
      const n1 = await tx.payment.updateMany({
        where: { id: REEMBOLSO, venueId: VENUE, type: 'REFUND', status: 'COMPLETED', authorizationNumber: 'OFFLINE' },
        data: {
          status: 'FAILED',
          processorData: { ...pdReembolso, voidedAt: new Date().toISOString(), voidedReason: MOTIVO } as Prisma.InputJsonValue,
        },
      })
      const n2 = await tx.payment.updateMany({
        where: { id: ORIGINAL, venueId: VENUE, status: 'COMPLETED', processorData: { path: ['lastRefundId'], equals: REEMBOLSO } },
        data: { processorData: pdNuevo as Prisma.InputJsonValue },
      })
      const n3 = await tx.shift.updateMany({
        where: { id: TURNO, venueId: VENUE, status: 'OPEN' },
        data: { totalSales: { increment: 254 } },
      })
      const n4 = await tx.venueTransaction.deleteMany({ where: { id: TRANSACCION, paymentId: REEMBOLSO } })
      const n5 = await tx.digitalReceipt.deleteMany({ where: { id: RECIBO, paymentId: REEMBOLSO } })
      if ([n1, n2, n3, n4, n5].some(r => r.count !== 1)) {
        throw new Error(`Alguna fila cambió mientras tanto (${[n1, n2, n3, n4, n5].map(r => r.count).join('/')}): se deshace todo`)
      }
      await tx.activityLog.create({
        data: {
          venueId: VENUE,
          action: 'REFUND_VOIDED',
          entity: 'Payment',
          entityId: REEMBOLSO,
          data: { originalPaymentId: ORIGINAL, amount: -254, reason: MOTIVO, source: 'scripts/anular-reembolso-sin-blumon.ts' },
        },
      })
    })
    console.log('✅ Corrección aplicada. El pago de $254 vuelve a poder reembolsarse desde la PAX.')
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

const drenar = (flujo: NodeJS.WriteStream): Promise<void> =>
  flujo.writableLength === 0 ? Promise.resolve() : new Promise(resolve => flujo.write('', () => resolve()))

main()
  .then(() => Promise.all([drenar(process.stdout), drenar(process.stderr)]))
  .then(() => process.exit(0))
  .catch(async e => {
    const codigo = e instanceof Rechazo ? e.codigo : 1
    if (!(e instanceof Rechazo)) console.error(e)
    await Promise.all([drenar(process.stdout), drenar(process.stderr)])
    process.exit(codigo)
  })
