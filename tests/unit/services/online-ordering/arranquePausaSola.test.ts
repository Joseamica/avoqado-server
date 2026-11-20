import { prismaMock } from '@tests/__helpers__/setup'
import {
  __resetArranqueParaPruebas,
  arranqueDeLaPausaSola,
  CLAVE_PAUSA_SOLA,
  cuentaComoServicio,
  MARGEN_DEL_ARRANQUE_MS,
  marcarPrimerServicio,
  marcarPrimerServicioMiddleware,
} from '@/services/online-ordering/arranquePausaSola'

/**
 * D662 parte 2 v4 (hueco 1 y 4): el inicio de la pausa sola es UNO para toda la plataforma: la primera petición que atiende el SERVIDOR
 * nuevo (no `/health`) + 120 s. Un despliegue que nunca atiende no lo escribe; se escribe una sola vez en la vida.
 */
describe('arranque de la pausa sola', () => {
  beforeEach(() => {
    __resetArranqueParaPruebas()
    ;(prismaMock.arranqueDeFuncion.createMany as jest.Mock).mockResolvedValue({ count: 1 })
  })

  it('la revisión de salud de Render no cuenta como servicio; cualquier otra petición sí', () => {
    expect(cuentaComoServicio('/health')).toBe(false)
    expect(cuentaComoServicio('/health/')).toBe(false) // Express sirve las dos (Codex p2v4-r2 #1)
    expect(cuentaComoServicio('/api/v1/public/venues/x/info')).toBe(true)
    expect(cuentaComoServicio('/')).toBe(true)
  })

  it('la primera petición guarda su hora una sola vez (sin pisar: skipDuplicates) y luego ya no escribe', async () => {
    const ahora = new Date('2026-11-20T18:00:00.000Z')
    await marcarPrimerServicio(ahora)
    await marcarPrimerServicio(new Date('2026-11-20T19:00:00.000Z'))
    expect(prismaMock.arranqueDeFuncion.createMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.arranqueDeFuncion.createMany).toHaveBeenCalledWith({
      data: [{ clave: CLAVE_PAUSA_SOLA, primerServicioAt: ahora }],
      skipDuplicates: true,
    })
  })

  it('si la escritura falla no tumba la petición y el reintento escribe la hora de la PRIMERA petición (Codex p2v4-r2 #1)', async () => {
    ;(prismaMock.arranqueDeFuncion.createMany as jest.Mock).mockRejectedValueOnce(new Error('db'))
    const primera = new Date('2026-11-20T18:00:00.000Z')
    await expect(marcarPrimerServicio(primera)).resolves.toBeUndefined()
    await marcarPrimerServicio(new Date('2026-11-20T18:00:07.000Z'))
    expect(prismaMock.arranqueDeFuncion.createMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.arranqueDeFuncion.createMany).toHaveBeenLastCalledWith({
      data: [{ clave: CLAVE_PAUSA_SOLA, primerServicioAt: primera }],
      skipDuplicates: true,
    })
  })

  it('el middleware nunca espera: /health no escribe; otra ruta sí', () => {
    const next = jest.fn()
    marcarPrimerServicioMiddleware({ path: '/health' }, {}, next)
    expect(prismaMock.arranqueDeFuncion.createMany).not.toHaveBeenCalled()
    marcarPrimerServicioMiddleware({ path: '/api/v1/mobile/venues/v1/online-orders/inbox' }, {}, next)
    expect(prismaMock.arranqueDeFuncion.createMany).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('sin fila no hay arranque (la pausa sola todavía no existe); con fila, inicio = primer servicio + 120 s, recordado', async () => {
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock).mockResolvedValueOnce(null)
    await expect(arranqueDeLaPausaSola()).resolves.toBeNull()
    const primer = new Date('2026-11-20T18:00:00.000Z')
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock).mockResolvedValueOnce({ primerServicioAt: primer })
    await expect(arranqueDeLaPausaSola()).resolves.toEqual({
      primerServicio: primer,
      inicio: new Date(primer.getTime() + MARGEN_DEL_ARRANQUE_MS),
    })
    expect(MARGEN_DEL_ARRANQUE_MS).toBe(120_000)
    await arranqueDeLaPausaSola()
    expect(prismaMock.arranqueDeFuncion.findUnique).toHaveBeenCalledTimes(2)
  })
})
