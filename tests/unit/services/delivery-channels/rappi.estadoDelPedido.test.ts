/**
 * El estado de un pedido de Rappi del lado de Rappi (Tarea 9): la marca de aceptación y la lectura del historial.
 *
 * Los cuerpos del historial son REALES, del sandbox DEV de Rappi (21-oct-2026, recorrido-real.md):
 * un pedido aceptado trae sólo `taken_visible_order`, y uno nunca aceptado trae `[]`.
 */
import * as fs from 'fs'
import * as path from 'path'

import prisma from '../../../../src/utils/prismaClient'
import {
  anotarAceptacion,
  leerEstado,
  leerHistorial,
  leerRespuestaDelHistorial,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'

const SANDBOX = path.join(__dirname, 'fixtures/rappi/sandbox')
const crudo = (archivo: string) => fs.readFileSync(path.join(SANDBOX, archivo), 'utf8')

describe('leerHistorial', () => {
  it('🔴 el ejemplo de la documentación: cancelado después de aceptado ⇒ YA_NO_ACTIVO (no se registra)', () => {
    expect(leerHistorial([{ event: 'canceled_with_charge' }, { event: 'taken_visible_order' }])).toBe('YA_NO_ACTIVO')
  })

  it('🔴 el historial REAL de un pedido aceptado (sólo `taken_visible_order`) ⇒ ACEPTADO', () => {
    expect(leerHistorial(JSON.parse(crudo('eventos-aceptado.json')))).toBe('ACEPTADO')
  })

  it('el historial REAL de un pedido nunca aceptado (`[]`) ⇒ INCIERTO', () => {
    expect(leerHistorial(JSON.parse(crudo('eventos-vacio.json')))).toBe('INCIERTO')
  })

  it('eventos que no son ni aceptación ni cierre (repartidor, ETA) ⇒ INCIERTO', () => {
    expect(leerHistorial([{ event: 'courier_assigned' }, { event: 'arrived_at_store' }])).toBe('INCIERTO')
  })

  it('no distingue mayúsculas, y un evento sin nombre no cuenta', () => {
    expect(leerHistorial([{}, { event: 'TAKEN_VISIBLE_ORDER' }])).toBe('ACEPTADO')
    expect(leerHistorial([{ event: 'taken_visible_order' }, { event: 'Order_Timeout' }])).toBe('YA_NO_ACTIVO')
    expect(leerHistorial([{ event: 'rejected_by_store' }])).toBe('YA_NO_ACTIVO')
    expect(leerHistorial([{ event_time: '2026-10-21T22:26:18' }])).toBe('INCIERTO')
  })
})

describe('leerRespuestaDelHistorial — `null` es «no se pudo leer», `[]` es «se leyó y no hay eventos»', () => {
  it('el cuerpo REAL de un aceptado se entiende', () => {
    expect(leerRespuestaDelHistorial({ ok: true, status: 200, raw: crudo('eventos-aceptado.json') })).toEqual([
      { event: 'taken_visible_order', event_time: '2026-10-21T22:26:18' },
    ])
  })

  it('🔴 el cuerpo REAL de un nunca aceptado da `[]`, NO `null`', () => {
    expect(leerRespuestaDelHistorial({ ok: true, status: 200, raw: crudo('eventos-vacio.json') })).toEqual([])
  })

  it.each([
    ['un status distinto de 2xx', { ok: false, status: 500, raw: '[]' }],
    ['un 404', { ok: false, status: 404, raw: '{"message":"not found"}' }],
    ['un cuerpo que no es JSON', { ok: true, status: 200, raw: '<html>error</html>' }],
    ['un cuerpo vacío', { ok: true, status: 200, raw: '' }],
    ['un objeto en vez de una lista', { ok: true, status: 200, raw: '{"events":[]}' }],
  ])('%s ⇒ null', (_caso, r) => {
    expect(leerRespuestaDelHistorial(r)).toBeNull()
  })

  it('un renglón que no es objeto, o con campos de otro tipo, queda como evento sin nombre', () => {
    expect(leerRespuestaDelHistorial({ ok: true, status: 200, raw: '[null, 7, {"event": 3}, {"event": "taken_visible_order"}]' })).toEqual([
      {},
      {},
      {},
      { event: 'taken_visible_order' },
    ])
  })
})

describe('leerEstado', () => {
  it('sin nada guardado (los pedidos de Rappi no traen `resourcePayload`) ⇒ estado vacío', () => {
    expect(leerEstado(null)).toEqual({})
  })

  it('lee la marca de aceptación y el contador de «listo»', () => {
    const guardado = {
      aceptacion: { en: '2026-10-21T22:26:18.000Z', evidencia: 'HTTP_2XX' },
      listo: { llamadas: 2, cerrado: 'TOPE' },
    }
    expect(leerEstado(guardado)).toEqual(guardado)
  })

  it('una marca con evidencia desconocida o sin fecha NO cuenta como aceptación', () => {
    expect(leerEstado({ aceptacion: { en: '2026-10-21T22:26:18.000Z', evidencia: 'ADIVINANZA' } })).toEqual({})
    expect(leerEstado({ aceptacion: { evidencia: 'HISTORIAL_TAKEN' } })).toEqual({})
    expect(leerEstado({ aceptacion: 'sí' })).toEqual({})
  })

  it('basura (lista, texto, número, contador inválido) ⇒ estado vacío, sin lanzar', () => {
    expect(leerEstado([1, 2] as never)).toEqual({})
    expect(leerEstado('x')).toEqual({})
    expect(leerEstado(3)).toEqual({})
    expect(leerEstado({ listo: { llamadas: -1 } })).toEqual({})
    expect(leerEstado({ listo: { llamadas: 1, cerrado: 'OTRO' } })).toEqual({ listo: { llamadas: 1 } })
  })
})

describe('anotarAceptacion', () => {
  const ejecutar = (prisma as any).$executeRaw as jest.Mock
  const sql = () => (ejecutar.mock.calls[0][0] as TemplateStringsArray).join('?')
  const valores = () => ejecutar.mock.calls[0].slice(1)

  it('🔴 escribe SÓLO si el reclamo sigue siendo suyo: el UPDATE va condicionado al token', async () => {
    ejecutar.mockResolvedValueOnce(1)

    expect(await anotarAceptacion('evt1', 'tok-1', 'HTTP_2XX')).toBe(true)

    expect(sql()).toMatch(/UPDATE "DeliveryOrderEvent"/)
    expect(sql()).toMatch(/"id" = \?/)
    expect(sql()).toMatch(/"claimToken" = \?/)
    expect(valores()).toEqual(expect.arrayContaining(['evt1', 'tok-1']))
  })

  it('🔴 MEZCLA dentro de resourcePayload (el contador de «listo» vive ahí): no lo reemplaza', async () => {
    ejecutar.mockResolvedValueOnce(1)

    await anotarAceptacion('evt1', 'tok-1', 'HISTORIAL_TAKEN')

    expect(sql()).toMatch(/"resourcePayload" = .*\|\| jsonb_build_object\('aceptacion'/s)
    const marca = JSON.parse(valores().find((v: unknown) => typeof v === 'string' && v.startsWith('{')))
    expect(marca).toEqual({ en: expect.any(String), evidencia: 'HISTORIAL_TAKEN' })
    expect(new Date(marca.en).toISOString()).toBe(marca.en)
  })

  it('con el reclamo de otro (0 filas) devuelve false: quien llama no ingiere', async () => {
    ejecutar.mockResolvedValueOnce(0)

    expect(await anotarAceptacion('evt1', 'tok-viejo', 'HTTP_2XX')).toBe(false)
  })
})
