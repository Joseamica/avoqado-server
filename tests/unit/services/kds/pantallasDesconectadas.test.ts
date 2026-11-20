/**
 * D6 de Flautas (opción B simplificada, Codex r7): el SERVIDOR decide qué pantallas de cocina no están conectadas a internet,
 * con las estaciones de SU base (no la copia de la caja) y la última lectura de cada tablero.
 */
const mockPlan = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockPlan(...a),
}))

import prisma from '@/utils/prismaClient'
import { pantallasDesconectadas } from '@/services/kds/kitchenDisplayStations'
import { marcarPantallaViva, olvidarPantallas, PANTALLA_VIVA_MS } from '@/services/kds/pantallasVivas'

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

    expect(r).toEqual({ hayPantallas: true, completo: true, desconectadas: [cocina] })
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

    expect(await pantallasDesconectadas('venue-1', reloj(T0 + 1_000))).toEqual({ hayPantallas: true, completo: true, desconectadas: [cocina] })
  })

  it('Codex r5 #4: recién arrancado el servidor no da a ninguna por desconectada (completo = false)', async () => {
    estaciones(cocina)

    expect(await pantallasDesconectadas('venue-1', { ahora: 10_000, arranque: 0 })).toEqual({
      hayPantallas: true,
      completo: false,
      desconectadas: [],
    })
  })

  it('sin estaciones con pantalla no hay nada que vigilar, y ni se consulta el plan', async () => {
    estaciones()

    expect(await pantallasDesconectadas('venue-1', reloj(T0))).toEqual({ hayPantallas: false, completo: true, desconectadas: [] })
    expect(mockPlan).not.toHaveBeenCalled()
  })

  it('una estación «No lleva comanda» nunca es pantalla, aunque tenga la casilla', async () => {
    estaciones({ id: 'st_tienda', name: 'Tienda', sendsComanda: false })

    expect((await pantallasDesconectadas('venue-1', reloj(T0))).hayPantallas).toBe(false)
  })

  it('sin el plan de Pantalla de cocina no hay pantalla efectiva (igual que la print-config)', async () => {
    estaciones(cocina)
    mockPlan.mockResolvedValue(false)

    expect(await pantallasDesconectadas('venue-1', reloj(T0))).toEqual({ hayPantallas: false, completo: true, desconectadas: [] })
    expect(mockPlan).toHaveBeenCalledWith('venue-1', 'KITCHEN_DISPLAY')
  })
})
