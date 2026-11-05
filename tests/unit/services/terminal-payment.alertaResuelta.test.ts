/**
 * D23 (IQ, 4-nov-2026): el correo «cobro sin respuesta» salió a los 67 s y la terminal contestó «no se cobró» a los 79 s.
 * En producción (30 días) las 3 alertas se resolvieron solas entre 11 s y 149 s. El correo sigue saliendo igual; cuando ese
 * cobro termina con resultado, el vigilante manda UN «✅ Resuelto» con el desenlace.
 */
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))

jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => id.replace(/^AVQD-/i, '').toLowerCase(),
  terminalRegistry: { getTerminal: jest.fn(), getTerminalBySocketId: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))

const prismaMock = prisma as any
const tpr = () => prismaMock.terminalPaymentRequest
const alerta = sendOpsAlert as jest.Mock

const now = new Date('2026-11-04T19:41:00Z')
const enDuda = (requestId: string, venueId = 'venue-iq') => ({
  id: `row-${requestId}`,
  requestId,
  venueId,
  terminalId: 'n860w175376',
  status: 'CANCEL_REQUESTED',
  amountCents: 805000,
  tipCents: 0,
  orderId: 'order-iq',
  paymentId: null,
  resultJson: null,
  failureCode: null,
  createdAt: new Date(now.getTime() - 67_000),
  updatedAt: new Date(now.getTime() - 40_000),
  expiresAt: new Date(now.getTime() + 233_000),
  cancelDisposition: null,
  deliveryProvenance: null,
})

/** El barrido lee las vencidas con `status: { in }`; el seguimiento, por `requestId: { in }`. */
function barridos(vencidas: any[], desenlaces: Record<string, any>) {
  tpr().findMany.mockImplementation(async ({ where }: any) => {
    if (where?.requestId?.in) return where.requestId.in.map((id: string) => desenlaces[id]).filter(Boolean)
    return vencidas
  })
}

const resueltos = () => alerta.mock.calls.map(([a]: any) => a).filter((a: any) => a.subject.includes('Resuelto'))
const correcciones = () => alerta.mock.calls.map(([a]: any) => a).filter((a: any) => a.subject.includes('Corrección'))
/** El seguimiento corre aparte del barrido (Codex r3): se deja terminar antes de mirar los correos. */
async function barrer(t: Date) {
  const r = await terminalPaymentService.reconcileStaleRequests(t)
  await new Promise(res => setImmediate(res))
  return r
}

describe('D23 · el vigilante avisa «✅ Resuelto» cuando un cobro que alertó termina', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminalPaymentAttemptLink.findMany.mockResolvedValue([])
    prismaMock.payment.findFirst.mockResolvedValue(null)
    tpr().updateMany.mockResolvedValue({ count: 1 })
  })

  it('alerta → la terminal dice «no se cobró» → un solo «Resuelto» con el desenlace, y no se repite', async () => {
    barridos([enDuda('REQ-A')], {})
    await barrer(now)
    expect(alerta.mock.calls.filter(([a]: any) => a.subject.includes('cobro sin respuesta'))).toHaveLength(1)
    expect(resueltos()).toHaveLength(0)

    const fila = { requestId: 'REQ-A', venueId: 'venue-iq', terminalId: 'n860w175376', amountCents: 805000 }
    barridos([], { 'REQ-A': { ...fila, status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: { outcomeEvidence: 'PRE_AUTHORIZATION' } } })
    await barrer(new Date(now.getTime() + 30_000))
    expect(resueltos()).toHaveLength(1)
    const [r] = resueltos()
    expect(r.subject).toContain('n860w175376')
    expect(r.lines.join('\n')).toContain('$8050.00')
    expect(r.lines.join('\n')).toContain('NO se cobró')
    expect(r.lines.join('\n')).toContain('REQ-A')

    await barrer(new Date(now.getTime() + 60_000))
    expect(resueltos()).toHaveLength(1)
  })

  it('si al final SÍ se cobró, el «Resuelto» lo dice', async () => {
    barridos([enDuda('REQ-B')], {})
    await barrer(now)
    barridos([], { 'REQ-B': { requestId: 'REQ-B', venueId: 'venue-iq', terminalId: 't', amountCents: 805000, status: 'COMPLETED', failureCode: null, paymentId: 'pay-1' } })
    await barrer(new Date(now.getTime() + 30_000))
    expect(resueltos()[0].lines.join('\n')).toContain('SÍ se cobró')
  })

  it('mientras siga en duda (UNKNOWN o soltada sin desenlace) no manda nada y lo sigue vigilando', async () => {
    barridos([enDuda('REQ-C')], {})
    await barrer(now)
    const base = { requestId: 'REQ-C', venueId: 'venue-iq', terminalId: 't', amountCents: 1 }
    barridos([], { 'REQ-C': { ...base, status: 'UNKNOWN', failureCode: 'TIMED_OUT' } })
    await barrer(new Date(now.getTime() + 30_000))
    barridos([], { 'REQ-C': { ...base, status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' } })
    await barrer(new Date(now.getTime() + 60_000))
    expect(resueltos()).toHaveLength(0)
    barridos([], { 'REQ-C': { ...base, status: 'CANCELLED', failureCode: null, cancelDisposition: 'ACCEPTED' } })
    await barrer(new Date(now.getTime() + 90_000))
    expect(resueltos()).toHaveLength(1)
  })

  it('una fila de otra sucursal con el mismo requestId no cuenta como resuelta', async () => {
    barridos([enDuda('REQ-D')], {})
    await barrer(now)
    barridos([], { 'REQ-D': { requestId: 'REQ-D', venueId: 'otra', terminalId: 't', amountCents: 1, status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: { outcomeEvidence: 'PRE_AUTHORIZATION' } } })
    await barrer(new Date(now.getTime() + 30_000))
    expect(resueltos()).toHaveLength(0)
  })

  it('si la consulta del seguimiento falla, el barrido termina igual y lo reintenta en la siguiente vuelta', async () => {
    barridos([enDuda('REQ-E')], {})
    await barrer(now)
    tpr().findMany.mockImplementation(async ({ where }: any) => {
      if (where?.requestId?.in) throw new Error('Connection terminated')
      return []
    })
    await expect(barrer(new Date(now.getTime() + 30_000))).resolves.toMatchObject({ unknown: 0 })
    barridos([], { 'REQ-E': { requestId: 'REQ-E', venueId: 'venue-iq', terminalId: 't', amountCents: 1, status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: { outcomeEvidence: 'PRE_AUTHORIZATION' } } })
    await barrer(new Date(now.getTime() + 60_000))
    expect(resueltos()).toHaveLength(1)
  })

  it('Codex r1 · una liberación REVERSIBLE (sin evidencia tras la ventana) o un negativo sin evidencia no se anuncian', async () => {
    barridos([enDuda('REQ-F')], {})
    await barrer(now)
    const base = { requestId: 'REQ-F', venueId: 'venue-iq', terminalId: 't', amountCents: 1 }
    barridos([], { 'REQ-F': { ...base, status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' } })
    await barrer(new Date(now.getTime() + 30_000))
    barridos([], { 'REQ-F': { ...base, status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: null } })
    await barrer(new Date(now.getTime() + 60_000))
    barridos([], { 'REQ-F': { ...base, status: 'CANCELLED', failureCode: null, cancelDisposition: null } })
    await barrer(new Date(now.getTime() + 90_000))
    expect(resueltos()).toHaveLength(0)
  })

  it.each(['OPERATOR_RECONCILED_NO_CHARGE', 'BANK_DECLINED'])(
    'Codex r2 · %s es reversible: no se anuncia y se sigue vigilando hasta que haya desenlace firme',
    async codigo => {
      const id = `REQ-H-${codigo}`
      barridos([enDuda(id)], {})
      await barrer(now)
      const base = { requestId: id, venueId: 'venue-iq', terminalId: 't', amountCents: 1 }
      barridos([], { [id]: { ...base, status: 'FAILED', failureCode: codigo, paymentId: null } })
      await barrer(new Date(now.getTime() + 30_000))
      expect(resueltos()).toHaveLength(0)
      barridos([], { [id]: { ...base, status: 'COMPLETED', failureCode: null, paymentId: 'pay-tarde' } })
      await barrer(new Date(now.getTime() + 60_000))
      expect(resueltos()).toHaveLength(1)
      expect(resueltos()[0].lines.join('\n')).toContain('SÍ se cobró')
    },
  )

  it('Codex r2 · un «SÍ se cobró» nunca dice «No hace falta hacer nada»: pide revisar un posible doble cobro', async () => {
    barridos([enDuda('REQ-I')], {})
    await barrer(now)
    barridos([], { 'REQ-I': { requestId: 'REQ-I', venueId: 'venue-iq', terminalId: 't', amountCents: 1, status: 'COMPLETED', failureCode: null, paymentId: 'pay-3' } })
    await barrer(new Date(now.getTime() + 30_000))
    const texto = resueltos()[0].lines.join('\n')
    expect(texto).toContain('cobrado otra vez')
    expect(texto).not.toContain('No hace falta hacer nada')
  })

  it('Codex r1 · cobrado con el importe descuadrado: pide conciliar, nunca «No hace falta hacer nada»', async () => {
    barridos([enDuda('REQ-G')], {})
    await barrer(now)
    barridos([], { 'REQ-G': { requestId: 'REQ-G', venueId: 'venue-iq', terminalId: 't', amountCents: 805000, status: 'COMPLETED', failureCode: 'CONTRACT_MISMATCH', paymentId: 'pay-2' } })
    await barrer(new Date(now.getTime() + 30_000))
    const texto = resueltos()[0].lines.join('\n')
    expect(texto).toContain('hay que conciliarlo')
    expect(texto).not.toContain('No hace falta hacer nada')
  })
  it('Codex r3 · un «NO se cobró» anunciado que después el cierre vuelve COMPLETED manda UNA «⚠️ Corrección»', async () => {
    barridos([enDuda('REQ-J')], {})
    await barrer(now)
    const base = { requestId: 'REQ-J', venueId: 'venue-iq', terminalId: 't', amountCents: 805000 }
    barridos([], { 'REQ-J': { ...base, status: 'FAILED', failureCode: 'TPV_CONFIRMED_NO_CHARGE', paymentId: null, resultJson: { outcomeEvidence: 'PROCESSOR_DECLINED' } } })
    await barrer(new Date(now.getTime() + 30_000))
    expect(resueltos()).toHaveLength(1)
    expect(resueltos()[0].lines.join('\n')).toContain('te llegará una corrección')
    barridos([], { 'REQ-J': { ...base, status: 'COMPLETED', failureCode: null, paymentId: 'pay-tardio' } })
    await barrer(new Date(now.getTime() + 60_000))
    await barrer(new Date(now.getTime() + 90_000))
    expect(correcciones()).toHaveLength(1)
    const texto = correcciones()[0].lines.join('\n')
    expect(texto).toContain('te dijimos que NO se cobró')
    expect(texto).toContain('SÍ se cobró')
    expect(texto).toContain('cobrado otra vez')
  })

  it('Codex r3 · si el correo «Resuelto» falla al enviarse, se reintenta en la siguiente vuelta', async () => {
    barridos([enDuda('REQ-K')], {})
    await barrer(now)
    barridos([], { 'REQ-K': { requestId: 'REQ-K', venueId: 'venue-iq', terminalId: 't', amountCents: 1, status: 'COMPLETED', failureCode: null, paymentId: 'pay-k' } })
    alerta.mockResolvedValueOnce(false)
    await barrer(new Date(now.getTime() + 30_000))
    expect(resueltos()).toHaveLength(1)
    await barrer(new Date(now.getTime() + 60_000))
    expect(resueltos()).toHaveLength(2)
    await barrer(new Date(now.getTime() + 90_000))
    expect(resueltos()).toHaveLength(2)
  })

  it('Codex r4 · un envío que falla se reintenta, pero a lo más 3 veces (un «false» por plazo pudo haber llegado)', async () => {
    barridos([enDuda('REQ-M')], {})
    await barrer(now)
    barridos([], { 'REQ-M': { requestId: 'REQ-M', venueId: 'venue-iq', terminalId: 't', amountCents: 1, status: 'COMPLETED', failureCode: null, paymentId: 'pay-m' } })
    alerta.mockResolvedValue(false)
    for (let i = 1; i <= 5; i++) await barrer(new Date(now.getTime() + i * 30_000))
    alerta.mockResolvedValue(true)
    expect(resueltos().filter((r: any) => r.lines.join(' ').includes('REQ-M'))).toHaveLength(3)
  })

  it('Codex r4 · con la lista llena sale la alerta más vieja, nunca la nueva', async () => {
    const muchas = Array.from({ length: 501 }, (_, i) => enDuda(`REQ-N-${i}`))
    barridos(muchas, {})
    await barrer(now)
    barridos([], { 'REQ-N-500': { requestId: 'REQ-N-500', venueId: 'venue-iq', terminalId: 't', amountCents: 1, status: 'COMPLETED', failureCode: null, paymentId: 'pay-n' } })
    await barrer(new Date(now.getTime() + 30_000))
    expect(resueltos().filter((r: any) => r.lines.join(' ').includes('REQ-N-500'))).toHaveLength(1)
  })

  it('Codex r3 y r4 · una consulta colgada no detiene el barrido, no arranca otra encima y suelta el candado a los 10 s', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    barridos([enDuda('REQ-L')], {})
    await barrer(now)
    let seguimientos = 0
    tpr().findMany.mockImplementation(({ where }: any) => {
      if (where?.requestId?.in) {
        seguimientos++
        return new Promise(() => {})
      }
      return Promise.resolve([])
    })
    await expect(barrer(new Date(now.getTime() + 30_000))).resolves.toMatchObject({ unknown: 0 })
    await expect(barrer(new Date(now.getTime() + 60_000))).resolves.toMatchObject({ unknown: 0 })
    expect(seguimientos).toBe(1)
    jest.advanceTimersByTime(10_001)
    await new Promise(res => setImmediate(res))
    await barrer(new Date(now.getTime() + 90_000))
    expect(seguimientos).toBe(2)
    jest.advanceTimersByTime(10_001)
    await new Promise(res => setImmediate(res))
    jest.useRealTimers()
  })
})
