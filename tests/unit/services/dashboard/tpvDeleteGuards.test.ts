import prisma from '../../../../src/utils/prismaClient'
import { deleteTpv } from '../../../../src/services/dashboard/tpv.dashboard.service'

const prismaMock = prisma as any
const VENUE = 'venue_1'
const TPV = 'tpv_1'

function terminal(overrides: Record<string, any> = {}) {
  return { id: TPV, venueId: VENUE, activatedAt: null, selfRegistered: false, ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.terminal.findFirst.mockReset()
  prismaMock.terminal.delete.mockReset()
  prismaMock.order.count.mockReset()
  prismaMock.payment.count.mockReset()
  prismaMock.order.count.mockResolvedValue(0)
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.terminal.delete.mockResolvedValue({})
})

describe('deleteTpv — guardas contra pérdida de atribución de ventas', () => {
  // Las FK Order.terminalId / Payment.terminalId son ON DELETE SET NULL: borrar no
  // destruye ventas, pero las deja SIN dispositivo de forma irreversible.

  // ── REGRESIÓN: la guarda que ya existía ──────────────────────────────────────
  it('no borra una terminal activada', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal({ activatedAt: new Date() }))

    await expect(deleteTpv(VENUE, TPV)).rejects.toThrow(/activada/i)
    expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
  })

  // ── NUEVO: el hueco que abría el device registry ─────────────────────────────
  it('no borra un dispositivo auto-registrado, aunque nunca haya pasado por activación', async () => {
    // Este es el caso que el guard viejo NO cubría: un iPhone o un Sunmi que se
    // registró al hacer login nace con activatedAt = null.
    prismaMock.terminal.findFirst.mockResolvedValue(terminal({ selfRegistered: true }))

    await expect(deleteTpv(VENUE, TPV)).rejects.toThrow(/registró al iniciar sesión/i)
    expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
  })

  it('no borra una terminal con órdenes en su historial', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.order.count.mockResolvedValue(12)

    await expect(deleteTpv(VENUE, TPV)).rejects.toThrow(/historial/i)
    expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
  })

  it('no borra una terminal con pagos en su historial', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.payment.count.mockResolvedValue(3)

    await expect(deleteTpv(VENUE, TPV)).rejects.toThrow(/historial/i)
    expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
  })

  it('el mensaje de error dice cuántas ventas están en juego', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())
    prismaMock.order.count.mockResolvedValue(12)
    prismaMock.payment.count.mockResolvedValue(7)

    await expect(deleteTpv(VENUE, TPV)).rejects.toThrow(/12 órdenes, 7 pagos/)
  })

  // ── El caso que SÍ debe poder borrarse ───────────────────────────────────────
  it('sí borra una terminal provisionada, sin activar y sin historial', async () => {
    // Una terminal creada por error o un duplicado que nunca se usó: borrarla es seguro
    // porque no hay nada que atribuir.
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())

    await expect(deleteTpv(VENUE, TPV)).resolves.toBeUndefined()
    expect(prismaMock.terminal.delete).toHaveBeenCalledWith({ where: { id: TPV } })
  })

  it('el conteo de historial está acotado a ESA terminal', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal())

    await deleteTpv(VENUE, TPV)

    expect(prismaMock.order.count).toHaveBeenCalledWith({ where: { terminalId: TPV } })
    expect(prismaMock.payment.count).toHaveBeenCalledWith({ where: { terminalId: TPV } })
  })

  it('sigue rechazando una terminal que no pertenece al venue', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)

    await expect(deleteTpv(VENUE, TPV)).rejects.toThrow()
    expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
  })
})
