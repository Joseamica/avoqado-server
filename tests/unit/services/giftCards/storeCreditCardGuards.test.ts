/**
 * S8a (spec 2026-10-30-saldo-a-favor §5.2, «Reenvío y código», el teléfono y «Reportes de tarjetas»):
 *  - un sobre de saldo a favor NO se reenvía, NO cambia de destino y NO enseña su código: los tres darían un código al portador;
 *  - un gerente cambia el teléfono con que se gasta: el nuevo gasta, un código pedido con el viejo y una prueba firmada con el viejo
 *    dejan de servir;
 *  - el resumen del periodo pone el saldo a favor en su propia línea, fuera de «vendidas» y de «ajustes».
 * La base es un doble chico en memoria (el sobre, sus retos de teléfono y sus movimientos) para probar el comportamiento de punta a
 * punta con las funciones reales; lo de Postgres real vive en tests/integration/storeCredit/telefonoYReporteDelSaldo.integration.test.ts.
 */
jest.mock('@/services/whatsapp.service', () => ({ sendOtpWhatsApp: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/giftCards/giftCardCode', () => {
  const real = jest.requireActual('@/services/giftCards/giftCardCode')
  return { ...real, decryptGiftCardCode: jest.fn(real.decryptGiftCardCode) }
})

import { Prisma, type GiftCardActivityType } from '@prisma/client'
import { sendOtpWhatsApp } from '@/services/whatsapp.service'
import { decryptGiftCardCode, encryptGiftCardCode, generateGiftCardCode } from '@/services/giftCards/giftCardCode'
import { cambiarDestinoDeTarjeta, reenviarTarjeta, revelarCodigo, type QuienPregunta } from '@/services/giftCards/giftCardCuenta.service'
import { cambiarTelefonoDeSaldoAFavorEnTx, esSobreDeSaldoAFavorSql, lockGiftCardsForUpdate } from '@/services/giftCards/giftCardLedger'
import { pedirCodigoDeTelefono, verificarCodigoDeTelefono } from '@/services/giftCards/giftCardPhone.service'
import { resolverPrueba } from '@/services/giftCards/giftCardProof'
import { getGiftCardSummary } from '@/services/giftCards/giftCardReports.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'cvenue0000000000000000001'
const SOBRE = 'cgiftcard0000000000000001'
const GERENTE: QuienPregunta = { staffId: 'cstaffgerente000000000001', puedeVender: true, puedeGestionar: true }
const APARATO = 'caja-1'
const VIEJO = '+525512345678'
const NUEVO = '+525598765432'
const codigo = generateGiftCardCode()

/** El texto de una llamada a `$queryRaw` (plantilla o `Prisma.sql`). */
const textoDe = (arg: any): string => (Array.isArray(arg) ? arg.join('?') : (arg?.strings ?? []).join('?'))
const ultimos10 = (t: string | null) => (t ?? '').replace(/\D/g, '').slice(-10)

// ─── La base simulada ───

type Fila = {
  id: string
  venueId: string
  codeHash: string
  pageToken: string
  codeLast4: string
  recipientPhone: string | null
  deliveryChannel: string
  deliveryStatus: string
  status: string
  balance: Prisma.Decimal
  initialAmount: Prisma.Decimal
  expiresAt: Date | null
  activatedAt: Date | null
  validityMonths: number | null
  customerId: string | null
}
type Reto = {
  id: string
  venueId: string
  destination: string
  channel: string
  purpose: string
  codeHash: string
  expiresAt: Date
  attempts: number
  maxAttempts: number
  consumedAt: Date | null
  createdAt: Date
}

let sobre: Fila | null
let esDeSaldo: boolean
let retos: Reto[]

function nuevoSobre(over: Partial<Fila> = {}): Fila {
  return {
    id: SOBRE,
    venueId: VENUE,
    codeHash: 'huella-del-sobre',
    pageToken: 'liga-del-sobre-0123456789abcdef',
    codeLast4: codigo.last4,
    recipientPhone: VIEJO,
    deliveryChannel: 'WHATSAPP',
    deliveryStatus: 'SENT',
    status: 'ACTIVE',
    balance: new Prisma.Decimal(300),
    initialAmount: new Prisma.Decimal(300),
    expiresAt: null,
    activatedAt: new Date('2026-10-01T18:00:00.000Z'),
    validityMonths: null,
    customerId: 'ccliente00000000000000001',
    ...over,
  }
}

/** `where` de Prisma sobre un reto: igualdad, `null` y los `gt`/`lt` que usan los límites y los CAS de intentos. */
function retoCumple(r: Reto, where: Record<string, any>): boolean {
  return Object.entries(where).every(([campo, v]) => {
    const actual = (r as any)[campo]
    if (v === null) return actual === null
    if (v instanceof Date || typeof v !== 'object') return actual === v
    return Object.entries(v).every(([op, x]: [string, any]) => {
      if (op === 'gt') return actual > x
      if (op === 'lt') return actual < x
      throw new Error(`operador inesperado en el reto: ${op}`)
    })
  })
}

function armarBase() {
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockImplementation((async (strings: any, ...valores: any[]) => {
    const sql = textoDe(strings)
    if (sql.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: '' }]
    if (sql.includes('FOR UPDATE')) return sobre ? [{ ...sobre }] : []
    if (sql.includes(' AS es FROM "GiftCard"')) return sobre && valores.includes(sobre.id) ? [{ es: esDeSaldo }] : []
    if (sql.includes('regexp_replace')) {
      // `tarjetasDelTelefono`: el prefiltro por los últimos 10 dígitos del teléfono VIGENTE del sobre.
      return sobre && sobre.deliveryChannel === 'WHATSAPP' && valores.includes(ultimos10(sobre.recipientPhone)) ? [{ ...sobre }] : []
    }
    throw new Error(`SQL inesperado: ${sql}`)
  }) as any)
  prismaMock.giftCard.updateMany.mockImplementation((async ({ where, data }: any) => {
    if (!sobre || where.id !== sobre.id || where.venueId !== sobre.venueId) return { count: 0 }
    Object.assign(sobre, data)
    return { count: 1 }
  }) as any)
  prismaMock.giftCard.findFirst.mockImplementation((async ({ where }: any) =>
    sobre && where.id === sobre.id && where.venueId === sobre.venueId ? { id: sobre.id, codeLast4: sobre.codeLast4 } : null) as any)
  prismaMock.giftCard.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.giftCard.update.mockResolvedValue({ id: SOBRE } as any)
  prismaMock.giftCardActivity.findUnique.mockResolvedValue(null)
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' } as any)
  prismaMock.activityLog.createMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', organizationId: 'org-1' } as any)

  prismaMock.otpChallenge.create.mockImplementation((async ({ data }: any) => {
    const reto: Reto = {
      id: `reto-${retos.length + 1}`,
      attempts: 0,
      maxAttempts: 5,
      consumedAt: null,
      createdAt: new Date(),
      ...data,
    }
    retos.push(reto)
    return reto
  }) as any)
  prismaMock.otpChallenge.findMany.mockImplementation((async ({ where }: any) =>
    retos.filter(r => retoCumple(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) as any)
  prismaMock.otpChallenge.findFirst.mockImplementation(
    (async ({ where }: any) =>
      retos.filter(r => retoCumple(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null) as any,
  )
  prismaMock.otpChallenge.updateMany.mockImplementation((async ({ where, data }: any) => {
    const tocados = retos.filter(r => retoCumple(r, where))
    for (const r of tocados) {
      if ('consumedAt' in data) r.consumedAt = data.consumedAt
      if (data.attempts?.increment) r.attempts += data.attempts.increment
      if (data.attempts?.decrement) r.attempts -= data.attempts.decrement
    }
    return { count: tocados.length }
  }) as any)
}

beforeEach(() => {
  sobre = nuevoSobre()
  esDeSaldo = true
  retos = []
  ;(sendOtpWhatsApp as jest.Mock).mockClear()
  ;(decryptGiftCardCode as jest.Mock).mockClear()
  armarBase()
})

/** El código que el doble de WhatsApp «mandó» a ese teléfono (el último). */
function codigoMandadoA(telefono: string): string {
  const llamadas = (sendOtpWhatsApp as jest.Mock).mock.calls.filter(([destino]) => destino === telefono)
  if (llamadas.length === 0) throw new Error(`No salió ningún código por WhatsApp a ${telefono}`)
  return llamadas[llamadas.length - 1][1]
}

const cambiarTelefono = (telefono: string) =>
  cambiarTelefonoDeSaldoAFavorEnTx(prismaMock, { venueId: VENUE, giftCardId: SOBRE, telefono, staffId: GERENTE.staffId })

/** El sobre como lo ve el cobro: bloqueado y releído (la prueba por teléfono se juzga contra ESTO). */
const sobreBajoElCandado = async () => (await lockGiftCardsForUpdate(prismaMock, [SOBRE]))[0]

// ─── 1. Reenviar, cambiar destino y mostrar el código ───

describe('un sobre de saldo a favor no se reenvía, no cambia de destino ni enseña su código', () => {
  const NO_ELEGIBLE = { code: 'STORE_CREDIT_CARD_NOT_ELIGIBLE', statusCode: 409 }
  const AUDITORIA = { staffId: GERENTE.staffId, ruta: 'POST /prueba' }

  const acciones: Record<string, () => Promise<unknown>> = {
    reenviar: () => reenviarTarjeta(VENUE, SOBRE, GERENTE, { operationKey: 'reenvia-0001' }),
    'cambiar destino': () =>
      cambiarDestinoDeTarjeta(VENUE, SOBRE, GERENTE, {
        operationKey: 'destino-0001',
        destino: { deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' },
      }),
    'mostrar código (reveal)': () =>
      revelarCodigo(VENUE, SOBRE, GERENTE, { operationKey: 'revela-0001', motivo: 'REPRINT', comoGerente: false, auditoria: AUDITORIA }),
    'mostrar código (reveal-manager)': () =>
      revelarCodigo(VENUE, SOBRE, GERENTE, { operationKey: 'revela-0002', motivo: 'SHOW_QR', comoGerente: true, auditoria: AUDITORIA }),
  }

  it.each(Object.keys(acciones))('%s → STORE_CREDIT_CARD_NOT_ELIGIBLE, sin tocar nada ni enseñar nada', async accion => {
    const error: any = await acciones[accion]().catch(e => e)
    expect(error).toMatchObject(NO_ELEGIBLE)
    expect(error.message).toMatch(/^Este saldo se usa con el teléfono de la clienta/)
    // Nada se escribe: ni la entrega, ni el destino, ni el código, ni el renglón de la salida del secreto.
    expect(prismaMock.giftCard.update).not.toHaveBeenCalled()
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.giftCardActivity.create).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.createMany).not.toHaveBeenCalled()
    expect(decryptGiftCardCode).not.toHaveBeenCalled()
    expect(sobre).toEqual(nuevoSobre())
    // Lo decide EL predicado del saldo a favor, preguntado por este sobre y bajo su candado.
    const sqls = prismaMock.$queryRaw.mock.calls.map((c: any[]) => textoDe(c[0]))
    expect(sqls[0]).toContain('FOR UPDATE')
    const pregunta = prismaMock.$queryRaw.mock.calls.find((c: any[]) => textoDe(c[0]).includes(' AS es FROM'))!
    expect(pregunta.slice(1).some((v: any) => v?.sql === esSobreDeSaldoAFavorSql('g').sql)).toBe(true)
    expect(pregunta.slice(1)).toContain(SOBRE)
  })

  it('una tarjeta regalada (no es saldo a favor) sí enseña su código: el bloqueo es sólo del saldo a favor', async () => {
    esDeSaldo = false
    sobre = nuevoSobre({ customerId: null })
    prismaMock.giftCard.findUnique.mockResolvedValue({
      id: SOBRE,
      codeEnc: encryptGiftCardCode(codigo.normalized),
      pageToken: 'liga-del-sobre-0123456789abcdef',
      codeLast4: codigo.last4,
      initialAmount: 300,
      balance: 300,
      expiresAt: null,
      termsVersion: '2026-10-14',
      recipientName: 'Ana',
      purchaserName: 'Luis',
      message: null,
    } as any)
    await expect(acciones['mostrar código (reveal-manager)']()).resolves.toMatchObject({ codigo: codigo.display })
  })
})

// ─── 2. Cambiar el teléfono con que se gasta ───

describe('cambiarTelefonoDeSaldoAFavorEnTx: el gerente cambia el teléfono con que se gasta el saldo', () => {
  it('control: antes del cambio, el código pedido con el teléfono de la clienta sí sirve (el doble de la base funciona)', async () => {
    await pedirCodigoDeTelefono(VENUE, { phone: VIEJO, deviceId: APARATO })
    const r = await verificarCodigoDeTelefono(VENUE, { phone: VIEJO, code: codigoMandadoA(VIEJO), deviceId: APARATO })
    expect(r.cards.map(c => c.giftCardId)).toEqual([SOBRE])
  })

  it('🔴 un código pedido con el teléfono viejo se rechaza después del cambio', async () => {
    await pedirCodigoDeTelefono(VENUE, { phone: VIEJO, deviceId: APARATO })
    const codigoViejo = codigoMandadoA(VIEJO)
    await cambiarTelefono('55 9876 5432')
    await expect(verificarCodigoDeTelefono(VENUE, { phone: VIEJO, code: codigoViejo, deviceId: APARATO })).rejects.toMatchObject({
      code: 'GIFT_CARD_PHONE_CODE_INVALID',
      statusCode: 409,
    })
  })

  it('🔴 una prueba firmada con el teléfono viejo deja de servir para gastar', async () => {
    await pedirCodigoDeTelefono(VENUE, { phone: VIEJO, deviceId: APARATO })
    const { proofToken } = await verificarCodigoDeTelefono(VENUE, { phone: VIEJO, code: codigoMandadoA(VIEJO), deviceId: APARATO })
    const prueba = await resolverPrueba(VENUE, { kind: 'PHONE_OTP', proofToken, giftCardId: SOBRE }, { deviceId: APARATO })
    expect(prueba.vigente(await sobreBajoElCandado(), new Date())).toBe(true)

    await cambiarTelefono(NUEVO)
    expect(prueba.vigente(await sobreBajoElCandado(), new Date())).toBe(false)
    expect(prueba.rechazo()).toMatchObject({ code: 'GIFT_CARD_PHONE_PROOF_INVALID', statusCode: 409 })
  })

  it('🔴 el teléfono nuevo gasta: le llega el código, verifica y su prueba vale para el sobre', async () => {
    await cambiarTelefono('5598765432')
    expect(sobre!.recipientPhone).toBe(NUEVO)
    await pedirCodigoDeTelefono(VENUE, { phone: '5598765432', deviceId: APARATO })
    const r = await verificarCodigoDeTelefono(VENUE, { phone: '5598765432', code: codigoMandadoA(NUEVO), deviceId: APARATO })
    expect(r.cards).toEqual([expect.objectContaining({ giftCardId: SOBRE, usable: true })])
    const prueba = await resolverPrueba(VENUE, { kind: 'PHONE_OTP', proofToken: r.proofToken, giftCardId: SOBRE }, { deviceId: APARATO })
    expect(prueba.vigente(await sobreBajoElCandado(), new Date())).toBe(true)
    // Y el número viejo ya no encuentra el sobre: ni siquiera le sale el WhatsApp.
    ;(sendOtpWhatsApp as jest.Mock).mockClear()
    await pedirCodigoDeTelefono(VENUE, { phone: VIEJO, deviceId: APARATO })
    expect(sendOtpWhatsApp).not.toHaveBeenCalled()
  })

  it('bajo el candado del sobre, con bitácora STORE_CREDIT_PHONE_CHANGED enmascarada, sin mandar nada y sin tocar la entrega', async () => {
    await pedirCodigoDeTelefono(VENUE, { phone: VIEJO, deviceId: APARATO })
    ;(sendOtpWhatsApp as jest.Mock).mockClear()
    prismaMock.$queryRaw.mockClear()

    await expect(cambiarTelefono('+52 55 9876 5432')).resolves.toEqual({ phoneLast4: '5432' })

    // El candado del sobre va PRIMERO (no se cruza con un canje: la prueba se juzga bajo ese mismo candado).
    expect(textoDe(prismaMock.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE')
    // Sólo cambia el teléfono, en su forma canónica: ni el canal ni el estado de la entrega (con PENDING, la entrega mandaría la página).
    expect(prismaMock.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: SOBRE, venueId: VENUE },
      data: { recipientPhone: NUEVO },
    })
    expect(sobre).toMatchObject({ deliveryChannel: 'WHATSAPP', deliveryStatus: 'SENT' })
    expect(sendOtpWhatsApp).not.toHaveBeenCalled()
    // Los retos vivos del número viejo, de ESTE propósito, se consumen en la misma transacción.
    expect(prismaMock.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: { venueId: VENUE, destination: VIEJO, purpose: 'GIFT_CARD_PHONE', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    })
    expect(retos.every(r => r.consumedAt !== null)).toBe(true)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: {
        venueId: VENUE,
        staffId: GERENTE.staffId,
        action: 'STORE_CREDIT_PHONE_CHANGED',
        entity: 'GiftCard',
        entityId: SOBRE,
        data: { telefonoAnterior: '55•••••678', telefonoNuevo: '55•••••432' },
      },
    })
    // Nunca el teléfono completo en la bitácora.
    expect(JSON.stringify(prismaMock.activityLog.create.mock.calls)).not.toMatch(/5512345678|5598765432/)
  })

  it('un sobre BLOQUEADO también cambia de teléfono (el gerente lo arregla antes de desbloquearlo)', async () => {
    sobre = nuevoSobre({ status: 'BLOCKED' })
    await expect(cambiarTelefono(NUEVO)).resolves.toEqual({ phoneLast4: '5432' })
    expect(sobre.recipientPhone).toBe(NUEVO)
  })

  it('el mismo teléfono no escribe nada (repetir el cambio es seguro)', async () => {
    await expect(cambiarTelefono('55 1234 5678')).resolves.toEqual({ phoneLast4: '5678' })
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.otpChallenge.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  const sinEscribir = () => {
    expect(prismaMock.giftCard.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.otpChallenge.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  }

  it('una tarjeta regalada (no es saldo a favor) → STORE_CREDIT_CARD_NOT_ELIGIBLE, sin escribir', async () => {
    esDeSaldo = false
    await expect(cambiarTelefono(NUEVO)).rejects.toMatchObject({ code: 'STORE_CREDIT_CARD_NOT_ELIGIBLE', statusCode: 409 })
    sinEscribir()
  })

  it('un teléfono que no se entiende → 400 GIFT_CARD_PHONE_INVALID antes de tomar el candado', async () => {
    await expect(cambiarTelefono('12')).rejects.toMatchObject({ code: 'GIFT_CARD_PHONE_INVALID', statusCode: 400 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    sinEscribir()
  })

  it.each([
    ['de otro negocio', () => nuevoSobre({ venueId: 'cvenue0000000000000000002' })],
    ['desactivado', () => nuevoSobre({ status: 'DEACTIVATED' })],
    ['que no existe', () => null],
  ])('un sobre %s → 404 GIFT_CARD_NOT_FOUND, sin escribir', async (_caso, armar) => {
    sobre = armar()
    await expect(cambiarTelefono(NUEVO)).rejects.toMatchObject({ code: 'GIFT_CARD_NOT_FOUND', statusCode: 404 })
    sinEscribir()
  })
})

// ─── 3. El resumen del periodo ───

type Mov = {
  giftCardId: string
  venueId: string
  type: GiftCardActivityType
  amount: Prisma.Decimal
  refundPaymentId: string | null
  createdAt: Date
}

describe('el resumen separa el saldo a favor de las vendidas y de los ajustes', () => {
  const EN_EL_PERIODO = new Date('2026-10-10T18:00:00.000Z')
  const mov = (giftCardId: string, type: GiftCardActivityType, monto: number, refundPaymentId: string | null = null): Mov => ({
    giftCardId,
    venueId: VENUE,
    type,
    amount: new Prisma.Decimal(monto),
    refundPaymentId,
    createdAt: EN_EL_PERIODO,
  })
  const movimientos: Mov[] = [
    // Una tarjeta regalada: se vende, se usa y un reembolso le regresa parte (su REDEEM_REVERSAL trae refundPaymentId y NO es saldo a favor).
    mov('regalada', 'ACTIVATE', 1000),
    mov('regalada', 'REDEEM', 200),
    mov('regalada', 'REDEEM_REVERSAL', 50, 'reembolso-del-canje'),
    // El sobre de saldo a favor: nace con un Cambio, se recarga con un Reembolso y un gerente lo ajusta (eso sigue siendo ajuste).
    mov('saldo', 'ACTIVATE', 300, 'devolucion-1'),
    mov('saldo', 'ADJUST_INCREMENT', 150, 'devolucion-2'),
    mov('saldo', 'ADJUST_INCREMENT', 40),
    mov('saldo', 'ADJUST_DECREMENT', 10),
    // Una venta de tarjeta cancelada (su DEACTIVATE trae refundPaymentId y NO es saldo a favor).
    mov('cancelada', 'ACTIVATE', 500),
    mov('cancelada', 'DEACTIVATE', 500, 'devolucion-de-la-venta'),
    // Un sobre que nunca se cobró: su desactivación de $0 no es una «cancelada» (M4).
    mov('nunca-cobrado', 'DEACTIVATE', 0),
  ]

  /** El `where` de Prisma evaluado sobre los movimientos: los operadores que usa el resumen, y nada más (lo demás truena). */
  function cumple(m: Mov, where: Record<string, any>): boolean {
    return Object.entries(where).every(([campo, v]) => {
      if (campo === 'NOT') return (Array.isArray(v) ? v : [v]).every(c => !cumple(m, c))
      if (campo === 'giftCard') {
        const { none, ...resto } = v.activities
        if (Object.keys(resto).length) throw new Error('relación inesperada')
        return !movimientos.some(o => o.giftCardId === m.giftCardId && cumple(o, none))
      }
      const actual = (m as any)[campo]
      if (v === null || typeof v !== 'object' || v instanceof Date) return actual === v
      return Object.entries(v).every(([op, x]: [string, any]) => {
        if (op === 'in') return x.includes(actual)
        if (op === 'not') return actual !== x
        if (op === 'gte') return actual >= x
        if (op === 'lte') return actual instanceof Prisma.Decimal ? actual.lte(x) : actual <= x
        throw new Error(`operador inesperado: ${op}`)
      })
    })
  }

  beforeEach(() => {
    prismaMock.giftCardActivity.groupBy.mockImplementation((async ({ by, where }: any) => {
      expect(by).toEqual(['type'])
      const grupos = new Map<string, { type: string; _sum: { amount: Prisma.Decimal }; _count: { _all: number } }>()
      for (const m of movimientos.filter(x => cumple(x, where))) {
        const g = grupos.get(m.type) ?? { type: m.type, _sum: { amount: new Prisma.Decimal(0) }, _count: { _all: 0 } }
        g._sum.amount = g._sum.amount.plus(m.amount)
        g._count._all += 1
        grupos.set(m.type, g)
      }
      return [...grupos.values()]
    }) as any)
    prismaMock.giftCard.aggregate
      .mockResolvedValueOnce({ _sum: { balance: new Prisma.Decimal('1230') }, _count: { _all: 2 } })
      .mockResolvedValueOnce({ _sum: { balance: null } })
  })

  it('«vendidas» y «ajustes» sin el saldo a favor; el saldo a favor en su línea; lo demás como siempre', async () => {
    const r = await getGiftCardSummary(VENUE, { from: '2026-10-01', to: '2026-10-14' })
    expect(r).toMatchObject({
      sold: { cards: 2, amount: 1500 },
      redeemed: { movements: 1, amount: 200, reversed: 50, net: 150 },
      cancelled: { cards: 1, amount: 500 },
      adjustments: { increments: 40, decrements: 10, net: 30 },
      storeCredit: { cards: 1, movements: 2, amount: 450 },
    })
  })

  it('acotado: un número fijo de agregados en la base, todos del negocio y del periodo (sin N+1)', async () => {
    await getGiftCardSummary(VENUE, { from: '2026-10-01', to: '2026-10-14' })
    const llamadas = prismaMock.giftCardActivity.groupBy.mock.calls.map((c: any[]) => c[0].where)
    expect(llamadas).toHaveLength(2)
    for (const where of llamadas) {
      expect(where).toMatchObject({
        venueId: VENUE,
        createdAt: { gte: new Date('2026-10-01T06:00:00.000Z'), lte: new Date('2026-10-15T05:59:59.999Z') },
      })
    }
  })

  it('sin saldo a favor en el periodo: la línea sale en cero, nunca undefined', async () => {
    prismaMock.giftCardActivity.groupBy.mockResolvedValue([])
    const r = await getGiftCardSummary(VENUE, { from: '2026-10-01', to: '2026-10-01' })
    expect(r.storeCredit).toEqual({ cards: 0, movements: 0, amount: 0 })
  })
})
