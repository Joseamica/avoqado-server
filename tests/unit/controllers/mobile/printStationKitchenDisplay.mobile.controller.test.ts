/** La casilla desde la tablet usa el MISMO servicio que el dashboard, con quien la cambió. */
const mockSet = jest.fn()
jest.mock('@/services/dashboard/printStation.dashboard.service', () => ({ setKitchenDisplay: (...a: unknown[]) => mockSet(...a) }))
jest.mock('@/services/mobile/print.mobile.service', () => ({}))

import { setStationKitchenDisplay } from '@/controllers/mobile/print.mobile.controller'
import { ForbiddenError } from '@/errors/AppError'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const req = (enabled: boolean) =>
  ({ params: { venueId: 'v1', stationId: 's1' }, body: { enabled }, authContext: { userId: 'staff-1' } }) as any

beforeEach(() => mockSet.mockReset())

it('apaga con el mismo servicio del dashboard y quien lo hizo', async () => {
  mockSet.mockResolvedValue({ id: 's1', hasKitchenDisplay: false })
  const r = res()
  await setStationKitchenDisplay(req(false), r, jest.fn())
  expect(mockSet).toHaveBeenCalledWith('v1', 's1', false, 'staff-1')
  expect(r.status).toHaveBeenCalledWith(200)
})

it('si el servicio niega prender, el error sigue a Express (403 con su mensaje)', async () => {
  const error = new ForbiddenError('La pantalla de cocina todavía no está disponible para clientes.', 'KITCHEN_DISPLAY_NOT_RELEASED')
  mockSet.mockRejectedValue(error)
  const next = jest.fn()
  await setStationKitchenDisplay(req(true), res(), next)
  expect(next).toHaveBeenCalledWith(error)
})
