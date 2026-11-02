/**
 * El Cambio con saldo a favor contra Postgres REAL (spec 2026-10-30-saldo-a-favor §5.4, tarea S5). Lo que un mock no prueba:
 * - la diferencia a favor se abona al sobre de la clienta en la MISMA transacción que el Cambio: si el abono lanza (tope, sin
 *   teléfono), no queda ni el cambio, ni la venta nueva, ni la devolución;
 * - la respuesta, la repetición por llave y la bitácora `EXCHANGE_CREATED` dicen a quién y cuánto;
 * - una app vieja que manda efectivo en una venta con tarjeta sigue recibiendo el 422 de hoy;
 * - «Sólo saldo a favor»: sin pieza con Defecto, efectivo no; con Defecto, sí;
 * - la cadena real con raíz en tarjeta: lo pagado con crédito sí se abona, nunca más de lo que la raíz todavía respalda.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "cambioASaldo" --ci
 *
 * La libreta no se puede borrar (trigger): los sobres se quedan en la base desechable; cada negocio es único.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange, type CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { seedClothingSale } from '../exchanges/seedExchange'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
let n = 0
let ref = 0

/** Una venta de ropa (efectivo o tarjeta procesada por Avoqado), su clienta con teléfono y una prenda de $300 para llevarse. */
async function seed(opts: Parameters<typeof seedClothingSale>[0] = {}, conTelefono = true) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  if (conTelefono)
    await prisma.customer.update({
      where: { id: s.customer.id },
      data: { phone: `55${String(10_000_000 + ((process.pid * 97 + ++n * 7919 + Date.now()) % 89_999_999)).padStart(8, '0')}` },
    })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(300) } })
  return s
}

/** Regresa la prenda y se lleva la de $300: la diferencia a favor, por el medio que se pida. */
const cambioMasBarato = (
  s: Seed,
  settlement: Partial<CreateExchangeBody['settlement']>,
  extra: Partial<CreateExchangeBody> = {},
  diferenciaCents = -20000,
) =>
  s.body({
    taken: [{ productId: s.products[3].id, quantity: 1 }],
    settlement: {
      kind: 'PAYOUT',
      method: 'STORE_CREDIT',
      expectedDifferenceCents: diferenciaCents,
      customerId: s.customer.id,
      ...settlement,
    },
    ...extra,
  })

/** Lo que la base dice que se escribió en la sucursal: para «no escribió nada». */
const escrito = async (s: Seed) => ({
  cambios: await prisma.exchange.count({ where: { venueId: s.venueId } }),
  devoluciones: await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } }),
  sobres: await prisma.giftCard.count({ where: { venueId: s.venueId } }),
  ventas: await prisma.order.count({ where: { venueId: s.venueId } }),
})

const devolucionDeLaTerminal = (s: Seed, cents: number) =>
  recordRefund(
    s.venueId,
    {
      venueId: s.venueId,
      originalPaymentId: s.payments[0].id,
      originalOrderId: s.order.id,
      amount: cents,
      reason: 'CUSTOMER_REQUEST',
      merchantAccountId: s.payments[0].merchantAccountId,
      authorizationNumber: `AUT${++ref}`,
      referenceNumber: `REF${ref}`,
      isPartialRefund: cents < 50000,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: `${s.venueId}-devolucion-${ref}`,
    } as Parameters<typeof recordRefund>[1],
    s.staffId,
  )

afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

describe('el Cambio con saldo a favor · Postgres real', () => {
  it('venta con tarjeta $500 → cambio por $300 → $200 a saldo: la respuesta, la fila, el sobre, la bitácora y la repetición', async () => {
    const s = await seed({ card: true })
    const body = cambioMasBarato(s, {})
    const { exchange, replay } = await createExchange(s.input(body))

    expect(replay).toBe(false)
    expect(exchange.status).toBe('COMPLETED')
    expect(exchange.settlement).toMatchObject({
      kind: 'PAYOUT',
      method: 'STORE_CREDIT',
      amountCents: 20000,
      storeCredit: {
        customerId: s.customer.id,
        customerName: expect.stringContaining('Clienta'),
        amountCents: 20000,
        newBalanceCents: 20000,
        phoneMismatch: false,
      },
    })
    const tramo = exchange.settlement.sources.find(x => x.amountCents === 20000)!
    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: tramo.refundPaymentId }, include: { tenderType: true } })
    expect(fila).toMatchObject({ method: 'OTHER', merchantAccountId: null, tenderSatFormaPago: '17', fundsFlow: 'EXTERNAL_RECORDED' })
    expect(fila.tenderType?.systemKind).toBe('STORE_CREDIT')
    expect(fila.amount.toFixed(2)).toBe('-200.00')
    expect(fila.processorData).toMatchObject({
      originalPaymentId: s.payments[0].id,
      originalMethod: 'CREDIT_CARD',
      exchange: { exchangeId: exchange.id, role: 'DIFFERENCE' },
    })
    // El cajón no se toca: el saldo a favor no es efectivo.
    expect(await prisma.cashDrawerEvent.count({ where: { venueId: s.venueId } })).toBe(0)

    const sobres = await prisma.giftCard.findMany({ where: { venueId: s.venueId, customerId: s.customer.id }, take: 5 })
    expect(sobres).toHaveLength(1)
    expect(sobres[0]).toMatchObject({ status: 'ACTIVE' })
    expect(sobres[0].balance.toFixed(2)).toBe('200.00')
    const movimientos = await prisma.giftCardActivity.findMany({ where: { giftCardId: sobres[0].id }, take: 5 })
    expect(movimientos).toHaveLength(1)
    expect(movimientos[0]).toMatchObject({ type: 'ACTIVATE', refundPaymentId: fila.id, operationKey: `saldo-a-favor:${fila.id}` })
    expect(movimientos[0].note).toContain('Cambio')

    const bitacora = await prisma.activityLog.findFirstOrThrow({ where: { venueId: s.venueId, action: 'EXCHANGE_CREATED' } })
    expect(bitacora.data).toMatchObject({
      settlement: { method: 'STORE_CREDIT', amount: 200 },
      storeCredit: { customerId: s.customer.id, amount: 200, newBalance: 200, phoneMismatch: false },
    })

    // La app murió tras el commit y reenvía: el mismo Cambio, el mismo saldo, ni un abono más.
    const otra = await createExchange(s.input(body))
    expect(otra.replay).toBe(true)
    expect(otra.exchange.settlement.storeCredit).toEqual(exchange.settlement.storeCredit)
    expect(await prisma.giftCardActivity.count({ where: { venueId: s.venueId } })).toBe(1)
  })

  it('una app vieja que manda CASH en una venta con tarjeta sigue recibiendo el 422 de hoy, sin escribir nada', async () => {
    const s = await seed({ card: true })
    const antes = await escrito(s)
    await expect(createExchange(s.input(cambioMasBarato(s, { method: 'CASH', customerId: undefined })))).rejects.toMatchObject({
      statusCode: 422,
      code: 'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      details: { reason: 'INSUFFICIENT_FOR_METHOD', payoutOptions: [expect.objectContaining({ method: 'STORE_CREDIT' })] },
    })
    expect(await escrito(s)).toEqual(antes)
  })

  it('tope → STORE_CREDIT_OVER_CAP sin escribir el cambio (ni la venta nueva, ni la devolución, ni el sobre)', async () => {
    const s = await seed({ card: true, list: 10500 })
    const antes = await escrito(s)
    await expect(createExchange(s.input(cambioMasBarato(s, {}, {}, -1020000)))).rejects.toMatchObject({
      statusCode: 422,
      code: 'STORE_CREDIT_OVER_CAP',
    })
    expect(await escrito(s)).toEqual(antes)
  })

  it('la clienta sin teléfono → STORE_CREDIT_CUSTOMER_PHONE_REQUIRED, sin escribir nada', async () => {
    const s = await seed({ card: true }, false)
    const antes = await escrito(s)
    await expect(createExchange(s.input(cambioMasBarato(s, {})))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED',
    })
    expect(await escrito(s)).toEqual(antes)
  })

  it('una clienta de otro negocio → STORE_CREDIT_CUSTOMER_REQUIRED, sin escribir nada', async () => {
    const s = await seed({ card: true })
    const otra = await seed()
    const antes = await escrito(s)
    await expect(createExchange(s.input(cambioMasBarato(s, { customerId: otra.customer.id })))).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_CUSTOMER_REQUIRED',
    })
    expect(await escrito(s)).toEqual(antes)
  })

  describe('«Sólo saldo a favor» prendido', () => {
    it('sin pieza con Defecto, efectivo no (400 STORE_CREDIT_ONLY, sin escribir); con Defecto, sí; y saldo a favor siempre', async () => {
      const s = await seed({ quantity: 3 })
      await prisma.venueSettings.upsert({
        where: { venueId: s.venueId },
        update: { storeCreditOnly: true },
        create: { venueId: s.venueId, storeCreditOnly: true },
      })
      const antes = await escrito(s)
      const linea = (reason: 'SIZE' | 'DEFECT') => ({
        returned: [{ orderItemId: s.order.items[0].id, quantity: 1, restock: true, reason }],
      })
      await expect(
        createExchange(
          s.input(cambioMasBarato(s, { method: 'CASH', customerId: undefined, cashDrawerSessionId: s.drawer.id }, linea('SIZE'))),
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'STORE_CREDIT_ONLY',
        details: { payoutOptions: [expect.objectContaining({ method: 'STORE_CREDIT' })] },
      })
      expect(await escrito(s)).toEqual(antes)

      const conDefecto = await createExchange(
        s.input(cambioMasBarato(s, { method: 'CASH', customerId: undefined, cashDrawerSessionId: s.drawer.id }, linea('DEFECT'))),
      )
      expect(conDefecto.exchange.settlement).toMatchObject({ method: 'CASH', amountCents: 20000 })

      const aSaldo = await createExchange(s.input(cambioMasBarato(s, {}, linea('SIZE'))))
      expect(aSaldo.exchange.settlement.storeCredit).toMatchObject({ amountCents: 20000, newBalanceCents: 20000 })
    })

    it('🔴 D-1: sin las llaves el interruptor no restringe (no se puede dar saldo): un Cambio en efectivo sin Defecto pasa', async () => {
      const s = await seed()
      await prisma.venueSettings.upsert({
        where: { venueId: s.venueId },
        update: { storeCreditOnly: true },
        create: { venueId: s.venueId, storeCreditOnly: true },
      })
      const llave = process.env.GIFT_CARD_HMAC_KEY
      delete process.env.GIFT_CARD_HMAC_KEY
      try {
        const { exchange } = await createExchange(
          s.input(cambioMasBarato(s, { method: 'CASH', customerId: undefined, cashDrawerSessionId: s.drawer.id })),
        )
        expect(exchange.settlement).toMatchObject({ method: 'CASH', amountCents: 20000 })
      } finally {
        process.env.GIFT_CARD_HMAC_KEY = llave
      }
    })
  })

  describe('crédito de cambio con raíz en tarjeta bancaria', () => {
    /** Compra con tarjeta $500 → Cambio parejo REAL (la venta nueva se paga con crédito) → el body del segundo Cambio, más barato. */
    async function cadena(s: Seed) {
      const { exchange: parejo } = await createExchange(s.input())
      const item = parejo.lines.taken[0].newOrderItemIds[0]
      const creditId = parejo.paymentIds[0]
      return {
        creditId,
        body: (settlement: Partial<CreateExchangeBody['settlement']>) =>
          cambioMasBarato(s, settlement, {
            originalPaymentId: creditId,
            returned: [{ orderItemId: item, quantity: 1, restock: true, reason: 'SIZE' }],
          }),
      }
    }

    it('hoy en efectivo no se puede (va a la terminal); a saldo a favor sí, con el origen fiscal de la raíz', async () => {
      const s = await seed({ card: true })
      const c = await cadena(s)
      await expect(createExchange(s.input(c.body({ method: 'CASH', customerId: undefined })))).rejects.toMatchObject({
        details: { reason: 'INSUFFICIENT_FOR_METHOD' },
      })

      const { exchange } = await createExchange(s.input(c.body({})))
      expect(exchange.settlement.storeCredit).toMatchObject({ amountCents: 20000, newBalanceCents: 20000 })
      const tramo = exchange.settlement.sources.find(x => x.amountCents === 20000)!
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: tramo.refundPaymentId } })).processorData).toMatchObject({
        originalPaymentId: c.creditId,
        rootPaymentId: s.payments[0].id,
        originalMethod: 'CREDIT_CARD',
      })
    })

    it('la terminal ya devolvió la compra original → STORE_CREDIT_ROOT_ALREADY_REFUNDED, sin escribir nada', async () => {
      const s = await seed({ card: true })
      const c = await cadena(s)
      await devolucionDeLaTerminal(s, 50000)
      const antes = await escrito(s)
      await expect(createExchange(s.input(c.body({})))).rejects.toMatchObject({
        statusCode: 422,
        code: 'STORE_CREDIT_ROOT_ALREADY_REFUNDED',
        details: { maxCents: 0 },
      })
      expect(await escrito(s)).toEqual(antes)
    })
  })
})
