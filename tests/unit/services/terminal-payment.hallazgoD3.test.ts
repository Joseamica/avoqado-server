import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { Prisma } from '@prisma/client'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => id.replace(/^AVQD-/i, '').toLowerCase(),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))

const svc = terminalPaymentService as any
const db = prisma as any

describe('Hallazgo D3 · avance bounded entre ticks de solicitudes liberadas', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    svc.positivasCursor = null
    db.terminalPaymentRequest.findFirst.mockResolvedValue(null)
  })

  it('tras 5000 candidatas persistentes continúa, vuelve al principio al agotar y reinicia con seguridad', async () => {
    const createdAt = new Date('2026-10-22T00:00:00Z')
    const held = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAprobacion').mockResolvedValue('HELD')
    const reconcile = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('NADA')
    db.terminalPaymentRequest.findFirst.mockImplementation(async ({ where }: any) =>
      where.requestId === 'exact-last' ? { requestId: 'exact-last', venueId: 'venue' } : null,
    )
    const queries: Array<{ text: string; values: unknown[] }> = []
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values)
      queries.push({ text: sql.text, values: sql.values })
      const after = sql.values.find(v => typeof v === 'string' && v.startsWith('row-')) as string | undefined
      const start = after ? Number(after.slice(4)) + 1 : 0
      return Array.from({ length: Math.min(200, 5001 - start) }, (_, index) => ({
        requestId: start + index === 5000 ? 'exact-last' : 'request',
        venueId: 'venue',
        id: `row-${String(start + index).padStart(5, '0')}`,
        createdAt,
        paymentId: null,
        evidenciaIds: ['ajena'],
        afirmacion: false,
        cursorDeEvidencias: null,
        aprobacionId: start + index === 5000 ? 'event-exact' : null,
        aprobacionAttemptId: start + index === 5000 ? 'attempt-exact' : null,
      }))
    })
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-10-22T01:00:00Z'))
    expect(queries).toHaveLength(25)
    expect(held).not.toHaveBeenCalled()
    expect(await svc.retenerLiberadasConSenalPositiva(new Date('2026-10-22T01:00:30Z'))).toMatchObject({ sinPago: 1 })
    expect(held).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'exact-last', eventLogId: 'event-exact' }))
    expect(queries[25].text).toContain('r."id" >')
    expect(queries[25].values.flatMap(v => (v as { values?: unknown[] })?.values ?? [v])).toContain('row-04999')
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-10-22T01:01:00Z'))
    expect(queries[26].values.flatMap(v => (v as { values?: unknown[] })?.values ?? [v])).not.toContain('row-04999')
    // Reiniciar el proceso pierde sólo la posición: vuelve al principio y conserva los datos durables.
    svc.positivasCursor = null
    const next = queries.length
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-10-22T01:01:30Z'))
    expect(queries[next].text).not.toContain('r."id" >')
    held.mockRestore()
    reconcile.mockRestore()
  })
})
