/**
 * P1 (Codex, 2ª auditoría): el PAY_IN/PAY_OUT manual se colaba en una caja que el cierre acababa de
 * firmar (leía la sesión y luego insertaba sin candado). Ahora el insert va DENTRO de una transacción
 * que primero toca la fila con status='OPEN'; si el cierre ganó, el movimiento se rechaza con el
 * mismo 404 que las apps ya conocen. Y el cierre con `sessionId` de una caja que ya no es la abierta
 * NO cierra la ajena.
 */
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import { payOut, closeSession } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  ;(prismaMock as any).staff = { findUnique: jest.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'M' }) }
})

describe('movimiento manual bajo candado', () => {
  it('🔴 si la caja se cerró entre leerla e insertar, el retiro se rechaza (404) y NO se escribe', async () => {
    ;(prismaMock as any).cashDrawerSession = { update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ id: 's-1', venueId: VENUE, status: 'OPEN' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }), // el cierre ganó
    }
    ;(prismaMock as any).cashDrawerEvent = { create: jest.fn(), createMany: jest.fn(), findFirst: jest.fn() }
    await expect(payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 100, note: null })).rejects.toMatchObject({ statusCode: 404 })
    expect((prismaMock as any).cashDrawerEvent.create).not.toHaveBeenCalled()
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })
  it('con la caja abierta el candado se toma con status=OPEN y luego se inserta', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    ;(prismaMock as any).cashDrawerSession = { update: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue({ id: 's-1', venueId: VENUE, status: 'OPEN' }), updateMany }
    const create = jest.fn().mockResolvedValue({ id: 'e-1', sessionId: 's-1', venueId: VENUE, type: 'PAY_OUT', amount: 100, staffId: 'st', staffName: 'Ana', note: null, createdAt: new Date(), localId: null, orderId: null })
    ;(prismaMock as any).cashDrawerEvent = { create, createMany: jest.fn(), findFirst: jest.fn() }
    await payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 100, note: null })
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's-1', status: 'OPEN' } }))
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0])
  })
})

describe('cierre encolado con sessionId', () => {
  it('🔴 si la caja abierta ahora es OTRA, no se cierra con el conteo de la vieja: 404', async () => {
    ;(prismaMock as any).cashDrawerSession = { update: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue({ id: 's-2' }), updateMany: jest.fn() }
    await expect(closeSession({ venueId: VENUE, staffId: 'st', staffName: 'Ana', actualAmount: 300, sessionId: 's-1' })).rejects.toMatchObject({ statusCode: 404 })
    expect((prismaMock as any).cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })
})
