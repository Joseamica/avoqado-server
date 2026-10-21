// tests/unit/services/customer-display/customerDisplayAckView.test.ts
import { enLaTablet } from '@/services/customer-display/customerDisplayAckView'

/**
 * Lo que el MCP contesta a «¿ya se ve mi diseño en la tablet?». LA MISMA regla y el MISMO orden que la tarjeta del
 * dashboard (F1, `estado.ts:81-92`): si divergieran, la IA y el panel dirían cosas distintas del mismo aparato.
 */
const VIGENTE = 'a'.repeat(32)
const RECIBIDO = '2026-10-15T18:00:00.000Z'
const ack = (over: Record<string, unknown> = {}) => ({
  fingerprint: VIGENTE,
  seq: 1,
  receivedAt: RECIBIDO,
  storedAt: '2026-10-15T17:59:00.000Z',
  shownAt: null,
  clientClockSkew: false,
  surface: null,
  imagesReady: 2,
  imagesPending: 1,
  imagesFailed: 0,
  unsupportedSchema: false,
  ...over,
})

it('sin versión reportada: la app no entiende diseños, pase lo que pase con el acuse', () => {
  expect(enLaTablet(ack(), VIGENTE, null).estado).toBe('APP_SIN_DISENOS')
  // El orden de F1: la versión se mira ANTES que la huella (con otra huella, «pendiente» mentiría: la app no entiende diseños).
  expect(enLaTablet(ack({ fingerprint: 'b'.repeat(32) }), VIGENTE, null).estado).toBe('APP_SIN_DISENOS')
  expect(enLaTablet(ack({ fingerprint: 'b'.repeat(32) }), VIGENTE, undefined).estado).toBe('APP_SIN_DISENOS')
})

it('sin acuse, o uno que no es un objeto con huella y `receivedAt` ISO: sin acuse', () => {
  expect(enLaTablet(null, VIGENTE, 1).estado).toBe('SIN_ACUSE')
  expect(enLaTablet({ seq: 1 }, VIGENTE, 1).estado).toBe('SIN_ACUSE')
  expect(enLaTablet('raro', VIGENTE, 1).estado).toBe('SIN_ACUSE')
  // 🔴 Review Focus 2: el formato de `now()::text` de Postgres NO es evidencia (F1 tampoco lo acepta).
  expect(enLaTablet(ack({ receivedAt: '2026-10-14 10:00:00.123456-06' }), VIGENTE, 1).estado).toBe('SIN_ACUSE')
})

it('🔴 la huella del acuse contra la VIGENTE al leer: otra es pendiente', () => {
  expect(enLaTablet(ack({ fingerprint: 'b'.repeat(32), shownAt: RECIBIDO }), VIGENTE, 1)).toMatchObject({
    estado: 'PENDIENTE',
    fecha: null,
  })
})

it('el orden de F1: esquema no soportado, kiosco, mostrado, guardado, recibido', () => {
  expect(enLaTablet(ack({ unsupportedSchema: true, shownAt: RECIBIDO }), VIGENTE, 1).estado).toBe('NO_SOPORTADO')
  expect(enLaTablet(ack({ surface: 'kiosk', shownAt: RECIBIDO }), VIGENTE, 1)).toMatchObject({ estado: 'KIOSCO', fecha: RECIBIDO })
  expect(enLaTablet(ack({ surface: 'kiosk', storedAt: null }), VIGENTE, 1).estado).toBe('RECIBIDO')
  expect(enLaTablet(ack({ shownAt: RECIBIDO, surface: 'presentation' }), VIGENTE, 1)).toMatchObject({ estado: 'MOSTRADO', fecha: RECIBIDO })
  expect(enLaTablet(ack(), VIGENTE, 1)).toMatchObject({ estado: 'GUARDADO', fecha: RECIBIDO })
  expect(enLaTablet(ack({ storedAt: null }), VIGENTE, 1)).toMatchObject({ estado: 'RECIBIDO', fecha: null })
})

it('🔴 Review Focus 3: la ventana de Windows que ya lo mostró dice «Mostrado»', () => {
  expect(enLaTablet(ack({ surface: 'window', shownAt: RECIBIDO }), VIGENTE, 1).estado).toBe('MOSTRADO')
})

it('la fecha es SIEMPRE la del servidor (receivedAt) y las cuentas basura salen en 0', () => {
  const r = enLaTablet(ack({ shownAt: '2030-01-01T00:00:00.000Z', imagesPending: 'x', imagesFailed: -3 }), VIGENTE, 1)
  expect(r).toEqual({ estado: 'MOSTRADO', fecha: RECIBIDO, imagenesDescargandose: 0, imagenesFallidas: 0 })
})
