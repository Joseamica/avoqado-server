/**
 * S10 (I1 de la revisión final = P1 de Codex código r1): un reintento con la MISMA llave nunca recibe un rechazo definitivo mientras la
 * primera petición todavía puede escribir. Lo que cambia entre el envío y el reenvío —la marca de la terminal, «Sólo saldo a favor»,
 * los cambios apagados— se mira bajo el candado y DESPUÉS de reconocer la llave. Contra Postgres REAL:
 *  1. A pasa sus comprobaciones y queda detenida más adelante (una tercera sesión sostiene el candado por cliente del saldo a favor, o
 *     el turno);
 *  2. cambia algo (la terminal abre la devolución, se prende «Sólo saldo», se apagan los cambios);
 *  3. B reenvía con la misma llave: espera a A y contesta lo que A escribió. Un solo reembolso, un solo Cambio, un solo abono.
 * Antes, B recibía 409 `STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS` (o 400 `STORE_CREDIT_ONLY`, o 422 `EXCHANGES_DISABLED`) de una
 * consulta sin candado, la app borraba lo pendiente «porque no se escribió nada», y A abonaba después.
 *
 * Y el I2 por el camino real: con destino saldo a favor, un rechazo de siempre sin prefijo («No se puede devolver $X», otra caja ya
 * devolvió parte) sale como `STORE_CREDIT_REJECTED` con el mismo status y mensaje y su código original en `details`.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "repeticionBajoCandado" --ci
 *
 * La libreta no se puede borrar (trigger): los sobres se quedan en la base desechable; cada negocio es único.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange, type CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { issuePosRefund, type PosRefundInput } from '@/services/storeCredit/storeCreditRefund.service'
import { marcarDevolucionEnTerminal } from '@/services/storeCredit/terminalRefundMarker'
import { seedClothingSale } from '../exchanges/seedExchange'
import { pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.setTimeout(120_000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
let n = 0
const telefono = () => `55${String(10_000_000 + ((process.pid * 97 + ++n * 7919 + Date.now()) % 89_999_999)).padStart(8, '0')}`

/** Una venta de ropa de $500 (efectivo, o tarjeta de la TPV) con su clienta con teléfono y una prenda de $300 para llevarse. */
async function seed(opts: Parameters<typeof seedClothingSale>[0] = {}) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  await prisma.customer.update({ where: { id: s.customer.id }, data: { phone: telefono() } })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(300) } })
  return s
}

const reembolso = (s: Seed, over: Partial<PosRefundInput> = {}): PosRefundInput => ({
  venueId: s.venueId,
  paymentId: s.payments[0].id,
  amount: 15000,
  reason: 'RETURNED_GOODS',
  staffId: s.staffId,
  refundMethod: 'STORE_CREDIT',
  customerId: s.customer.id,
  idempotencyKey: `repetir-${randomUUID().slice(0, 12)}`,
  ...over,
})

/** Regresa la prenda y se lleva la de $300: $200 a saldo a favor de la clienta. */
const cambioASaldo = (s: Seed): CreateExchangeBody =>
  s.body({
    taken: [{ productId: s.products[3].id, quantity: 1 }],
    settlement: { kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -20000, customerId: s.customer.id },
  })

/** Una tercera sesión sostiene un candado que la primera petición toma DESPUÉS de sus comprobaciones. */
async function sostener(sql: Prisma.Sql) {
  let soltar!: () => void
  const suelta = new Promise<void>(resolve => (soltar = resolve))
  let avisar!: (pid: number) => void
  const pid = new Promise<number>(resolve => (avisar = resolve))
  const tx = prisma.$transaction(
    async t => {
      await t.$queryRaw(sql)
      avisar(await pidDe(t))
      await suelta
    },
    { timeout: 60_000, maxWait: 5_000 },
  )
  return { pid: await pid, soltar, tx }
}
const candadoDeLaClienta = (s: Seed) =>
  Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'saldo-a-favor:' + s.venueId + ':' + s.customer.id}))::text`
const elTurno = (s: Seed) => Prisma.sql`SELECT id FROM "Shift" WHERE id = ${s.shift.id} FOR UPDATE`

const esperando = async (filtro: Prisma.Sql) =>
  (
    await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 AND ${filtro} LIMIT 1`
  ).length > 0

/**
 * A arranca y se detiene en el candado que sostiene la tercera sesión; entonces cambia algo; B (la misma llave) arranca y, o bien
 * espera (a A, no a la tercera sesión), o bien termina de una vez (el defecto: un rechazo sin candado). Pase lo que pase se suelta el
 * candado y ninguna promesa queda colgada: la prueba falla rápido, no congela la corrida.
 */
async function cruzar<A, B>(candado: Prisma.Sql, primera: () => Promise<A>, cambio: () => Promise<unknown>, segunda: () => Promise<B>) {
  const tercera = await sostener(candado)
  const vigilar = <T>(p: Promise<T>) => {
    void p.catch(() => undefined)
    return p
  }
  let a: Promise<A> | undefined
  let b: Promise<B> | undefined
  try {
    a = vigilar(primera())
    for (let i = 0; !(await esperando(Prisma.sql`${tercera.pid}::int = ANY(pg_blocking_pids(pid))`)); i++) {
      if (i > 200) throw new Error('La primera petición nunca llegó al candado de la tercera sesión')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await cambio()
    let terminoB = false
    b = vigilar(segunda())
    void b.then(
      () => (terminoB = true),
      () => (terminoB = true),
    )
    for (let i = 0; !terminoB && !(await esperando(Prisma.sql`NOT (${tercera.pid}::int = ANY(pg_blocking_pids(pid)))`)); i++) {
      if (i > 200) throw new Error('La repetición ni esperó ni terminó')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  } finally {
    tercera.soltar()
    await tercera.tx.catch(() => undefined)
  }
  return Promise.allSettled([a!, b!])
}

/** El valor de una petición que debía terminar bien; si se rechazó, la prueba dice con qué código y mensaje (no sólo «rejected»). */
function valorDe<T>(r: PromiseSettledResult<T>, quien: string): T {
  if (r.status === 'fulfilled') return r.value
  const e = r.reason as { code?: string; statusCode?: number; message?: string }
  throw new Error(`${quien} se rechazó: ${e?.statusCode ?? '?'} ${e?.code ?? '(sin código)'} — ${e?.message ?? String(e)}`)
}

afterAll(async () => {
  for (const s of fixtures) {
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await s.cleanup().catch(error => console.warn('repeticionBajoCandado: la limpieza no terminó', String(error)))
  }
  await prisma.$disconnect()
})

describe('🔴 la repetición con la misma llave contesta lo que la primera escribió · Postgres real', () => {
  it('Reembolso a saldo: la terminal abre la devolución mientras A espera; B (misma llave, otra cajera) espera a A y la repite — un solo reembolso y un solo abono', async () => {
    const s = await seed({ card: true })
    const pedido = reembolso(s)

    const [a, b] = await cruzar(
      candadoDeLaClienta(s),
      () => issuePosRefund(pedido),
      async () => marcarDevolucionEnTerminal(s.payments[0].id),
      () => issuePosRefund({ ...pedido, staffId: s.seller.id }),
    )

    const [primera, repetida] = [valorDe(a, 'A'), valorDe(b, 'B (la repetición)')]
    expect(repetida.refundId).toBe(primera.refundId)
    expect(repetida.storeCredit).toEqual(primera.storeCredit)
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { venueId: s.venueId } })).toBe(1) // el ACTIVATE del sobre nuevo, y nada más
    const sobre = await prisma.giftCard.findFirstOrThrow({ where: { venueId: s.venueId, customerId: s.customer.id } })
    expect(sobre.balance.toFixed(2)).toBe('150.00')

    // Una llave NUEVA con la marca viva sí se rechaza (409), y bajo el candado: nada más se escribe.
    await expect(issuePosRefund(reembolso(s))).rejects.toMatchObject({ statusCode: 409, code: 'STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS' })
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(1)
  })

  it('Reembolso en efectivo: se prende «Sólo saldo a favor» mientras A espera; B (misma llave) la repite en vez de recibir STORE_CREDIT_ONLY', async () => {
    const s = await seed()
    const pedido = reembolso(s, { refundMethod: 'CASH', customerId: undefined })

    const [a, b] = await cruzar(
      elTurno(s),
      () => issuePosRefund(pedido),
      () =>
        prisma.venueSettings.upsert({
          where: { venueId: s.venueId },
          create: { venueId: s.venueId, storeCreditOnly: true },
          update: { storeCreditOnly: true },
        }),
      () => issuePosRefund(pedido),
    )

    const [primera, repetida] = [valorDe(a, 'A'), valorDe(b, 'B (la repetición)')]
    expect(repetida.refundId).toBe(primera.refundId)
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(1)

    // Una llave NUEVA, ya con el interruptor prendido, sí se rechaza.
    await expect(issuePosRefund(reembolso(s, { refundMethod: 'CASH', customerId: undefined }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_ONLY',
    })
  })

  it('Cambio a saldo: la terminal abre la devolución de la venta mientras A espera; B (misma llave) la repite — un solo Cambio y un solo abono', async () => {
    const s = await seed({ card: true })
    const body = cambioASaldo(s)

    const [a, b] = await cruzar(
      candadoDeLaClienta(s),
      () => createExchange(s.input(body)),
      async () => marcarDevolucionEnTerminal(s.payments[0].id),
      () => createExchange(s.input(body)),
    )

    const [primera, repetida] = [valorDe(a, 'A'), valorDe(b, 'B (la repetición)')]
    expect([primera.replay, repetida.replay]).toEqual([false, true])
    expect(repetida.exchange.id).toBe(primera.exchange.id)
    expect(repetida.exchange.settlement.storeCredit).toEqual(primera.exchange.settlement.storeCredit)
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { venueId: s.venueId } })).toBe(1)
    const sobre = await prisma.giftCard.findFirstOrThrow({ where: { venueId: s.venueId, customerId: s.customer.id } })
    expect(sobre.balance.toFixed(2)).toBe('200.00')
  })

  it('Cambio a saldo: se apagan los cambios mientras A espera; B (misma llave) la repite en vez de un rechazo definitivo', async () => {
    const s = await seed({ card: true })
    const body = cambioASaldo(s)

    const [a, b] = await cruzar(
      candadoDeLaClienta(s),
      () => createExchange(s.input(body)),
      () =>
        prisma.venueSettings.upsert({
          where: { venueId: s.venueId },
          create: { venueId: s.venueId, exchangesEnabled: false },
          update: { exchangesEnabled: false },
        }),
      () => createExchange(s.input(body)),
    )

    const [primera, repetida] = [valorDe(a, 'A'), valorDe(b, 'B (la repetición)')]
    expect([primera.replay, repetida.replay]).toEqual([false, true])
    expect(repetida.exchange.id).toBe(primera.exchange.id)
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
  })
})

describe('I2: con destino saldo a favor, un rechazo de siempre sin prefijo sale como STORE_CREDIT_REJECTED', () => {
  it('otra caja ya devolvió $400 de los $500: «No se puede devolver $200.00» llega como STORE_CREDIT_REJECTED (mismo 400 y mensaje, código original en details) y no escribe', async () => {
    const s = await seed()
    await issuePosRefund(reembolso(s, { amount: 40000, reason: 'ACCIDENTAL_CHARGE', refundMethod: undefined, customerId: undefined }))

    await expect(issuePosRefund(reembolso(s, { amount: 20000 }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_REJECTED',
      message: 'No se puede devolver $200.00: de este cobro sólo quedan $100.00 por devolver.',
      details: { originalCode: null },
    })
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(1)
    expect(await prisma.giftCard.count({ where: { venueId: s.venueId } })).toBe(0)

    // Sin saldo a favor, el mismo rechazo sale como siempre (las apps viejas ven exactamente lo de hoy).
    const deSiempre = await issuePosRefund(reembolso(s, { amount: 20000, refundMethod: undefined, customerId: undefined })).catch(e => e)
    expect(deSiempre).toMatchObject({
      statusCode: 400,
      message: 'No se puede devolver $200.00: de este cobro sólo quedan $100.00 por devolver.',
    })
    expect(deSiempre.code).toBeUndefined()
  })
})
