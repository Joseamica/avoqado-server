/**
 * S13 (P2-6): «Guardar en mi cuenta». Con el doble de Prisma: el orden de candados (Customer FOR SHARE → GiftCard FOR UPDATE), la
 * revalidación de la sesión bajo la ficha (R1/R1'), la prueba juzgada otra vez bajo el candado de la tarjeta (codex-plan2-r1 #1), sólo
 * tarjetas vivas (R6), un CLAIM una vez, el 409 entre clientas y que nunca mueve saldo. Las carreras reales van en la integración.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { generateGiftCardCode, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { guardarTarjetaEnMiCuenta, type SesionDeLaClienta } from '@/services/giftCards/giftCardClaim.service'

const VENUE = 'cvenue000000000000000000a'
const ELLA = 'cficha00000000000000000a1'
const OTRA = 'cficha00000000000000000b2'
const TARJETA = 'cgift0000000000000000000a'
const codigo = generateGiftCardCode()
const SESION: SesionDeLaClienta = {
  customerId: ELLA,
  contactos: [{ tipo: 'PHONE', valor: '+525511112222', metodo: 'WHATSAPP', probadoEn: 1_800_000_000 }],
  verifiedPhone: '+525511112222',
  v: 2,
}
const FICHA = { active: true, versionDeSesion: 2, phone: '+525511112222', email: null }

const texto = (a: any): string => (Array.isArray(a) ? a.join('?') : (a?.sql ?? a?.strings?.join('?') ?? ''))

function tarjeta(extra: Record<string, unknown> = {}) {
  return {
    id: TARJETA,
    venueId: VENUE,
    codeHash: hashGiftCardCode(codigo.normalized),
    pageToken: 'pagetoken000000000000000000000',
    recipientPhone: null,
    deliveryChannel: 'HANDED_TO_BUYER',
    status: 'ACTIVE',
    balance: new Prisma.Decimal('450.00'),
    initialAmount: new Prisma.Decimal('500.00'),
    expiresAt: null,
    activatedAt: new Date('2026-11-01T18:00:00.000Z'),
    validityMonths: null,
    customerId: null,
    ...extra,
  }
}

/** Cada consulta cruda, en orden: la ficha (FOR SHARE), la tarjeta (FOR UPDATE) y si es saldo a favor. */
function armar(o: { ficha?: any[]; tarjeta?: any; saldoAFavor?: boolean } = {}) {
  prismaMock.giftCard.findFirst.mockReset().mockResolvedValue({ id: TARJETA, codeLast4: codigo.last4 } as any)
  prismaMock.giftCard.updateMany.mockReset().mockResolvedValue({ count: 1 } as any)
  prismaMock.giftCardActivity.create.mockReset().mockResolvedValue({ id: 'cact' } as any)
  prismaMock.activityLog.create.mockReset().mockResolvedValue({ id: 'clog' } as any)
  prismaMock.$transaction.mockClear()
  prismaMock.$queryRaw.mockReset().mockImplementation(async (a: any) => {
    const sql = texto(a)
    if (sql.includes('FOR SHARE')) return o.ficha ?? [FICHA]
    if (sql.includes('FOR UPDATE')) return [o.tarjeta ?? tarjeta()]
    if (sql.includes('AS es')) return [{ es: o.saldoAFavor ?? false }]
    throw new Error(`consulta cruda no esperada: ${sql.slice(0, 80)}`)
  })
}
const consultas = (): string[] => prismaMock.$queryRaw.mock.calls.map(([a]: any[]) => texto(a))
const nadaEscrito = () => {
  expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
}

describe('guardarTarjetaEnMiCuenta', () => {
  it('sin dueña: la liga a ella, escribe UN CLAIM de $0 con el saldo de ese momento y su bitácora; nunca mueve saldo', async () => {
    armar()
    const r = await guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: '203.0.113.9' })
    expect(r).toEqual({ giftCardId: TARJETA, last4: codigo.last4, saldo: 450 })
    // El código se resuelve dentro del negocio, ANTES de la transacción.
    expect(prismaMock.giftCard.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE, codeHash: hashGiftCardCode(codigo.normalized) })
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: TARJETA, venueId: VENUE, customerId: null },
      data: { customerId: ELLA },
    })
    expect(prismaMock.giftCardActivity.create).toHaveBeenCalledTimes(1)
    const actividad = prismaMock.giftCardActivity.create.mock.calls[0][0].data
    expect(actividad).toEqual({
      giftCardId: TARJETA,
      venueId: VENUE,
      type: 'CLAIM',
      amount: new Prisma.Decimal(0),
      balanceAfter: new Prisma.Decimal('450.00'),
    })
    // Una tarjeta guardada no se vuelve saldo a favor: no hay ACTIVATE ni devolución (EL predicado sigue en falso).
    expect(actividad).not.toHaveProperty('refundPaymentId')
    expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({
      venueId: VENUE,
      action: 'GIFT_CARD_CLAIMED',
      entity: 'GiftCard',
      entityId: TARJETA,
      data: { customerId: ELLA, last4: codigo.last4 },
      ipAddress: '203.0.113.9',
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('toma Customer FOR SHARE (de ESTA sucursal) ANTES de lockGiftCardsForUpdate (orden de llamadas al doble)', async () => {
    armar()
    await guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })
    const q = consultas()
    const ficha = q.findIndex(s => s.includes('FROM "Customer"') && s.includes('FOR SHARE'))
    const sobre = q.findIndex(s => s.includes('FROM "GiftCard"') && s.includes('FOR UPDATE'))
    expect(ficha).toBe(0)
    expect(sobre).toBe(1)
    expect(q[ficha]).toContain('"venueId" =')
    expect(q[ficha]).not.toContain('KEY SHARE')
  })

  it('ya guardada por otra clienta ⇒ 409 GIFT_CARD_ALREADY_SAVED, sin escribir', async () => {
    armar({ tarjeta: tarjeta({ customerId: OTRA }) })
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).rejects.toMatchObject({
      statusCode: 409,
      code: 'GIFT_CARD_ALREADY_SAVED',
      message: 'Esta tarjeta ya está guardada en otra cuenta.',
    })
    nadaEscrito()
  })

  it('repetir (ya es suya) ⇒ la misma respuesta, sin otra actividad', async () => {
    armar({ tarjeta: tarjeta({ customerId: ELLA }) })
    expect(await guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).toEqual({
      giftCardId: TARJETA,
      last4: codigo.last4,
      saldo: 450,
    })
    nadaEscrito()
  })

  it('codex-plan2-r1 #1: el gerente repuso el código antes del candado (la huella bajo el candado ya es otra) ⇒ 404, sin escribir', async () => {
    armar({ tarjeta: tarjeta({ codeHash: hashGiftCardCode(generateGiftCardCode().normalized) }) })
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GIFT_CARD_NOT_FOUND',
    })
    nadaEscrito()
  })

  it('un código mal escrito o de otro negocio ⇒ el mismo 404, sin abrir transacción', async () => {
    armar()
    prismaMock.giftCard.findFirst.mockResolvedValue(null)
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).rejects.toMatchObject({ statusCode: 404 })
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, 'NO-ES-UN-CODIGO', { ip: null })).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  const ayer = new Date(Date.now() - 86_400_000)
  it.each([
    ['bloqueada', { status: 'BLOCKED' }],
    ['sin activar', { status: 'PENDING' }],
    ['desactivada', { status: 'DEACTIVATED' }],
    ['vencida', { expiresAt: ayer }],
    ['de otro negocio', { venueId: 'cotrovenue00000000000000a' }],
  ])('R6: %s ⇒ el MISMO 404 del código inválido, sin escribir', async (_c, extra) => {
    armar({ tarjeta: tarjeta(extra) })
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GIFT_CARD_NOT_FOUND',
      message: 'No encontramos esa tarjeta de regalo en este negocio. Revisa el código.',
    })
    nadaEscrito()
  })

  it('un sobre de saldo a favor (aunque sea suyo) no se guarda como tarjeta: el mismo 404', async () => {
    armar({ tarjeta: tarjeta({ customerId: ELLA }), saldoAFavor: true })
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).rejects.toMatchObject({ statusCode: 404 })
    nadaEscrito()
  })

  it.each([
    ['la versión quedó vieja (S8 cambió el número)', [{ ...FICHA, versionDeSesion: 3 }]],
    ['el teléfono probado ya no es el de la ficha', [{ ...FICHA, phone: '+525599998888' }]],
    ["la ficha se desactivó (R1')", [{ ...FICHA, active: false }]],
    ["la ficha no es de esta sucursal (R1')", []],
  ])('R1: %s bajo el candado ⇒ 401 CUSTOMER_REAUTH_REQUIRED, sin tomar la tarjeta ni escribir', async (_c, ficha) => {
    armar({ ficha })
    await expect(guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_REAUTH_REQUIRED',
    })
    expect(consultas().some(s => s.includes('FOR UPDATE'))).toBe(false)
    nadaEscrito()
  })

  it('si Postgres corta por interbloqueo (40P01), la transacción se repite entera y guarda UNA vez', async () => {
    armar()
    const traba = new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '40P01' },
    })
    prismaMock.$transaction.mockImplementationOnce(async () => {
      throw traba
    })
    const r = await guardarTarjetaEnMiCuenta(VENUE, SESION, codigo.display, { ip: null })
    expect(r.giftCardId).toBe(TARJETA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(prismaMock.giftCardActivity.create).toHaveBeenCalledTimes(1)
  })
})
