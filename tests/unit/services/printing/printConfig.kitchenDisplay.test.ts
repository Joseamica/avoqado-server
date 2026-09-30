/**
 * La caja decide qué estaciones son «sólo pantalla» con la print-config (spec 2026-09-27 §2 y §5). El
 * `hasKitchenDisplay` que recibe es EFECTIVO: casilla Y estación activa Y plan vigente. Si el negocio baja de plan,
 * la caja vuelve a imprimir esas estaciones mientras el servidor sigue armando (traslape, nunca hueco).
 */
const planMock = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: (...a: unknown[]) => planMock(...a) }))

import { prismaMock } from '../../../__helpers__/setup'
import { buildPrintConfig } from '@/services/printing/printConfig.service'

const estacion = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  printerId: null,
  copies: 1,
  isDefault: false,
  isPacking: false,
  hasKitchenDisplay: false,
  active: true,
  displayOrder: 0,
  ...extra,
})

function seed(stations: unknown[]) {
  prismaMock.printGateway.findUnique.mockResolvedValue(null)
  prismaMock.printer.findMany.mockResolvedValue([])
  prismaMock.printStation.findMany.mockResolvedValue(stations as any)
  prismaMock.menuCategory.findMany.mockResolvedValue([])
  prismaMock.product.findMany.mockResolvedValue([])
}

beforeEach(() => jest.clearAllMocks())

it('con Pro, la estación con pantalla llega marcada; una apagada o inactiva no', async () => {
  seed([estacion('cocina', { hasKitchenDisplay: true }), estacion('barra'), estacion('vieja', { hasKitchenDisplay: true, active: false })])
  planMock.mockResolvedValue(true)
  const c = await buildPrintConfig('v1')
  expect(c.stations.map(s => [s.id, s.hasKitchenDisplay])).toEqual([
    ['cocina', true],
    ['barra', false],
    ['vieja', false],
  ])
  expect(c.kitchenDisplayOpenToClients).toBe(false)
})

it('sin Pro, la casilla sigue en la base pero la caja la ve apagada — y la versión cambia para que refresque', async () => {
  seed([estacion('cocina', { hasKitchenDisplay: true })])
  planMock.mockResolvedValue(true)
  const conPlan = await buildPrintConfig('v1')
  planMock.mockResolvedValue(false)
  const sinPlan = await buildPrintConfig('v1')
  expect(sinPlan.stations[0].hasKitchenDisplay).toBe(false)
  expect(sinPlan.version).not.toBe(conPlan.version)
})

it('sin ninguna estación con pantalla ni se consulta el plan', async () => {
  seed([estacion('cocina')])
  await buildPrintConfig('v1')
  expect(planMock).not.toHaveBeenCalled()
})
