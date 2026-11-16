/**
 * Encargo 921513 (hz:e5ee98bc:D14, founder 16-nov «A»): el retiro (o ingreso) hecho sin internet a las 20:03 quedaba en el servidor a
 * las 20:11:42, la hora en que SUBIÓ (ensayo general, escenario 14b). El POS manda ahora su hora (`createdAt`, ISO) y el servidor la
 * guarda acotada a la vida de SU caja `[openedAt, closedAt ?? llegada]`, la misma regla que ya usa `/cash-drawer/sync`. Sin hora, como
 * siempre (la base pone la de hoy).
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { payIn, payOut } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const ABIERTA = new Date('2026-11-12T01:00:00.000Z')
const VEINTE_03 = '2026-11-12T02:03:00.000Z'

let guardadas: any[]
function caja(sesion: { status: string; closedAt: Date | null; actualAmount?: unknown }) {
  guardadas = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-1', venueId: VENUE, openedAt: ABIERTA, ...sesion })
  prismaMock.cashDrawerSession.findUnique.mockResolvedValue({ actualAmount: null, overShort: null, startingAmount: 0, events: [] })
  prismaMock.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.cashDrawerEvent.createMany.mockImplementation(async ({ data }: any) => {
    guardadas.push(...data)
    return { count: data.length }
  })
  prismaMock.cashDrawerEvent.create.mockImplementation(async ({ data }: any) => {
    guardadas.push(data)
    return { id: 'ev-1', createdAt: new Date(), ...data }
  })
  prismaMock.cashDrawerEvent.findFirst.mockImplementation(async () => ({ id: 'ev-1', createdAt: new Date(), ...guardadas.at(-1) }))
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
}

const retiro = (extra: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: 'staff-1',
  staffName: 'Ana',
  amount: 50,
  localId: 'retiro-local-1',
  sessionId: 'caja-1',
  ...extra,
})

describe('ingreso y retiro sin red — la hora real del movimiento', () => {
  beforeEach(() => jest.clearAllMocks())

  it('P1 el retiro de las 20:03 que sube a las 20:11 queda a las 20:03', async () => {
    caja({ status: 'OPEN', closedAt: null })
    await payOut(retiro({ createdAt: VEINTE_03 }))
    expect(guardadas[0].createdAt).toEqual(new Date(VEINTE_03))
  })

  it('P1 el ingreso también, y acepta epoch ms', async () => {
    caja({ status: 'OPEN', closedAt: null })
    await payIn(retiro({ createdAt: new Date(VEINTE_03).getTime() }))
    expect(guardadas[0].createdAt).toEqual(new Date(VEINTE_03))
  })

  it('P1 reloj atrasado: nunca antes de abrir su caja', async () => {
    caja({ status: 'OPEN', closedAt: null })
    await payOut(retiro({ createdAt: '2026-11-11T12:00:00.000Z' }))
    expect(guardadas[0].createdAt).toEqual(ABIERTA)
  })

  it('P1 reloj adelantado: nunca en el futuro', async () => {
    caja({ status: 'OPEN', closedAt: null })
    const antes = Date.now()
    await payOut(retiro({ createdAt: new Date(Date.now() + 3_600_000).toISOString() }))
    expect(guardadas[0].createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(guardadas[0].createdAt.getTime()).toBeGreaterThanOrEqual(antes)
  })

  it('P1 caja ya cerrada (llega tarde): nunca detrás de su corte', async () => {
    const cierre = new Date('2026-11-12T02:05:00.000Z')
    caja({ status: 'CLOSED', closedAt: cierre })
    await payOut(retiro({ createdAt: '2026-11-12T02:09:00.000Z' }))
    expect(guardadas[0].createdAt).toEqual(cierre)
  })

  it('P1 Codex r2: reloj del aparato 1 h adelantado, con la espera medida: queda a la hora real (llegada − espera)', async () => {
    caja({ status: 'OPEN', closedAt: null })
    const antes = Date.now()
    await payOut(retiro({ createdAt: new Date(antes + 3_600_000).toISOString(), edadMs: 5 * 60_000 }))
    const guardada = guardadas[0].createdAt.getTime()
    expect(guardada).toBeGreaterThanOrEqual(antes - 5 * 60_000)
    expect(guardada).toBeLessThanOrEqual(Date.now() - 5 * 60_000)
  })

  it('regresión: sin hora (app vieja), el movimiento no lleva createdAt, como siempre', async () => {
    caja({ status: 'OPEN', closedAt: null })
    await payOut(retiro())
    expect(guardadas[0]).not.toHaveProperty('createdAt')
  })

  it('regresión: sin llave (petición a mano) no se fecha: la caja cerrada relee el último movimiento por hora', async () => {
    caja({ status: 'CLOSED', closedAt: new Date('2026-11-12T02:05:00.000Z') })
    await payOut(retiro({ localId: undefined, createdAt: VEINTE_03 }))
    expect(guardadas[0]).not.toHaveProperty('createdAt')
  })

  it('regresión: una hora ilegible no tumba el retiro (el dinero ya salió): queda sin hora propia', async () => {
    caja({ status: 'OPEN', closedAt: null })
    await expect(payOut(retiro({ createdAt: 'ayer en la tarde' }))).resolves.toBeDefined()
    expect(guardadas[0]).not.toHaveProperty('createdAt')
  })
})
