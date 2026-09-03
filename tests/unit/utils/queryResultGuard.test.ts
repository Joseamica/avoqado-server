/**
 * Guardia de resultados gigantes de Prisma.
 *
 * Incidente 2026-09-01: getVenueById materializaba 66k filas por petición y el server
 * se congelaba hasta que Render lo reemplazó. El barrido estático encontró 186 findMany
 * sin `take` sobre tablas grandes — imposible garantizar a mano que ninguno explote
 * cuando un venue acumule historial (Testarudo hoy; cualquier cliente grande mañana).
 *
 * Esta guardia vive en el cliente de Prisma: cuando un findMany devuelve más filas que
 * el umbral, lo DENUNCIA en el log con modelo y tamaño (el contexto de ejecución ya
 * estampa entrypoint y venue). No bloquea nunca: observabilidad, no comportamiento.
 */
import { evaluarResultadoGigante, extensionResultadoGigante, UMBRAL_FILAS_DEFAULT } from '@/utils/queryResultGuard'

describe('evaluarResultadoGigante', () => {
  it('no denuncia un resultado chico', () => {
    expect(evaluarResultadoGigante({ model: 'Order', rows: 150, take: undefined, umbral: 2000 })).toBeNull()
  })

  it('denuncia un findMany sin take que devuelve más filas que el umbral', () => {
    const aviso = evaluarResultadoGigante({ model: 'Payment', rows: 32646, take: undefined, umbral: 2000 })
    expect(aviso).toEqual({ model: 'Payment', rows: 32646, take: null, umbral: 2000 })
  })

  it('denuncia también cuando SÍ hay take pero es enorme (el tope no exime)', () => {
    const aviso = evaluarResultadoGigante({ model: 'OrderItem', rows: 5000, take: 5000, umbral: 2000 })
    expect(aviso).toEqual({ model: 'OrderItem', rows: 5000, take: 5000, umbral: 2000 })
  })

  it('el umbral es inclusivo por arriba: exactamente el umbral ya denuncia', () => {
    expect(evaluarResultadoGigante({ model: 'Order', rows: 2000, take: undefined, umbral: 2000 })).not.toBeNull()
    expect(evaluarResultadoGigante({ model: 'Order', rows: 1999, take: undefined, umbral: 2000 })).toBeNull()
  })

  it('un resultado que no es arreglo jamás denuncia (findMany raro, mock, lo que sea)', () => {
    expect(evaluarResultadoGigante({ model: 'Order', rows: Number.NaN, take: undefined, umbral: 2000 })).toBeNull()
  })

  it('el default del umbral es 2000', () => {
    expect(UMBRAL_FILAS_DEFAULT).toBe(2000)
  })
})

/**
 * P3 de la auditoría de Codex (2026-09-01): la promesa "el $extends nunca rompe una
 * consulta" estaba probada sólo en la función pura. Estas pruebas ejecutan el WRAPPER
 * real de la extensión: misma referencia de resultado, error de Prisma propagado
 * intacto, y un logger que truena absorbido sin tocar el resultado.
 */
describe('extensionResultadoGigante — el wrapper de verdad', () => {
  const wrapper = extensionResultadoGigante.query.$allModels.findMany

  it('devuelve LA MISMA referencia que la consulta (jamás copia ni recorta)', async () => {
    const filas = Array.from({ length: 3 }, (_, i) => ({ id: i }))
    const res = await wrapper({ model: 'Order', args: {}, query: async () => filas })
    expect(res).toBe(filas)
  })

  it('un error de la consulta se propaga INTACTO (la guardia no lo traga)', async () => {
    const boom = new Error('P2024 pool timeout')
    await expect(wrapper({ model: 'Order', args: {}, query: async () => Promise.reject(boom) })).rejects.toBe(boom)
  })

  it('si el logger truena, el resultado llega igual (observabilidad jamás rompe la consulta)', async () => {
    const logger = (jest.requireMock('@/config/logger') as { default: { warn: jest.Mock } }).default
    logger.warn.mockImplementationOnce(() => {
      throw new Error('winston murió')
    })
    const filas = Array.from({ length: 5000 }, (_, i) => ({ id: i }))
    const res = await wrapper({ model: 'Payment', args: {}, query: async () => filas })
    expect(res).toBe(filas)
  })

  it('denuncia con el modelo, el tamaño y el take cuando cruza el umbral', async () => {
    const logger = (jest.requireMock('@/config/logger') as { default: { warn: jest.Mock } }).default
    const filas = Array.from({ length: 2500 }, (_, i) => ({ id: i }))
    await wrapper({ model: 'Payment', args: { take: 5000 }, query: async () => filas })
    expect(logger.warn).toHaveBeenCalledWith(
      '[query-guard] findMany gigante',
      expect.objectContaining({ model: 'Payment', rows: 2500, take: 5000 }),
    )
  })
})
