/**
 * §8 C.1 — el MCP y el POS tienen que leer la MISMA verdad de la misma fila.
 *
 * 🔴 Antes no la leían: la tool consultaba Prisma por su cuenta, devolvía el `status` CRUDO (sin la traducción que
 * protege a las apps) y marcaba `busy` con su propia lista `TPR_ACTIVE` (PENDING/SENT/CANCEL_REQUESTED/UNKNOWN),
 * que NO incluye lo que el servicio sí trata como ocupado: TIMED_OUT, los FAILED sin evidencia y los CANCELLED sin
 * aceptación. Consecuencia medible: un operador preguntaba «¿está libre la terminal?», el MCP decía que sí, y el
 * cobro siguiente rebotaba con 409.
 */

import { StaffRole, TerminalPaymentRequestStatus as S } from '@prisma/client'

import { registerTerminalTools } from '@/mcp/tools/terminals'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/terminal-payment.service', () => {
  const real = jest.requireActual('@/services/terminal-payment.service')
  return { ...real, terminalPaymentService: { requestRefundOnTerminal: jest.fn(), releaseUnknownRequest: jest.fn() } }
})

/** Un ámbito con permisos completos sobre `venue-1`; sin `scopes` declarados (token de desarrollo), como el resto. */
const ambito = {
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: ['venue-1'],
  perVenueAccess: new Map([
    [
      'venue-1',
      {
        userId: 'staff-1',
        venueId: 'venue-1',
        organizationId: 'org-1',
        role: StaffRole.SUPERADMIN,
        corePermissions: ['*:*'],
        whiteLabelEnabled: false,
        enabledFeatures: [],
        featureAccess: {},
        featureMetadata: {},
      },
    ],
  ]),
}

function capturarTool(nombre: string) {
  let handler: ((input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined
  const server = {
    tool: (n: string, _d: string, _s: unknown, candidato: typeof handler) => {
      if (n === nombre) handler = candidato
    },
  }
  registerTerminalTools(server as any, ambito as any)
  if (!handler) throw new Error(`la tool ${nombre} no se registró`)
  return handler
}

function fila(overrides: Record<string, unknown>) {
  return {
    requestId: 'REQ',
    venueId: 'venue-1',
    terminalId: 'term-1',
    status: S.FAILED,
    amountCents: 10000,
    tipCents: 0,
    orderId: null,
    paymentId: null,
    customerId: null,
    senderDevice: null,
    lateResult: false,
    failureCode: null,
    cancelDisposition: null,
    resultJson: null,
    createdAt: new Date('2026-09-11T10:00:00.000Z'),
    updatedAt: new Date('2026-09-11T10:00:00.000Z'),
    ...overrides,
  }
}

/** Codex R3 (P2): la ventana de vínculos es POR SOLICITUD (`$queryRaw` con ROW_NUMBER) y los conteos reales salen de un `groupBy`. */
function vinculos(ventana: { requestId: string; attemptId: string; createdAt: Date }[], totales: Record<string, number> = {}) {
  ;(prismaMock as any).$queryRaw.mockResolvedValue(ventana)
  ;(prismaMock as any).terminalPaymentAttemptLink.groupBy.mockResolvedValue(
    Object.entries(totales).map(([requestId, n]) => ({ requestId, _count: { _all: n } })),
  )
}

async function listar(rows: ReturnType<typeof fila>[]) {
  ;(prismaMock as any).terminalPaymentRequest.findMany.mockResolvedValue(rows)
  vinculos([])
  ;(prismaMock as any).terminalPaymentAttemptLink.findMany.mockResolvedValue([])
  ;(prismaMock as any).payment.findMany.mockResolvedValue([])
  const handler = capturarTool('terminal_payment_requests')
  return JSON.parse((await handler({ venueId: 'venue-1' })).content[0].text)
}

describe('terminal_payment_requests — la misma proyección que el GET del POS', () => {
  it('🔴 una FAILED sin evidencia sale UNKNOWN, ocupada y UNRESOLVED (antes: FAILED y libre)', async () => {
    const salida = await listar([fila({ requestId: 'R-TPV-ERROR', status: S.FAILED, failureCode: 'TPV_ERROR' })])
    expect(salida.requests[0]).toMatchObject({
      requestId: 'R-TPV-ERROR',
      status: 'UNKNOWN',
      outcome: 'UNRESOLVED',
      outcomeEvidence: null,
      evidenceClass: null,
      failureCode: 'TPV_ERROR',
      busy: true,
    })
    expect(salida.busyTerminals).toEqual(['term-1'])
    expect(salida.unknownCount).toBe(1)
  })

  it('🔴 una TIMED_OUT/AUTO_RELEASED de producción ocupa la terminal (TPR_ACTIVE no la contaba)', async () => {
    const salida = await listar([fila({ requestId: 'R-AUTO', terminalId: 'term-9', status: S.TIMED_OUT, failureCode: 'AUTO_RELEASED' })])
    expect(salida.requests[0]).toMatchObject({ status: 'TIMED_OUT', outcome: 'UNRESOLVED', busy: true })
    expect(salida.busyTerminals).toEqual(['term-9'])
  })

  it('una LÁPIDA de admisión sale FAILED, NO ocupa y se marca rejectedAtAdmission', async () => {
    const salida = await listar([fila({ requestId: 'R-LAPIDA', failureCode: 'REJECTED_TERMINAL_BUSY' })])
    expect(salida.requests[0]).toMatchObject({
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'REJECTED_AT_ADMISSION',
      evidenceClass: 'SERVER',
      rejectedAtAdmission: true,
      busy: false,
    })
    expect(salida.busyTerminals).toEqual([])
    expect(salida.unknownCount).toBe(0)
  })

  it('un rechazo del banco CON evidencia no ocupa: FAILED, NOT_CHARGED, clase TERMINAL', async () => {
    const salida = await listar([
      fila({
        requestId: 'R-DECLINADA',
        failureCode: 'TPV_CONFIRMED_NO_CHARGE',
        resultJson: { status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED' },
      }),
    ])
    expect(salida.requests[0]).toMatchObject({
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'PROCESSOR_DECLINED',
      evidenceClass: 'TERMINAL',
      busy: false,
      rejectedAtAdmission: false,
    })
  })

  it('un cobro registrado sale CHARGED con su Payment y no ocupa', async () => {
    const salida = await listar([fila({ requestId: 'R-OK', status: S.COMPLETED, paymentId: 'pay-1' })])
    expect(salida.requests[0]).toMatchObject({ status: 'COMPLETED', outcome: 'CHARGED', outcomeEvidence: 'PAYMENT_RECORDED', busy: false })
  })

  it('🔴 una CANCELLED sin aceptación de la terminal sale UNKNOWN y ocupa; con ACCEPTED sale CANCELLED y libera', async () => {
    const sinAceptar = await listar([fila({ requestId: 'R-CANCEL', status: S.CANCELLED })])
    expect(sinAceptar.requests[0]).toMatchObject({ status: 'UNKNOWN', outcome: 'UNRESOLVED', busy: true })

    const aceptada = await listar([fila({ requestId: 'R-CANCEL-OK', status: S.CANCELLED, cancelDisposition: 'ACCEPTED' })])
    expect(aceptada.requests[0]).toMatchObject({
      status: 'CANCELLED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'CANCEL_ACCEPTED',
      cancelDisposition: 'ACCEPTED',
      busy: false,
    })
  })

  it('la consulta trae también las filas VIEJAS que siguen ocupando, no sólo las de 24 h', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findMany.mockResolvedValue([])
    await capturarTool('terminal_payment_requests')({ venueId: 'venue-1' })
    const where = (prismaMock as any).terminalPaymentRequest.findMany.mock.calls[0][0].where
    // El primer brazo del OR es el predicado del servicio (bloqueo), no una lista de estados escrita aquí.
    expect(JSON.stringify(where)).toContain('TPV_CONFIRMED_NO_CHARGE')
    expect(where.OR).toHaveLength(2)
  })
})

describe('release_terminal_payment — no puede contradecir a la lista', () => {
  it('🔴 la consulta PIDE los cuatro campos del desenlace: sin ellos compila igual y clasifica mal', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findFirst.mockResolvedValue(null)
    await capturarTool('release_terminal_payment')({ venueId: 'venue-1', requestId: 'REQ', reason: 'prueba' })
    const select = (prismaMock as any).terminalPaymentRequest.findFirst.mock.calls[0][0].select
    expect(select).toMatchObject({ status: true, failureCode: true, cancelDisposition: true, paymentId: true, resultJson: true })
  })

  it('un cobro que NO está en UNKNOWN se rechaza diciendo también su desenlace (la lista lo muestra traducido)', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findFirst.mockResolvedValue({
      id: 'row-1',
      status: S.FAILED,
      terminalId: 'term-1',
      amountCents: 10000,
      tipCents: 0,
      orderId: null,
      senderDevice: null,
      createdAt: new Date(),
      terminalReturnedAt: null,
      failureCode: 'TPV_ERROR',
      cancelDisposition: null,
      paymentId: null,
      resultJson: null,
    })
    const salida = JSON.parse(
      (await capturarTool('release_terminal_payment')({ venueId: 'venue-1', requestId: 'REQ', reason: 'prueba' })).content[0].text,
    )
    expect(salida).toMatchObject({ ok: false, status: 'FAILED', outcome: 'UNRESOLVED' })
  })
})

describe('S8 · quién confirmó (closedVia) y los intentos de cada solicitud', () => {
  it('muestra closedVia CONSERVANDO al ganador, los intentos vinculados y cuál de ellos ganó', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findMany.mockResolvedValue([
      fila({ status: S.COMPLETED, paymentId: 'pay-A', closedVia: 'webhook' }),
    ])
    vinculos(
      [
        { requestId: 'REQ', attemptId: 'A', createdAt: new Date('2026-09-13T20:00:00Z') },
        { requestId: 'REQ', attemptId: 'B', createdAt: new Date('2026-09-13T20:00:05Z') },
      ],
      { REQ: 2 },
    )
    ;(prismaMock as any).terminalPaymentAttemptLink.findMany.mockResolvedValue([
      { requestId: 'REQ', attemptId: 'A', createdAt: new Date('2026-09-13T20:00:00Z') },
    ])
    ;(prismaMock as any).payment.findMany.mockResolvedValue([{ id: 'pay-A', idempotencyKey: 'A' }])
    const salida = JSON.parse((await capturarTool('terminal_payment_requests')({ venueId: 'venue-1' })).content[0].text)
    expect(salida.requests[0]).toMatchObject({
      status: 'COMPLETED',
      outcome: 'CHARGED',
      paymentId: 'pay-A',
      closedVia: 'webhook',
      winnerAttemptId: 'A',
      attempts: [
        { attemptId: 'A', linkedAt: '2026-09-13T20:00:00.000Z' },
        { attemptId: 'B', linkedAt: '2026-09-13T20:00:05.000Z' },
      ],
    })
    expect(salida.requests[0]).toMatchObject({ attemptsTruncated: false, attemptsTotal: 2 })
    // La ventana y los conteos se piden para las solicitudes listadas; el ganador se trae aparte por su llave.
    expect((prismaMock as any).$queryRaw).toHaveBeenCalled()
    expect((prismaMock as any).terminalPaymentAttemptLink.groupBy.mock.calls[0][0].where).toMatchObject({ requestId: { in: ['REQ'] } })
    expect((prismaMock as any).terminalPaymentAttemptLink.findMany.mock.calls[0][0].where).toMatchObject({ attemptId: { in: ['A'] } })
  })

  it('sin vínculos ni ganador: closedVia null, attempts vacío y winnerAttemptId null (aditivo: el resto no cambia)', async () => {
    const salida = await listar([fila({ status: S.SENT })])
    expect(salida.requests[0]).toMatchObject({ closedVia: null, winnerAttemptId: null, attempts: [] })
  })
})

describe('Codex R4 (P2): continuación por solicitud — así se llega a los intentos que la ventana de 25 recortó', () => {
  const vinculo = (i: number) => ({
    requestId: 'REQ',
    attemptId: `A${String(i).padStart(2, '0')}`,
    createdAt: new Date(2026, 8, 13, 20, 0, i),
  })

  it('attemptsRequestId devuelve SÓLO los intentos de esa solicitud, 25 por página, con attemptsNextCursor y el total real', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findFirst.mockResolvedValue({ requestId: 'REQ' })
    ;(prismaMock as any).terminalPaymentAttemptLink.findMany.mockResolvedValue(Array.from({ length: 26 }, (_, i) => vinculo(i + 1)))
    ;(prismaMock as any).terminalPaymentAttemptLink.count.mockResolvedValue(50)
    const salida = JSON.parse(
      (await capturarTool('terminal_payment_requests')({ venueId: 'venue-1', attemptsRequestId: 'REQ' })).content[0].text,
    )
    expect(salida.requestId).toBe('REQ')
    expect(salida.attempts).toHaveLength(25)
    expect(salida.attempts[0]).toEqual({ attemptId: 'A01', linkedAt: new Date(2026, 8, 13, 20, 0, 1).toISOString() })
    expect(salida).toMatchObject({ attemptsTotal: 50, attemptsNextCursor: 'A25' })
    // La solicitud se busca dentro del alcance del operador y la página es keyset (createdAt, attemptId), 25 + 1 de mirada.
    expect((prismaMock as any).terminalPaymentRequest.findFirst.mock.calls[0][0].where).toMatchObject({ requestId: 'REQ' })
    const consulta = (prismaMock as any).terminalPaymentAttemptLink.findMany.mock.calls[0][0]
    expect(consulta).toMatchObject({ where: { requestId: 'REQ' }, take: 26, orderBy: [{ createdAt: 'asc' }, { attemptId: 'asc' }] })
    // Sin la lista general: ni ventana ni conteos por groupBy.
    expect((prismaMock as any).$queryRaw).not.toHaveBeenCalled()
  })

  it('attemptsAfter continúa DESPUÉS del cursor por (createdAt, attemptId); la última página no trae cursor', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findFirst.mockResolvedValue({ requestId: 'REQ' })
    const ancla = vinculo(25)
    ;(prismaMock as any).terminalPaymentAttemptLink.findUnique.mockResolvedValue(ancla)
    ;(prismaMock as any).terminalPaymentAttemptLink.findMany.mockResolvedValue([vinculo(26), vinculo(27)])
    ;(prismaMock as any).terminalPaymentAttemptLink.count.mockResolvedValue(27)
    const salida = JSON.parse(
      (await capturarTool('terminal_payment_requests')({ venueId: 'venue-1', attemptsRequestId: 'REQ', attemptsAfter: 'A25' })).content[0]
        .text,
    )
    expect(salida.attempts.map((a: { attemptId: string }) => a.attemptId)).toEqual(['A26', 'A27'])
    expect(salida.attemptsNextCursor).toBeNull()
    const where = (prismaMock as any).terminalPaymentAttemptLink.findMany.mock.calls[0][0].where
    expect(where).toEqual({
      requestId: 'REQ',
      OR: [{ createdAt: { gt: ancla.createdAt } }, { createdAt: ancla.createdAt, attemptId: { gt: 'A25' } }],
    })
  })

  it('un cursor que pertenece a OTRA solicitud, o una solicitud fuera del alcance, se rechazan sin listar nada', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findFirst.mockResolvedValueOnce({ requestId: 'REQ' })
    ;(prismaMock as any).terminalPaymentAttemptLink.findUnique.mockResolvedValue({
      requestId: 'OTRA',
      attemptId: 'X',
      createdAt: new Date(),
    })
    const ajeno = JSON.parse(
      (await capturarTool('terminal_payment_requests')({ venueId: 'venue-1', attemptsRequestId: 'REQ', attemptsAfter: 'X' })).content[0]
        .text,
    )
    expect(ajeno).toMatchObject({ ok: false })
    expect((prismaMock as any).terminalPaymentAttemptLink.findMany).not.toHaveBeenCalled()
    ;(prismaMock as any).terminalPaymentRequest.findFirst.mockResolvedValueOnce(null)
    const fuera = JSON.parse(
      (await capturarTool('terminal_payment_requests')({ venueId: 'venue-1', attemptsRequestId: 'NO-EXISTE' })).content[0].text,
    )
    expect(fuera).toMatchObject({ ok: false })
  })
})

describe('Codex R2 · P2-7: el ganador no se esconde detrás del tope de vínculos', () => {
  it('con 26 intentos y el ganador fuera de los 25 listados, winnerAttemptId lo encuentra igual y la lista dice que está recortada', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findMany.mockResolvedValue([
      fila({ status: S.COMPLETED, paymentId: 'pay-A26', closedVia: 'webhook' }),
    ])
    const primeros = Array.from({ length: 25 }, (_, i) => ({
      requestId: 'REQ',
      attemptId: `A${i + 1}`,
      createdAt: new Date(2026, 8, 13, 20, 0, i),
    }))
    vinculos(primeros, { REQ: 26 })
    ;(prismaMock as any).terminalPaymentAttemptLink.findMany.mockResolvedValue([
      { requestId: 'REQ', attemptId: 'A26', createdAt: new Date(2026, 8, 13, 20, 0, 26) },
    ])
    ;(prismaMock as any).payment.findMany.mockResolvedValue([{ id: 'pay-A26', idempotencyKey: 'A26' }])
    const salida = JSON.parse((await capturarTool('terminal_payment_requests')({ venueId: 'venue-1' })).content[0].text)
    // Con el ganador fundido, los 26 están a la vista: la lista NO está recortada y lo dice con el conteo real.
    expect(salida.requests[0]).toMatchObject({ winnerAttemptId: 'A26', attemptsTruncated: false, attemptsTotal: 26 })
    expect(salida.requests[0].attempts).toHaveLength(26)
    expect(salida.requests[0].attempts.some((a: { attemptId: string }) => a.attemptId === 'A26')).toBe(true)
  })
})

describe('Codex R3 · P2: la ventana de vínculos es POR SOLICITUD y el recorte se declara con el conteo real', () => {
  it('A con 50 intentos y B con 1: B muestra su intento (no queda vacío detrás de A), A se declara recortada (25 de 50) y B completa', async () => {
    ;(prismaMock as any).terminalPaymentRequest.findMany.mockResolvedValue([
      fila({ requestId: 'A', status: S.SENT }),
      fila({ requestId: 'B', status: S.SENT, terminalId: 'term-2' }),
    ])
    const ventanaDeA = Array.from({ length: 25 }, (_, i) => ({
      requestId: 'A',
      attemptId: `A${i + 1}`,
      createdAt: new Date(2026, 8, 13, 20, 0, i),
    }))
    vinculos([...ventanaDeA, { requestId: 'B', attemptId: 'B1', createdAt: new Date(2026, 8, 13, 21, 0, 0) }], { A: 50, B: 1 })
    ;(prismaMock as any).terminalPaymentAttemptLink.findMany.mockResolvedValue([])
    ;(prismaMock as any).payment.findMany.mockResolvedValue([])

    const salida = JSON.parse((await capturarTool('terminal_payment_requests')({ venueId: 'venue-1' })).content[0].text)
    const porId = Object.fromEntries(salida.requests.map((r: { requestId: string }) => [r.requestId, r]))
    expect(porId.A.attempts).toHaveLength(25)
    expect(porId.A).toMatchObject({ attemptsTruncated: true, attemptsTotal: 50 })
    expect(porId.B.attempts).toEqual([{ attemptId: 'B1', linkedAt: new Date(2026, 8, 13, 21, 0, 0).toISOString() }])
    expect(porId.B).toMatchObject({ attemptsTruncated: false, attemptsTotal: 1 })
    // La ventana se pide con ROW_NUMBER por solicitud, nunca con un tope global.
    const sql = ((prismaMock as any).$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY "requestId"')
  })
})
