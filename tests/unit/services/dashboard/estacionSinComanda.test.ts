/**
 * Estación «No lleva comanda» (plan 2026-11-10, Task 1, tras Codex r3). `sendsComanda` se elige SÓLO al crear y nunca
 * cambia: una estación sin comanda no tiene impresora, empaque, pantalla ni es la predeterminada. El SERVIDOR lo rechaza al
 * escribir y lo vuelve a imponer al leer (print-config), para que una fila mezclada nunca imprima.
 */
jest.mock('@/services/kds/kitchenDisplayRelease', () => ({ PANTALLA_ABIERTA_A_CLIENTES: true }))
jest.mock('@/mcp/scope', () => ({ isActiveSuperAdmin: jest.fn().mockResolvedValue(false) }))
const planMock = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: (...a: unknown[]) => planMock(...a) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { createStation, setKitchenDisplay, updateStation } from '@/services/dashboard/printStation.dashboard.service'
import { buildPrintConfig, esSinComanda } from '@/services/printing/printConfig.service'
import { createStationSchema, updateStationSchema } from '@/schemas/dashboard/printStation.schema'

const V = 'venue_1'
const S = 'st_tienda'

const fila = (extra: Record<string, unknown> = {}) => ({
  id: S,
  venueId: V,
  name: 'Tienda',
  printerId: null,
  copies: 1,
  isDefault: false,
  isPacking: false,
  hasKitchenDisplay: false,
  kitchenDisplaySince: null,
  sendsComanda: true,
  active: true,
  displayOrder: 0,
  ...extra,
})

const codigoDe = (p: Promise<unknown>) =>
  p.then(
    () => 'SIN ERROR',
    (e: any) => `${e.statusCode} ${e.code}`,
  )

beforeEach(() => {
  jest.clearAllMocks()
  planMock.mockResolvedValue(true)
  prismaMock.venue.findUnique.mockResolvedValue({ id: V })
  prismaMock.printer.findFirst.mockResolvedValue({ id: 'pr_1' })
  prismaMock.printStation.create.mockImplementation(async (a: any) => ({ id: S, ...a.data }))
  prismaMock.printStation.update.mockImplementation(async (a: any) => ({ ...fila({ sendsComanda: false }), ...a.data }))
})

describe('crea_estacion_sin_comanda', () => {
  it('el esquema de alta acepta sendsComanda', () => {
    expect(createStationSchema.safeParse({ body: { name: 'Tienda', sendsComanda: false }, params: { venueId: V } }).success).toBe(true)
  })

  it('queda sin impresora, sin empaque, no es la predeterminada y la bitácora lo dice', async () => {
    await createStation(V, { name: 'Tienda', sendsComanda: false }, 'dueno-1')
    expect(prismaMock.printStation.create.mock.calls[0][0].data).toMatchObject({
      sendsComanda: false,
      printerId: null,
      isPacking: false,
      isDefault: false,
    })
    // La pantalla no se puede pedir al crear: nace apagada (default de la base).
    expect(prismaMock.printStation.create.mock.calls[0][0].data).not.toHaveProperty('hasKitchenDisplay', true)
    // No es predeterminada ni empaca: no le quita nada a las demás.
    expect(prismaMock.printStation.updateMany).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls[0][0]).toMatchObject({ action: 'PRINT_STATION_CREATED', data: { sendsComanda: false } })
  })

  it('sin decir nada, la estación lleva comanda (como hoy)', async () => {
    await createStation(V, { name: 'Cocina' })
    expect(prismaMock.printStation.create.mock.calls[0][0].data).toMatchObject({ sendsComanda: true })
  })
})

describe('rechaza_crear_sin_comanda_con_impresora_empaque_omision_o_pantalla', () => {
  it.each([{ printerId: 'pr_1' }, { isPacking: true }, { isDefault: true }])('con %o ⇒ 400 y no escribe', async extra => {
    expect(await codigoDe(createStation(V, { name: 'Tienda', sendsComanda: false, ...extra }))).toBe(
      '400 ESTACION_SIN_COMANDA_INCOMPATIBLE',
    )
    expect(prismaMock.printStation.create).not.toHaveBeenCalled()
    expect(prismaMock.printStation.updateMany).not.toHaveBeenCalled()
  })

  it('la pantalla ni siquiera se puede pedir al crear (el esquema la rechaza)', () => {
    const r = createStationSchema.safeParse({
      body: { name: 'Tienda', sendsComanda: false, hasKitchenDisplay: true },
      params: { venueId: V },
    })
    expect(r.success).toBe(false)
  })

  it('vacíos o en false sí se puede', async () => {
    await createStation(V, { name: 'Tienda', sendsComanda: false, printerId: null, isPacking: false, isDefault: false })
    expect(prismaMock.printStation.create).toHaveBeenCalled()
  })
})

describe('update_no_acepta_sendsComanda', () => {
  it.each([false, true])('mandar sendsComanda=%s al editar ⇒ el esquema lo rechaza (400)', valor => {
    const r = updateStationSchema.safeParse({ body: { sendsComanda: valor }, params: { venueId: V, stationId: S } })
    expect(r.success).toBe(false)
  })
})

describe('sobre_sin_comanda_rechaza_impresora_pantalla_empaque_omision', () => {
  beforeEach(() => prismaMock.printStation.findFirst.mockResolvedValue(fila({ sendsComanda: false })))

  it.each([{ printerId: 'pr_1' }, { isPacking: true }, { isDefault: true }])('editar con %o ⇒ 400 y no escribe', async extra => {
    expect(await codigoDe(updateStation(V, S, extra))).toBe('400 ESTACION_SIN_COMANDA_INCOMPATIBLE')
    expect(prismaMock.printStation.update).not.toHaveBeenCalled()
    expect(prismaMock.printStation.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('prender la pantalla ⇒ 400 y no escribe', async () => {
    expect(await codigoDe(setKitchenDisplay(V, S, true, 'dueno-1'))).toBe('400 ESTACION_SIN_COMANDA_INCOMPATIBLE')
    expect(prismaMock.printStation.update).not.toHaveBeenCalled()
    expect(planMock).not.toHaveBeenCalled()
  })

  it('renombrarla, apagarle la pantalla o quitarle lo que no tiene sí se puede', async () => {
    await updateStation(V, S, { name: 'Abarrotes' })
    await updateStation(V, S, { printerId: null, isPacking: false, isDefault: false })
    await setKitchenDisplay(V, S, false)
    expect(prismaMock.printStation.update).toHaveBeenCalledTimes(3)
  })

  it('una estación que SÍ lleva comanda se edita como siempre', async () => {
    prismaMock.printStation.findFirst.mockResolvedValue(fila())
    await updateStation(V, S, { printerId: 'pr_1', isDefault: true })
    expect(prismaMock.printStation.update).toHaveBeenCalled()
  })
})

describe('print_config_dominio', () => {
  function seed(stations: unknown[]) {
    prismaMock.printGateway.findUnique.mockResolvedValue(null)
    prismaMock.printer.findMany.mockResolvedValue([])
    prismaMock.printStation.findMany.mockResolvedValue(stations)
    prismaMock.menuCategory.findMany.mockResolvedValue([])
    prismaMock.product.findMany.mockResolvedValue([])
  }

  it('una fila mezclada sale sin impresora, sin pantalla, y nunca como predeterminada ni de empaque', async () => {
    seed([
      fila({ sendsComanda: false, printerId: 'pr_1', hasKitchenDisplay: true, isDefault: true, isPacking: true }),
      fila({ id: 'st_cocina', name: 'Cocina', printerId: 'pr_2' }),
    ])
    const c = await buildPrintConfig(V)
    expect(c.stations[0]).toMatchObject({
      id: S,
      sendsComanda: false,
      printerId: null,
      hasKitchenDisplay: false,
      isDefault: false,
      isPacking: false,
    })
    expect(c.stations[1]).toMatchObject({ id: 'st_cocina', sendsComanda: true, printerId: 'pr_2' })
    expect(c.defaultStationId).toBeNull()
    expect(c.packingStationId).toBeNull()
    // Su pantalla no cuenta: ni se consulta el plan.
    expect(planMock).not.toHaveBeenCalled()
  })

  it('el campo entra en la versión, para que las cajas bajen la configuración nueva', async () => {
    seed([fila()])
    const conComanda = await buildPrintConfig(V)
    seed([fila({ sendsComanda: false })])
    expect((await buildPrintConfig(V)).version).not.toBe(conComanda.version)
  })

  it('esSinComanda', () => {
    expect(esSinComanda({ sendsComanda: false })).toBe(true)
    expect(esSinComanda({ sendsComanda: true })).toBe(false)
  })
})
