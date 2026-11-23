/**
 * Cobro simple · S1.3: lo que el SERVIDOR contesta tras «sin respuesta ⇒ 10 s ⇒ no cobrado» tiene que leerse como «puedes volver a
 * cobrar» en las apps de la calle, SIN actualizarlas. Los lectores (git de cada app, en su etiqueta):
 *  · ANDROID/WINDOWS 2.22 (`v2.22.0-50`, `CardChargeOutcome.kt:289-294`): evalúa `cancelDisposition == "ACTIVE"` ANTES que el estado
 *    (si llega ACTIVE dice «el cobro sigue activo» para siempre); luego `status == FAILED && outcomeEvidence == NO_EVIDENCE_AFTER_WINDOW`
 *    ⇒ NotCharged «No se confirmó el cobro en 30 s. Puedes volver a cobrar…».
 *  · iOS 1.13 (`424e928`, `CardChargeOutcome.swift:367`): `case "FAILED" where outcomeEvidence == "NO_EVIDENCE_AFTER_WINDOW"`.
 *  · TPV ≥ 2.11.1 (`v2.11.1`, `VeredictoDeIntento.kt:152`): libera su libreta con `outcome NOT_CHARGED` + `outcomeEvidence` en
 *    {NO_EVIDENCE_AFTER_WINDOW, OPERATOR_RECONCILED}.
 * Y el POST largo: `failed` ⇒ HTTP 422 (nunca el 504 de «sin confirmar»). Ningún campo de siempre se quita; `noChargeCause` es nuevo
 * y opcional.
 */
const mockSend = jest.fn()
const mockStatus = jest.fn()
jest.mock('@/services/terminal-payment.service', () => {
  const real = jest.requireActual('@/services/terminal-payment.service')
  return {
    ...real,
    terminalPaymentService: {
      sendPaymentToTerminal: (...a: unknown[]) => mockSend(...(a as [])),
      getPaymentStatus: (...a: unknown[]) => mockStatus(...(a as [])),
    },
  }
})

import { TerminalPaymentRequestStatus } from '@prisma/client'
import { getTerminalPaymentStatus, sendTerminalPayment } from '@/controllers/mobile/terminal-payment.mobile.controller'
import { proyectarEstado } from '@/services/terminal-payment.service'

function resFalso() {
  const res: any = { locals: {} }
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

/** La fila tal como la deja `cerrarSinRespuesta` (con un ACTIVE viejo de una TPV 2.16/2.20 encima, el peor caso). */
const cerrada = {
  requestId: 'REQ-1',
  venueId: 'v1',
  terminalId: 'abc',
  amountCents: 23650,
  tipCents: 0,
  orderId: 'o1',
  senderDevice: 'Tablet',
  lateResult: false,
  status: TerminalPaymentRequestStatus.FAILED,
  failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
  cancelDisposition: 'ACTIVE',
  paymentId: null,
  resultJson: { status: 'failed', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', noChargeCause: 'NO_RESPONSE' },
  createdAt: new Date('2026-11-22T15:25:00Z'),
  updatedAt: new Date('2026-11-22T15:25:12Z'),
}

describe('S1.3 · contrato con las apps viejas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('el GET devuelve exactamente la forma «no cobrado» que pintan ANDROID 2.22, iOS 1.13 y la TPV 2.11.1, sin quitar campos', async () => {
    mockStatus.mockResolvedValue(proyectarEstado(cerrada))
    const res = resFalso()
    await getTerminalPaymentStatus({ params: { venueId: 'v1', requestId: 'REQ-1' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(200)
    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo).toEqual({
      success: true,
      inProgress: false,
      requestId: 'REQ-1',
      venueId: 'v1',
      terminalId: 'abc',
      status: 'FAILED',
      amount: 236.5,
      tip: 0,
      orderId: 'o1',
      paymentId: null,
      senderDevice: 'Tablet',
      lateResult: false,
      // 🔴 ANDROID 2.22 lee ACTIVE antes que el estado: tiene que salir null.
      cancelDisposition: null,
      failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
      evidenceClass: 'SERVER',
      noChargeCause: 'NO_RESPONSE',
      createdAt: '2026-11-22T15:25:00.000Z',
      updatedAt: '2026-11-22T15:25:12.000Z',
    })
  })

  it('el POST largo que despierta el cierre contesta 422 `failed` (nunca 504), con la evidencia que las apps ya leen', async () => {
    mockSend.mockResolvedValue({
      requestId: 'REQ-1',
      status: 'failed',
      outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
      noChargeCause: 'ACK_TIMEOUT',
      errorMessage: 'El cobro no llegó a la terminal.',
    })
    const res = resFalso()
    await sendTerminalPayment(
      {
        params: { venueId: 'v1' },
        body: { terminalId: 'abc', amountCents: 23650, requestId: 'REQ-1' },
        authContext: { venueId: 'v1' },
        headers: {},
      } as any,
      res,
    )
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, status: 'failed', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW' })
  })

  it('en sus 10 s la fila se ve EN VUELO (SENT, inProgress): ANDROID 2.22 e iOS 1.13 siguen consultando y nadie la toma por «no cobrado» antes de tiempo', async () => {
    const enDuda = proyectarEstado({
      ...cerrada,
      status: TerminalPaymentRequestStatus.UNKNOWN,
      noResponseAt: new Date(),
      failureCode: null,
      cancelDisposition: null,
      resultJson: { status: 'timeout', noChargeCause: 'NO_RESPONSE' },
    })
    expect(enDuda).toMatchObject({ status: 'SENT', outcome: 'UNRESOLVED', outcomeEvidence: null })
    expect(enDuda).not.toHaveProperty('noChargeCause')
    mockStatus.mockResolvedValue(enDuda)
    const res = resFalso()
    await getTerminalPaymentStatus({ params: { venueId: 'v1', requestId: 'REQ-1' } } as any, res)
    expect(res.json.mock.calls[0][0]).toMatchObject({ inProgress: true, status: 'SENT' })
  })

  it('Codex S1 r2 (R2-3) · dentro de los 10 s: SENT, inProgress y cancelDisposition null aunque la fila guarde un ACTIVE del cancel', async () => {
    const ahora = new Date('2026-11-22T15:25:20Z')
    const enDuda = proyectarEstado(
      {
        ...cerrada,
        status: TerminalPaymentRequestStatus.UNKNOWN,
        noResponseAt: new Date(ahora.getTime() - 4_000),
        failureCode: 'ACK_TIMEOUT',
        cancelDisposition: 'ACTIVE',
        resultJson: { status: 'timeout', noChargeCause: 'ACK_TIMEOUT' },
      },
      ahora,
    )
    expect(enDuda).toMatchObject({ status: 'SENT', cancelDisposition: null, outcome: 'UNRESOLVED' })
    mockStatus.mockResolvedValue(enDuda)
    const res = resFalso()
    await getTerminalPaymentStatus({ params: { venueId: 'v1', requestId: 'REQ-1' } } as any, res)
    expect(res.json.mock.calls[0][0]).toMatchObject({ inProgress: true, status: 'SENT', cancelDisposition: null })
  })

  it('Codex S1 r2 (R2-3) · a los 11 s una UNKNOWN que sigue ahí («aprobado, por registrar») ya no se ve en vuelo: UNKNOWN, inProgress false', async () => {
    const ahora = new Date('2026-11-22T15:25:20Z')
    const porRegistrar = proyectarEstado(
      {
        ...cerrada,
        status: TerminalPaymentRequestStatus.UNKNOWN,
        noResponseAt: new Date(ahora.getTime() - 11_000),
        failureCode: null,
        cancelDisposition: null,
        resultJson: { status: 'timeout', noChargeCause: 'NO_RESPONSE', claimedSuccess: { status: 'success' } },
      },
      ahora,
    )
    expect(porRegistrar).toMatchObject({ status: 'UNKNOWN', outcome: 'UNRESOLVED' })
    mockStatus.mockResolvedValue(porRegistrar)
    const res = resFalso()
    await getTerminalPaymentStatus({ params: { venueId: 'v1', requestId: 'REQ-1' } } as any, res)
    expect(res.json.mock.calls[0][0]).toMatchObject({ inProgress: false, status: 'UNKNOWN' })
  })
})
