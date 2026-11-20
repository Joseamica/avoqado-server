import { Prisma } from '@prisma/client'
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

  it('el middleware: /health sigue sin escribir; la PRIMERA petición espera su escritura (p2v4-r3 #2); las demás no esperan', async () => {
    const next = jest.fn()
    marcarPrimerServicioMiddleware({ path: '/health' }, {}, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(prismaMock.arranqueDeFuncion.createMany).not.toHaveBeenCalled()
    marcarPrimerServicioMiddleware({ path: '/api/v1/mobile/venues/v1/online-orders/inbox' }, {}, next)
    expect(next).toHaveBeenCalledTimes(1) // todavía esperando la escritura
    await new Promise(r => setImmediate(r))
    expect(prismaMock.arranqueDeFuncion.createMany).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(2)
    marcarPrimerServicioMiddleware({ path: '/x' }, {}, next)
    expect(next).toHaveBeenCalledTimes(3)
  })

  it('sin fila no hay arranque (la pausa sola todavía no existe); con fila sellada, inicio = primer servicio + 120 s, recordado', async () => {
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock).mockResolvedValueOnce(null)
    await expect(arranqueDeLaPausaSola()).resolves.toBeNull()
    const primer = new Date('2026-11-20T18:00:00.000Z')
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock).mockResolvedValueOnce({ primerServicioAt: primer, legadoSelladoAt: primer })
    await expect(arranqueDeLaPausaSola()).resolves.toEqual({
      primerServicio: primer,
      inicio: new Date(primer.getTime() + MARGEN_DEL_ARRANQUE_MS),
    })
    expect(MARGEN_DEL_ARRANQUE_MS).toBe(120_000)
    await arranqueDeLaPausaSola()
    expect(prismaMock.arranqueDeFuncion.findUnique).toHaveBeenCalledTimes(2)
  })

  it('Codex p2v4-r3 #1: al llegar el inicio sella UNA vez lo que contestó el SERVIDOR anterior (marca = primer servicio) y lo recuerda', async () => {
    const primer = new Date(Date.now() - MARGEN_DEL_ARRANQUE_MS - 5_000)
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock)
      .mockResolvedValueOnce({ primerServicioAt: primer, legadoSelladoAt: null }) // la lectura
      .mockResolvedValueOnce({ legadoSelladoAt: null }) // bajo el candado del sello
    ;(prismaMock.$executeRaw as jest.Mock).mockResolvedValue(3)
    ;(prismaMock.arranqueDeFuncion.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    await expect(arranqueDeLaPausaSola()).resolves.toMatchObject({ primerServicio: primer })
    const llamadas = (prismaMock.$executeRaw as jest.Mock).mock.calls.map(
      ([plantilla, ...valores]) => Prisma.sql(plantilla as TemplateStringsArray, ...valores).sql,
    )
    expect(llamadas.some(t => t.includes('pg_advisory_xact_lock'))).toBe(true)
    const sello = llamadas.find(t => t.includes('UPDATE "OnlineOrder"'))!
    expect(sello).toContain('"staffAnsweredAt" IS NULL')
    expect(sello).toContain('oo."createdAt" <')
    expect(sello).toContain('oo."acceptDeadlineAt" >')
    // Un cobro tardío de un pedido vencido lo deja entregado SIN aceptación: no es evidencia de persona.
    expect(sello).toContain(`oo.status IN ('ACCEPTED', 'READY', 'COMPLETED') AND oo."acceptedAt" IS NOT NULL`)
    expect(prismaMock.arranqueDeFuncion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clave: CLAVE_PAUSA_SOLA, legadoSelladoAt: null } }),
    )
    await arranqueDeLaPausaSola()
    expect(prismaMock.arranqueDeFuncion.findUnique).toHaveBeenCalledTimes(2)
  })

  it('antes del inicio no sella (el anterior puede seguir vivo) ni recuerda; si el sello falla, no hay arranque todavía', async () => {
    const primer = new Date(Date.now() - 1_000)
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock).mockResolvedValue({ primerServicioAt: primer, legadoSelladoAt: null })
    await expect(arranqueDeLaPausaSola()).resolves.toMatchObject({ primerServicio: primer })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    __resetArranqueParaPruebas()
    const viejo = new Date(Date.now() - 10 * 60_000)
    ;(prismaMock.arranqueDeFuncion.findUnique as jest.Mock).mockResolvedValue({ primerServicioAt: viejo, legadoSelladoAt: null })
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValueOnce(new Error('db'))
    await expect(arranqueDeLaPausaSola()).resolves.toBeNull()
  })
})
