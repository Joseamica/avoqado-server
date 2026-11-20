/**
 * D6 de Flautas (opción B): el tablero de una pantalla con estación registra su lectura (sin esperarla ni poder tumbar el
 * tablero); lo que lee el vigilante de reparto (sin estación) no cuenta. La caja lee qué pantallas no están conectadas, y esa
 * ruta nunca contesta 5xx (la caja lo tomaría como «servidor caído»).
 */
const mockListar = jest.fn()
const mockContar = jest.fn()
jest.mock('@/services/mobile/kds.mobile.service', () => ({
  KDS_LIST_MAX: 100,
  listKdsOrders: (...a: unknown[]) => mockListar(...a),
  countKdsOrders: (...a: unknown[]) => mockContar(...a),
}))
const mockDesconectadas = jest.fn()
const mockRegistrar = jest.fn()
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  pantallasDesconectadas: (...a: unknown[]) => mockDesconectadas(...a),
  registrarLecturaDelTablero: (...a: unknown[]) => mockRegistrar(...a),
}))

import { listKdsOrders, listarPantallasDesconectadas } from '@/controllers/mobile/kds.mobile.controller'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  r.setHeader = jest.fn()
  return r
}
const req = (query: Record<string, string>) => ({ params: { venueId: 'venue-1' }, query }) as any

beforeEach(() => {
  jest.clearAllMocks()
  mockListar.mockReset().mockResolvedValue([])
  mockContar.mockReset().mockResolvedValue(0)
})

it('el tablero de una estación registra la lectura de su pantalla', async () => {
  const r = res()

  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), r, jest.fn())

  expect(r.status).toHaveBeenCalledWith(200)
  expect(mockRegistrar).toHaveBeenCalledWith('venue-1', 'st_cocina')
})

it('la lectura sin estación (el vigilante de reparto, apps viejas) no registra nada', async () => {
  await listKdsOrders(req({ status: 'NEW,PREPARING,READY' }), res(), jest.fn())

  expect(mockRegistrar).not.toHaveBeenCalled()
})

it('si el tablero no se pudo leer, la pantalla no cuenta como conectada', async () => {
  mockListar.mockRejectedValue(new Error('base caída'))

  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), res(), jest.fn())

  expect(mockRegistrar).not.toHaveBeenCalled()
})

it('la caja lee las pantallas desconectadas de su negocio', async () => {
  const data = { hayPantallas: true, pantallas: ['st_cocina'], completo: true, desconectadas: [{ id: 'st_cocina', name: 'COCINA 1' }] }
  mockDesconectadas.mockResolvedValue(data)
  const r = res()

  await listarPantallasDesconectadas({ params: { venueId: 'venue-1' } } as any, r)

  expect(mockDesconectadas).toHaveBeenCalledWith('venue-1')
  expect(r.status).toHaveBeenCalledWith(200)
  expect(r.json).toHaveBeenCalledWith({ success: true, data })
})

it('Codex r8 #2: si no se pudo leer la lista contesta 200 «no se sabe», nunca 5xx', async () => {
  mockDesconectadas.mockRejectedValue(new Error('base caída'))
  const r = res()

  await listarPantallasDesconectadas({ params: { venueId: 'venue-1' } } as any, r)

  expect(r.status).toHaveBeenCalledWith(200)
  expect(r.json).toHaveBeenCalledWith({ success: true, data: { hayPantallas: true, completo: false, desconectadas: [] } })
})
