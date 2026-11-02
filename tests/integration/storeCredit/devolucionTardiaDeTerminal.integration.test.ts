/**
 * La devolución de la TERMINAL que llega DESPUÉS del saldo a favor, contra Postgres REAL (spec 2026-10-30-saldo-a-favor §5.5, opción 1
 * del founder: avisar y congelar; tarea S7). La terminal ya devolvió al banco cuando avisa (`recordRefund`), así que:
 * - se anota SIEMPRE, aunque pase de lo reembolsable (lo que se pasó a saldo no salió del banco: el banco todavía lo tenía);
 * - en la misma transacción, UNA anomalía `STORE_CREDIT_DOUBLE_REFUND` por devolución de la terminal, con lo duplicado NUEVO y todos
 *   los abonos a saldo de ese cobro (por su origen económico: también los de la cadena de un Cambio);
 * - los sobres ACTIVE de esos abonos se bloquean (`SUSPICIOUS_ACTIVITY` y la nota del folio); uno ya bloqueado no se toca;
 * - el orden de candados (cobro → sobres → turno): con un cobro con ese saldo a la vez, los dos terminan, sin interbloqueo.
 * Lo de la marca en memoria (antes de que la terminal devuelva) está en `tests/unit/services/storeCredit/lateTerminalRefund.test.ts`.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "devolucionTardiaDeTerminal" --ci
 *
 * La libreta no se puede borrar (trigger): los sobres se quedan en la base desechable; cada negocio es único.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { decryptGiftCardCode } from '@/services/giftCards/giftCardCode'
import { operarSobreDeGerenteEnTx } from '@/services/giftCards/giftCardLedger'
import { createExchange } from '@/services/exchanges/exchange.service'
import { issuePosRefund } from '@/services/storeCredit/storeCreditRefund.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { payGiftCardBalanceOnOrder } from '@/services/mobile/order.mobile.service'
import { seedClothingSale } from '../exchanges/seedExchange'
import { crearCuentaDeMercancia, esperarAQueAlguienEspereA, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.setTimeout(120_000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
const D = (v: number) => new Prisma.Decimal(v)
let n = 0
const telefono = () => `55${String(10_000_000 + ((process.pid * 97 + ++n * 7919 + Date.now()) % 89_999_999)).padStart(8, '0')}`

/** Una venta de ropa de $500 con tarjeta de la TPV (procesada por Avoqado); la clienta (Ana) y su hija, las dos con teléfono. */
async function seed() {
  const s = await seedClothingSale({ card: true })
  fixtures.push(s)
  await prisma.customer.update({ where: { id: s.customer.id }, data: { firstName: 'Ana', lastName: 'López', phone: telefono() } })
  const hija = await prisma.customer.create({ data: { venueId: s.venueId, firstName: 'Hija', lastName: 'López', phone: telefono() } })
  return { ...s, hija }
}
type Escenario = Awaited<ReturnType<typeof seed>>

/** El Reembolso del POS a saldo a favor (S4), por el servicio de producción. */
const aSaldo = (s: Escenario, cents: number, customerId = s.customer.id, paymentId = s.payments[0].id) =>
  issuePosRefund({
    venueId: s.venueId,
    paymentId,
    amount: cents,
    reason: 'RETURNED_GOODS',
    staffId: s.staffId,
    refundMethod: 'STORE_CREDIT',
    customerId,
    idempotencyKey: `saldo-${randomUUID().slice(0, 12)}`,
  })

let ref = 0
/** La terminal ya devolvió a la tarjeta y AVISA (`recordRefund`). La llave se puede repetir para un reintento. */
const terminal = (s: Escenario, cents: number, llave = `${s.venueId.slice(-10)}-terminal-${++ref}`) =>
  recordRefund(
    s.venueId,
    {
      venueId: s.venueId,
      originalPaymentId: s.payments[0].id,
      originalOrderId: s.order.id,
      amount: cents,
      reason: 'CUSTOMER_REQUEST',
      merchantAccountId: s.payments[0].merchantAccountId,
      // Un reintento de verdad reenvía la MISMA autorización y referencia del procesador (entran en la huella de la llave).
      authorizationNumber: `AUT-${llave.slice(-16)}`,
      referenceNumber: `REF-${llave.slice(-16)}`,
      isPartialRefund: cents < 50000,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: llave,
    } as Parameters<typeof recordRefund>[1],
    s.staffId,
  )

const anomalias = (s: Escenario) =>
  prisma.moneyAnomaly.findMany({
    where: { category: 'GIFT_CARD_STORE_CREDIT_DOUBLE_REFUND', expectedState: { path: ['venueId'], equals: s.venueId } },
    orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
    take: 10,
  })
const sobreDe = (s: Escenario, customerId: string) =>
  prisma.giftCard.findFirstOrThrow({ where: { venueId: s.venueId, customerId }, orderBy: { createdAt: 'asc' } })
const bloqueos = (giftCardId: string) =>
  prisma.giftCardActivity.findMany({ where: { giftCardId, type: 'BLOCK' }, orderBy: { createdAt: 'asc' }, take: 10 })
const reembolsosDeTerminal = (s: Escenario) =>
  prisma.payment.findMany({
    where: {
      venueId: s.venueId,
      type: 'REFUND',
      method: 'CREDIT_CARD',
      processorData: { path: ['originalPaymentId'], equals: s.payments[0].id },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })
/** Un gerente ya lo había bloqueado antes de que llegara la terminal. */
const bloquearAntes = (s: Escenario, giftCardId: string) =>
  prisma.$transaction(tx =>
    operarSobreDeGerenteEnTx(tx, {
      venueId: s.venueId,
      giftCardId,
      staffId: s.staffId,
      operationKey: `pre-bloqueo-${giftCardId}`,
      op: { tipo: 'BLOQUEAR', reason: 'CUSTOMER_REQUEST' },
    }),
  )

afterAll(async () => {
  for (const s of fixtures) {
    await prisma.moneyAnomaly.deleteMany({ where: { expectedState: { path: ['venueId'], equals: s.venueId } } })
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await s.cleanup().catch(error => console.warn('devolucionTardiaDeTerminal: la limpieza no terminó', String(error)))
  }
  await prisma.$disconnect()
})

describe('la devolución de la terminal después del saldo a favor · Postgres real', () => {
  it('🔴 saldo primero ($150), terminal después ($400 y $100): se anotan aunque pasen de lo reembolsable; lo duplicado es lo NUEVO ($50, luego $100); repetir no avisa otra vez; el banco sigue siendo el tope', async () => {
    const s = await seed()
    const saldo = await aSaldo(s, 15000)
    const sobre = await sobreDe(s, s.customer.id)

    const primera = await terminal(s, 40000)
    let filas = await reembolsosDeTerminal(s)
    expect(filas.map(f => f.amount.toNumber())).toEqual([-400])
    let avisos = await anomalias(s)
    expect(avisos).toHaveLength(1)
    expect(avisos[0].stripeEventId).toBe(`giftcard:STORE_CREDIT_DOUBLE_REFUND:${primera.id}`)
    expect(avisos[0].observedState).toMatchObject({
      duplicadoCents: 5000,
      abonos: [
        { storeCreditRefundPaymentId: saldo.refundId, giftCardId: sobre.id, montoCents: 15000, saldoCents: 15000, estado: 'ACTIVE' },
      ],
    })
    // El sobre se congela con el motivo y la nota del folio; el saldo no se toca.
    const congelado = await prisma.giftCard.findUniqueOrThrow({ where: { id: sobre.id } })
    expect(congelado).toMatchObject({ status: 'BLOCKED' })
    expect(congelado.balance.toFixed(2)).toBe('150.00')
    const [bloqueo] = await bloqueos(sobre.id)
    expect(bloqueo).toMatchObject({ reason: 'SUSPICIOUS_ACTIVITY', staffId: s.staffId })
    expect(bloqueo.note).toBe(`Doble devolución: la terminal devolvió el cobro ${s.order.orderNumber}, que ya tenía saldo a favor`)

    const llave = `${s.venueId.slice(-10)}-terminal-segunda`
    const segunda = await terminal(s, 10000, llave)
    avisos = await anomalias(s)
    expect(avisos).toHaveLength(2)
    expect(avisos[1].stripeEventId).toBe(`giftcard:STORE_CREDIT_DOUBLE_REFUND:${segunda.id}`)
    // $150 + $400 + $100 sobre $500: $150 duplicados en total, $100 de ellos nuevos (no $200).
    expect(avisos[1].observedState).toMatchObject({ duplicadoCents: 10000, abonos: [{ estado: 'BLOCKED' }] })
    // Ya estaba bloqueado: no se vuelve a bloquear.
    expect(await bloqueos(sobre.id)).toHaveLength(1)

    // La terminal reintenta la MISMA devolución: se contesta lo escrito y no hay aviso nuevo.
    const repetida = await terminal(s, 10000, llave)
    expect(repetida.id).toBe(segunda.id)
    expect(await anomalias(s)).toHaveLength(2)

    // El banco tenía $500 y ya devolvió $500: un centavo más no se anota.
    await expect(terminal(s, 1)).rejects.toThrow(/exceeds remaining refundable/)
    filas = await reembolsosDeTerminal(s)
    expect(filas.map(f => f.amount.toNumber())).toEqual([-400, -100])
  })

  it('sin exceso ($150 a saldo y $300 en la terminal sobre $500): ni aviso ni sobre congelado', async () => {
    const s = await seed()
    await aSaldo(s, 15000)

    await terminal(s, 30000)

    expect(await anomalias(s)).toHaveLength(0)
    expect((await sobreDe(s, s.customer.id)).status).toBe('ACTIVE')
  })

  it('si el sobre ya estaba bloqueado no se toca y la devolución se anota igual', async () => {
    const s = await seed()
    await aSaldo(s, 15000)
    const sobre = await sobreDe(s, s.customer.id)
    await bloquearAntes(s, sobre.id)

    const r = await terminal(s, 50000)

    expect(r).toMatchObject({ amount: 500 })
    const [aviso] = await anomalias(s)
    expect(aviso.observedState).toMatchObject({ duplicadoCents: 15000, abonos: [{ giftCardId: sobre.id, estado: 'BLOCKED' }] })
    const bloqueosDelSobre = await bloqueos(sobre.id)
    expect(bloqueosDelSobre).toHaveLength(1)
    expect(bloqueosDelSobre[0].reason).toBe('CUSTOMER_REQUEST')
  })

  it('terminal primero, saldo después: el saldo se rechaza por lo que queda por devolver y no abona nada', async () => {
    const s = await seed()
    await terminal(s, 50000)

    await expect(aSaldo(s, 10000)).rejects.toThrow(/sólo quedan \$0\.00 por devolver/)

    expect(await prisma.giftCard.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await anomalias(s)).toHaveLength(0)
  })

  it('dos destinatarias ($150 a Ana, $100 a su hija) y luego la devolución completa de la terminal: UNA anomalía con los dos abonos y los dos sobres congelados', async () => {
    const s = await seed()
    const deAna = await aSaldo(s, 15000)
    const deLaHija = await aSaldo(s, 10000, s.hija.id)
    const [sobreDeAna, sobreDeLaHija] = [await sobreDe(s, s.customer.id), await sobreDe(s, s.hija.id)]

    await terminal(s, 50000)

    const avisos = await anomalias(s)
    expect(avisos).toHaveLength(1)
    const detalle = avisos[0].observedState as { duplicadoCents: number; abonos: Array<Record<string, unknown>> }
    expect(detalle.duplicadoCents).toBe(25000)
    expect(detalle.abonos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storeCreditRefundPaymentId: deAna.refundId, giftCardId: sobreDeAna.id, montoCents: 15000 }),
        expect.objectContaining({ storeCreditRefundPaymentId: deLaHija.refundId, giftCardId: sobreDeLaHija.id, montoCents: 10000 }),
      ]),
    )
    expect(detalle.abonos).toHaveLength(2)
    for (const sobre of [sobreDeAna, sobreDeLaHija]) {
      expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: sobre.id } })).status).toBe('BLOCKED')
      expect(await bloqueos(sobre.id)).toHaveLength(1)
    }
  })

  it('un sobre ya bloqueado y otro ACTIVE: sólo se toca el ACTIVE, y los dos entran en la anomalía', async () => {
    const s = await seed()
    await aSaldo(s, 15000)
    await aSaldo(s, 10000, s.hija.id)
    const [sobreDeAna, sobreDeLaHija] = [await sobreDe(s, s.customer.id), await sobreDe(s, s.hija.id)]
    await bloquearAntes(s, sobreDeLaHija.id)

    await terminal(s, 50000)

    const [aviso] = await anomalias(s)
    expect((aviso.observedState as { abonos: unknown[] }).abonos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ giftCardId: sobreDeAna.id, estado: 'ACTIVE' }),
        expect.objectContaining({ giftCardId: sobreDeLaHija.id, estado: 'BLOCKED' }),
      ]),
    )
    expect((await bloqueos(sobreDeAna.id)).map(b => b.reason)).toEqual(['SUSPICIOUS_ACTIVITY'])
    expect((await bloqueos(sobreDeLaHija.id)).map(b => b.reason)).toEqual(['CUSTOMER_REQUEST'])
  })

  it('compra con tarjeta $500 → Cambio parejo → $200 del crédito a saldo → devolución tardía de la compra original: el sobre de $200 se congela y entra en la anomalía (cadena por la raíz)', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    expect(exchange.status).toBe('COMPLETED')
    const delCredito = await aSaldo(s, 20000, s.customer.id, exchange.paymentIds[0])
    const sobre = await sobreDe(s, s.customer.id)

    await terminal(s, 50000)

    const [aviso] = await anomalias(s)
    expect(aviso.observedState).toMatchObject({
      abonos: [{ storeCreditRefundPaymentId: delCredito.refundId, giftCardId: sobre.id, montoCents: 20000, estado: 'ACTIVE' }],
    })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: sobre.id } })).status).toBe('BLOCKED')
    // Lo de siempre del Cambio sigue igual: va a revisar.
    expect((await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })).status).toBe('NEEDS_REVIEW')
  })

  describe('🔴 con un cobro con ese saldo a la vez, los dos terminan sin interbloqueo (cobro → sobre → turno)', () => {
    /** Una tercera sesión sostiene el TURNO: quien llegue a él ya trae su sobre apartado. */
    async function sostenerElTurno(s: Escenario) {
      let soltar!: () => void
      const suelta = new Promise<void>(resolve => (soltar = resolve))
      let avisar!: (pid: number) => void
      const pid = new Promise<number>(resolve => (avisar = resolve))
      const turno = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${s.shift.id} FOR UPDATE`
          avisar(await pidDe(tx))
          await suelta
        },
        { timeout: 30_000, maxWait: 5_000 },
      )
      return { pid: await pid, soltar, turno }
    }
    /** Espera a que alguien esté detenido por OTRA sesión que no es la del turno (la segunda espera, en el sobre). */
    async function esperarOtraEspera(pidDelTurno: number) {
      for (let i = 0; i < 200; i++) {
        const [fila] = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 AND NOT (${pidDelTurno}::int = ANY(pg_blocking_pids(pid)))
          LIMIT 1`
        if (fila) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('Nadie llegó a esperar el sobre')
    }
    async function preparar() {
      const s = await seed()
      await aSaldo(s, 10000) // Ana tiene $100 de saldo de esta venta
      const sobre = await sobreDe(s, s.customer.id)
      const { orderId } = await crearCuentaDeMercancia({ venueId: s.venueId, staffId: s.staffId, total: 50 })
      const cobrar = () =>
        payGiftCardBalanceOnOrder(s.venueId, orderId, {
          idempotencyKey: `saldo-${s.venueId.slice(-12)}-cobro`,
          proof: { kind: 'CODE' as const, code: decryptGiftCardCode(sobre.codeEnc!) },
          amount: D(50),
          tip: D(0),
          staffId: s.staffId,
          deviceId: null,
        })
      return { s, sobre, cobrar }
    }

    /**
     * `primero` llega al sobre y se queda esperando el turno; `segundo` arranca y espera el sobre; se suelta el turno. Pase lo que pase
     * (una espera que nunca llega), el turno se suelta y ninguna promesa queda colgada: la prueba falla rápido, no congela la corrida.
     */
    async function cruzar<A, B>(s: Escenario, primero: () => Promise<A>, segundo: () => Promise<B>) {
      const { pid, soltar, turno } = await sostenerElTurno(s)
      const vigilar = <T>(p: Promise<T>) => {
        void p.catch(() => undefined) // su rechazo se lee en `allSettled`; si la prueba se corta antes, no queda suelto
        return p
      }
      let a: Promise<A> | undefined
      let b: Promise<B> | undefined
      try {
        a = vigilar(primero())
        await esperarAQueAlguienEspereA(pid) // el primero ya tiene el sobre y espera el turno
        b = vigilar(segundo())
        await esperarOtraEspera(pid) // el segundo espera el sobre
      } finally {
        soltar()
        await turno.catch(() => undefined)
      }
      return Promise.allSettled([a, b])
    }

    it('la terminal llega primero al sobre: se anota; el cobro, que esperaba el sobre, lo encuentra congelado (409, no 40P01)', async () => {
      const { s, sobre, cobrar } = await preparar()

      const [d, c] = await cruzar(s, () => terminal(s, 50000), cobrar)

      expect(d).toMatchObject({ status: 'fulfilled' })
      expect(c).toMatchObject({ status: 'rejected', reason: { code: 'GIFT_CARD_BLOCKED' } })
      const final = await prisma.giftCard.findUniqueOrThrow({ where: { id: sobre.id } })
      expect(final.status).toBe('BLOCKED')
      expect(final.balance.toFixed(2)).toBe('100.00')
    })

    it('el cobro llega primero al sobre: se cobra; la terminal, que esperaba el sobre, se anota y lo congela con lo que queda', async () => {
      const { s, sobre, cobrar } = await preparar()

      const [c, d] = await cruzar(s, cobrar, () => terminal(s, 50000))

      expect(c).toMatchObject({ status: 'fulfilled' })
      expect(d).toMatchObject({ status: 'fulfilled' })
      const [aviso] = await anomalias(s)
      expect(aviso.observedState).toMatchObject({
        duplicadoCents: 10000,
        abonos: [{ giftCardId: sobre.id, saldoCents: 5000, estado: 'ACTIVE' }],
      })
      const final = await prisma.giftCard.findUniqueOrThrow({ where: { id: sobre.id } })
      expect(final.status).toBe('BLOCKED')
      expect(final.balance.toFixed(2)).toBe('50.00')
    })
  })
})
