/**
 * D662 v5 (rediseño B): el interruptor «pausa sola desde <hora>» vive en la base (Codex p2v5-r1 #1). Nunca se prende con una hora pasada
 * ni cercana, no se mueve una hora que ya llegó, y cada proceso lo recuerda pocos segundos.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import {
  __resetInterruptorParaPruebas,
  apagarPausaSola,
  CACHE_MS,
  CLAVE_PAUSA_SOLA,
  pausaSolaDesde,
  prenderPausaSola,
} from '@/services/online-ordering/interruptorPausaSola'

const NOW = new Date('2026-11-21T18:00:00.000Z')
const fila = () => prismaMock.interruptorDePlataforma

beforeEach(() => __resetInterruptorParaPruebas())

describe('pausaSolaDesde', () => {
  it('sin fila o con «desde» vacío: apagado (null)', async () => {
    fila().findUnique.mockResolvedValue(null)
    await expect(pausaSolaDesde()).resolves.toBeNull()
    __resetInterruptorParaPruebas()
    fila().findUnique.mockResolvedValue({ desde: null } as any)
    await expect(pausaSolaDesde()).resolves.toBeNull()
  })

  it('lee la fila de `pausa-sola` y la recuerda a lo más CACHE_MS (una sola consulta para lecturas seguidas)', async () => {
    jest.useFakeTimers({ now: NOW })
    try {
      fila().findUnique.mockResolvedValue({ desde: NOW } as any)
      await expect(Promise.all([pausaSolaDesde(), pausaSolaDesde()])).resolves.toEqual([NOW, NOW])
      await pausaSolaDesde()
      expect(fila().findUnique).toHaveBeenCalledTimes(1)
      expect(fila().findUnique).toHaveBeenCalledWith({ where: { clave: CLAVE_PAUSA_SOLA }, select: { desde: true } })
      jest.setSystemTime(NOW.getTime() + CACHE_MS + 1)
      fila().findUnique.mockResolvedValue({ desde: null } as any)
      await expect(pausaSolaDesde()).resolves.toBeNull()
      expect(fila().findUnique).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('si la base falla, LANZA (la lectura de la tienda falla; nunca contesta «apagado» por no poder leer)', async () => {
    fila().findUnique.mockRejectedValue(new Error('db'))
    await expect(pausaSolaDesde()).rejects.toThrow('db')
  })
})

describe('prenderPausaSola / apagarPausaSola', () => {
  const raw = () => prismaMock.$queryRaw as unknown as jest.Mock
  const sql = () => {
    const [partes, ...valores] = raw().mock.calls[0]
    return { texto: (partes as string[]).join('?'), valores }
  }

  it('prende en UNA instrucción con el reloj de Postgres: «desde» = ahora + 15 min por omisión, y anota quién', async () => {
    raw().mockResolvedValue([{ desde: NOW }])
    await expect(prenderPausaSola({ por: 'founder' })).resolves.toEqual(NOW)
    const { texto, valores } = sql()
    expect(texto).toContain('ON CONFLICT ("clave") DO UPDATE')
    expect(texto).toContain('clock_timestamp() AT TIME ZONE')
    expect(valores).toEqual(expect.arrayContaining([CLAVE_PAUSA_SOLA, 15, 'founder']))
  })

  it('🔴 Codex p2v5-r2 #7: la condición «no mover una hora que ya llegó» va DENTRO de la misma instrucción (sin hueco revisar→escribir)', async () => {
    raw().mockResolvedValue([])
    await expect(prenderPausaSola({ por: 'x', minutos: 20 })).rejects.toThrow('primero apágala')
    const { texto } = sql()
    expect(texto).toMatch(/WHERE "InterruptorDePlataforma"\."desde" IS NULL\s+OR "InterruptorDePlataforma"\."desde" > \(clock_timestamp\(\)/)
    expect(prismaMock.interruptorDePlataforma.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 Codex p2v5-r3 #2: el guardia y el nuevo «desde» usan la hora REAL al escribir (clock_timestamp), no la del inicio (now())', async () => {
    // Si la instrucción espera el candado de la fila, `now()` se queda en la hora en que empezó: el guardia podría aprobar mover una hora
    // que ya llegó durante la espera, y el nuevo «desde» quedaría a menos de 15 min del guardado. `EXCLUDED` también se calcula ANTES de
    // la espera, así que la rama UPDATE recalcula «desde» con su propio reloj.
    raw().mockResolvedValue([{ desde: NOW }])
    await prenderPausaSola({ por: 'founder', minutos: 20 })
    const { texto } = sql()
    expect(texto).not.toMatch(/\bnow\(\)/)
    expect(texto).not.toContain('EXCLUDED."desde"')
    const [, actualizacion] = texto.split('DO UPDATE')
    const [set, guardia] = actualizacion.split('WHERE')
    expect(set).toMatch(/"desde" = \(clock_timestamp\(\) AT TIME ZONE 'UTC'\) \+/)
    expect(guardia).toMatch(/"desde" > \(clock_timestamp\(\) AT TIME ZONE 'UTC'\) \+/)
  })

  it('nunca con menos de 15 min (ni una hora pasada)', async () => {
    for (const minutos of [0, -5, 14.9, NaN]) {
      await expect(prenderPausaSola({ por: 'x', minutos })).rejects.toThrow('al menos 15 minutos')
    }
    expect(raw()).not.toHaveBeenCalled()
  })

  it('apagar deja «desde» vacío', async () => {
    await apagarPausaSola({ por: 'founder' })
    expect(fila().upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { desde: null, actualizadoPor: 'founder' } }))
  })
})
