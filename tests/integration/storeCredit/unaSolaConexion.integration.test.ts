/**
 * S10 r2, familia A (Codex código r2 P2-a): dentro de la transacción de dinero, toda consulta va por SU transacción, nunca por el cliente
 * global. Con UNA conexión en el pool la diferencia es tajante: la transacción retiene la única conexión, y una consulta global dentro
 * de ella espera una conexión que nunca llega (P2024 a los 10 s de `pool_timeout`). En producción pasa con tantos Cambios a la vez como
 * conexiones (18 por default): se traban todos, también los de efectivo de las apps viejas.
 *
 * Los servicios se cargan en un registro de módulos APARTE (`jest.isolateModulesAsync`) con su propio cliente de UNA conexión; la
 * siembra y las lecturas de la prueba usan el cliente de siempre. Se recorren los caminos de dinero de la rama: el Cambio (parejo en
 * efectivo, y a saldo a favor), el Reembolso del POS (a saldo, y en efectivo con «Sólo saldo» mirado bajo el candado) y la devolución
 * tardía de la terminal sobre un cobro con saldo a favor (S7: anomalía y sobre congelado en la misma transacción).
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "unaSolaConexion" --ci
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type * as ServicioDelCambio from '@/services/exchanges/exchange.service'
import type * as ServicioDelReembolso from '@/services/storeCredit/storeCreditRefund.service'
import type * as ServicioDeLaTerminal from '@/services/tpv/refund.tpv.service'
import { seedClothingSale } from '../exchanges/seedExchange'

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

async function seed(opts: Parameters<typeof seedClothingSale>[0] = {}) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  await prisma.customer.update({ where: { id: s.customer.id }, data: { phone: telefono() } })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(300) } })
  return s
}

type Servicios = {
  cambio: typeof ServicioDelCambio
  reembolso: typeof ServicioDelReembolso
  terminal: typeof ServicioDeLaTerminal
}

/** Corre `trabajo` con los servicios de producción cargados sobre un cliente de Prisma con UNA sola conexión. */
async function conUnaConexion<T>(trabajo: (s: Servicios) => Promise<T>): Promise<T> {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  url.searchParams.set('connection_limit', '1')
  const antes = process.env.DATABASE_URL
  process.env.DATABASE_URL = url.toString()
  let cliente: { $disconnect: () => Promise<void> } | undefined
  let resultado: T | undefined
  try {
    await jest.isolateModulesAsync(async () => {
      cliente = require('@/utils/prismaClient').default
      resultado = await trabajo({
        cambio: require('@/services/exchanges/exchange.service'),
        reembolso: require('@/services/storeCredit/storeCreditRefund.service'),
        terminal: require('@/services/tpv/refund.tpv.service'),
      })
    })
  } finally {
    process.env.DATABASE_URL = antes
    await cliente?.$disconnect()
  }
  return resultado as T
}

afterAll(async () => {
  for (const s of fixtures) {
    await prisma.moneyAnomaly.deleteMany({ where: { expectedState: { path: ['venueId'], equals: s.venueId } } })
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await s.cleanup().catch(error => console.warn('unaSolaConexion: la limpieza no terminó', String(error)))
  }
  await prisma.$disconnect()
})

describe('🔴 con UNA conexión en el pool, los caminos de dinero de la rama terminan (nada consulta por fuera de su transacción)', () => {
  it('el control: el cliente aislado se arma con UNA conexión (la receta de producción, `buildDatasourceUrl`)', async () => {
    await conUnaConexion(async () => {
      const { buildDatasourceUrl } = require('@/utils/prismaClient') as typeof import('@/utils/prismaClient')
      expect(new URL(buildDatasourceUrl()!).searchParams.get('connection_limit')).toBe('1')
    })
  })

  it('un Cambio parejo en efectivo (lo que mandan las apps de hoy) termina', async () => {
    const s = await seed()
    const r = await conUnaConexion(({ cambio }) => cambio.createExchange(s.input()))
    expect(r).toMatchObject({ replay: false, exchange: { status: 'COMPLETED' } })
  })

  it('un Cambio a saldo a favor termina y abona', async () => {
    const s = await seed({ card: true })
    const body = s.body({
      taken: [{ productId: s.products[3].id, quantity: 1 }],
      settlement: { kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -20000, customerId: s.customer.id },
    })
    const r = await conUnaConexion(({ cambio }) => cambio.createExchange(s.input(body)))
    expect(r.exchange.settlement.storeCredit).toMatchObject({ amountCents: 20000 })
  })

  it('un Reembolso del POS a saldo a favor termina y abona; después la terminal devuelve el cobro y se congela el sobre (S7)', async () => {
    const s = await seed({ card: true })
    const r = await conUnaConexion(({ reembolso }) =>
      reembolso.issuePosRefund({
        venueId: s.venueId,
        paymentId: s.payments[0].id,
        amount: 15000,
        reason: 'RETURNED_GOODS',
        staffId: s.staffId,
        refundMethod: 'STORE_CREDIT',
        customerId: s.customer.id,
        idempotencyKey: `una-conexion-${randomUUID().slice(0, 12)}`,
      }),
    )
    expect(r.storeCredit).toMatchObject({ amountCents: 15000 })

    await conUnaConexion(({ terminal }) =>
      terminal.recordRefund(
        s.venueId,
        {
          venueId: s.venueId,
          originalPaymentId: s.payments[0].id,
          originalOrderId: s.order.id,
          amount: 50000,
          reason: 'CUSTOMER_REQUEST',
          merchantAccountId: s.payments[0].merchantAccountId,
          authorizationNumber: 'AUT-UNA-CONEXION',
          referenceNumber: 'REF-UNA-CONEXION',
          isPartialRefund: false,
          currency: 'MXN',
          processor: 'angelpay',
          idempotencyKey: `${s.venueId.slice(-10)}-terminal-una`,
        } as Parameters<typeof ServicioDeLaTerminal.recordRefund>[1],
        s.staffId,
      ),
    )
    const sobre = await prisma.giftCard.findFirstOrThrow({ where: { venueId: s.venueId, customerId: s.customer.id } })
    expect(sobre.status).toBe('BLOCKED')
  })

  it('un Reembolso del POS en efectivo con devolución de mercancía («Sólo saldo» se mira bajo el candado) termina', async () => {
    const s = await seed()
    const r = await conUnaConexion(({ reembolso }) =>
      reembolso.issuePosRefund({
        venueId: s.venueId,
        paymentId: s.payments[0].id,
        amount: 10000,
        reason: 'RETURNED_GOODS',
        staffId: s.staffId,
        refundMethod: 'CASH',
        idempotencyKey: `una-conexion-${randomUUID().slice(0, 12)}`,
      }),
    )
    expect(r).toMatchObject({ amount: 100 })
  })
})
