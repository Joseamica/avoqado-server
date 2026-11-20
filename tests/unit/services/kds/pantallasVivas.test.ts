/**
 * D6 de Flautas (opción B del founder, 20-nov): qué pantallas de cocina están conectadas. Una pantalla pide su tablero cada
 * 10 s mientras se ve; la caja pregunta para decir con una franja fija si una pantalla NO está conectada.
 */
import { marcarPantallaViva, olvidarPantallas, pantallasConectadas, PANTALLA_VIVA_MS } from '../../../../src/services/kds/pantallasVivas'

const ARRANQUE = 0
const T0 = 1_000_000

describe('pantallasVivas', () => {
  beforeEach(() => olvidarPantallas())

  it('una pantalla que pidió su tablero hace ≤ 90 s está conectada; después ya no', () => {
    marcarPantallaViva('venue-1', 'st_cocina', T0)

    expect(pantallasConectadas('venue-1', T0 + PANTALLA_VIVA_MS, ARRANQUE)).toEqual({ conectadas: ['st_cocina'], completo: true })
    expect(pantallasConectadas('venue-1', T0 + PANTALLA_VIVA_MS + 1, ARRANQUE)).toEqual({ conectadas: [], completo: true })
  })

  it('Codex r5 #3: aguanta una vuelta lenta de la pantalla (más de 45 s entre lecturas)', () => {
    marcarPantallaViva('venue-1', 'st_cocina', T0)

    expect(pantallasConectadas('venue-1', T0 + 60_000, ARRANQUE).conectadas).toEqual(['st_cocina'])
  })

  it('Codex r5 #4: recién arrancado el servidor, lo que falta no se puede dar por desconectado (completo = false)', () => {
    expect(pantallasConectadas('venue-1', 10_000, 0)).toEqual({ conectadas: [], completo: false })
    expect(pantallasConectadas('venue-1', PANTALLA_VIVA_MS + 1, 0).completo).toBe(true)
  })

  it('cada lectura renueva la marca, y cada negocio ve sólo las suyas', () => {
    marcarPantallaViva('venue-1', 'st_cocina', T0)
    marcarPantallaViva('venue-2', 'st_barra', T0)
    marcarPantallaViva('venue-1', 'st_cocina', T0 + 80_000)

    expect(pantallasConectadas('venue-1', T0 + 150_000, ARRANQUE).conectadas).toEqual(['st_cocina'])
    expect(pantallasConectadas('venue-2', T0 + 150_000, ARRANQUE).conectadas).toEqual([])
    expect(pantallasConectadas('venue-3', T0, ARRANQUE).conectadas).toEqual([])
  })

  it('no crece sin tope: guarda a lo más 100 estaciones por negocio (las más recientes)', () => {
    for (let i = 0; i < 150; i++) marcarPantallaViva('venue-1', `st_${i}`, T0 + i)

    const { conectadas } = pantallasConectadas('venue-1', T0 + 150, ARRANQUE)
    expect(conectadas).toHaveLength(100)
    expect(conectadas).toContain('st_149')
    expect(conectadas).not.toContain('st_0')
  })
})
