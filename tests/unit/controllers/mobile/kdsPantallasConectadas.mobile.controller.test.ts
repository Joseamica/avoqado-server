/**
 * D6 de Flautas (opción B): el tablero de una pantalla con estación la marca viva; lo que lee el vigilante de reparto (sin
 * estación) no cuenta. La caja lee la lista de conectadas de su negocio.
 */
const mockListar = jest.fn()
const mockContar = jest.fn()
jest.mock('@/services/mobile/kds.mobile.service', () => ({
  KDS_LIST_MAX: 100,
  listKdsOrders: (...a: unknown[]) => mockListar(...a),
  countKdsOrders: (...a: unknown[]) => mockContar(...a),
}))

import prisma from '@/utils/prismaClient'
import { listKdsOrders, listarPantallasConectadas } from '@/controllers/mobile/kds.mobile.controller'
import { olvidarPantallas, pantallasConectadas } from '@/services/kds/pantallasVivas'

/** La estación existe, es de este negocio, está activa y tiene pantalla. */
const estacionConPantalla = (si: boolean) => (prisma.printStation.findFirst as jest.Mock).mockResolvedValue(si ? { id: 'st_cocina' } : null)
const conectadas = () => pantallasConectadas('venue-1').conectadas
/** La marca corre sin que la respuesta la espere: se dejan correr las promesas pendientes. */
const sinPendientes = () => new Promise(resolve => setImmediate(resolve))

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
  estacionConPantalla(true)
  mockListar.mockReset().mockResolvedValue([])
  mockContar.mockReset().mockResolvedValue(0)
})

it('el tablero de una estación marca viva a su pantalla', async () => {
  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), res(), jest.fn())
  await sinPendientes()

  expect(conectadas()).toEqual(['st_cocina'])
  expect((prisma.printStation.findFirst as jest.Mock).mock.calls.at(-1)[0].where).toEqual({
    id: 'st_cocina',
    venueId: 'venue-1',
    active: true,
    hasKitchenDisplay: true,
  })
})

it('Codex r5 #6: un id que no es una estación activa con pantalla de este negocio no marca nada', async () => {
  estacionConPantalla(false)

  await listKdsOrders(req({ stationId: 'st_ajena', urgencyVersion: '1' }), res(), jest.fn())
  await sinPendientes()

  expect(conectadas()).toEqual([])
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

it('Codex r6 #6: si falla la consulta de la estación, el tablero contesta igual y no marca nada', async () => {
  ;(prisma.printStation.findFirst as jest.Mock).mockRejectedValue(new Error('base lenta'))
  const r = res()

  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), r, jest.fn())
  await sinPendientes()

  expect(r.status).toHaveBeenCalledWith(200)
  expect(conectadas()).toEqual([])
})

it('la caja lee las pantallas conectadas de su negocio', async () => {
  await listKdsOrders(req({ stationId: 'st_cocina', urgencyVersion: '1' }), res(), jest.fn())
  await sinPendientes()
  const r = res()

  await listarPantallasConectadas({ params: { venueId: 'venue-1' } } as any, r, jest.fn())

  expect(r.status).toHaveBeenCalledWith(200)
  expect(r.json).toHaveBeenCalledWith({ success: true, data: { conectadas: ['st_cocina'], completo: expect.any(Boolean) } })
})
