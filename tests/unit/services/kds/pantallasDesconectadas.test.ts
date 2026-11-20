/**
 * D6 de Flautas (opción B simplificada, Codex r7): el SERVIDOR decide qué pantallas de cocina no están conectadas a internet,
 * con las estaciones de SU base (no la copia de la caja) y la última lectura de cada tablero.
 */
const mockPlan = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockPlan(...a),
}))

import prisma from '@/utils/prismaClient'
import { pantallasDesconectadas, registrarLecturaDelTablero } from '@/services/kds/kitchenDisplayStations'
import { marcarPantallaViva, olvidarPantallas, pantallasConectadas, PANTALLA_VIVA_MS } from '@/services/kds/pantallasVivas'

const T0 = 1_000_000
const reloj = (ahora: number) => ({ ahora, arranque: 0 })
const estaciones = (...filas: Array<{ id: string; name: string; sendsComanda?: boolean }>) =>
  (prisma.printStation.findMany as jest.Mock).mockResolvedValue(filas.map(f => ({ sendsComanda: true, ...f })))
const cocina = { id: 'st_cocina', name: 'COCINA 1' }
const barra = { id: 'st_barra', name: 'Barra' }

describe('pantallasDesconectadas', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    olvidarPantallas()
    mockPlan.mockResolvedValue(true)
  })

  it('lista, con su nombre, las estaciones con pantalla que no han leído su tablero en la ventana', async () => {
    estaciones(cocina, barra)
    marcarPantallaViva('venue-1', 'st_barra', T0)

    const r = await pantallasDesconectadas('venue-1', reloj(T0 + 30_000))

    expect(r).toEqual({ hayPantallas: true, pantallas: ['st_cocina', 'st_barra'], completo: true, desconectadas: [cocina] })
    expect((prisma.printStation.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: { venueId: 'venue-1', active: true, hasKitchenDisplay: true },
      take: 100,
    })
  })

  it('la pantalla que leyó hace más de 90 s ya cuenta como desconectada', async () => {
    estaciones(cocina)
    marcarPantallaViva('venue-1', 'st_cocina', T0)

    expect((await pantallasDesconectadas('venue-1', reloj(T0 + PANTALLA_VIVA_MS))).desconectadas).toEqual([])
    expect((await pantallasDesconectadas('venue-1', reloj(T0 + PANTALLA_VIVA_MS + 1))).desconectadas).toEqual([cocina])
  })

  it('Codex r5 #6: una marca de un id que no es una estación con pantalla de este negocio no cuenta ni aparece', async () => {
    estaciones(cocina)
    marcarPantallaViva('venue-1', 'st_ajena', T0)

    expect(await pantallasDesconectadas('venue-1', reloj(T0 + 1_000))).toEqual({
      hayPantallas: true,
      pantallas: ['st_cocina'],
      completo: true,
      desconectadas: [cocina],
    })
  })

  it('Codex r5 #4: recién arrancado el servidor no da a ninguna por desconectada (completo = false)', async () => {
    estaciones(cocina)

    expect(await pantallasDesconectadas('venue-1', { ahora: 10_000, arranque: 0 })).toEqual({
      hayPantallas: true,
      pantallas: ['st_cocina'],
      completo: false,
      desconectadas: [],
    })
  })

  it('sin estaciones con pantalla no hay nada que vigilar, y ni se consulta el plan', async () => {
    estaciones()

    expect(await pantallasDesconectadas('venue-1', reloj(T0))).toEqual({ hayPantallas: false, pantallas: [], completo: true, desconectadas: [] })
    expect(mockPlan).not.toHaveBeenCalled()
  })

  it('una estación «No lleva comanda» nunca es pantalla, aunque tenga la casilla', async () => {
    estaciones({ id: 'st_tienda', name: 'Tienda', sendsComanda: false })

    expect((await pantallasDesconectadas('venue-1', reloj(T0))).hayPantallas).toBe(false)
  })

  it('sin el plan de Pantalla de cocina no hay pantalla efectiva (igual que la print-config)', async () => {
    estaciones(cocina)
    mockPlan.mockResolvedValue(false)

    expect(await pantallasDesconectadas('venue-1', reloj(T0))).toEqual({ hayPantallas: false, pantallas: [], completo: true, desconectadas: [] })
    expect(mockPlan).toHaveBeenCalledWith('venue-1', 'KITCHEN_DISPLAY')
  })
})

describe('registrarLecturaDelTablero', () => {
  const vivas = () => pantallasConectadas('venue-1').conectadas
  const sinPendientes = () => new Promise(resolve => setImmediate(resolve))
  const estacion = (fila: { id: string } | null) => (prisma.printStation.findFirst as jest.Mock).mockResolvedValue(fila)

  beforeEach(() => {
    jest.clearAllMocks()
    olvidarPantallas()
    mockPlan.mockResolvedValue(true)
  })

  it('la primera lectura sólo marca una estación activa con pantalla de ESTE negocio', async () => {
    estacion({ id: 'st_cocina' })

    registrarLecturaDelTablero('venue-1', 'st_cocina')
    await sinPendientes()

    expect(vivas()).toEqual(['st_cocina'])
    expect((prisma.printStation.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({
      id: 'st_cocina',
      venueId: 'venue-1',
      active: true,
      hasKitchenDisplay: true,
    })
  })

  it('Codex r8 #1: un id que no es una pantalla de este negocio no entra, y cien de ésos no desplazan a una pantalla real', async () => {
    estacion({ id: 'st_cocina' })
    registrarLecturaDelTablero('venue-1', 'st_cocina')
    await sinPendientes()
    estacion(null)

    for (let i = 0; i < 150; i++) registrarLecturaDelTablero('venue-1', `ajena_${i}`)
    await sinPendientes()

    expect(vivas()).toEqual(['st_cocina'])
  })

  it('una pantalla ya conocida renueva su marca sin otra consulta', async () => {
    estacion({ id: 'st_cocina' })
    registrarLecturaDelTablero('venue-1', 'st_cocina')
    await sinPendientes()
    ;(prisma.printStation.findFirst as jest.Mock).mockClear()

    registrarLecturaDelTablero('venue-1', 'st_cocina')

    expect(prisma.printStation.findFirst).not.toHaveBeenCalled()
    expect(vivas()).toEqual(['st_cocina'])
  })

  it('Codex r9 #1: si la revisión falla nada entra sin comprobar, nada lanza y durante una ventana no se da a nadie por desconectado', async () => {
    ;(prisma.printStation.findFirst as jest.Mock).mockRejectedValue(new Error('base lenta'))

    expect(() => registrarLecturaDelTablero('venue-1', 'st_cocina')).not.toThrow()
    for (let i = 0; i < 150; i++) registrarLecturaDelTablero('venue-1', `ajena_${i}`)
    await sinPendientes()

    expect(vivas()).toEqual([])
    ;(prisma.printStation.findMany as jest.Mock).mockResolvedValue([{ id: 'st_cocina', name: 'COCINA 1', sendsComanda: true }])
    const ahora = Date.now()
    expect(await pantallasDesconectadas('venue-1', { ahora: ahora + 1_000, arranque: 0 })).toEqual({
      hayPantallas: true,
      pantallas: ['st_cocina'],
      completo: false,
      desconectadas: [],
    })
    // Pasada la ventana sin más dudas, la lista vuelve a ser de fiar.
    expect((await pantallasDesconectadas('venue-1', { ahora: ahora + PANTALLA_VIVA_MS + 5_000, arranque: 0 })).completo).toBe(true)
  })
})
