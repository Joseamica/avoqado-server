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

async function listar(rows: ReturnType<typeof fila>[]) {
  ;(prismaMock as any).terminalPaymentRequest.findMany.mockResolvedValue(rows)
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
