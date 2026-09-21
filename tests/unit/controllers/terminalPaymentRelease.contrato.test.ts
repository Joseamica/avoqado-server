/**
 * El CONTRATO de `/terminal-payment/:requestId/release` con declaración (P1/P2 de la auditoría de Codex, 18-sep).
 *
 * 🔴 Dos defectos que ninguna prueba anterior veía, porque todas llamaban al SERVICIO por dentro y nunca a la
 * puerta:
 *
 *  - El cuerpo que documenta el plan (`{statement, statementVersion, resolutionId}`) devolvía 409: el esquema
 *    exige además `requestId` DENTRO del JSON, y el controlador pasaba el cuerpo intacto. El `requestId` ya
 *    viene en la RUTA; pedirlo dos veces es un contrato que se contradice a sí mismo.
 *  - El replay respondía «Terminal liberada» aunque entretanto hubiera aparecido el dinero.
 */
const mockRelease = jest.fn()
jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { releaseUnknownRequest: (...a: unknown[]) => mockRelease(...(a as [])) },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { releaseTerminalPayment } from '@/controllers/mobile/terminal-payment.mobile.controller'

function reqFalso(body: unknown) {
  return { params: { venueId: 'v1', requestId: 'req-1' }, body, authContext: { userId: 'staff-cashier' } } as any
}
function resFalso() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

beforeEach(() => jest.clearAllMocks())

describe('el contrato de la declaración', () => {
  it('🔴 el cuerpo DOCUMENTADO (sin requestId dentro) funciona: el id viene de la RUTA', async () => {
    mockRelease.mockResolvedValue({ requestId: 'req-1', released: true, status: 'FAILED', resolution: { id: 'r1', acceptedAt: 'x' } })
    await releaseTerminalPayment(reqFalso({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: 'uuid-1' }), resFalso())

    const arg = mockRelease.mock.calls[0][0] as any
    expect(arg.declaration).toMatchObject({
      requestId: 'req-1', // ← inyectado desde la ruta
      statement: 'UNCHARGED_VERIFIED',
      statementVersion: 1,
      resolutionId: 'uuid-1',
    })
  })

  it('🔴 un requestId del CUERPO no puede contradecir al de la RUTA', async () => {
    mockRelease.mockResolvedValue({ requestId: 'req-1', released: true, status: 'FAILED' })
    await releaseTerminalPayment(
      reqFalso({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: 'uuid-1', requestId: 'OTRO' }),
      resFalso(),
    )
    expect((mockRelease.mock.calls[0][0] as any).declaration.requestId).toBe('req-1')
  })

  it('🔴 si entretanto apareció el dinero, NO dice «liberada»', async () => {
    mockRelease.mockResolvedValue({
      requestId: 'req-1',
      released: false,
      status: 'COMPLETED',
      paymentId: 'pay-1',
      resolution: { id: 'r1', acceptedAt: 'x' },
    })
    const res = resFalso()
    await releaseTerminalPayment(reqFalso({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: 'uuid-1' }), res)

    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo.released).toBe(false)
    expect(cuerpo.message).not.toMatch(/liberada/i)
    expect(cuerpo.paymentId).toBe('pay-1')
  })

  it('la respuesta feliz devuelve la resolución, para que el POS pueda recuperarla', async () => {
    mockRelease.mockResolvedValue({ requestId: 'req-1', released: true, status: 'FAILED', resolution: { id: 'r1', acceptedAt: 'x' } })
    const res = resFalso()
    await releaseTerminalPayment(reqFalso({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: 'uuid-1' }), res)
    expect(res.json.mock.calls[0][0].resolution).toMatchObject({ id: 'r1' })
  })

  it('🔴 la respuesta trae los campos que PROMETE el contrato: requestId, outcome y outcomeEvidence', async () => {
    mockRelease.mockResolvedValue({
      requestId: 'req-1',
      released: true,
      status: 'FAILED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      resolution: { id: 'r1', acceptedAt: 'x' },
    })
    const res = resFalso()
    await releaseTerminalPayment(reqFalso({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: 'uuid-1' }), res)
    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo.requestId).toBe('req-1')
    expect(cuerpo.outcome).toBe('NOT_CHARGED')
    expect(cuerpo.outcomeEvidence).toBe('OPERATOR_RECONCILED')
  })

  it('🔴 no liberada NUNCA afirma «no cobrado»: el desenlace honesto es que sigue sin resolverse', async () => {
    // Codex r3 (P1-5): `desenlaceCanonico` clasifica por el código de la fila, así que con un claimedSuccess
    // durable encima seguía diciendo NOT_CHARGED / OPERATOR_RECONCILED — decirle al POS que no se cobró
    // justo cuando la terminal acaba de afirmar lo contrario.
    mockRelease.mockResolvedValue({
      requestId: 'req-1',
      released: false,
      status: 'FAILED',
      outcome: 'UNRESOLVED',
      outcomeEvidence: null,
      resolution: { id: 'r1', acceptedAt: 'x' },
    })
    const res = resFalso()
    await releaseTerminalPayment(reqFalso({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: 'uuid-1' }), res)
    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo.released).toBe(false)
    expect(cuerpo.outcome).not.toBe('NOT_CHARGED')
    expect(cuerpo.outcomeEvidence).toBeNull()
  })

  it('🔴 sin declaración, el cuerpo NO se toca: el camino viejo queda igual', async () => {
    mockRelease.mockResolvedValue({ requestId: 'req-1', released: false, status: 'UNKNOWN' })
    await releaseTerminalPayment(reqFalso({ reason: 'la PAX se reinició' }), resFalso())
    expect((mockRelease.mock.calls[0][0] as any).declaration).toBeUndefined()
  })
})
