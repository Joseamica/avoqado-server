/**
 * `POST /mobile/venues/:venueId/cash-drawer/open` — el contrato ADITIVO de la apertura reproducida
 * desde la cola offline (N1 de la Task 8b, 5-sep-2026): `localId` (llave idempotente) y `openedAt`
 * (la hora REAL a la que el aparato abrió la caja, no la del replay).
 *
 * Aquí se fija la FRONTERA del servicio móvil: qué se valida antes de tocar la base (400 explícito,
 * nunca un 500 desde el índice ni un `Invalid Date` en Postgres), qué se le pasa a
 * `abrirTurnoDeCaja` ya tipado, y qué ECHO devuelve la respuesta para que la app pueda reconocer su
 * propia apertura. La lógica de dinero (acotar la hora, deduplicar por llave) tiene sus pruebas en
 * `tests/unit/services/shared/abrirTurnoDeCaja.{horaReal,llaveIdempotente}.test.ts`.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  getSocketServer: jest.fn(() => null),
  emitToVenue: jest.fn(),
}))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  abrirTurnoDeCaja: jest.fn(),
  cerrarTurnoDeCaja: jest.fn(),
  turnoAbiertoDelNegocio: jest.fn(),
}))

import { openSession } from '@/services/mobile/cash-drawer.mobile.service'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { BadRequestError } from '@/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-llave'
const LLAVE = '5c3d1d2e-0b6a-4a1e-9f0e-6a1f6d3d9a11'
const ABRIO_A_LAS = new Date('2026-09-05T16:22:00.000Z')

function sesionDelServidor(localIdDelOpen: string | null = LLAVE) {
  return {
    id: 'cds-servidor',
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: 500,
    openedAt: ABRIO_A_LAS,
    openedByStaffId: 'staff-yo',
    openedByName: 'Yo Cajero',
    deviceName: 'samsung SM-X133',
    closedAt: null,
    expectedAmount: null,
    actualAmount: null,
    events: [
      {
        id: 'ev-open',
        sessionId: 'cds-servidor',
        type: 'OPEN',
        amount: 500,
        note: 'Caja abierta con $500',
        staffId: 'staff-yo',
        staffName: 'Yo Cajero',
        orderId: null,
        localId: localIdDelOpen,
        createdAt: ABRIO_A_LAS,
      },
    ],
  }
}

function abrirDevuelve(over: Record<string, unknown> = {}) {
  ;(abrirTurnoDeCaja as jest.Mock).mockResolvedValue({
    shiftId: 'shift-1',
    cashDrawerSessionId: 'cds-servidor',
    cajaCreada: true,
    shiftCreado: true,
    localId: LLAVE,
    reintento: false,
    staffName: 'Yo Cajero',
    fondoAplicado: '500',
    ...over,
  })
}

const base = { venueId: VENUE, staffId: 'staff-yo', staffName: 'Yo Cajero', startingAmount: 500, deviceName: 'samsung SM-X133' }

describe('POST /cash-drawer/open — localId y openedAt en la frontera del servicio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession.findUnique = jest.fn().mockResolvedValue(sesionDelServidor())
    abrirDevuelve()
  })

  it('pasa la llave y la hora (ya como Date) a abrirTurnoDeCaja', async () => {
    await openSession({ ...base, localId: LLAVE, openedAt: ABRIO_A_LAS.toISOString() })

    expect(abrirTurnoDeCaja).toHaveBeenCalledWith(expect.objectContaining({ localId: LLAVE, openedAt: ABRIO_A_LAS, source: 'CAJA_MOVIL' }))
  })

  it('openedAt también se acepta como epoch en milisegundos (lo que un reloj de Android tiene a mano)', async () => {
    await openSession({ ...base, openedAt: ABRIO_A_LAS.getTime() })

    expect(abrirTurnoDeCaja).toHaveBeenCalledWith(expect.objectContaining({ openedAt: ABRIO_A_LAS }))
  })

  it('🔴 una llave basura ⇒ 400 ANTES de abrir (la misma regla que pay-in/pay-out)', async () => {
    await expect(openSession({ ...base, localId: '   ' })).rejects.toBeInstanceOf(BadRequestError)
    await expect(openSession({ ...base, localId: 'x'.repeat(65) })).rejects.toBeInstanceOf(BadRequestError)
    expect(abrirTurnoDeCaja).not.toHaveBeenCalled()
  })

  it('🔴 una hora ilegible ⇒ 400 ANTES de abrir, nunca un `Invalid Date` camino a Postgres', async () => {
    await expect(openSession({ ...base, openedAt: 'ayer a las diez' })).rejects.toMatchObject({
      constructor: BadRequestError,
      message: expect.stringContaining('openedAt'),
    })
    await expect(openSession({ ...base, openedAt: true as unknown as string })).rejects.toBeInstanceOf(BadRequestError)
    await expect(openSession({ ...base, openedAt: Number.NaN })).rejects.toBeInstanceOf(BadRequestError)
    expect(abrirTurnoDeCaja).not.toHaveBeenCalled()
  })

  it('la respuesta hace ECHO de la llave del evento OPEN y dice si fue reintento', async () => {
    const r = await openSession({ ...base, localId: LLAVE, openedAt: ABRIO_A_LAS.toISOString() })

    expect(r.localId).toBe(LLAVE)
    expect(r.reintento).toBe(false)
    // Y la sesión que devuelve trae la hora REAL: es la que la app usa como ventana de su caja.
    expect(r.openedAt).toBe(ABRIO_A_LAS.toISOString())
  })

  it('en un reintento la respuesta lo dice, con la misma caja', async () => {
    abrirDevuelve({ reintento: true, shiftCreado: false })

    const r = await openSession({ ...base, localId: LLAVE })

    expect(r.reintento).toBe(true)
    expect(r.cajaCreada).toBe(true)
    expect(r.id).toBe('cds-servidor')
  })

  it('cuando el servidor LIGÓ a la caja de OTRO aparato, el echo trae la llave de ESA apertura, no la mía', async () => {
    // Es lo que le permite a la app saber que NO es su caja aunque coincidan modelo, cuenta y fondo.
    ;(prismaMock as any).cashDrawerSession.findUnique = jest.fn().mockResolvedValue(sesionDelServidor('llave-de-la-otra-tablet'))
    abrirDevuelve({ cajaCreada: false, localId: 'llave-de-la-otra-tablet' })

    const r = await openSession({ ...base, localId: LLAVE })

    expect(r.cajaCreada).toBe(false)
    expect(r.localId).toBe('llave-de-la-otra-tablet')
  })

  it('REGRESIÓN — sin llave ni hora: abrirTurnoDeCaja recibe null en ambos y la respuesta conserva el contrato viejo', async () => {
    ;(prismaMock as any).cashDrawerSession.findUnique = jest.fn().mockResolvedValue(sesionDelServidor(null))
    abrirDevuelve({ localId: null })

    const r = await openSession(base)

    expect(abrirTurnoDeCaja).toHaveBeenCalledWith(expect.objectContaining({ localId: null, openedAt: null }))
    expect(r).toEqual(
      expect.objectContaining({
        id: 'cds-servidor',
        status: 'OPEN',
        shiftId: 'shift-1',
        cajaCreada: true,
        shiftCreado: true,
        openedAt: ABRIO_A_LAS.toISOString(),
        localId: null,
        reintento: false,
      }),
    )
  })
})
