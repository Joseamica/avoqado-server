/**
 * Revisión final · ronda 2 (17-sep) — el P1 preexistente que confirmó Codex r7 y su hermano.
 *
 * P1: un cobro con tarjeta COMPLETED LIGADO a una solicitud (puntero, etiqueta legacy o llave de intento) que llega DESPUÉS de que
 * la ventana o el cajero la liberaran, y que el cierre común NO puede ligar, dejaba la solicitud en «puedes volver a cobrar». Ahora
 * la RE-RETIENE (`TIMED_OUT/PAYMENT_UNBOUND_AWAITING_REVIEW`) quien intentó ligar y no pudo: el registrador, el webhook, el socket,
 * la ventana, los barridos y la liberación manual.
 *
 * Hermano: la aprobación tardía tras una DECLARACIÓN del cajero tiene la misma detección que la ventana (conteo, asiento, correo).
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { avisarAprobacionTardiaTrasVentana, terminalPaymentService, UNPROVEN_NEGATIVE_WINDOW_MS } from '@/services/terminal-payment.service'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => {
  const normalizeTerminalId = (id: string) => id.replace(/^AVQD-/i, '').toLowerCase()
  return {
    normalizeTerminalId,
    terminalRegistry: { getTerminal: jest.fn(), getTerminalBySocketId: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
  }
})

const prismaMock = prisma as any
const tpr = () => prismaMock.terminalPaymentRequest
const svc = terminalPaymentService as any
const opsAlert = require('@/services/alerts/opsAlert.service')
const logger = require('@/config/logger').default
const ACCION = 'TERMINAL_PAYMENT_UNBOUND_PAYMENT_AFTER_RELEASE'

/** El texto COMPLETO de un tagged template de Prisma: las plantillas y los fragmentos `Prisma.sql` anidados. */
const sqlDe = (llamada: any[]) => {
  const [strings, ...values] = llamada
  const fragmentos = values.filter(v => v && typeof v === 'object' && typeof (v as { sql?: unknown }).sql === 'string')
  return { texto: (strings as string[]).join('?'), fragmentos: fragmentos.map(f => (f as { sql: string }).sql), values }
}
const llamadasDelCas = () =>
  prismaMock.$executeRaw.mock.calls.filter((c: any[]) => (c[0] as string[]).join('?').includes('UPDATE "TerminalPaymentRequest"'))

const liberadaEn = '2026-09-17T10:00:00.000Z'
const liberada = (extra: Record<string, unknown> = {}) => ({
  id: 'row-u',
  requestId: 'REQ-U',
  venueId: 'venue-1',
  terminalId: 't-u',
  orderId: 'order-u',
  amountCents: 10000,
  tipCents: 0,
  status: 'FAILED',
  failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
  paymentId: null,
  updatedAt: new Date('2026-09-17T10:05:00.000Z'),
  resultJson: {
    requestId: 'REQ-U',
    status: 'failed',
    outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
    errorMessage: 'No se confirmó el cobro en la ventana de 30 s. Se puede volver a cobrar.',
    releasedAfterWindow: { windowMs: 30_000, releasedAt: liberadaEn, origen: 'TIMER' },
    terminalResult: { status: 'failed', errorMessage: 'SDK U100', outcomeEvidence: null },
  },
  ...extra,
})

let orden: string[]
let alerta: jest.SpyInstance

beforeEach(() => {
  orden = []
  alerta = jest.spyOn(opsAlert, 'sendOpsAlert').mockImplementation(async () => {
    orden.push('correo')
    return true
  })
  tpr().findFirst.mockReset().mockResolvedValue(null)
  tpr().findMany.mockReset().mockResolvedValue([])
  tpr().updateMany.mockReset().mockResolvedValue({ count: 1 })
  tpr().count.mockReset().mockResolvedValue(0)
  prismaMock.terminalPaymentAttemptLink.findMany.mockReset().mockResolvedValue([])
  prismaMock.terminalPaymentAttemptLink.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.payment.count.mockReset().mockResolvedValue(0)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])
  prismaMock.$executeRaw.mockReset().mockResolvedValue(1)
  prismaMock.activityLog.create.mockReset().mockResolvedValue({ id: 'log' })
  prismaMock.activityLog.findFirst.mockReset().mockResolvedValue(null)
  // `mockReset` también descarta los `…Once` que una prueba anterior no llegó a consumir.
  prismaMock.$transaction.mockReset().mockImplementation((callback: any) => callback(prismaMock))
  ;(logger.error as jest.Mock).mockClear()
  ;(logger.warn as jest.Mock).mockClear()
})
afterEach(() => {
  alerta.mockRestore()
  prismaMock.$transaction.mockReset().mockImplementation((callback: any) => callback(prismaMock))
})

// ── P1 · el helper: re-retiene una solicitud LIBERADA cuando un Payment ligado a ella no se pudo LIGAR ──
describe('Ronda 2 · P1: retenerSolicitudLiberadaPorPagoSinLigar', () => {
  const entrada = { requestId: 'REQ-U', venueId: 'venue-1', paymentId: 'pay-u', origen: 'REST' as const }

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      orden.push('abre-tx')
      const r = await callback(prismaMock)
      orden.push('commit')
      return r
    })
    prismaMock.$queryRaw.mockImplementation(async (strings: string[], ...values: unknown[]) => {
      const texto = strings.join('?')
      if (texto.includes('pg_advisory_xact_lock')) orden.push(`candado:${values[0]}:${values[1]}`)
      if (texto.includes('ligados')) {
        orden.push('ligados')
        return [{ id: 'pay-u' }]
      }
      return []
    })
    prismaMock.terminalPaymentAttemptLink.findMany.mockImplementation(async () => {
      orden.push('vinculos')
      return [{ attemptId: 'att-z' }, { attemptId: 'att-u' }]
    })
    prismaMock.$executeRaw.mockImplementation(async (strings: string[]) => {
      if (strings.join('?').includes('UPDATE "TerminalPaymentRequest"')) orden.push('cas')
      return 1
    })
    prismaMock.payment.count.mockResolvedValue(3)
    tpr().count.mockResolvedValue(1)
    prismaMock.activityLog.create.mockImplementation(async () => {
      orden.push('asiento')
      return { id: 'log-u' }
    })
  })

  it.each([
    ['sin fila', null],
    ['FAILED con evidencia de la terminal (TPV_CONFIRMED_NO_CHARGE)', { failureCode: 'TPV_CONFIRMED_NO_CHARGE' }],
    ['FAILED/TPV_NEVER_RECEIVED (nunca se entregó)', { failureCode: 'TPV_NEVER_RECEIVED' }],
    ['liberada que ya tiene su Payment', { paymentId: 'pay-x' }],
    ['todavía EN la ventana (TIMED_OUT sin código)', { status: 'TIMED_OUT', failureCode: null }],
    ['ya retenida por el banco', { status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' }],
    ['ya retenida por un Payment sin ligar', { status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW' }],
    ['COMPLETED', { status: 'COMPLETED', failureCode: null, paymentId: 'pay-y' }],
  ])('%s ⇒ NOT_APPLICABLE sin abrir transacción ni escribir', async (_nombre, extra) => {
    tpr().findFirst.mockResolvedValue(extra === null ? null : liberada(extra))
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).toBe('NOT_APPLICABLE')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(llamadasDelCas()).toEqual([])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(alerta).not.toHaveBeenCalled()
  })

  it('liberada por la ventana ⇒ candado de la SOLICITUD, vínculos DENTRO, candado de CADA intento en orden, los Payments ligados bajo el candado y el CAS exige EXISTS de Payment ligado', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).toBe('HELD')
    expect(orden.slice(0, 7)).toEqual([
      'abre-tx',
      'candado:7310114:REQ-U',
      'vinculos',
      'candado:7310113:att-u',
      'candado:7310113:att-z',
      'ligados',
      'cas',
    ])
    const [cas] = llamadasDelCas()
    const { texto, fragmentos, values } = sqlDe(cas)
    expect(texto).toMatch(/SET "status" = 'TIMED_OUT', "failureCode" = 'PAYMENT_UNBOUND_AWAITING_REVIEW'/)
    expect(texto).toMatch(/"resultJson" = coalesce\("resultJson", '\{\}'::jsonb\) \|\| /)
    expect(texto).toMatch(/"updatedAt" = \(NOW\(\) AT TIME ZONE 'UTC'\)/)
    expect(texto).toMatch(/WHERE "id" = \? AND "status" = 'FAILED' AND "failureCode" = \? AND "paymentId" IS NULL/)
    expect(values).toEqual(expect.arrayContaining(['row-u', 'NO_EVIDENCE_AFTER_WINDOW']))
    // EXISTS de Payment ligado (el MISMO SQL del veto G1), evaluado EN la escritura; nada del banco ni un NOT EXISTS de Payment.
    expect(fragmentos.some(f => /^EXISTS \(/.test(f) && f.includes('FROM "Payment" p'))).toBe(true)
    expect(fragmentos.some(f => /^NOT EXISTS \(/.test(f))).toBe(false)
    expect(fragmentos.some(f => f.includes('"ProviderEventLog"'))).toBe(false)
    // El sobre se FUNDE: conserva la liberación y el sobre de la terminal, y ya no dice «puedes volver a cobrar».
    const sobre = JSON.parse(values.find((v: unknown) => typeof v === 'string' && v.includes('unboundPaymentAfterRelease')) as string)
    expect(sobre).toMatchObject({
      requestId: 'REQ-U',
      status: 'timeout',
      outcomeEvidence: null,
      unboundPaymentAfterRelease: {
        paymentIds: ['pay-u'],
        reportedPaymentId: 'pay-u',
        origen: 'REST',
        previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
        releasedAt: liberadaEn,
        otherCardPaymentsOnOrderAfterRelease: 3,
        otherUnresolvedRequestsOnOrderAfterRelease: 1,
        heldAt: expect.any(String),
      },
    })
    expect(sobre).not.toHaveProperty('releasedAfterWindow')
    expect(String(sobre.errorMessage)).not.toMatch(/volver a cobrar\./)
  })

  it('HELD ⇒ UN asiento DENTRO de la transacción, 🚨, y el correo DESPUÉS del commit; el conteo excluye el Payment ligado y cuenta las solicitudes sin desenlace', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).toBe('HELD')
    expect(orden.slice(-4)).toEqual(['cas', 'asiento', 'commit', 'correo'])
    expect(prismaMock.payment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        venueId: 'venue-1',
        orderId: 'order-u',
        status: 'COMPLETED',
        id: { notIn: ['pay-u'] },
        createdAt: { gt: new Date(liberadaEn) },
      }),
    })
    expect(tpr().count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        venueId: 'venue-1',
        orderId: 'order-u',
        requestId: { not: 'REQ-U' },
        createdAt: { gt: new Date(liberadaEn) },
        OR: expect.any(Array),
      }),
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: ACCION,
        entity: 'TerminalPaymentRequest',
        entityId: 'row-u',
        venueId: 'venue-1',
        data: expect.objectContaining({
          requestId: 'REQ-U',
          paymentIds: ['pay-u'],
          reportedPaymentId: 'pay-u',
          origen: 'REST',
          previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
          otherCardPaymentsOnOrderAfterRelease: 3,
          otherUnresolvedRequestsOnOrderAfterRelease: 1,
          terminalId: 't-u',
          orderId: 'order-u',
          amountCents: 10000,
          releasedAt: liberadaEn,
        }),
      }),
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/🚨.*held for review/),
      expect.objectContaining({ requestId: 'REQ-U', venueId: 'venue-1', previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW', origen: 'REST' }),
    )
    expect(alerta).toHaveBeenCalledTimes(1)
    const correo = alerta.mock.calls[0][0] as { subject: string; lines: string[] }
    expect(correo.subject).toContain('sin ligar')
    expect(correo.subject).toContain('t-u')
    const texto = correo.lines.join(' ')
    expect(texto).toContain('REQ-U')
    expect(texto).toContain('pay-u')
    expect(texto).toMatch(/3 cobro\(s\) con tarjeta/)
    expect(texto).toMatch(/1 solicitud\(es\) de cobro sin desenlace/)
    expect(texto).toContain('PAYMENT_UNBOUND_AWAITING_REVIEW')
  })

  it('DECLARADA por el cajero ⇒ cuenta desde la DECLARACIÓN (acceptedAt), guarda el código previo y el correo lo dice', async () => {
    const declaradaEn = '2026-09-17T11:00:00.000Z'
    tpr().findFirst.mockResolvedValue(
      liberada({
        failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
        resultJson: {
          status: 'failed',
          outcomeEvidence: 'OPERATOR_RECONCILED',
          operatorResolution: { id: 'res-1', kind: 'NO_INSTRUMENT_PRESENTED', acceptedAt: declaradaEn, staffId: 's-1', by: 'SESSION' },
        },
      }),
    )
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar({ ...entrada, origen: 'WEBHOOK' })).toBe('HELD')
    expect(prismaMock.payment.count).toHaveBeenCalledWith({ where: expect.objectContaining({ createdAt: { gt: new Date(declaradaEn) } }) })
    expect(tpr().count).toHaveBeenCalledWith({ where: expect.objectContaining({ createdAt: { gt: new Date(declaradaEn) } }) })
    expect(sqlDe(llamadasDelCas()[0]).values).toEqual(expect.arrayContaining(['OPERATOR_RECONCILED_NO_CHARGE']))
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        data: expect.objectContaining({ previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE', releasedAt: declaradaEn, origen: 'WEBHOOK' }),
      }),
    })
    expect((alerta.mock.calls[0][0] as { lines: string[] }).lines.join(' ')).toContain('el cajero declarara que no se presentó tarjeta')
  })

  it('sin orden ligada ⇒ no cuenta nada (null) y lo dice; sin pista de Payment ⇒ `reportedPaymentId` null', async () => {
    tpr().findFirst.mockResolvedValue(liberada({ orderId: null }))
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar({ ...entrada, paymentId: null })).toBe('HELD')
    expect(prismaMock.payment.count).not.toHaveBeenCalled()
    expect(tpr().count).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        data: expect.objectContaining({
          otherCardPaymentsOnOrderAfterRelease: null,
          otherUnresolvedRequestsOnOrderAfterRelease: null,
          reportedPaymentId: null,
          paymentIds: ['pay-u'],
        }),
      }),
    })
    expect((alerta.mock.calls[0][0] as { lines: string[] }).lines.join(' ')).toContain('Sin orden ligada')
  })

  it('CAS en 0 (otra pasada ya la retuvo, el Payment se ligó o ya no hay Payment ligado) ⇒ NOT_APPLICABLE, sin asiento, sin 🚨 ni correo', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    prismaMock.$executeRaw.mockImplementation(async () => 0)
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).toBe('NOT_APPLICABLE')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect((logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('🚨'))).toEqual([])
    expect(alerta).not.toHaveBeenCalled()
  })

  it('la fila cambió BAJO el candado (relectura) ⇒ NOT_APPLICABLE sin intentar el CAS', async () => {
    tpr()
      .findFirst.mockResolvedValueOnce(liberada())
      .mockResolvedValueOnce(liberada({ status: 'COMPLETED', paymentId: 'pay-z' }))
    expect(await svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).toBe('NOT_APPLICABLE')
    expect(llamadasDelCas()).toEqual([])
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it.each([
    ['55P03 (candado ocupado)', Object.assign(new Error('canceling statement due to lock timeout'), { meta: { code: '55P03' } })],
    ['la base cayó', new Error('Connection terminated')],
  ])('%s ⇒ DEFERRED sin lanzar, sin asiento ni correo', async (_n, error) => {
    tpr().findFirst.mockResolvedValue(liberada())
    prismaMock.$transaction.mockRejectedValueOnce(error)
    await expect(svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).resolves.toBe('DEFERRED')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(alerta).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deferred'), expect.objectContaining({ requestId: 'REQ-U' }))
  })

  it('la lectura barata que revienta ⇒ DEFERRED, tampoco lanza', async () => {
    tpr().findFirst.mockRejectedValueOnce(new Error('pool agotado'))
    await expect(svc.retenerSolicitudLiberadaPorPagoSinLigar(entrada)).resolves.toBe('DEFERRED')
  })
})

// ── Minor · el correo de la re-retención por APROBACIÓN (6506d550) también cuenta las solicitudes sin desenlace ──
describe('Ronda 2 · minor: la re-retención por aprobación cuenta los recobros en vuelo en un campo aparte', () => {
  it('el sobre, el asiento y el correo llevan `otherUnresolvedRequestsOnOrderAfterRelease`; el CAS sigue siendo el de la aprobación', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    prismaMock.terminalPaymentAttemptLink.findMany.mockResolvedValue([{ attemptId: 'att-u' }])
    prismaMock.payment.count.mockResolvedValue(0)
    tpr().count.mockResolvedValue(2)
    expect(
      await svc.retenerSolicitudLiberadaPorAprobacion({
        requestId: 'REQ-U',
        venueId: 'venue-1',
        attemptId: 'att-u',
        eventLogId: 'evt-u',
        motivo: 'AMOUNT_MISMATCH',
      }),
    ).toBe('HELD')
    expect(tpr().count).toHaveBeenCalledWith({
      where: expect.objectContaining({ venueId: 'venue-1', orderId: 'order-u', requestId: { not: 'REQ-U' }, OR: expect.any(Array) }),
    })
    const [cas] = llamadasDelCas()
    const { texto, fragmentos, values } = sqlDe(cas)
    expect(texto).toMatch(/"failureCode" = 'BANK_APPROVED_AWAITING_PAYMENT'/)
    expect(fragmentos.some(f => /^EXISTS \(/.test(f) && f.includes('"ProviderEventLog"'))).toBe(true)
    expect(fragmentos.some(f => /^NOT EXISTS \(/.test(f) && f.includes('FROM "Payment" p'))).toBe(true)
    const sobre = JSON.parse(values.find((v: unknown) => typeof v === 'string' && v.includes('bankApprovedAfterRelease')) as string)
    expect(sobre.bankApprovedAfterRelease).toMatchObject({
      otherCardPaymentsOnOrderAfterRelease: 0,
      otherUnresolvedRequestsOnOrderAfterRelease: 2,
    })
    expect(sobre).not.toHaveProperty('unboundPaymentAfterRelease')
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'TERMINAL_PAYMENT_WINDOW_BANK_APPROVED_AWAITING_PAYMENT',
        data: expect.objectContaining({ otherUnresolvedRequestsOnOrderAfterRelease: 2 }),
      }),
    })
    const texto2 = (alerta.mock.calls[0][0] as { lines: string[] }).lines.join(' ')
    expect(texto2).toMatch(/🔴 La orden order-u tiene 2 solicitud\(es\) de cobro sin desenlace/)
  })

  it('sin recobros en vuelo, la línea lo dice en cero', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    tpr().count.mockResolvedValue(0)
    await svc.retenerSolicitudLiberadaPorAprobacion({
      requestId: 'REQ-U',
      venueId: 'venue-1',
      attemptId: 'att-u',
      eventLogId: 'evt-u',
      motivo: 'AMOUNT_MISMATCH',
    })
    expect((alerta.mock.calls[0][0] as { lines: string[] }).lines.join(' ')).toMatch(/0 solicitud\(es\) de cobro sin desenlace/)
  })
})

// ── P1 · por las IDENTIDADES del Payment: el registrador (y su consolidación) no siempre sabe qué solicitud liga el Payment ──
describe('Ronda 2 · P1: retenerLiberadasPorPagoSinLigar resuelve las solicitudes por las identidades del Payment', () => {
  let porSolicitud: jest.SpyInstance
  const pago = (extra: Record<string, unknown> = {}) => ({
    id: 'pay-p',
    venueId: 'venue-1',
    status: 'COMPLETED',
    method: 'CREDIT_CARD',
    type: 'REGULAR',
    idempotencyKey: null,
    terminalPaymentRequestId: null,
    processorData: null,
    ...extra,
  })
  beforeEach(() => {
    porSolicitud = jest.spyOn(svc, 'retenerSolicitudLiberadaPorPagoSinLigar').mockResolvedValue('HELD')
  })
  afterEach(() => porSolicitud.mockRestore())

  it.each([
    ['no COMPLETED', { status: 'PENDING', idempotencyKey: 'att-1' }],
    ['efectivo', { method: 'CASH', idempotencyKey: 'att-1' }],
    ['un reembolso', { type: 'REFUND', idempotencyKey: 'att-1' }],
  ])('%s ⇒ nada (ni siquiera busca el vínculo)', async (_n, extra) => {
    expect(await svc.retenerLiberadasPorPagoSinLigar(pago(extra), 'REST')).toEqual([])
    expect(prismaMock.terminalPaymentAttemptLink.findUnique).not.toHaveBeenCalled()
    expect(porSolicitud).not.toHaveBeenCalled()
  })

  it('las TRES identidades, sin repetir: puntero, etiqueta legacy y la solicitud del vínculo de su llave (mismo venue)', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue({ requestId: 'REQ-LINK', venueId: 'venue-1' })
    const r = await svc.retenerLiberadasPorPagoSinLigar(
      pago({
        idempotencyKey: '  att-1  ',
        terminalPaymentRequestId: 'REQ-COL',
        processorData: { terminalPaymentRequestId: 'REQ-TAG' },
      }),
      'REST',
    )
    expect(prismaMock.terminalPaymentAttemptLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { attemptId: 'att-1' } }),
    )
    expect(porSolicitud.mock.calls.map(c => c[0].requestId).sort()).toEqual(['REQ-COL', 'REQ-LINK', 'REQ-TAG'])
    for (const [args] of porSolicitud.mock.calls) {
      expect(args).toEqual({ requestId: expect.any(String), venueId: 'venue-1', paymentId: 'pay-p', origen: 'REST' })
    }
    expect(r).toEqual(
      expect.arrayContaining([
        { requestId: 'REQ-COL', resultado: 'HELD' },
        { requestId: 'REQ-TAG', resultado: 'HELD' },
        { requestId: 'REQ-LINK', resultado: 'HELD' },
      ]),
    )
  })

  it('la misma solicitud por dos identidades se pide UNA vez', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue({ requestId: 'REQ-1', venueId: 'venue-1' })
    await svc.retenerLiberadasPorPagoSinLigar(
      pago({ idempotencyKey: 'att-1', processorData: { terminalPaymentRequestId: 'REQ-1' } }),
      'WEBHOOK',
    )
    expect(porSolicitud).toHaveBeenCalledTimes(1)
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-1', venueId: 'venue-1', paymentId: 'pay-p', origen: 'WEBHOOK' })
  })

  it('el vínculo de OTRO venue no cuenta; sin identidades no se pide nada', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue({ requestId: 'REQ-AJENA', venueId: 'venue-otro' })
    expect(await svc.retenerLiberadasPorPagoSinLigar(pago({ idempotencyKey: 'att-1' }), 'REST')).toEqual([])
    expect(porSolicitud).not.toHaveBeenCalled()
    expect(await svc.retenerLiberadasPorPagoSinLigar(pago(), 'REST')).toEqual([])
    expect(prismaMock.terminalPaymentAttemptLink.findUnique).toHaveBeenCalledTimes(1)
  })

  it('si leer el vínculo revienta, sigue con las otras identidades, no lanza — y REPORTA el diferimiento', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockRejectedValue(new Error('pool agotado'))
    // 🔴 Ronda 4 (P2 de Codex r9): la entrada `{ requestId: null, resultado: 'DEFERRED' }` es lo que distingue «no pude
    // comprobar» de «comprobé y no había nada» — sin ella, la puerta del backfill leía la lista como comprobación
    // terminada y sellaba encima de una solicitud liberada que nadie iba a volver a mirar.
    await expect(
      svc.retenerLiberadasPorPagoSinLigar(pago({ idempotencyKey: 'att-1', terminalPaymentRequestId: 'REQ-COL' }), 'REST'),
    ).resolves.toEqual([
      { requestId: null, resultado: 'DEFERRED' },
      { requestId: 'REQ-COL', resultado: 'HELD' },
    ])
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ── P1 · los llamadores del cierre común piden la re-retención DESPUÉS de un cierre que no ligó ──
describe('Ronda 2 · P1: quien intenta ligar y no puede, pide re-retener', () => {
  let porSolicitud: jest.SpyInstance
  let cierre: jest.SpyInstance
  let buscar: jest.SpyInstance
  const pagoEncontrado = { id: 'pay-x', amount: new Prisma.Decimal(100), tipAmount: new Prisma.Decimal(0) }
  const noLigo = { bound: false as const, reason: 'PAYMENT_BOUND_ELSEWHERE' as const }
  const ligo = { bound: true as const, reopened: true, contractMismatch: false, previousStatus: 'FAILED', alarmed: true }
  const fila = (extra: Record<string, unknown>) => ({
    id: 'row-x',
    requestId: 'REQ-X',
    venueId: 'venue-1',
    terminalId: 't-x',
    orderId: 'order-x',
    amountCents: 10000,
    tipCents: 0,
    createdAt: new Date(Date.now() - 10 * 60_000),
    updatedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() - 5 * 60_000),
    terminalReturnedAt: null,
    paymentId: null,
    resultJson: null,
    ...extra,
  })
  /** `findMany` por consulta: cada barrido recibe SUS filas. */
  const filasPorBarrido = (filas: {
    vencidas?: unknown[]
    unknown?: unknown[]
    soltadas?: unknown[]
    ventana?: unknown[]
    declaradas?: unknown[]
  }) =>
    tpr().findMany.mockImplementation(async ({ where }: any) => {
      if (Array.isArray(where?.status?.in) && where?.OR) return filas.vencidas ?? []
      if (where?.status === 'UNKNOWN') return filas.unknown ?? []
      if (where?.status === 'TIMED_OUT' && where?.failureCode?.in) return filas.soltadas ?? []
      if (where?.status === 'FAILED' && where?.failureCode === 'NO_EVIDENCE_AFTER_WINDOW') return filas.ventana ?? []
      if (where?.status === 'FAILED' && where?.failureCode === 'OPERATOR_RECONCILED_NO_CHARGE') return filas.declaradas ?? []
      return []
    })

  beforeEach(() => {
    porSolicitud = jest.spyOn(svc, 'retenerSolicitudLiberadaPorPagoSinLigar').mockResolvedValue('HELD')
    cierre = jest.spyOn(svc, 'closeRowFromPaymentTx').mockResolvedValue(noLigo)
    buscar = jest.spyOn(svc, 'findReconcilablePayment').mockResolvedValue(pagoEncontrado)
    const { terminalRegistry } = require('@/communication/sockets/terminal-registry')
    ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
  })
  afterEach(() => {
    porSolicitud.mockRestore()
    cierre.mockRestore()
    buscar.mockRestore()
  })

  it('reconcileStaleRequests: cierre que no liga ⇒ pide re-retener DESPUÉS del cierre (BARRIDO_VENCIDAS); si liga, no', async () => {
    filasPorBarrido({ vencidas: [fila({ status: 'SENT' })] })
    await svc.reconcileStaleRequests(new Date())
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'BARRIDO_VENCIDAS' })
    expect(cierre.mock.invocationCallOrder[0]).toBeLessThan(porSolicitud.mock.invocationCallOrder[0])
    porSolicitud.mockClear()
    cierre.mockResolvedValue(ligo)
    await svc.reconcileStaleRequests(new Date())
    expect(porSolicitud).not.toHaveBeenCalled()
  })

  it('reconcileUnknownRequests (UNKNOWN): cierre que no liga ⇒ BARRIDO_UNKNOWN', async () => {
    filasPorBarrido({ unknown: [fila({ status: 'UNKNOWN' })] })
    await svc.reconcileUnknownRequests(new Date())
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'BARRIDO_UNKNOWN' })
  })

  it('reconcileUnknownRequests (soltadas por política): cierre que no liga ⇒ BARRIDO_SOLTADAS', async () => {
    filasPorBarrido({ soltadas: [fila({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })] })
    await svc.reconcileUnknownRequests(new Date())
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'BARRIDO_SOLTADAS' })
  })

  it('reconcileUnknownRequests (liberadas por la ventana): cierre que no liga ⇒ BARRIDO_LIBERADAS; si liga, no', async () => {
    filasPorBarrido({ ventana: [fila({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })] })
    await svc.reconcileUnknownRequests(new Date())
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'BARRIDO_LIBERADAS' })
    porSolicitud.mockClear()
    cierre.mockResolvedValue(ligo)
    await svc.reconcileUnknownRequests(new Date())
    expect(porSolicitud).not.toHaveBeenCalled()
  })

  it('reconcileUnknownRequests (liberadas): sin Payment atribuible pero con uno LIGADO (G1 tras liberar) ⇒ pide re-retener con ese Payment; sin ligados, nada', async () => {
    filasPorBarrido({ ventana: [fila({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })] })
    buscar.mockResolvedValue(null)
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) => (strings.join('?').includes('ligados') ? [{ id: 'pay-g1' }] : []))
    await svc.reconcileUnknownRequests(new Date())
    expect(cierre).not.toHaveBeenCalled()
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-g1', origen: 'BARRIDO_LIBERADAS' })
    porSolicitud.mockClear()
    prismaMock.$queryRaw.mockImplementation(async () => [])
    await svc.reconcileUnknownRequests(new Date())
    expect(porSolicitud).not.toHaveBeenCalled()
  })

  it('reconcileUnknownRequests (DECLARADAS por el cajero, hermano): el barrido de 30 min también las recorre — concilia con aviso tardío, o re-retiene', async () => {
    filasPorBarrido({ declaradas: [fila({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })] })
    const consultas = () =>
      tpr()
        .findMany.mock.calls.map(([a]: any[]) => a)
        .filter((a: any) => a?.where?.failureCode === 'OPERATOR_RECONCILED_NO_CHARGE')
    await svc.reconcileUnknownRequests(new Date())
    expect(consultas()).toHaveLength(1)
    expect(consultas()[0]).toMatchObject({
      where: { status: 'FAILED', updatedAt: { gte: expect.any(Date) } },
      take: 200,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    })
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'BARRIDO_LIBERADAS' })
    porSolicitud.mockClear()
    cierre.mockResolvedValue({
      ...ligo,
      lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: 0, previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE' },
    })
    await svc.reconcileUnknownRequests(new Date())
    expect(porSolicitud).not.toHaveBeenCalled()
    expect(alerta).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Cobro aprobado tarde tras la declaración del cajero — t-x' }))
  })

  it('releaseUnknownRequest: cierre que no liga ⇒ LIBERACION_MANUAL (la fila pudo liberarse entre la lectura y el cierre)', async () => {
    tpr().findFirst.mockResolvedValue(fila({ status: 'UNKNOWN' }))
    await svc.releaseUnknownRequest({
      requestId: 'REQ-X',
      venueId: 'venue-1',
      actor: { staffId: 's-1', source: 'MCP' },
      reason: 'prueba',
    })
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'LIBERACION_MANUAL' })
  })

  describe('la ventana (releaseUnprovenNegative): si su propia marca ya no aplica porque la fila se liberó en medio, re-retiene post-liberación', () => {
    const enLaVentana = () =>
      fila({
        status: 'TIMED_OUT',
        failureCode: null,
        updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000),
        resultJson: { status: 'timeout', terminalResult: { status: 'failed', errorMessage: 'U100', outcomeEvidence: null } },
      })

    it('pago exacto que no liga + marca en 0 ⇒ pide re-retener (VENTANA) y contesta HELD_BY_UNBOUND_PAYMENT', async () => {
      tpr().findFirst.mockResolvedValue(enLaVentana())
      cierre.mockResolvedValue({ bound: false, reason: 'TERMINAL_MISMATCH' })
      prismaMock.$executeRaw.mockResolvedValue(0)
      expect(await svc.releaseUnprovenNegative('REQ-X', 'venue-1', 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
      expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-x', origen: 'VENTANA' })
    })

    it('pago exacto que no liga + su marca SÍ aplica ⇒ no pide la post-liberación', async () => {
      tpr().findFirst.mockResolvedValue(enLaVentana())
      cierre.mockResolvedValue({ bound: false, reason: 'TERMINAL_MISMATCH' })
      prismaMock.$executeRaw.mockResolvedValue(1)
      expect(await svc.releaseUnprovenNegative('REQ-X', 'venue-1', 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
      expect(porSolicitud).not.toHaveBeenCalled()
    })

    it('G1 (Payment ligado sin atribuir) + marca en 0 ⇒ pide re-retener con ese Payment; si tampoco aplica, NOT_ELIGIBLE', async () => {
      tpr().findFirst.mockResolvedValue(enLaVentana())
      buscar.mockResolvedValue(null)
      prismaMock.$queryRaw.mockImplementation(async (strings: string[]) => (strings.join('?').includes('ligados') ? [{ id: 'pay-g' }] : []))
      prismaMock.$executeRaw.mockResolvedValue(0)
      expect(await svc.releaseUnprovenNegative('REQ-X', 'venue-1', 'WATCHDOG')).toBe('HELD_BY_UNBOUND_PAYMENT')
      expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-g', origen: 'VENTANA' })
      porSolicitud.mockResolvedValue('NOT_APPLICABLE')
      expect(await svc.releaseUnprovenNegative('REQ-X', 'venue-1', 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    })
  })

  describe('el `success` del socket (closeRow)', () => {
    const socket = { socketId: 'sock-t-x', terminalId: 't-x', venueId: 'venue-1' }
    beforeEach(() => {
      // Propiedad de la fila, la relectura dentro de la transacción y el «ganador» final: la solicitud liberada.
      tpr().findFirst.mockImplementation(async ({ where }: any) =>
        where?.OR ? null : fila({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' }),
      )
    })

    it('un success cuyo Payment no se liga ⇒ pide re-retener ESA solicitud (SOCKET) después del cierre y ANTES de fundir la afirmación', async () => {
      cierre.mockResolvedValue({ bound: false, reason: 'TERMINAL_MISMATCH' })
      await svc.handlePaymentResultFromSocket({ requestId: 'REQ-X', status: 'success', paymentId: 'pay-s', transactionId: 'tx-1' }, socket)
      expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-X', venueId: 'venue-1', paymentId: 'pay-s', origen: 'SOCKET' })
      expect(cierre.mock.invocationCallOrder[0]).toBeLessThan(porSolicitud.mock.invocationCallOrder[0])
      const fusion = prismaMock.$executeRaw.mock.calls.findIndex((c: any[]) => (c[0] as string[]).join('?').includes('claimedSuccess'))
      expect(fusion).toBeGreaterThanOrEqual(0)
      expect(porSolicitud.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$executeRaw.mock.invocationCallOrder[fusion])
    })

    it('un success que SÍ liga no pide nada; un success sin paymentId (no hubo cierre) tampoco', async () => {
      cierre.mockResolvedValue(ligo)
      await svc.handlePaymentResultFromSocket({ requestId: 'REQ-X', status: 'success', paymentId: 'pay-s' }, socket)
      await svc.handlePaymentResultFromSocket({ requestId: 'REQ-X', status: 'success', transactionId: 'tx-2' }, socket)
      expect(porSolicitud).not.toHaveBeenCalled()
    })
  })
})

// ── Hermano · la aprobación tardía tras una DECLARACIÓN tiene la misma detección que la ventana ──
describe('Ronda 2 · hermano: closeRowFromPaymentTx detecta la aprobación tardía tras cualquiera de las dos liberaciones', () => {
  const declaradaEn = '2026-09-17T11:00:00.000Z'
  const tx = (before: Record<string, unknown>) =>
    ({
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          processorData: {},
          amount: new Prisma.Decimal(100),
          tipAmount: new Prisma.Decimal(0),
          source: 'TPV',
          orderId: 'order-h',
          terminalPaymentRequestId: null,
          terminal: { serialNumber: 'AVQD-T-H' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(2),
      },
      terminalPaymentRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'row-h',
          status: 'FAILED',
          amountCents: 10000,
          tipCents: 0,
          orderId: 'order-h',
          terminalId: 't-h',
          paymentId: null,
          updatedAt: new Date('2026-09-17T12:00:00.000Z'),
          ...before,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'log-h' }) },
    }) as any

  it('DECLARADA (OPERATOR_RECONCILED_NO_CHARGE) ⇒ `lateAfterWindow` con el código previo, conteo desde la declaración y el asiento de aprobación tardía', async () => {
    const t = tx({
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      resultJson: { status: 'failed', operatorResolution: { id: 'res-h', acceptedAt: declaradaEn } },
    })
    const r = await terminalPaymentService.closeRowFromPaymentTx(t, 'REQ-H', 'pay-h', 'venue-1')
    expect(r).toMatchObject({
      bound: true,
      reopened: true,
      lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: 2, previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE' },
    })
    expect(t.payment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ orderId: 'order-h', id: { not: 'pay-h' }, createdAt: { gt: new Date(declaradaEn) } }),
    })
    expect(t.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW',
        entityId: 'row-h',
        data: expect.objectContaining({
          requestId: 'REQ-H',
          paymentId: 'pay-h',
          previousFailureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
          otherCardPaymentsOnOrderAfterRelease: 2,
          releasedAt: declaradaEn,
        }),
      }),
    })
  })

  it('DECLARADA sin instante legible ⇒ cuenta desde `updatedAt` (respaldo)', async () => {
    const t = tx({ failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', resultJson: { status: 'failed' } })
    await terminalPaymentService.closeRowFromPaymentTx(t, 'REQ-H', 'pay-h', 'venue-1')
    expect(t.payment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ createdAt: { gt: new Date('2026-09-17T12:00:00.000Z') } }),
    })
  })

  it('regresión: liberada por la VENTANA ⇒ la misma detección, ahora con su código previo', async () => {
    const t = tx({
      failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
      resultJson: { status: 'failed', releasedAfterWindow: { releasedAt: '2026-09-17T09:00:00.000Z' } },
    })
    const r = await terminalPaymentService.closeRowFromPaymentTx(t, 'REQ-H', 'pay-h', 'venue-1')
    expect(r).toMatchObject({ lateAfterWindow: { previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW' } })
    expect(t.payment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ createdAt: { gt: new Date('2026-09-17T09:00:00.000Z') } }),
    })
  })

  it('regresión: otros «no se cobró» (TPV_CONFIRMED_NO_CHARGE) NO son una liberación sin evidencia: sin `lateAfterWindow` ni asiento', async () => {
    const t = tx({ failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: { status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED' } })
    const r = await terminalPaymentService.closeRowFromPaymentTx(t, 'REQ-H', 'pay-h', 'venue-1')
    expect(r).toMatchObject({ bound: true })
    expect(r).not.toHaveProperty('lateAfterWindow')
    expect(t.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('Ronda 2 · hermano: el correo de la aprobación tardía dice cuál de las dos liberaciones fue', () => {
  const ctx = { requestId: 'REQ-M', venueId: 'venue-1', paymentId: 'pay-m', terminalId: 'T-M', orderId: 'order-m' }
  const cierre = (previousFailureCode?: string, otros: number | null = 0) =>
    ({
      bound: true,
      reopened: true,
      contractMismatch: false,
      previousStatus: 'FAILED',
      alarmed: true,
      lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: otros, ...(previousFailureCode ? { previousFailureCode } : {}) },
    }) as any

  it('regresión: la VENTANA conserva su asunto exacto', () => {
    avisarAprobacionTardiaTrasVentana(cierre('NO_EVIDENCE_AFTER_WINDOW'), ctx)
    expect(alerta).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Cobro aprobado tarde tras la ventana — T-M' }))
    expect((alerta.mock.calls[0][0] as { lines: string[] }).lines[0]).toContain('la ventana de 30 s la liberara')
  })

  it('regresión: un desenlace sin código previo (anterior a este cambio) se trata como ventana', () => {
    avisarAprobacionTardiaTrasVentana(cierre(undefined), ctx)
    expect(alerta).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Cobro aprobado tarde tras la ventana — T-M' }))
  })

  it('la DECLARACIÓN del cajero tiene su propio asunto y lo explica', () => {
    avisarAprobacionTardiaTrasVentana(cierre('OPERATOR_RECONCILED_NO_CHARGE', 1), ctx)
    const correo = alerta.mock.calls[0][0] as { subject: string; lines: string[] }
    expect(correo.subject).toBe('Cobro aprobado tarde tras la declaración del cajero — T-M')
    // 🔴 El texto cambió el 18-sep, y NO es que la prueba se haya aflojado para que pase (P3 de la auditoría de
    // Codex): cuando esta prueba se escribió existía UNA sola declaración —la de gerencia, «no se presentó
    // tarjeta»—. Ahora hay dos que escriben el MISMO `failureCode`, y la nueva afirma otra cosa: que el cajero
    // MIRÓ la terminal y el cobro no pasó. El texto viejo se lo atribuía a quien nunca lo dijo. Se usa un texto
    // común que no atribuye ninguna de las dos afirmaciones; el ASUNTO sigue distinguiendo las dos liberaciones,
    // que es la garantía que esta prueba nació a cuidar y que no se toca.
    expect(correo.lines[0]).toContain('un operador declarara que ese cobro no había pasado')
    expect(correo.lines[0]).not.toContain('no se presentó tarjeta')
    expect(correo.lines[0]).toContain('pay-m')
    expect(correo.lines[0]).toContain('REQ-M')
    expect(correo.lines.join(' ')).toContain('La orden order-m tiene 1 cobro(s) con tarjeta')
  })
})
