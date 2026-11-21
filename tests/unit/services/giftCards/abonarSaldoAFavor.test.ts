/**
 * Saldo a favor (spec 2026-10-30-saldo-a-favor §5.2, tarea S2): la libreta abona lo que se le regresa a una clienta en SU sobre de
 * saldo a favor. Uno vivo por clienta y sucursal; se crea ACTIVE con su ACTIVATE (con `refundPaymentId`) o se recarga con un
 * ADJUST_INCREMENT. Sin mínimo de $100; tope de $10,000 contando lo que sus canjes aún pueden regresar. Lo de Postgres real (dos
 * cajas a la vez, una tarjeta regalada guardada) vive en tests/integration/storeCredit/abonarSaldoAFavor.integration.test.ts.
 */
import { Prisma } from '@prisma/client'
import {
  abonarSaldoAFavorEnTx,
  esSobreDeSaldoAFavor,
  esSobreDeSaldoAFavorSql,
  prepararSobreDeSaldoAFavorEnTx,
  type LockedGiftCard,
} from '@/services/giftCards/giftCardLedger'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: string | number) => new Prisma.Decimal(v)
const AHORA = new Date('2026-10-31T18:00:00.000Z')
const VENUE = 'venue-1'
const CLIENTA = 'cust-1'
const TEL = '+525512345678'

function sobre(over: Partial<LockedGiftCard> = {}): LockedGiftCard {
  return {
    id: 'gc-saldo',
    venueId: VENUE,
    codeHash: 'hash-del-sobre',
    pageToken: 'liga-del-sobre-000000000000',
    recipientPhone: TEL,
    deliveryChannel: 'WHATSAPP',
    status: 'ACTIVE',
    balance: D(300),
    initialAmount: D(300),
    expiresAt: null,
    activatedAt: new Date('2026-10-01T18:00:00.000Z'),
    validityMonths: null,
    customerId: CLIENTA,
    ...over,
  }
}

/** El texto de una llamada a `$queryRaw` (plantilla o `Prisma.sql`). */
const textoDe = (arg: any): string => (Array.isArray(arg) ? arg.join('?') : (arg?.strings ?? []).join('?'))

/** La base simulada responde por el texto del SQL: el candado, la búsqueda del sobre de saldo y el FOR UPDATE del sobre. */
function base(p: { sobreDeSaldo?: LockedGiftCard | null } = {}) {
  prismaMock.$queryRaw.mockImplementation((async (strings: any) => {
    const sql = textoDe(strings)
    if (sql.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: '' }]
    // D661 (Ruling 75): la ficha bajo el MISMO candado de fila con que «Mi cuenta» cambia el número.
    if (sql.includes('FROM "Customer"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: CLIENTA }]
    if (sql.includes('FOR UPDATE')) return p.sobreDeSaldo ? [p.sobreDeSaldo] : []
    if (sql.includes('FROM "GiftCard"')) return p.sobreDeSaldo ? [{ id: p.sobreDeSaldo.id }] : []
    throw new Error(`SQL inesperado: ${sql}`)
  }) as any)
  // Lo que vale HOY el sobre ya bloqueado (la relectura de `abonar`): por omisión, lo mismo que vio `preparar`.
  prismaMock.giftCard.findFirst
    .mockReset()
    .mockResolvedValue(p.sobreDeSaldo ? ({ balance: p.sobreDeSaldo.balance, status: p.sobreDeSaldo.status } as any) : null)
}

const preparar = (bloquearFicha = false) =>
  prepararSobreDeSaldoAFavorEnTx(prismaMock, { venueId: VENUE, customerId: CLIENTA, ...(bloquearFicha ? { bloquearFicha } : {}) })
/** Como la devolución de «Nadie» (ronda 2 de codex-r3): quien exige el mismo teléfono prepara con la ficha ya bloqueada. */
const abonar = async (monto: number, over: Partial<Parameters<typeof abonarSaldoAFavorEnTx>[1]> = {}) =>
  abonarSaldoAFavorEnTx(prismaMock, {
    preparado: await preparar(over.exigirMismoTelefono !== undefined),
    monto: D(monto),
    staffId: 'cajera-1',
    origen: { orderId: 'order-1', refundPaymentId: 'ref-1' },
    folio: 'F-12',
    tipo: 'CAMBIO',
    ...over,
  })

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({ now: AHORA, doNotFake: ['nextTick', 'setImmediate'] })
  prismaMock.$queryRaw.mockReset()
  prismaMock.customer.findFirst.mockReset().mockResolvedValue({ firstName: 'Ana', lastName: 'López', phone: '55 1234 5678' } as any)
  prismaMock.venue.findUnique.mockReset().mockResolvedValue({ organizationId: 'org-1' } as any)
  prismaMock.giftCardSettings.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.giftCard.create.mockReset().mockResolvedValue({ id: 'gc-nuevo' } as any)
  prismaMock.giftCard.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.giftCardActivity.create.mockReset().mockImplementation((async ({ data }: any) => ({ id: 'act-1', ...data })) as any)
  prismaMock.giftCardActivity.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.giftCardActivity.groupBy.mockReset().mockResolvedValue([] as any)
})
afterEach(() => jest.useRealTimers())

describe('esSobreDeSaldoAFavor (el predicado único)', () => {
  it('es un EXISTS de un ACTIVATE con refundPaymentId sobre el alias que se le pasa', () => {
    const sql = esSobreDeSaldoAFavorSql('g').sql
    expect(sql).toMatch(/^EXISTS \(/)
    expect(sql).toContain('"GiftCardActivity"')
    expect(sql).toContain(`."giftCardId" = "g".id`)
    expect(sql).toMatch(/\.type = 'ACTIVATE'/)
    expect(sql).toMatch(/\."refundPaymentId" IS NOT NULL/)
  })

  it('rechaza un alias que no es un identificador (nunca se arma SQL con texto ajeno)', () => {
    expect(() => esSobreDeSaldoAFavorSql('g; DROP TABLE x')).toThrow()
  })

  it('la versión en la transacción usa el MISMO predicado', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ es: true }] as any)
    await expect(esSobreDeSaldoAFavor(prismaMock, 'gc-1')).resolves.toBe(true)
    const [plantilla, ...valores] = prismaMock.$queryRaw.mock.calls[0] as any[]
    expect(textoDe(plantilla)).toContain('FROM "GiftCard"')
    expect(valores.some(v => v?.sql === esSobreDeSaldoAFavorSql('g').sql)).toBe(true)
    expect(valores).toContain('gc-1')

    prismaMock.$queryRaw.mockResolvedValue([] as any)
    await expect(esSobreDeSaldoAFavor(prismaMock, 'no-existe')).resolves.toBe(false)
  })
})

describe('prepararSobreDeSaldoAFavorEnTx', () => {
  it('toma el candado POR CLIENTA (saldo-a-favor:<venue>:<cliente>) antes de leer nada', async () => {
    base()
    await preparar()
    const primera = prismaMock.$queryRaw.mock.calls[0] as any[]
    expect(textoDe(primera[0])).toMatch(/pg_advisory_xact_lock\(hashtext\(/)
    expect(primera.slice(1)).toEqual(['saldo-a-favor:venue-1:cust-1'])
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.customer.findFirst.mock.invocationCallOrder[0])
  })

  it('busca sólo el sobre de SALDO A FAVOR vivo de la clienta (el predicado, no sólo customerId) y lo bloquea', async () => {
    base({ sobreDeSaldo: sobre() })
    const p = await preparar()
    const llamadas = prismaMock.$queryRaw.mock.calls as any[][]
    const busqueda = llamadas.find(c => textoDe(c[0]).includes('FROM "GiftCard"') && !textoDe(c[0]).includes('FOR UPDATE'))!
    const texto = textoDe(busqueda[0])
    expect(texto).toMatch(/"customerId" = \?/)
    expect(texto).toMatch(/status IN \('ACTIVE', 'BLOCKED'\)/)
    expect(busqueda.slice(1)).toEqual(expect.arrayContaining([VENUE, CLIENTA]))
    expect(busqueda.some(v => v?.sql === esSobreDeSaldoAFavorSql('g').sql)).toBe(true)
    expect(llamadas.some(c => textoDe(c[0]).includes('FOR UPDATE'))).toBe(true)
    expect(p).toEqual({ venueId: VENUE, customerId: CLIENTA, sobre: sobre(), telefonoCliente: TEL, nombreCliente: 'Ana López' })
  })

  it('una clienta de otro negocio se rechaza con STORE_CREDIT_CUSTOMER_REQUIRED', async () => {
    base()
    prismaMock.customer.findFirst.mockResolvedValue(null)
    await expect(preparar()).rejects.toMatchObject({ code: 'STORE_CREDIT_CUSTOMER_REQUIRED', statusCode: 400 })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CLIENTA, venueId: VENUE } }))
  })
})

describe('abonarSaldoAFavorEnTx', () => {
  it('sin sobre crea uno ACTIVE con ACTIVATE, refundPaymentId, WHATSAPP, SENT, sin vencimiento y el teléfono del cliente', async () => {
    base()
    const out = await abonar(500)

    const tarjeta = prismaMock.giftCard.create.mock.calls[0][0].data as any
    expect(tarjeta).toMatchObject({
      venueId: VENUE,
      organizationId: 'org-1',
      initialAmount: D(500),
      balance: D(500),
      status: 'ACTIVE',
      activatedAt: AHORA,
      expiresAt: null,
      validityMonths: null,
      termsVersion: '2026-10-14',
      customerId: CLIENTA,
      recipientName: 'Ana López',
      recipientPhone: TEL,
      deliveryChannel: 'WHATSAPP',
      deliveryStatus: 'SENT',
      deliveredAt: null,
      source: 'POS',
    })
    expect(tarjeta.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tarjeta.codeLast4).toMatch(/^[0-9A-Z]{4}$/)
    expect(typeof tarjeta.pageToken).toBe('string')

    const fila = prismaMock.giftCardActivity.create.mock.calls[0][0].data as any
    expect(fila).toMatchObject({
      giftCardId: 'gc-nuevo',
      venueId: VENUE,
      type: 'ACTIVATE',
      amount: D(500),
      balanceAfter: D(500),
      refundPaymentId: 'ref-1',
      orderId: 'order-1',
      staffId: 'cajera-1',
      operationKey: 'saldo-a-favor:ref-1',
      note: 'Saldo a favor · Cambio F-12',
    })
    // El ACTIVATE no lleva motivo, igual que el de la venta (TARJETAS, 30-oct).
    expect(fila.reason).toBeUndefined()
    // El código y la liga nunca salen: un código al portador es justo lo que el founder descartó.
    expect(out).toEqual({ giftCardId: 'gc-nuevo', abonado: D(500), saldoNuevo: D(500), telefonoDelSobre: TEL, telefonoNoCoincide: false })
  })

  it('ventaHuella, deliveryOperationKey y deliveryMessageId quedan nulos (la entrega nunca lo manda solo)', async () => {
    base()
    await abonar(500)
    const tarjeta = prismaMock.giftCard.create.mock.calls[0][0].data as any
    expect(tarjeta).toMatchObject({ ventaHuella: null, deliveryOperationKey: null, deliveryMessageId: null })
  })

  it('usa la versión de términos del negocio si tiene ajustes de tarjetas', async () => {
    base()
    prismaMock.giftCardSettings.findUnique.mockResolvedValue({ termsVersion: '2027-01-01' } as any)
    await abonar(500)
    expect((prismaMock.giftCard.create.mock.calls[0][0].data as any).termsVersion).toBe('2027-01-01')
  })

  it('un abono de $50 se acepta (sin mínimo de $100)', async () => {
    base()
    const out = await abonar(50)
    expect(out.abonado).toEqual(D(50))
    expect((prismaMock.giftCard.create.mock.calls[0][0].data as any).initialAmount).toEqual(D(50))
  })

  it('con sobre ACTIVE hace ADJUST_INCREMENT con reason OTHER y nota «Saldo a favor · Cambio F-12»', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(300) }) })
    const out = await abonar(200)

    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-saldo', venueId: VENUE, status: 'ACTIVE' },
      data: { balance: { increment: D(200) } },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({
      giftCardId: 'gc-saldo',
      venueId: VENUE,
      type: 'ADJUST_INCREMENT',
      amount: D(200),
      balanceAfter: D(500),
      reason: 'OTHER',
      note: 'Saldo a favor · Cambio F-12',
      refundPaymentId: 'ref-1',
      orderId: 'order-1',
      staffId: 'cajera-1',
      operationKey: 'saldo-a-favor:ref-1',
    })
    expect(out).toEqual({ giftCardId: 'gc-saldo', abonado: D(200), saldoNuevo: D(500), telefonoDelSobre: TEL, telefonoNoCoincide: false })
  })

  it('desde un Reembolso la nota dice «Saldo a favor · Reembolso <folio>»', async () => {
    base({ sobreDeSaldo: sobre() })
    await abonar(100, { tipo: 'REEMBOLSO', folio: 'R-7' })
    expect((prismaMock.giftCardActivity.create.mock.calls[0][0].data as any).note).toBe('Saldo a favor · Reembolso R-7')
  })

  it('con sobre BLOCKED lanza STORE_CREDIT_CARD_BLOCKED y no escribe', async () => {
    base({ sobreDeSaldo: sobre({ status: 'BLOCKED' }) })
    await expect(abonar(100)).rejects.toMatchObject({ code: 'STORE_CREDIT_CARD_BLOCKED', statusCode: 422 })
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('el mensaje del bloqueo nombra a la clienta y dice quién lo desbloquea', async () => {
    base({ sobreDeSaldo: sobre({ status: 'BLOCKED' }) })
    await expect(abonar(100)).rejects.toThrow('El saldo de Ana López está bloqueado; un gerente lo puede desbloquear.')
  })

  it('si pasaría de 10000 lanza STORE_CREDIT_OVER_CAP con el sobrante y no parte el abono', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(9800) }) })
    await expect(abonar(500)).rejects.toMatchObject({
      code: 'STORE_CREDIT_OVER_CAP',
      statusCode: 422,
      details: { sobrante: 300 },
      // El texto del spec §4, tal cual.
      message: 'El saldo a favor de Ana López pasaría de $10,000. Devuelve $300.00 de otra forma o elige a otra persona.',
    })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('un sobre nuevo de más de 10000 también se rechaza con el sobrante', async () => {
    base()
    await expect(abonar(10500)).rejects.toMatchObject({ code: 'STORE_CREDIT_OVER_CAP', details: { sobrante: 500 } })
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
  })

  it('sobre de 10000, se gastan 5000, un abono de 5000 se rechaza porque lo canjeado aún puede regresar', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(5000), initialAmount: D(10000) }) })
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([{ type: 'REDEEM', _sum: { amount: D(5000) } }] as any)

    await expect(abonar(5000)).rejects.toMatchObject({
      code: 'STORE_CREDIT_OVER_CAP',
      details: { sobrante: 5000 },
      message:
        'El saldo a favor de Ana López podría pasar de $10,000: $5,000.00 de sus compras todavía pueden regresar a su saldo con un reembolso. Devuelve $5,000.00 de otra forma o elige a otra persona.',
    })
    // La misma cuenta que el ajuste de gerente (giftCardLedger.ts, r1 F7): REDEEM − REDEEM_REVERSAL del sobre.
    expect(prismaMock.giftCardActivity.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['type'],
        where: { venueId: VENUE, giftCardId: 'gc-saldo', type: { in: ['REDEEM', 'REDEEM_REVERSAL'] } },
      }),
    )
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('lo canjeado que ya regresó con un reembolso no cuenta para el tope', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(5000), initialAmount: D(10000) }) })
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([
      { type: 'REDEEM', _sum: { amount: D(5000) } },
      { type: 'REDEEM_REVERSAL', _sum: { amount: D(5000) } },
    ] as any)
    await expect(abonar(5000)).resolves.toMatchObject({ saldoNuevo: D(10000) })
  })

  it('la misma operationKey dos veces abona una sola', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(500) }) })
    prismaMock.giftCardActivity.findUnique.mockResolvedValue({
      giftCardId: 'gc-saldo',
      amount: D(200),
      balanceAfter: D(500),
      refundPaymentId: 'ref-1',
    } as any)

    const out = await abonar(200)

    expect(prismaMock.giftCardActivity.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_operationKey: { venueId: VENUE, operationKey: 'saldo-a-favor:ref-1' } } }),
    )
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
    expect(out).toEqual({ giftCardId: 'gc-saldo', abonado: D(200), saldoNuevo: D(500), telefonoDelSobre: TEL, telefonoNoCoincide: false })
  })

  it('la misma operationKey con otro monto es IDEMPOTENCY_KEY_REUSED y no escribe', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(500) }) })
    prismaMock.giftCardActivity.findUnique.mockResolvedValue({
      giftCardId: 'gc-saldo',
      amount: D(200),
      balanceAfter: D(500),
      refundPaymentId: 'ref-1',
    } as any)
    await expect(abonar(300)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('una llave saldo-a-favor:<id> que ya usó OTRO movimiento (no este abono) es IDEMPOTENCY_KEY_REUSED (revisión M3)', async () => {
    base({ sobreDeSaldo: sobre({ balance: D(500) }) })
    prismaMock.giftCardActivity.findUnique.mockResolvedValue({
      giftCardId: 'gc-saldo',
      amount: D(200),
      balanceAfter: D(500),
      refundPaymentId: null,
    } as any)
    await expect(abonar(200)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('🔴 recarga con el saldo de HOY: si un reverso regresó saldo al mismo sobre después de preparar, balanceAfter y saldoNuevo lo cuentan (revisión I1)', async () => {
    // `preparar` vio $300; en la MISMA transacción un `revertirCanjeEnTx` regresó $1,000 a ese sobre (Cambio pagado con su saldo).
    base({ sobreDeSaldo: sobre({ balance: D(300) }) })
    const preparado = await preparar()
    prismaMock.giftCard.findFirst.mockResolvedValue({ balance: D(1300), status: 'ACTIVE' } as any)

    const out = await abonarSaldoAFavorEnTx(prismaMock, {
      preparado,
      monto: D(200),
      staffId: 'cajera-1',
      origen: { orderId: 'order-1', refundPaymentId: 'ref-1' },
      folio: 'F-12',
      tipo: 'CAMBIO',
    })

    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledWith({
      where: { id: 'gc-saldo', venueId: VENUE },
      select: { balance: true, status: true },
    })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({ type: 'ADJUST_INCREMENT', balanceAfter: D(1500) })
    expect(out.saldoNuevo).toEqual(D(1500))
  })

  it('🔴 el tope cuenta el saldo de HOY: $4,000 vistos, un reverso de $1,000 al mismo sobre y $500 más pasan de $10,000 (revisión I1)', async () => {
    // Saldo $4,000 + $6,000 canjeados que pueden regresar = $10,000. Regresan $1,000 (SAME): $5,000 + $5,000. Abonar $500 ⇒ $10,500.
    base({ sobreDeSaldo: sobre({ balance: D(4000), initialAmount: D(10000) }) })
    const preparado = await preparar()
    prismaMock.giftCard.findFirst.mockResolvedValue({ balance: D(5000), status: 'ACTIVE' } as any)
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([
      { type: 'REDEEM', _sum: { amount: D(6000) } },
      { type: 'REDEEM_REVERSAL', _sum: { amount: D(1000) } },
    ] as any)

    await expect(
      abonarSaldoAFavorEnTx(prismaMock, {
        preparado,
        monto: D(500),
        staffId: 'cajera-1',
        origen: { orderId: 'order-1', refundPaymentId: 'ref-1' },
        folio: 'F-12',
        tipo: 'CAMBIO',
      }),
    ).rejects.toMatchObject({ code: 'STORE_CREDIT_OVER_CAP', details: { sobrante: 500 } })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('el estado también es el de HOY: si se bloqueó después de preparar, STORE_CREDIT_CARD_BLOCKED sin escribir', async () => {
    base({ sobreDeSaldo: sobre() })
    const preparado = await preparar()
    prismaMock.giftCard.findFirst.mockResolvedValue({ balance: D(300), status: 'BLOCKED' } as any)
    await expect(
      abonarSaldoAFavorEnTx(prismaMock, {
        preparado,
        monto: D(100),
        staffId: 'cajera-1',
        origen: { orderId: 'order-1', refundPaymentId: 'ref-1' },
        folio: 'F-12',
        tipo: 'CAMBIO',
      }),
    ).rejects.toMatchObject({ code: 'STORE_CREDIT_CARD_BLOCKED' })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('cliente sin teléfono lanza STORE_CREDIT_CUSTOMER_PHONE_REQUIRED', async () => {
    base()
    prismaMock.customer.findFirst.mockResolvedValue({ firstName: 'Ana', lastName: null, phone: null } as any)
    await expect(abonar(100)).rejects.toMatchObject({ code: 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED', statusCode: 400 })
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  })

  it('un teléfono que no se entiende cuenta como sin teléfono', async () => {
    base()
    prismaMock.customer.findFirst.mockResolvedValue({ firstName: 'Ana', lastName: null, phone: '123' } as any)
    await expect(abonar(100)).rejects.toMatchObject({ code: 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED' })
  })

  it('teléfono de la ficha distinto al del sobre: abona y regresa telefonoNoCoincide = true', async () => {
    base({ sobreDeSaldo: sobre({ recipientPhone: '+525598765478' }) })
    const out = await abonar(100)
    expect(out).toMatchObject({ giftCardId: 'gc-saldo', telefonoDelSobre: '+525598765478', telefonoNoCoincide: true })
    // El teléfono del sobre no se toca al recargar: quien edita la ficha no se lleva el saldo a su número (Codex r3, hallazgo 3).
    expect(prismaMock.giftCard.updateMany.mock.calls[0][0].data).toEqual({ balance: { increment: D(100) } })
  })

  it('con sobre y sin teléfono en la ficha abona igual: el sobre se usa con su propio teléfono', async () => {
    base({ sobreDeSaldo: sobre() })
    prismaMock.customer.findFirst.mockResolvedValue({ firstName: 'Ana', lastName: null, phone: null } as any)
    await expect(abonar(100)).resolves.toMatchObject({ telefonoDelSobre: TEL, telefonoNoCoincide: true })
  })

  it('un monto en cero o con más de dos decimales no escribe', async () => {
    base()
    await expect(abonar(0)).rejects.toMatchObject({ statusCode: 422 })
    await expect(abonar(10.005)).rejects.toMatchObject({ statusCode: 422 })
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
  })
})

// D661 (Task 6, r1 #6 y r3 #6): sólo la devolución de un pedido «Nadie» pasa `exigirMismoTelefono`. Con él, el teléfono que manda es
// el que la clienta VERIFICÓ al pagar (`request.telefonoVerificado`). D661 (Ruling 57): y sólo si SIGUE siendo el de su ficha.
describe('abonarSaldoAFavorEnTx con exigirMismoTelefono (D661)', () => {
  const VERIFICADO = '+525511112222'
  const nadie = (telefonoVerificado: string | null) => ({ tipo: 'REEMBOLSO' as const, exigirMismoTelefono: { telefonoVerificado } })
  /** Su ficha de hoy (por omisión, `55 1234 5678` = TEL). */
  const fichaCon = (phone: string | null) =>
    prismaMock.customer.findFirst.mockResolvedValue({ firstName: 'Ana', lastName: 'López', phone } as any)
  const sinEscribir = () => {
    expect(prismaMock.giftCard.create).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  }

  it('saldo: sobre con otro teléfono → STORE_CREDIT_PHONE_MISMATCH', async () => {
    // El sobre vive en el número de antes (TEL); su ficha y su pago ya son del nuevo.
    base({ sobreDeSaldo: sobre({ recipientPhone: TEL }) })
    fichaCon('55 1111 2222')
    await expect(abonar(250, nadie(VERIFICADO))).rejects.toMatchObject({
      code: 'STORE_CREDIT_PHONE_MISMATCH',
      statusCode: 409,
      message: expect.stringMatching(/Ana López[\s\S]*otro teléfono[\s\S]*tarjeta/),
    })
    sinEscribir()
  })

  it('saldo: sobre existente y sin teléfono verificado → STORE_CREDIT_PHONE_MISMATCH', async () => {
    base({ sobreDeSaldo: sobre() })
    await expect(abonar(250, nadie(null))).rejects.toMatchObject({
      code: 'STORE_CREDIT_PHONE_MISMATCH',
      statusCode: 409,
      message: expect.stringMatching(/sin verificar[\s\S]*tarjeta/),
    })
    sinEscribir()
  })

  it('el mismo teléfono verificado que el del sobre y el de su ficha (escritos distinto) recarga el sobre como siempre', async () => {
    base({ sobreDeSaldo: sobre({ recipientPhone: VERIFICADO, balance: D(100) }) })
    fichaCon('55 1111 2222')
    const out = await abonar(250, nadie('52 55 1111 2222'))
    expect(out).toMatchObject({ giftCardId: 'gc-saldo', telefonoDelSobre: VERIFICADO, telefonoNoCoincide: false })
    expect(prismaMock.giftCard.updateMany.mock.calls[0][0].data).toEqual({ balance: { increment: D(250) } })
  })

  it('D661 · Ruling 57: verificó un número al pagar y su ficha de hoy dice otro (lo cambió en «Mi cuenta»): sin sobre → 409 STORE_CREDIT_PHONE_MISMATCH, nada escrito', async () => {
    base()
    // La ficha de hoy trae TEL; la clienta pagó con VERIFICADO: un sobre con VERIFICADO no lo podría gastar.
    await expect(abonar(250, nadie(VERIFICADO))).rejects.toMatchObject({
      code: 'STORE_CREDIT_PHONE_MISMATCH',
      statusCode: 409,
      message: expect.stringMatching(/Ana López[\s\S]*otro teléfono[\s\S]*tarjeta/),
    })
    sinEscribir()
  })

  it('D661 · Ruling 57: con el sobre en el número verificado pero la ficha ya en otro, tampoco se abona', async () => {
    base({ sobreDeSaldo: sobre({ recipientPhone: VERIFICADO }) })
    await expect(abonar(250, nadie(VERIFICADO))).rejects.toMatchObject({ code: 'STORE_CREDIT_PHONE_MISMATCH', statusCode: 409 })
    sinEscribir()
  })

  it('D661 · Ruling 57: una ficha que ya no tiene teléfono tampoco es «el mismo número»: 409 y nada escrito', async () => {
    base()
    fichaCon(null)
    await expect(abonar(250, nadie(VERIFICADO))).rejects.toMatchObject({ code: 'STORE_CREDIT_PHONE_MISMATCH', statusCode: 409 })
    sinEscribir()
  })

  it('saldo: primer sobre se crea con el teléfono verificado del pago, que sigue siendo el de su ficha', async () => {
    base()
    fichaCon('55 1111 2222') // = VERIFICADO, escrito distinto
    const out = await abonar(250, nadie(VERIFICADO))
    expect((prismaMock.giftCard.create.mock.calls[0][0].data as any).recipientPhone).toBe(VERIFICADO)
    expect(out).toMatchObject({ giftCardId: 'gc-nuevo', telefonoDelSobre: VERIFICADO, telefonoNoCoincide: false })
    expect(prismaMock.giftCardActivity.create.mock.calls[0][0].data).toMatchObject({
      type: 'ACTIVATE',
      note: 'Saldo a favor · Reembolso F-12',
    })
  })

  it('saldo: sin teléfono verificado y sin sobre → STORE_CREDIT_CUSTOMER_PHONE_REQUIRED (aunque la ficha de hoy sí tenga)', async () => {
    base()
    await expect(abonar(250, nadie(null))).rejects.toMatchObject({
      code: 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED',
      statusCode: 400,
      message: expect.stringMatching(/verificado[\s\S]*tarjeta/),
    })
    sinEscribir()
  })

  it('sin el parámetro (el «Cambio» y el Reembolso del POS) todo sigue como hoy: otro número abona con su señal', async () => {
    base({ sobreDeSaldo: sobre({ recipientPhone: '+525598765478' }) })
    await expect(abonar(100)).resolves.toMatchObject({ telefonoNoCoincide: true })
  })

  /** El candado de la ficha (`FOR NO KEY UPDATE` sobre "Customer"), como lo toma `cambiarTelefonoEnTx` de «Mi cuenta». */
  const candadoDeLaFicha = () =>
    (prismaMock.$queryRaw.mock.calls as any[][]).findIndex(
      ([s]) => textoDe(s).includes('FROM "Customer"') && textoDe(s).includes('FOR NO KEY UPDATE'),
    )

  /** El orden de la primera llamada a `$queryRaw` cuyo SQL cumple `es` (Infinity si no hubo). */
  const ordenDe = (es: (sql: string) => boolean) => {
    const i = (prismaMock.$queryRaw.mock.calls as any[][]).findIndex(([s]) => es(textoDe(s)))
    return i < 0 ? Infinity : prismaMock.$queryRaw.mock.invocationCallOrder[i]
  }
  const asesor = (sql: string) => sql.includes('pg_advisory_xact_lock')
  /** El FOR UPDATE del sobre (`lockGiftCardsForUpdate`). */
  const candadoDelSobre = (sql: string) => sql.includes('FROM "GiftCard"') && sql.includes('FOR UPDATE')

  it('D661 · Ruling 75: el abono toma la ficha con el MISMO candado que «Mi cuenta» y relee su número bajo él: si ya es otro (lo confirmó mientras se abonaba), 409 y nada escrito', async () => {
    base({ sobreDeSaldo: sobre({ recipientPhone: VERIFICADO }) })
    // Al preparar, su ficha tenía el número verificado (escrito distinto); bajo el candado, ya es otro: lo cambió en «Mi cuenta».
    prismaMock.customer.findFirst
      .mockResolvedValueOnce({ firstName: 'Ana', lastName: 'López', phone: '55 1111 2222' } as any)
      .mockResolvedValueOnce({ phone: '55 3333 4444' } as any)
    await expect(abonar(250, nadie(VERIFICADO))).rejects.toMatchObject({ code: 'STORE_CREDIT_PHONE_MISMATCH', statusCode: 409 })
    sinEscribir()
    const candado = candadoDeLaFicha()
    expect(candado).toBeGreaterThanOrEqual(0)
    // Ronda 2 de codex-r3: el orden de la parte 2 es `Customer` (8) → asesor del saldo y `GiftCard` (9): la ficha se toma ANTES que el
    // asesor de la clienta y que el FOR UPDATE de su sobre (los toma `preparar`), y antes de leer su número.
    const ficha = prismaMock.$queryRaw.mock.invocationCallOrder[candado]
    expect(ordenDe(candadoDelSobre)).toBeLessThan(Infinity) // hubo sobre: su candado se tomó
    expect(ficha).toBeLessThan(ordenDe(asesor))
    expect(ordenDe(asesor)).toBeLessThan(ordenDe(candadoDelSobre))
    expect(ficha).toBeLessThan(prismaMock.customer.findFirst.mock.invocationCallOrder[0])
    // Y la relectura del número de `abonar` sigue bajo él (la segunda lectura de la ficha).
    expect(prismaMock.customer.findFirst).toHaveBeenCalledTimes(2)
    expect(ficha).toBeLessThan(prismaMock.customer.findFirst.mock.invocationCallOrder[1])
    expect(prismaMock.customer.findFirst.mock.calls[1][0]).toMatchObject({ where: { id: CLIENTA, venueId: VENUE } })
  })

  it('D661 · Ruling 75: con el mismo número bajo el candado abona como hoy; sin el parámetro (Cambio, Reembolso del POS) no toma la ficha', async () => {
    base()
    fichaCon('55 1111 2222') // = VERIFICADO, escrito distinto
    await expect(abonar(250, nadie(VERIFICADO))).resolves.toMatchObject({ giftCardId: 'gc-nuevo', telefonoDelSobre: VERIFICADO })
    expect(candadoDeLaFicha()).toBeGreaterThanOrEqual(0)

    jest.clearAllMocks()
    base()
    await expect(abonar(100)).resolves.toMatchObject({ giftCardId: 'gc-nuevo' })
    expect(candadoDeLaFicha()).toBe(-1)
    expect(prismaMock.customer.findFirst).toHaveBeenCalledTimes(1) // sólo la de preparar
  })
})
