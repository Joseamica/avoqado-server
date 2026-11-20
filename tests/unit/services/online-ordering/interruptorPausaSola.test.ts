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
  it('prende con «desde» = ahora + 15 min por omisión, y anota quién', async () => {
    fila().findUnique.mockResolvedValue(null)
    const desde = await prenderPausaSola({ por: 'founder', now: NOW })
    expect(desde).toEqual(new Date(NOW.getTime() + 15 * 60_000))
    expect(fila().upsert).toHaveBeenCalledWith({
      where: { clave: CLAVE_PAUSA_SOLA },
      create: { clave: CLAVE_PAUSA_SOLA, desde, actualizadoPor: 'founder' },
      update: { desde, actualizadoPor: 'founder' },
    })
  })

  it('nunca con menos de 15 min (ni una hora pasada)', async () => {
    for (const minutos of [0, -5, 14.9, NaN]) {
      await expect(prenderPausaSola({ por: 'x', minutos, now: NOW })).rejects.toThrow('al menos 15 minutos')
    }
    expect(fila().upsert).not.toHaveBeenCalled()
  })

  it('no mueve una hora que ya llegó (perdería fallas ya contadas); una hora futura sí se puede cambiar', async () => {
    fila().findUnique.mockResolvedValue({ desde: new Date(NOW.getTime() - 1) } as any)
    await expect(prenderPausaSola({ por: 'x', now: NOW })).rejects.toThrow('primero apágala')
    fila().findUnique.mockResolvedValue({ desde: new Date(NOW.getTime() + 60_000) } as any)
    await expect(prenderPausaSola({ por: 'x', minutos: 20, now: NOW })).resolves.toEqual(new Date(NOW.getTime() + 20 * 60_000))
  })

  it('apagar deja «desde» vacío', async () => {
    await apagarPausaSola({ por: 'founder' })
    expect(fila().upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { desde: null, actualizadoPor: 'founder' } }))
  })
})
