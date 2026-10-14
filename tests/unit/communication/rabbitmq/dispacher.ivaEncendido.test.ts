/**
 * Plan 6b (spec §5.4): con el IVA por producto encendido, NINGÚN evento del POS externo escribe; el rechazo deja `warn` siempre y una
 * fila de ActivityLog por negocio por hora (el latido llega cada minuto); el despachador termina sin lanzar ⇒ el consumidor hace ACK.
 */
const mockFlag = jest.fn()
const mockLog = jest.fn().mockResolvedValue(undefined)
const mockOrder = jest.fn()
const handlers = {
  processPosOrderItemEvent: jest.fn(),
  processPosStaffEvent: jest.fn(),
  processPosShiftEvent: jest.fn(),
  processPosAreaEvent: jest.fn(),
  processPosHeartbeat: jest.fn(),
}
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueIvaPorProducto: { findUnique: (...a: unknown[]) => mockFlag(...a) } },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLog(...a) }))
jest.mock('@/services/pos-sync/posSync.service', () => ({ posSyncService: handlers }))
jest.mock('@/services/pos-sync/posSyncOrder.service', () => ({
  processPosOrderEvent: (...a: unknown[]) => mockOrder(...a),
  processPosOrderDeleteEvent: jest.fn(),
}))

import { dispatchPosEvent } from '@/communication/rabbitmq/dispacher'
import { olvidarRechazos, PosRechazadoPorIva } from '@/services/pos-sync/exclusionIva'

beforeEach(() => {
  jest.clearAllMocks()
  olvidarRechazos()
})

it('encendido: ni la orden ni el latido escriben, y el despachador termina (ACK)', async () => {
  mockFlag.mockResolvedValue({ venueId: 'v1' })
  await expect(dispatchPosEvent('pos.softrestaurant.order.created', { venueId: 'v1' })).resolves.toBeUndefined()
  await expect(dispatchPosEvent('pos.softrestaurant.system.heartbeat', { venueId: 'v1' })).resolves.toBeUndefined()
  expect(mockOrder).not.toHaveBeenCalled()
  expect(handlers.processPosHeartbeat).not.toHaveBeenCalled()
})

it('60 latidos en una hora ⇒ UNA fila de ActivityLog; pasada la hora, otra', async () => {
  mockFlag.mockResolvedValue({ venueId: 'v1' })
  const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  for (let i = 0; i < 60; i++) await dispatchPosEvent('pos.softrestaurant.system.heartbeat', { venueId: 'v1' })
  expect(mockLog).toHaveBeenCalledTimes(1)
  expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', action: 'POS_EXTERNO_RECHAZADO_POR_IVA' }))
  ahora.mockReturnValue(1_000_000 + 60 * 60 * 1000 + 1)
  await dispatchPosEvent('pos.softrestaurant.system.heartbeat', { venueId: 'v1' })
  expect(mockLog).toHaveBeenCalledTimes(2)
  ahora.mockRestore()
})

it('apagado: todo sigue como hoy', async () => {
  mockFlag.mockResolvedValue(null)
  await dispatchPosEvent('pos.softrestaurant.staff.created', { venueId: 'v1' })
  expect(handlers.processPosStaffEvent).toHaveBeenCalledTimes(1)
  expect(mockLog).not.toHaveBeenCalled()
})

it('la carrera: la transacción de la orden ve la bandera ⇒ ACK y rastro, sin cola muerta', async () => {
  mockFlag.mockResolvedValueOnce(null)
  mockOrder.mockRejectedValueOnce(new PosRechazadoPorIva('v1'))
  await expect(dispatchPosEvent('pos.softrestaurant.order.updated', { venueId: 'v1' })).resolves.toBeUndefined()
  expect(mockLog).toHaveBeenCalledTimes(1)
})

it('cualquier otro error sigue lanzando (cola muerta, como hoy)', async () => {
  mockFlag.mockResolvedValue(null)
  mockOrder.mockRejectedValueOnce(new Error('otra cosa'))
  await expect(dispatchPosEvent('pos.softrestaurant.order.created', { venueId: 'v1' })).rejects.toThrow('otra cosa')
})
