/**
 * hz:nube0000:na7ab987: el controlador de `pay-in` / `pay-out` le pasa al servicio el `staffId` del cuerpo (quien hizo el
 * movimiento en el aparato) y el `sid` de la sesión que sube; quién firma lo decide el servicio (`autorDelMovimiento`).
 */
const mockPayIn = jest.fn()
const mockPayOut = jest.fn()
jest.mock('@/services/mobile/cash-drawer.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/cash-drawer.mobile.service'),
  payIn: (...a: unknown[]) => mockPayIn(...a),
  payOut: (...a: unknown[]) => mockPayOut(...a),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { payIn, payOut } from '@/controllers/mobile/cash-drawer.mobile.controller'

const llamar = async (handler: typeof payIn, body: Record<string, unknown>) => {
  const req: any = { params: { venueId: 'v1' }, body, authContext: { userId: 'beto', venueId: 'v1', sid: 'ses-beto' } }
  const res: any = { status: () => res, json: () => res }
  await handler(req, res, () => {})
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPayIn.mockResolvedValue({ event: { id: 'e1' }, created: true, authorizedBy: null })
  mockPayOut.mockResolvedValue({ event: { id: 'e1' }, created: true, authorizedBy: null })
})

it.each([
  ['pay-in', payIn, mockPayIn],
  ['pay-out', payOut, mockPayOut],
])('%s: pasa el autor del aparato y el sid; la sesión sigue en staffId', async (_ruta, handler, servicio) => {
  await llamar(handler, { amount: 50, localId: 'loc-1', staffId: 'ana' })
  expect(servicio).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'beto', autorDelAparato: 'ana', sid: 'ses-beto' }))
})
