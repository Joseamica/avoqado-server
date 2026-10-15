import { Prisma } from '@prisma/client'
import {
  activarSobresDeCuentaPagadaEnTx,
  canjearSobresEnTx,
  desactivarSobresDeCuentaEnTx,
  desactivarSobresPendientesDeCuentaEnTx,
  lockGiftCardsForUpdate,
  operarSobreDeGerenteEnTx,
  revertirCanjeEnTx,
  saldoUsable,
  sobresDelCanje,
  type LockedGiftCard,
} from '@/services/giftCards/giftCardLedger'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: string | number) => new Prisma.Decimal(v)
const AHORA = new Date('2026-10-14T18:00:00.000Z')
const VENUE = 'venue-1'

function sobre(over: Partial<LockedGiftCard> = {}): LockedGiftCard {
  return {
    id: 'gc-1',
    venueId: VENUE,
    codeHash: 'hash-del-codigo-gc-1',
    status: 'ACTIVE',
    balance: D(1000),
    initialAmount: D(1000),
    expiresAt: null,
    activatedAt: new Date('2026-09-01T18:00:00.000Z'),
    validityMonths: null,
    customerId: null,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({ now: AHORA, doNotFake: ['nextTick', 'setImmediate'] })
  prismaMock.$queryRaw.mockReset()
  prismaMock.giftCard.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.giftCard.findMany.mockReset().mockResolvedValue([])
  prismaMock.giftCard.findFirst.mockReset()
  prismaMock.giftCardActivity.create
    .mockReset()
    .mockImplementation(async ({ data }: any) => ({ id: `act-${prismaMock.giftCardActivity.create.mock.calls.length}`, ...data }))
  prismaMock.giftCardActivity.findMany.mockReset().mockResolvedValue([])
  prismaMock.giftCardActivity.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.giftCardActivity.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.giftCardActivity.count.mockReset().mockResolvedValue(0)
  prismaMock.giftCardActivity.groupBy.mockReset().mockResolvedValue([])
  prismaMock.orderItem.findMany.mockReset().mockResolvedValue([])
  prismaMock.payment.aggregate.mockReset()
  prismaMock.venue.findUnique.mockResolvedValue({ name: 'IQ Collection' })
  prismaMock.moneyAnomaly.createMany.mockResolvedValue({ count: 1 })
})
afterEach(() => jest.useRealTimers())

describe('saldoUsable', () => {
  it('suma sólo los sobres ACTIVE que no han vencido', () => {
    const cards = [
      sobre({ id: 'a', balance: D(100) }),
      sobre({ id: 'b', balance: D(50), expiresAt: new Date('2026-10-15T18:00:00Z') }),
      sobre({ id: 'c', balance: D(70), status: 'BLOCKED' }),
      sobre({ id: 'd', balance: D(30), expiresAt: new Date('2026-10-14T17:59:59Z') }),
      sobre({ id: 'e', balance: D(10), status: 'PENDING' }),
    ]
    expect(saldoUsable(cards, AHORA).toFixed(2)).toBe('150.00')
  })
})

describe('lockGiftCardsForUpdate', () => {
  it('sin ids no consulta', async () => {
    await expect(lockGiftCardsForUpdate(prismaMock, [])).resolves.toEqual([])
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('un SELECT … FOR UPDATE en el orden fijo (vencen antes → activados antes → id) y sin ids repetidos', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ ...sobre(), status: 'ACTIVE' }])
    const out = await lockGiftCardsForUpdate(prismaMock, ['gc-1', 'gc-1'])
    expect(out).toEqual([sobre()])
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')
    expect(sql).toMatch(/ORDER BY "expiresAt" ASC NULLS LAST, "activatedAt" ASC NULLS LAST, id ASC\s+FOR UPDATE/)
    // r1 (A-1): la huella vigente del código viaja en la fila bloqueada.
    expect(sql).toContain('"codeHash"')
  })
})

describe('canjearSobresEnTx', () => {
  const base = { venueId: VENUE, orderId: 'order-1', paymentId: 'pay-1', staffId: 'staff-1', deviceId: 'dev-1' }

  it('descuenta primero del sobre que vence antes y sigue con el siguiente; un REDEEM por sobre con su saldo después', async () => {
    const pronto = sobre({ id: 'gc-pronto', balance: D(300), expiresAt: new Date('2026-12-01T18:00:00Z') })
    const sinVencer = sobre({ id: 'gc-libre', balance: D(1000) })

    const out = await canjearSobresEnTx(prismaMock, { ...base, amount: D(500), cards: [pronto, sinVencer] })

    expect(out).toEqual([
      { giftCardId: 'gc-pronto', amount: D(300), balanceAfter: D(0) },
      { giftCardId: 'gc-libre', amount: D(200), balanceAfter: D(800) },
    ])
    expect(prismaMock.giftCard.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'gc-pronto',
        venueId: VENUE,
        status: 'ACTIVE',
        balance: { gte: D(300) },
        OR: [{ expiresAt: null }, { expiresAt: { gt: AHORA } }],
      },
      data: { balance: { decrement: D(300) } },
    })
    expect(prismaMock.giftCardActivity.create).toHaveBeenNthCalledWith(1, {
      data: {
        giftCardId: 'gc-pronto',
        venueId: VENUE,
        type: 'REDEEM',
        amount: D(300),
        balanceAfter: D(0),
        paymentId: 'pay-1',
        orderId: 'order-1',
        staffId: 'staff-1',
        deviceId: 'dev-1',
      },
    })
  })

  it('si no alcanza responde «quedan $X» y no escribe nada', async () => {
    await expect(canjearSobresEnTx(prismaMock, { ...base, amount: D(500), cards: [sobre({ balance: D(300) })] })).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      statusCode: 409,
      message: 'Quedan $300.00 en la tarjeta de regalo.',
      details: { saldoDisponible: 300 },
    })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('un sobre bloqueado o vencido no cuenta como saldo', async () => {
    const cards = [sobre({ status: 'BLOCKED' }), sobre({ id: 'gc-2', expiresAt: new Date('2026-10-01T18:00:00Z') })]
    await expect(canjearSobresEnTx(prismaMock, { ...base, amount: D(100), cards })).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      details: { saldoDisponible: 0 },
    })
  })

  it('si la escritura condicionada no encuentra la fila (otro la movió), rechaza: la transacción se revierte entera', async () => {
    prismaMock.giftCard.updateMany.mockResolvedValue({ count: 0 })
    await expect(canjearSobresEnTx(prismaMock, { ...base, amount: D(100), cards: [sobre()] })).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
    })
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('un sobre de OTRO negocio no existe aquí', async () => {
    await expect(canjearSobresEnTx(prismaMock, { ...base, amount: D(100), cards: [sobre({ venueId: 'venue-2' })] })).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('monto en cero o con más de dos decimales: GIFT_CARD_AMOUNT_OUT_OF_RANGE', async () => {
    await expect(canjearSobresEnTx(prismaMock, { ...base, amount: D(0), cards: [sobre()] })).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
    })
    await expect(canjearSobresEnTx(prismaMock, { ...base, amount: D('10.001'), cards: [sobre()] })).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
    })
  })
})

describe('activarSobresDeCuentaPagadaEnTx', () => {
  const pendiente = (id: string, monto: number, validityMonths: number | null) =>
    sobre({ id, status: 'PENDING', balance: D(0), initialAmount: D(monto), activatedAt: null, validityMonths })
  // Dos agregados: lo cobrado (sin REFUND) y lo devuelto (REFUND, guardado en NEGATIVO). r1, F8.
  const cobradoYDevuelto = (cobrado: number, devuelto = 0) =>
    prismaMock.payment.aggregate.mockImplementation(async ({ where }: any) => ({
      _sum: { amount: where.type === 'REFUND' ? D(-devuelto) : D(cobrado) },
    }))

  it('con la pista de renglones y ninguno de tarjeta, no consulta la base (la venta normal no paga nada extra)', async () => {
    await expect(
      activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1', items: [{ giftCardId: null }, {}] }),
    ).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.findMany).not.toHaveBeenCalled()
  })

  it('sin sobres PENDING de la cuenta no hace nada', async () => {
    await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.findMany).toHaveBeenCalledWith({
      where: { venueId: VENUE, status: 'PENDING', orderItem: { is: { orderId: 'order-1' } } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 21,
    })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('lo cobrado (sin propina) = suma de los sobres: activa, saldo = monto, vence con la política congelada y escribe ACTIVATE', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }, { id: 'gc-2' }])
    prismaMock.orderItem.findMany.mockResolvedValue([
      { id: 'oi-1', giftCardId: 'gc-1', total: D(500) },
      { id: 'oi-2', giftCardId: 'gc-2', total: D(1000) },
    ])
    cobradoYDevuelto(1500)
    prismaMock.$queryRaw.mockResolvedValue([pendiente('gc-1', 500, 12), pendiente('gc-2', 1000, null)])

    const out = await activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1', staffId: 'staff-1' })

    expect(out).toEqual({ activated: ['gc-1', 'gc-2'] })
    expect(prismaMock.payment.aggregate).toHaveBeenCalledWith({
      where: { venueId: VENUE, orderId: 'order-1', status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
      _sum: { amount: true },
    })
    expect(prismaMock.payment.aggregate).toHaveBeenCalledWith({
      where: { venueId: VENUE, orderId: 'order-1', status: 'COMPLETED', type: 'REFUND' },
      _sum: { amount: true },
    })
    expect(prismaMock.giftCard.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'gc-1', venueId: VENUE, status: 'PENDING' },
      data: { status: 'ACTIVE', balance: D(500), activatedAt: AHORA, expiresAt: new Date('2027-10-14T18:00:00.000Z') },
    })
    expect(prismaMock.giftCard.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'gc-2', venueId: VENUE, status: 'PENDING' },
      data: { status: 'ACTIVE', balance: D(1000), activatedAt: AHORA, expiresAt: null },
    })
    expect(prismaMock.giftCardActivity.create).toHaveBeenNthCalledWith(1, {
      data: {
        giftCardId: 'gc-1',
        venueId: VENUE,
        type: 'ACTIVATE',
        amount: D(500),
        balanceAfter: D(500),
        orderId: 'order-1',
        staffId: 'staff-1',
      },
    })
  })

  it('si lo cobrado no cuadra con los sobres, NO activa y deja un MoneyAnomaly', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.orderItem.findMany.mockResolvedValue([{ id: 'oi-1', giftCardId: 'gc-1', total: D(500) }])
    cobradoYDevuelto(400)

    await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            category: 'GIFT_CARD_ACTIVATION_AMOUNT_MISMATCH',
            stripeEventId: 'giftcard:ACTIVATION_AMOUNT_MISMATCH:order-1',
          }),
        ],
        skipDuplicates: true,
      }),
    )
  })

  it('🔴 r1 (F8): cobrado = sobres, pero la terminal devolvió parte: lo conservado no cubre, NO activa y la anomalía dice DINERO_DEVUELTO', async () => {
    // Tarjeta $500: abono $200 → la terminal lo devuelve (REFUND −200) → abono final $300. `computeOrderBalance` ve $500
    // pagados (no resta reembolsos) y la cuenta queda PAID, pero el negocio sólo conservó $300.
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.orderItem.findMany.mockResolvedValue([{ id: 'oi-1', giftCardId: 'gc-1', total: D(500) }])
    cobradoYDevuelto(500, 200)
    prismaMock.$queryRaw.mockResolvedValue([pendiente('gc-1', 500, null)])

    await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
    const anomalia = prismaMock.moneyAnomaly.createMany.mock.calls[0][0].data[0]
    expect(anomalia).toMatchObject({
      category: 'GIFT_CARD_ACTIVATION_AMOUNT_MISMATCH',
      stripeEventId: 'giftcard:ACTIVATION_AMOUNT_MISMATCH:order-1',
    })
    expect(JSON.stringify(anomalia)).toContain('DINERO_DEVUELTO')
    expect(JSON.stringify(anomalia)).toContain('200.00')
  })

  it('una cuenta MIXTA (un renglón sin tarjeta) nunca activa', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.orderItem.findMany.mockResolvedValue([
      { id: 'oi-1', giftCardId: 'gc-1', total: D(500) },
      { id: 'oi-2', giftCardId: null, total: D(80) },
    ])
    cobradoYDevuelto(580)

    await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalled()
  })

  it('un renglón que cobró MENOS que el monto de su sobre (descuento colado): NO activa y la anomalía dice MONTO_DE_SOBRE_DISTINTO', async () => {
    // Lo cobrado cuadra con los renglones ($400), pero el sobre vale $500: activarlo regalaría $100.
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.orderItem.findMany.mockResolvedValue([{ id: 'oi-1', giftCardId: 'gc-1', total: D(400) }])
    cobradoYDevuelto(400)
    prismaMock.$queryRaw.mockResolvedValue([pendiente('gc-1', 500, null)])

    await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
    const anomalia = prismaMock.moneyAnomaly.createMany.mock.calls[0][0].data[0]
    expect(anomalia).toMatchObject({
      category: 'GIFT_CARD_ACTIVATION_AMOUNT_MISMATCH',
      stripeEventId: 'giftcard:ACTIVATION_AMOUNT_MISMATCH:order-1',
    })
    expect(JSON.stringify(anomalia)).toContain('MONTO_DE_SOBRE_DISTINTO')
  })

  it('otro camino ya lo activó (bajo candado ya no está PENDING): no lo vuelve a activar', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.orderItem.findMany.mockResolvedValue([{ id: 'oi-1', giftCardId: 'gc-1', total: D(500) }])
    cobradoYDevuelto(500)
    prismaMock.$queryRaw.mockResolvedValue([sobre({ id: 'gc-1', status: 'ACTIVE', initialAmount: D(500) })])

    await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
  })

  // Ruling A6 (coordinador): una cuenta de tarjetas CANCELADA —sobres DEACTIVATED— recibe dinero tarde (reabrirSiRecibeDinero,
  // PAY_CASH reproducido, terminal tardía) y queda PAGADA. Nunca se reviven los sobres; se avisa con un MoneyAnomaly propio.
  describe('ruling A6: cuenta cancelada con sobres DEACTIVATED que queda pagada', () => {
    /** La consulta de PENDING no encuentra nada; la de todos los sobres de la cuenta devuelve `todos`. */
    const sobresDeLaCuenta = (todos: Array<{ id: string; status: string }>) =>
      prismaMock.giftCard.findMany.mockImplementation(async ({ where }: any) =>
        where.status === 'PENDING' ? todos.filter(s => s.status === 'PENDING').map(s => ({ id: s.id })) : todos,
      )

    it('🔴 NO reactiva y deja UN MoneyAnomaly PAID_WITH_DEACTIVATED con la cuenta, lo cobrado y cada sobre con su estado', async () => {
      sobresDeLaCuenta([
        { id: 'gc-1', status: 'DEACTIVATED' },
        { id: 'gc-2', status: 'DEACTIVATED' },
      ])
      cobradoYDevuelto(1500)

      await expect(
        activarSobresDeCuentaPagadaEnTx(prismaMock, {
          venueId: VENUE,
          orderId: 'order-1',
          staffId: 'staff-1',
          items: [{ giftCardId: 'gc-1' }, { giftCardId: 'gc-2' }],
        }),
      ).resolves.toEqual({ activated: [] })

      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
      expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
      expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalledWith({
        data: [
          {
            category: 'GIFT_CARD_PAID_WITH_DEACTIVATED',
            stripeEventId: 'giftcard:PAID_WITH_DEACTIVATED:order-1',
            expectedState: { venueId: VENUE, id: 'order-1', check: 'PAID_WITH_DEACTIVATED' },
            observedState: {
              motivo: 'COBRO_CON_SOBRES_DESACTIVADOS',
              orderId: 'order-1',
              cobrado: '1500.00',
              reembolsado: '0.00',
              sobres: [
                { id: 'gc-1', status: 'DEACTIVATED' },
                { id: 'gc-2', status: 'DEACTIVATED' },
              ],
            },
          },
        ],
        skipDuplicates: true,
      })
    })

    it('sobres ya ACTIVE (otro camino los activó: re-llamada idempotente): ni anomalía ni consulta del dinero', async () => {
      sobresDeLaCuenta([{ id: 'gc-1', status: 'ACTIVE' }])

      await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
      expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
      expect(prismaMock.moneyAnomaly.createMany).not.toHaveBeenCalled()
      // A6 r1: el segundo cierre de una cuenta normal de tarjetas (terminal, reconciliador) no escribe NADA ni toma candados.
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
      expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
    })

    it('venta cancelada CON el dinero devuelto completo (R2): no hay nada que avisar', async () => {
      sobresDeLaCuenta([{ id: 'gc-1', status: 'DEACTIVATED' }])
      cobradoYDevuelto(500, 500)

      await expect(activarSobresDeCuentaPagadaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({ activated: [] })
      expect(prismaMock.moneyAnomaly.createMany).not.toHaveBeenCalled()
      expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    })
  })
})

describe('revertirCanjeEnTx', () => {
  const base = { venueId: VENUE, originalPaymentId: 'pay-1', refundPaymentId: 'refund-1', staffId: 'staff-1' }

  it('regresa el saldo al sobre del canje con un REDEEM_REVERSAL que apunta al REDEEM', async () => {
    prismaMock.giftCardActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'red-1', giftCardId: 'gc-1', amount: D(400), orderId: 'order-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(600) })])

    const out = await revertirCanjeEnTx(prismaMock, { ...base, amount: D(150) })

    expect(out).toEqual([{ giftCardId: 'gc-1', amount: D(150), balanceAfter: D(750) }])
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE },
      data: { balance: { increment: D(150) } },
    })
    expect(prismaMock.giftCardActivity.create).toHaveBeenCalledWith({
      data: {
        giftCardId: 'gc-1',
        venueId: VENUE,
        type: 'REDEEM_REVERSAL',
        amount: D(150),
        balanceAfter: D(750),
        refundPaymentId: 'refund-1',
        reversesActivityId: 'red-1',
        orderId: 'order-1',
        staffId: 'staff-1',
      },
    })
  })

  it('nunca regresa más de lo canjeado menos lo ya regresado', async () => {
    prismaMock.giftCardActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'red-1', giftCardId: 'gc-1', amount: D(400), orderId: 'order-1' }])
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([{ reversesActivityId: 'red-1', _sum: { amount: D(300) } }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(900) })])

    await expect(revertirCanjeEnTx(prismaMock, { ...base, amount: D(150) })).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
    })
  })

  it('si el reembolso excede lo que queda por regresar, rechaza ANTES de escribir (un llamador que atrape el error no deja medio reverso)', async () => {
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'red-1', giftCardId: 'gc-1', amount: D(100), orderId: 'order-1' },
      { id: 'red-2', giftCardId: 'gc-2', amount: D(100), orderId: 'order-1' },
    ])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(0) }), sobre({ id: 'gc-2', balance: D(0) })])

    await expect(revertirCanjeEnTx(prismaMock, { ...base, amount: D(250) })).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      message: 'El reembolso excede lo cobrado con saldo de tarjeta de regalo (sobran $50.00).',
    })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('lo ya regresado se lee DESPUÉS del candado de los sobres (dos reembolsos a la vez no regresan dos veces lo mismo)', async () => {
    prismaMock.giftCardActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'red-1', giftCardId: 'gc-1', amount: D(400), orderId: 'order-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(600) })])

    await revertirCanjeEnTx(prismaMock, { ...base, amount: D(150) })
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.giftCardActivity.groupBy.mock.invocationCallOrder[0])
  })

  it('el MISMO reembolso otra vez devuelve lo ya escrito sin tocar el saldo', async () => {
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([{ giftCardId: 'gc-1', amount: D(150), balanceAfter: D(750) }])

    await expect(revertirCanjeEnTx(prismaMock, { ...base, amount: D(150) })).resolves.toEqual([
      { giftCardId: 'gc-1', amount: D(150), balanceAfter: D(750) },
    ])
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('si el sobre ya venció, el saldo regresa y su vigencia se extiende 90 días desde hoy', async () => {
    prismaMock.giftCardActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'red-1', giftCardId: 'gc-1', amount: D(400), orderId: 'order-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(0), expiresAt: new Date('2026-10-01T18:00:00Z') })])

    await revertirCanjeEnTx(prismaMock, { ...base, amount: D(400) })
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE },
      data: { balance: { increment: D(400) }, expiresAt: new Date('2027-01-12T18:00:00.000Z') },
    })
  })

  it('un cobro sin canjes de tarjeta no tiene saldo que regresar', async () => {
    await expect(revertirCanjeEnTx(prismaMock, { ...base, amount: D(10) })).rejects.toMatchObject({ code: 'GIFT_CARD_NOT_FOUND' })
  })

  it('🔴 B1 nota 4: un duplicado simultáneo del MISMO reembolso vuelve a mirar su reverso DESPUÉS del candado y no acredita otra vez', async () => {
    // El duplicado pasó la primera lectura (vacía: el otro aún no confirmaba) y esperó el candado. Al obtenerlo, el reverso del
    // primero ya existe: devuelve ése. Sin la segunda lectura, en un cobro de DOS sobres acreditaría el otro canje (doble saldo).
    prismaMock.giftCardActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'red-1', giftCardId: 'gc-1', amount: D(100), orderId: 'order-1' },
        { id: 'red-2', giftCardId: 'gc-2', amount: D(100), orderId: 'order-1' },
      ])
      .mockResolvedValueOnce([{ giftCardId: 'gc-1', amount: D(100), balanceAfter: D(100) }])
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([{ reversesActivityId: 'red-1', _sum: { amount: D(100) } }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(100) }), sobre({ id: 'gc-2', balance: D(0) })])

    await expect(revertirCanjeEnTx(prismaMock, { ...base, amount: D(100) })).resolves.toEqual([
      { giftCardId: 'gc-1', amount: D(100), balanceAfter: D(100) },
    ])
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
    // La segunda lectura por `refundPaymentId` va DESPUÉS del candado de los sobres.
    expect(prismaMock.giftCardActivity.findMany.mock.calls[2][0]).toMatchObject({
      where: { venueId: VENUE, refundPaymentId: 'refund-1', type: 'REDEEM_REVERSAL' },
    })
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.giftCardActivity.findMany.mock.invocationCallOrder[2])
  })

  it('🔴 B1 nota 1: un sobre DEACTIVATED no recibe saldo de vuelta: 409 con su terminación y nada se escribe', async () => {
    prismaMock.giftCardActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'red-1', giftCardId: 'gc-1', amount: D(400), orderId: 'order-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'DEACTIVATED', balance: D(0) })])
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1', codeLast4: '4321' }])

    const intento = revertirCanjeEnTx(prismaMock, { ...base, amount: D(150) })
    await expect(intento).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      statusCode: 409,
      details: { motivo: 'SOBRE_DESACTIVADO', giftCardIds: ['gc-1'] },
    })
    await expect(intento).rejects.toThrow(/terminación 4321/)
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('B1 nota 1: sólo cuentan los sobres que de verdad recibirían saldo (uno desactivado ya devuelto completo no estorba)', async () => {
    prismaMock.giftCardActivity.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'red-1', giftCardId: 'gc-1', amount: D(100), orderId: 'order-1' },
      { id: 'red-2', giftCardId: 'gc-2', amount: D(100), orderId: 'order-1' },
    ])
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([{ reversesActivityId: 'red-1', _sum: { amount: D(100) } }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'DEACTIVATED', balance: D(0) }), sobre({ id: 'gc-2', balance: D(0) })])

    await expect(revertirCanjeEnTx(prismaMock, { ...base, amount: D(100) })).resolves.toEqual([
      { giftCardId: 'gc-2', amount: D(100), balanceAfter: D(100) },
    ])
    expect(prismaMock.giftCard.findMany).not.toHaveBeenCalled()
  })
})

describe('operarSobreDeGerenteEnTx', () => {
  const ajuste = (amount: number, direccion: 'INCREMENT' | 'DECREMENT' = 'INCREMENT') => ({
    venueId: VENUE,
    giftCardId: 'gc-1',
    staffId: 'gerente-1',
    operationKey: 'dlg-ajuste-0001',
    op: { tipo: 'AJUSTE' as const, direccion, amount: D(amount), reason: 'CUSTOMER_REQUEST' as const, note: 'Compensación' },
  })

  it('AJUSTE a favor: sube el saldo y escribe ADJUST_INCREMENT con llave y huella', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre()])

    const out = await operarSobreDeGerenteEnTx(prismaMock, ajuste(50))

    expect(out).toEqual({ activityIds: ['act-1'], replay: false })
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE },
      data: { balance: { increment: D(50) } },
    })
    const fila = prismaMock.giftCardActivity.create.mock.calls[0][0].data
    expect(fila).toMatchObject({
      type: 'ADJUST_INCREMENT',
      amount: D(50),
      balanceAfter: D(1050),
      reason: 'CUSTOMER_REQUEST',
      note: 'Compensación',
      staffId: 'gerente-1',
      operationKey: 'dlg-ajuste-0001',
    })
    expect(fila.operationHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('🔴 la MISMA llave con el MISMO contenido (reintento del dashboard) devuelve el renglón original y no mueve saldo', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre()])
    await operarSobreDeGerenteEnTx(prismaMock, ajuste(50))
    const huella = prismaMock.giftCardActivity.create.mock.calls[0][0].data.operationHash
    prismaMock.giftCard.updateMany.mockClear()
    prismaMock.giftCardActivity.create.mockClear()
    prismaMock.giftCardActivity.findUnique.mockResolvedValue({ id: 'act-original', operationHash: huella, type: 'ADJUST_INCREMENT' })

    // r1 (F9): la repetición se decide bajo el candado y se dice en `replay` (C3 no vuelve a escribir la bitácora).
    await expect(operarSobreDeGerenteEnTx(prismaMock, ajuste(50))).resolves.toEqual({ activityIds: ['act-original'], replay: true })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('🔴 la MISMA llave con OTRO contenido: IDEMPOTENCY_KEY_REUSED (409)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre()])
    prismaMock.giftCardActivity.findUnique.mockResolvedValue({ id: 'act-original', operationHash: 'otra-huella', type: 'ADJUST_INCREMENT' })

    await expect(operarSobreDeGerenteEnTx(prismaMock, ajuste(60))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
  })

  it('AJUSTE en contra mayor al saldo: «quedan $X» y nada se escribe', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(100) })])
    await expect(operarSobreDeGerenteEnTx(prismaMock, ajuste(150, 'DECREMENT'))).rejects.toMatchObject({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      message: 'Quedan $100.00 en la tarjeta de regalo.',
    })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
  })

  it('AJUSTE en contra: escritura condicionada (balance >= monto) y ADJUST_DECREMENT', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(100) })])
    await operarSobreDeGerenteEnTx(prismaMock, ajuste(40, 'DECREMENT'))
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE, balance: { gte: D(40) } },
      data: { balance: { decrement: D(40) } },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({ type: 'ADJUST_DECREMENT', balanceAfter: D(60) })
  })

  it('un ajuste que dejaría la tarjeta arriba de $10,000 se rechaza', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(9950) })])
    await expect(operarSobreDeGerenteEnTx(prismaMock, ajuste(100))).rejects.toMatchObject({ code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE' })
  })

  it('🔴 r1 (F7): $10,000 → canje $5,000 → ajuste +$5,000 se RECHAZA: el reverso del canje lo dejaría en $15,000', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(5000), initialAmount: D(10000) })])
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([{ type: 'REDEEM', _sum: { amount: D(5000) } }])

    await expect(operarSobreDeGerenteEnTx(prismaMock, ajuste(5000))).rejects.toMatchObject({
      code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE',
      statusCode: 422,
      message:
        'Con este ajuste la tarjeta podría pasar de $10,000.00, el máximo por tarjeta: $5,000.00 de sus canjes todavía pueden regresar a su saldo con un reembolso.',
    })
    expect(prismaMock.giftCardActivity.groupBy).toHaveBeenCalledWith({
      by: ['type'],
      where: { venueId: VENUE, giftCardId: 'gc-1', type: { in: ['REDEEM', 'REDEEM_REVERSAL'] } },
      _sum: { amount: true },
    })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('r1 (F7): con el canje ya devuelto (REDEEM $5,000 y REDEEM_REVERSAL $5,000) y un descuento de $300, un +$300 sí cabe', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre({ balance: D(9700), initialAmount: D(10000) })])
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([
      { type: 'REDEEM', _sum: { amount: D(5000) } },
      { type: 'REDEEM_REVERSAL', _sum: { amount: D(5000) } },
    ])

    await expect(operarSobreDeGerenteEnTx(prismaMock, ajuste(300))).resolves.toEqual({ activityIds: ['act-1'], replay: false })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({ type: 'ADJUST_INCREMENT', balanceAfter: D(10000) })
  })

  it('motivo «Otro» sin nota y llave mal formada: 400 antes de tocar nada', async () => {
    await expect(
      operarSobreDeGerenteEnTx(prismaMock, {
        ...ajuste(10),
        op: { tipo: 'AJUSTE', direccion: 'INCREMENT', amount: D(10), reason: 'OTHER' },
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(operarSobreDeGerenteEnTx(prismaMock, { ...ajuste(10), operationKey: 'corta' })).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('BLOQUEAR un sobre activo lo deja BLOCKED con su renglón BLOCK', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre()])
    await operarSobreDeGerenteEnTx(prismaMock, {
      venueId: VENUE,
      giftCardId: 'gc-1',
      staffId: 'gerente-1',
      operationKey: 'dlg-bloqueo-0001',
      op: { tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY' },
    })
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE, status: 'ACTIVE' },
      data: { status: 'BLOCKED' },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({
      type: 'BLOCK',
      amount: D(0),
      balanceAfter: D(1000),
      reason: 'SUSPICIOUS_ACTIVITY',
    })
  })

  it('DESBLOQUEAR una cancelación de venta en curso sólo con el motivo CANCEL_IN_PROGRESS (lo hace «Cancelar venta»)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'BLOCKED' })])
    prismaMock.giftCardActivity.findFirst.mockResolvedValue({ reason: 'CANCEL_IN_PROGRESS' })
    const desbloquear = (reason: 'CUSTOMER_REQUEST' | 'CANCEL_IN_PROGRESS', operationKey: string) =>
      operarSobreDeGerenteEnTx(prismaMock, {
        venueId: VENUE,
        giftCardId: 'gc-1',
        staffId: 'gerente-1',
        operationKey,
        op: { tipo: 'DESBLOQUEAR', reason },
      })

    await expect(desbloquear('CUSTOMER_REQUEST', 'dlg-desbloq-0001')).rejects.toMatchObject({ code: 'GIFT_CARD_BLOCKED', statusCode: 409 })
    await expect(desbloquear('CANCEL_IN_PROGRESS', 'dlg-desbloq-0002')).resolves.toEqual({ activityIds: ['act-1'], replay: false })
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE, status: 'BLOCKED' },
      data: { status: 'ACTIVE' },
    })
  })

  it('REEMPLAZAR_CODIGO de un sobre sin guardar y nunca usado: código y pageToken nuevos, CODE_REPLACED', async () => {
    prismaMock.$queryRaw.mockResolvedValue([sobre()])

    const out = await operarSobreDeGerenteEnTx(prismaMock, {
      venueId: VENUE,
      giftCardId: 'gc-1',
      staffId: 'gerente-1',
      operationKey: 'dlg-repone-0001',
      op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' },
    })

    expect(out.nuevoCodigo?.display).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]$/)
    const data = prismaMock.giftCard.updateMany.mock.calls[0][0].data
    expect(data.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(data.codeLast4).toBe(out.nuevoCodigo?.last4)
    expect(typeof data.pageToken).toBe('string')
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({
      type: 'CODE_REPLACED',
      amount: D(0),
      reason: 'LOST_CARD',
    })
  })

  it('REEMPLAZAR_CODIGO de un sobre ya usado o ya guardado: GIFT_CARD_ALREADY_USED', async () => {
    const reponer = (operationKey: string) =>
      operarSobreDeGerenteEnTx(prismaMock, {
        venueId: VENUE,
        giftCardId: 'gc-1',
        staffId: 'g',
        operationKey,
        op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' },
      })
    prismaMock.$queryRaw.mockResolvedValue([sobre()])
    prismaMock.giftCardActivity.count.mockResolvedValue(1)
    await expect(reponer('dlg-repone-0002')).rejects.toMatchObject({ code: 'GIFT_CARD_ALREADY_USED' })
    prismaMock.giftCardActivity.count.mockResolvedValue(0)
    prismaMock.$queryRaw.mockResolvedValue([sobre({ customerId: 'cust-1' })])
    await expect(reponer('dlg-repone-0003')).rejects.toMatchObject({ code: 'GIFT_CARD_ALREADY_USED' })
  })
})

describe('desactivarSobresDeCuentaEnTx (cancelar la venta, R2)', () => {
  const base = { venueId: VENUE, orderId: 'order-1', refundPaymentId: 'refund-1', reason: 'SALE_CANCELLED' as const, staffId: 'g' }

  it('todos BLOCKED por CANCEL_IN_PROGRESS y ninguno usado: DEACTIVATED en saldo 0 con su DEACTIVATE', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'BLOCKED', balance: D(500) })])
    prismaMock.giftCardActivity.findFirst.mockResolvedValue({ type: 'BLOCK', reason: 'CANCEL_IN_PROGRESS' })

    await desactivarSobresDeCuentaEnTx(prismaMock, base)

    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE, status: 'BLOCKED' },
      data: { status: 'DEACTIVATED', balance: D(0), deactivatedAt: AHORA },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({
      type: 'DEACTIVATE',
      amount: D(500),
      balanceAfter: D(0),
      reason: 'SALE_CANCELLED',
      refundPaymentId: 'refund-1',
      orderId: 'order-1',
    })
  })

  it('un sobre con REDEEM en su historia: GIFT_CARD_ALREADY_USED, nada se desactiva', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'BLOCKED' })])
    prismaMock.giftCardActivity.count.mockResolvedValue(1)
    await expect(desactivarSobresDeCuentaEnTx(prismaMock, base)).rejects.toMatchObject({ code: 'GIFT_CARD_ALREADY_USED' })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
  })

  it('sin la cancelación iniciada (no bloqueado por CANCEL_IN_PROGRESS): GIFT_CARD_CANCEL_NOT_STARTED', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'ACTIVE' })])
    await expect(desactivarSobresDeCuentaEnTx(prismaMock, base)).rejects.toMatchObject({ code: 'GIFT_CARD_CANCEL_NOT_STARTED' })
  })

  it('🔴 E1: con el dinero YA devuelto (terminal) no valida R2: desactiva cada sobre vivo —usado o no, bloqueado o no— con lo que le quedaba', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }, { id: 'gc-2' }, { id: 'gc-3' }])
    prismaMock.$queryRaw.mockResolvedValue([
      sobre({ id: 'gc-1', status: 'ACTIVE', balance: D(300) }),
      sobre({ id: 'gc-2', status: 'BLOCKED', balance: D(200) }),
      sobre({ id: 'gc-3', status: 'DEACTIVATED', balance: D(0) }),
    ])
    prismaMock.giftCardActivity.count.mockResolvedValue(1) // un canje en la historia: igual se desactiva

    await desactivarSobresDeCuentaEnTx(prismaMock, { ...base, dineroYaDevuelto: true })

    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.giftCard.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'gc-1', venueId: VENUE, status: 'ACTIVE' },
      data: { status: 'DEACTIVATED', balance: D(0), deactivatedAt: AHORA },
    })
    expect(prismaMock.giftCard.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'gc-2', venueId: VENUE, status: 'BLOCKED' },
      data: { status: 'DEACTIVATED', balance: D(0), deactivatedAt: AHORA },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls.map((c: any) => [c[0].data.giftCardId, c[0].data.type, c[0].data.amount])).toEqual(
      [
        ['gc-1', 'DEACTIVATE', D(300)],
        ['gc-2', 'DEACTIVATE', D(200)],
      ],
    )
  })
})

describe('desactivarSobresPendientesDeCuentaEnTx (cuenta de tarjetas cancelada SIN cobrar)', () => {
  it('cada sobre PENDING queda DEACTIVATED sin haberse activado, con DEACTIVATE en $0', async () => {
    prismaMock.giftCard.findMany.mockResolvedValue([{ id: 'gc-1' }])
    prismaMock.$queryRaw.mockResolvedValue([sobre({ status: 'PENDING', balance: D(0), initialAmount: D(500) })])

    await expect(desactivarSobresPendientesDeCuentaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1', staffId: 's' })).resolves.toEqual(
      {
        desactivados: ['gc-1'],
      },
    )
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', venueId: VENUE, status: 'PENDING' },
      data: { status: 'DEACTIVATED', deactivatedAt: AHORA },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({
      type: 'DEACTIVATE',
      amount: D(0),
      reason: 'SALE_CANCELLED',
    })
  })

  it('una cuenta normal (sin sobres) no toma candados ni escribe', async () => {
    await expect(desactivarSobresPendientesDeCuentaEnTx(prismaMock, { venueId: VENUE, orderId: 'order-1' })).resolves.toEqual({
      desactivados: [],
    })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('sobresDelCanje', () => {
  it('los sobres de un cobro con saldo, sin repetir', async () => {
    prismaMock.giftCardActivity.findMany.mockResolvedValue([{ giftCardId: 'gc-2' }, { giftCardId: 'gc-1' }, { giftCardId: 'gc-2' }])
    await expect(sobresDelCanje(prismaMock, { venueId: VENUE, paymentId: 'pay-1' })).resolves.toEqual(['gc-2', 'gc-1'])
  })
})
