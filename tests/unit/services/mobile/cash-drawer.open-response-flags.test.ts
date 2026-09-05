/**
 * `POST /mobile/venues/:venueId/cash-drawer/open` — la respuesta DICE si la caja se creó o se LIGÓ.
 *
 * Desde el turno de caja del negocio, `abrirTurnoDeCaja` ya no rebota cuando hay una caja abierta:
 * LIGA y devuelve la EXISTENTE con 201. Ese 201 le llegaba al POS idéntico al de una caja nueva, así
 * que el aparato leía «abriste» cuando en realidad adoptó la caja de otro — el fondo tecleado se
 * perdía en silencio y los movimientos encolados iban al arqueo ajeno (C1 de la revisión de 8b y
 * P1 #1 de la auditoría de apps, 2026-09-04). El servidor SIEMPRE supo la diferencia
 * (`AbrirTurnoDeCajaResult.cajaCreada`); estas pruebas fijan que ahora la devuelve. Campos ADITIVOS:
 * los clientes viejos los ignoran.
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
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-flags'
const ABIERTA_A_LAS = new Date('2026-09-04T13:00:00.000Z')

function sesionDelServidor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cds-servidor',
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: 500,
    openedAt: ABIERTA_A_LAS,
    openedByStaffId: 'staff-otro',
    openedByName: 'Ana Pérez',
    deviceName: 'SM-X133',
    closedAt: null,
    expectedAmount: null,
    actualAmount: null,
    events: [],
    ...overrides,
  }
}

function abrirDevuelve(flags: { cajaCreada: boolean; shiftCreado: boolean }) {
  ;(abrirTurnoDeCaja as jest.Mock).mockResolvedValue({
    shiftId: 'shift-1',
    cashDrawerSessionId: 'cds-servidor',
    ...flags,
  })
}

describe('POST /cash-drawer/open — cajaCreada / shiftCreado en la respuesta (P1: la adopción ya no es invisible)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession.findUnique = jest.fn().mockResolvedValue(sesionDelServidor())
  })

  it('P1 — cuando el servidor LIGÓ una caja ya abierta, la respuesta trae cajaCreada:false (el POS no puede leer «abriste»)', async () => {
    abrirDevuelve({ cajaCreada: false, shiftCreado: true })
    const r = await openSession({ venueId: VENUE, staffId: 'staff-yo', startingAmount: 2000, deviceName: 'Tablet-2' })
    expect(r.cajaCreada).toBe(false)
    expect(r.shiftCreado).toBe(true)
    // Y devuelve la caja EXISTENTE, no una con el fondo que se tecleó: es lo que el aparato debe mostrar.
    expect(r.id).toBe('cds-servidor')
    expect(r.startingAmount).toBe(500)
    expect(r.openedByName).toBe('Ana Pérez')
  })

  it('P1 — cuando la caja es nueva, cajaCreada:true (y el turno puede haberse ligado a uno ya abierto)', async () => {
    abrirDevuelve({ cajaCreada: true, shiftCreado: false })
    const r = await openSession({ venueId: VENUE, staffId: 'staff-yo', startingAmount: 500, deviceName: 'SM-X133' })
    expect(r.cajaCreada).toBe(true)
    expect(r.shiftCreado).toBe(false)
  })

  it('REGRESIÓN — el contrato anterior se conserva: shiftId y los campos de la sesión siguen ahí, sin renombrar', async () => {
    abrirDevuelve({ cajaCreada: true, shiftCreado: true })
    const r = await openSession({ venueId: VENUE, staffId: 'staff-yo', startingAmount: 500, deviceName: 'SM-X133' })
    expect(r.shiftId).toBe('shift-1')
    expect(r).toEqual(
      expect.objectContaining({
        id: 'cds-servidor',
        status: 'OPEN',
        openedByName: 'Ana Pérez',
        deviceName: 'SM-X133',
        openedAt: ABIERTA_A_LAS.toISOString(),
      }),
    )
  })

  it('REGRESIÓN — un fondo negativo sigue rechazándose ANTES de llamar a abrirTurnoDeCaja', async () => {
    await expect(openSession({ venueId: VENUE, staffId: 'staff-yo', startingAmount: -1, deviceName: 'x' })).rejects.toThrow(
      'El monto inicial no puede ser negativo',
    )
    expect(abrirTurnoDeCaja).not.toHaveBeenCalled()
  })
})
