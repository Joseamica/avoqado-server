/**
 * Cobro simple · paso 1 de B (26-nov; Codex A1 r1 #2 y r2 #2), contra Postgres REAL.
 *
 * Lo que lee el POS (el GET de la solicitud y la respuesta de «Cancelar») NUNCA dice «no cobrado» si el SERVIDOR ya conoce dinero de
 * esa solicitud. Pasa en el hueco entre que la fila se soltó «no cobrada» (por silencio, por declaración o por rechazo del banco) y que
 * el aprobado tardío la re-retiene o la cierra COMPLETED: la afirmación de la terminal (`claimedSuccess`) se funde en una escritura y la
 * re-retención va en otra, y el aviso APROBADO de AngelPay se guarda antes de registrar el Payment. Ahí el POS ofrecía cobrar otra vez.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(() => undefined), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let f: Fixture

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('cslra')
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
})
afterEach(async () => {
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(() => f.destruir())

/** La fila tal como la deja el cierre de 10 s de S1: «no cobrada» por silencio. */
const soltadaPorSilencio = (extra: Record<string, unknown> = {}) =>
  f.solicitud({
    status: 'FAILED',
    failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
    resultJson: { status: 'failed', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', noChargeCause: 'NO_RESPONSE' },
    ...extra,
  })

const intento = async (requestId: string) => {
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId, venueId: f.venueId, terminalId: f.llaveTerminal } })
  return attemptId
}
const aprobadoGuardado = (attemptId: string) =>
  prisma.providerEventLog.create({
    data: {
      provider: 'PAYMENT_PROCESSOR',
      type: 'send_transaction',
      eventId: `angelpay-${f.nuevoEventId()}`,
      venueId: f.venueId,
      attemptId,
      payload: f.eventoAngelPay(attemptId),
    } as any,
  })

const leer = (requestId: string) => terminalPaymentService.getPaymentStatus(requestId, f.venueId)
const cancelar = (requestId: string) => terminalPaymentService.cancelPayment(f.serial, requestId, 'prueba', f.venueId)

/** «Sigue en curso», la forma que ANDROID 2.22 e iOS 1.13 ya leen como «sigue»: nunca «puedes volver a cobrar». */
const enCurso = (p: any) => {
  expect(p.status).toBe('SENT')
  expect(p.outcome).toBe('UNRESOLVED')
  expect(p.outcomeEvidence).toBeNull()
  expect(p.cancelDisposition).toBeNull()
  expect(p.noChargeCause).toBeUndefined()
  expect(p.errorMessage).toBeUndefined()
}

describe('la lectura del POS respeta el aprobado que el SERVIDOR ya conoce', () => {
  it('soltada por silencio y después la terminal dijo «cobré» (claimedSuccess, sin Payment): el GET y Cancelar la leen en curso', async () => {
    const s = await soltadaPorSilencio({
      resultJson: {
        status: 'failed',
        outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
        noChargeCause: 'NO_RESPONSE',
        claimedSuccess: { status: 'success', transactionId: 'tx-1' },
      },
    })
    enCurso(await leer(s.requestId))
    const c = await cancelar(s.requestId)
    expect(c.cancelIntent).toBe('ALREADY_FINAL')
    enCurso(c.payment)
  })

  it('soltada por silencio y después llegó el aviso APROBADO de AngelPay de su intento (sin Payment): el GET la lee en curso', async () => {
    const s = await soltadaPorSilencio()
    await aprobadoGuardado(await intento(s.requestId))
    enCurso(await leer(s.requestId))
  })

  it('soltada por el rechazo del banco y después la terminal dijo «cobré»: también en curso (es una liberación reversible)', async () => {
    const s = await f.solicitud({
      status: 'FAILED',
      failureCode: 'BANK_DECLINED',
      resultJson: { status: 'failed', errorMessage: '51 FONDOS INSUFICIENTES', claimedSuccess: { status: 'success' } },
    })
    enCurso(await leer(s.requestId))
  })

  it('sin ninguna señal de dinero, la soltada por silencio sigue «no cobrada» con su causa (S1 intacto)', async () => {
    const s = await soltadaPorSilencio()
    const p: any = await leer(s.requestId)
    expect(p.status).toBe('FAILED')
    expect(p.outcome).toBe('NOT_CHARGED')
    expect(p.outcomeEvidence).toBe('NO_EVIDENCE_AFTER_WINDOW')
    expect(p.noChargeCause).toBe('NO_RESPONSE')
  })

  it('una afirmación vacía (`claimedSuccess: {}`) no cuenta como dinero', async () => {
    const s = await soltadaPorSilencio({
      resultJson: { status: 'failed', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', noChargeCause: 'NO_RESPONSE', claimedSuccess: {} },
    })
    expect(((await leer(s.requestId)) as any).outcome).toBe('NOT_CHARGED')
  })

  it('un «no cobrado» que la terminal acreditó (cancel ACCEPTED) no cambia aunque haya afirmación: no es una liberación reversible', async () => {
    const s = await f.solicitud({
      status: 'CANCELLED',
      cancelDisposition: 'ACCEPTED',
      resultJson: { claimedSuccess: { status: 'success' } },
    })
    const p: any = await leer(s.requestId)
    expect(p.status).toBe('CANCELLED')
    expect(p.outcome).toBe('NOT_CHARGED')
  })
})
