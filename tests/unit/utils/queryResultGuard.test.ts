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
import { evaluarResultadoGigante, UMBRAL_FILAS_DEFAULT } from '@/utils/queryResultGuard'

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
