/**
 * Codex R4-6: la evidencia de conciliación tiene DOS clases —posible segunda captura y posible colisión de referencia— y
 * ninguna es una venta. Lo que no debe pasar con una (verificación de venta, lealtad, costo, turno) tampoco con la otra.
 */
import { esEvidenciaDeConciliacion, esEvidenciaDeSegundaCaptura, tipoDeEvidencia } from '@/services/tpv/segundaCaptura'

const durable = (kind: string, status = 'PENDING') => ({ id: 'p', status, processorData: { reconciliation: { kind } } })

it('segunda captura: marca transitoria o durable (PENDING + reconciliation.kind)', () => {
  expect(esEvidenciaDeSegundaCaptura({ possibleSecondCapture: { requestId: 'r' } })).toBe(true)
  expect(esEvidenciaDeSegundaCaptura(durable('POSSIBLE_SECOND_CAPTURE'))).toBe(true)
  expect(esEvidenciaDeConciliacion(durable('POSSIBLE_SECOND_CAPTURE'))).toBe(true)
  expect(tipoDeEvidencia(durable('POSSIBLE_SECOND_CAPTURE'))).toBe('POSSIBLE_SECOND_CAPTURE')
})

it('colisión de referencia: es evidencia de conciliación, pero NO segunda captura', () => {
  expect(esEvidenciaDeConciliacion({ possibleReferenceCollision: { referenceNumber: 'R', candidates: ['p1'] } })).toBe(true)
  expect(esEvidenciaDeConciliacion(durable('POSSIBLE_REFERENCE_COLLISION'))).toBe(true)
  expect(esEvidenciaDeSegundaCaptura(durable('POSSIBLE_REFERENCE_COLLISION'))).toBe(false)
  expect(tipoDeEvidencia(durable('POSSIBLE_REFERENCE_COLLISION'))).toBe('POSSIBLE_REFERENCE_COLLISION')
})

it('un Payment COMPLETED con reconciliación, uno sin ella, o algo que no es objeto: no es evidencia', () => {
  expect(esEvidenciaDeConciliacion(durable('POSSIBLE_REFERENCE_COLLISION', 'COMPLETED'))).toBe(false)
  expect(esEvidenciaDeConciliacion({ id: 'p', status: 'PENDING', processorData: {} })).toBe(false)
  expect(esEvidenciaDeConciliacion(durable('OTRA_COSA'))).toBe(false)
  expect(esEvidenciaDeConciliacion(null)).toBe(false)
  expect(esEvidenciaDeConciliacion('x')).toBe(false)
})
