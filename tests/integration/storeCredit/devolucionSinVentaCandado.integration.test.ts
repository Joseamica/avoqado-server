/**
 * La «devolución sin venta» contra el PRIMER saldo a favor de la sucursal, con Postgres REAL (spec 2026-10-30-saldo-a-favor §5.5, tarea S6;
 * Codex plan r1 h10, r2 h4/h5, r3 h2). Lo que un mock no puede probar: las dos mitades de la carrera no se cruzan ni se abrazan.
 *
 * - La devolución sin venta toma el candado «primer-sobre» como PRIMERA sentencia de su transacción (antes del turno, de Orders y de
 *   Payments) y repite ahí la comprobación de sobres activados. Lo que da saldo (Cambio / Reembolso a saldo) lo toma primero mientras la
 *   sucursal no tiene ningún sobre activado.
 * - Resultados SEPARADOS, no «uno de los dos»: si el primer saldo gana el candado, la devolución se rechaza (409) sin escribir nada; si
 *   la devolución lo gana, termina, y el saldo se da después SIN error.
 * - Los dos casos, con y sin turno abierto. Con turno, el lado del saldo también actualiza el turno al final: si la devolución reclamara
 *   el turno ANTES del candado, ella retendría el turno esperando el candado y el saldo esperaría el turno (40P01); en el orden bueno no.
 *
 * Cada espera es de verdad (`pg_blocking_pids`), no la suerte de un setTimeout.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "devolucionSinVentaCandado" --ci
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { createRefund } from '@/services/mobile/refund.mobile.service'
import { abonarSaldoAFavorEnTx, prepararSobreDeSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { tomarCandadoPrimerSobreSiHaceFaltaEnTx } from '@/services/storeCredit/primerSobreLock'
import { crearNegocioDePrueba, esperarAQueAlguienEspereA, limpiarNegocioDePrueba, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'
import type { TxConReintento } from '@/utils/serializableRetry'

jest.setTimeout(90_000)

const PRESUPUESTO = { timeout: 30_000, maxWait: 5_000 }
const D = (v: number) => new Prisma.Decimal(v)
const negocios: string[] = []

/** Un negocio propio con su clienta (con teléfono, para que el saldo tenga a dónde llegar) y, si se pide, un turno ABIERTO con $500. */
async function escenario(conTurno: boolean) {
  const { venueId, staffId } = await crearNegocioDePrueba(`s6-${conTurno ? 'turno' : 'sin-turno'}`)
  negocios.push(venueId)
  const customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Ana', lastName: 'López', phone: '+525512340601' } })).id
  const turno = conTurno
    ? await prisma.shift.create({ data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 100, totalSales: 500 } })
    : null
  return { venueId, staffId, customerId, turno }
}
type Escenario = Awaited<ReturnType<typeof escenario>>

afterAll(async () => {
  for (const venueId of negocios)
    await limpiarNegocioDePrueba(venueId).catch(error => console.warn('devolucionSinVentaCandado: limpieza', String(error)))
})

/** Lo que la devolución sin venta de $50 escribe: la orden testigo, el pago REFUND y su VenueTransaction. */
const escrituras = async (venueId: string) => ({
  ordenes: await prisma.order.count({ where: { venueId } }),
  pagos: await prisma.payment.count({ where: { venueId } }),
  transacciones: await prisma.venueTransaction.count({ where: { venueId } }),
})
const totalDelTurno = async (e: Escenario) => (await prisma.shift.findUniqueOrThrow({ where: { id: e.turno!.id } })).totalSales.toFixed(2)

const devolverSinVenta = (e: Escenario) =>
  createRefund({ venueId: e.venueId, amount: 5000, reason: 'Producto defectuoso', method: 'CASH', staffId: e.staffId })

/**
 * Lo que hace el lado que da saldo (Cambio / Reembolso a saldo, S3/S5) para dar el PRIMER saldo de la sucursal, en su orden:
 * «primer-sobre» → sobre de la clienta → (turno). `antesDeAbonar` es el punto donde la prueba fuerza el cruce.
 */
async function darElPrimerSaldo(tx: Prisma.TransactionClient, e: Escenario, antesDeAbonar: () => Promise<void> = async () => {}) {
  await tomarCandadoPrimerSobreSiHaceFaltaEnTx(tx, e.venueId)
  const preparado = await prepararSobreDeSaldoAFavorEnTx(tx as unknown as TxConReintento, { venueId: e.venueId, customerId: e.customerId })
  await antesDeAbonar()
  const abono = await abonarSaldoAFavorEnTx(tx as unknown as TxConReintento, {
    preparado,
    monto: D(100),
    staffId: e.staffId,
    origen: { orderId: cuid(), refundPaymentId: cuid() },
    folio: 'S6-1',
    tipo: 'REEMBOLSO',
  })
  if (e.turno) await tx.shift.update({ where: { id: e.turno.id }, data: { totalSales: { decrement: 100 } } })
  return abono
}

describe.each([
  ['sin turno abierto', false],
  ['con turno abierto', true],
])('la devolución sin venta y el primer saldo a favor · Postgres real · %s', (_nombre, conTurno) => {
  it('🔴 si el primer saldo gana el candado, la devolución sin venta se rechaza (409) sin escribir nada', async () => {
    const e = await escenario(conTurno)
    let avisarQueTengoElCandado!: (pid: number) => void
    const tengoElCandado = new Promise<number>(resolve => (avisarQueTengoElCandado = resolve))

    const saldo = prisma.$transaction(
      tx =>
        darElPrimerSaldo(tx, e, async () => {
          const mio = await pidDe(tx)
          avisarQueTengoElCandado(mio)
          // La devolución sin venta de verdad espera el candado (la comprobación de afuera todavía no ve ningún sobre activado).
          await esperarAQueAlguienEspereA(mio)
        }),
      PRESUPUESTO,
    )
    const devolucion = tengoElCandado.then(() => devolverSinVenta(e).catch((error: unknown) => error))

    const [abono, error] = await Promise.all([saldo, devolucion])

    expect(error).toBeInstanceOf(GiftCardError)
    expect(error).toMatchObject({ code: 'GIFT_CARD_UNLINKED_REFUND_BLOCKED', statusCode: 409 })
    expect(abono.saldoNuevo.toFixed(2)).toBe('100.00')
    expect(await escrituras(e.venueId)).toEqual({ ordenes: 0, pagos: 0, transacciones: 0 })
    // La devolución se rechazó antes del turno: sólo el saldo lo tocó ($500 − $100).
    if (e.turno) expect(await totalDelTurno(e)).toBe('400.00')
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: abono.giftCardId } })
    expect(sobre).toMatchObject({ status: 'ACTIVE', venueId: e.venueId })
    expect(sobre.activatedAt).not.toBeNull()
  })

  it('🔴 si la devolución sin venta gana el candado, termina, y el primer saldo se da después SIN error', async () => {
    const e = await escenario(conTurno)
    // Un «portero» sostiene la fila del negocio: la devolución, ya con el candado y con el turno reclamado, se detiene al escribir su
    // Order (su llave foránea a Venue pide un candado de fila que el portero tiene). Así se sabe que ella lo tiene cuando entra el saldo.
    let soltarAlPortero!: () => void
    const suelta = new Promise<void>(resolve => (soltarAlPortero = resolve))
    let avisarQueElPorteroEstaPuesto!: (pid: number) => void
    const porteroPuesto = new Promise<number>(resolve => (avisarQueElPorteroEstaPuesto = resolve))
    const portero = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${e.venueId} FOR UPDATE`
      avisarQueElPorteroEstaPuesto(await pidDe(tx))
      await suelta
    }, PRESUPUESTO)
    const pendientes: Array<Promise<unknown>> = [portero]
    let hecha: Awaited<ReturnType<typeof devolverSinVenta>>
    let abono: Awaited<ReturnType<typeof darElPrimerSaldo>>
    try {
      const pidDelPortero = await porteroPuesto

      const devolucion = devolverSinVenta(e)
      pendientes.push(devolucion)
      const pidDeLaDevolucion = await esperarAQueAlguienEspereA(pidDelPortero) // la devolución ya tiene el candado y espera al portero

      const saldo = prisma.$transaction(tx => darElPrimerSaldo(tx, e), PRESUPUESTO)
      pendientes.push(saldo)
      await esperarAQueAlguienEspereA(pidDeLaDevolucion) // y el saldo de verdad espera a LA DEVOLUCIÓN (no a otra sesión)
      soltarAlPortero()
      ;[hecha, abono] = await Promise.all([devolucion, saldo, portero]).then(([a, b]) => [a, b] as const)
    } finally {
      // Si algo de arriba falla, el portero se suelta igual: sin esto la devolución y el saldo se quedan detenidos para siempre.
      soltarAlPortero()
      await Promise.allSettled(pendientes)
    }

    expect(hecha).toMatchObject({ amount: 5000, method: 'CASH' })
    expect(await prisma.payment.count({ where: { venueId: e.venueId, type: 'REFUND', status: 'COMPLETED' } })).toBe(1)
    expect(abono.saldoNuevo.toFixed(2)).toBe('100.00')
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: abono.giftCardId } })
    expect(sobre).toMatchObject({ status: 'ACTIVE', venueId: e.venueId })
    expect(sobre.balance.toFixed(2)).toBe('100.00')
    // $500 − $50 de la devolución − $100 del saldo.
    if (e.turno) expect(await totalDelTurno(e)).toBe('350.00')

    // Y desde que el sobre existe, la siguiente devolución sin venta ya se rechaza (la comprobación de afuera).
    const antes = await escrituras(e.venueId)
    await expect(devolverSinVenta(e)).rejects.toMatchObject({ code: 'GIFT_CARD_UNLINKED_REFUND_BLOCKED', statusCode: 409 })
    expect(await escrituras(e.venueId)).toEqual(antes)
  })
})
