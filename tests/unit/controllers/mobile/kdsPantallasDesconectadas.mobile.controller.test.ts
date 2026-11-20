/**
 * D6 de Flautas (opción B): el tablero de una pantalla con estación la marca viva en memoria (sin otra consulta que pueda
 * tumbarlo); lo que lee el vigilante de reparto (sin estación) no cuenta. La caja lee qué pantallas no están conectadas.
 */
const mockListar = jest.fn()
const mockContar = jest.fn()
jest.mock('@/services/mobile/kds.mobile.service', () => ({
  KDS_LIST_MAX: 100,
  listKdsOrders: (...a: unknown[]) => mockListar(...a),
  countKdsOrders: (...a: unknown[]) => mockContar(...a),
}))
const mockDesconectadas = jest.fn()
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  pantallasDesconectadas: (...a: unknown[]) => mockDesconectadas(...a),
}))

import prisma from '@/utils/prismaClient'
import { listKdsOrders, listarPantallasDesconectadas } from '@/controllers/mobile/kds.mobile.controller'
import { olvidarPantallas, pantallasConectadas } from '@/services/kds/pantallasVivas'

const conectadas = () => pantallasConectadas('venue-1').conectadas

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  r.setHeader = jest.fn()
  return r
}
const req = (query: Record<string, string>) => ({ params: { venueId: 'venue-1' }, query }) as any

beforeEach(() => {
  olvidarPantallas()
  jest.clearAllMocks()
  mockListar.mockReset().mockResolvedValue([])
  mockContar.mockReset().mockResolvedValue(0)
})

it('el tablero de una estación marca viva a su pantalla, sin ninguna consulta de más', async () => {
  const r = res()

  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), r, jest.fn())

  expect(r.status).toHaveBeenCalledWith(200)
  expect(conectadas()).toEqual(['st_cocina'])
  expect(prisma.printStation.findFirst).not.toHaveBeenCalled()
  expect(prisma.printStation.findMany).not.toHaveBeenCalled()
})

it('la lectura sin estación (el vigilante de reparto, apps viejas) no marca a nadie', async () => {
  await listKdsOrders(req({ status: 'NEW,PREPARING,READY' }), res(), jest.fn())

  expect(conectadas()).toEqual([])
})

it('si el tablero no se pudo leer, la pantalla no cuenta como conectada', async () => {
  mockListar.mockRejectedValue(new Error('base caída'))

  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), res(), jest.fn())

  expect(conectadas()).toEqual([])
})

it('la caja lee las pantallas desconectadas de su negocio', async () => {
  const data = { hayPantallas: true, completo: true, desconectadas: [{ id: 'st_cocina', name: 'COCINA 1' }] }
  mockDesconectadas.mockResolvedValue(data)
  const r = res()

  await listarPantallasDesconectadas({ params: { venueId: 'venue-1' } } as any, r, jest.fn())

  expect(mockDesconectadas).toHaveBeenCalledWith('venue-1')
  expect(r.status).toHaveBeenCalledWith(200)
  expect(r.json).toHaveBeenCalledWith({ success: true, data })
})

it('si no se pudo leer la lista, responde error (la caja no afirma nada)', async () => {
  mockDesconectadas.mockRejectedValue(new Error('base caída'))
  const next = jest.fn()

  await listarPantallasDesconectadas({ params: { venueId: 'venue-1' } } as any, res(), next)

  expect(next).toHaveBeenCalledWith(expect.any(Error))
})
