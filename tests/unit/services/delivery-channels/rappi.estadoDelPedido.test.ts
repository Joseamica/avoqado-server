/**
 * El estado de un pedido de Rappi del lado de Rappi (Tarea 9): la marca de aceptación y la lectura del historial.
 *
 * Los cuerpos del historial son REALES, del sandbox DEV de Rappi (21-oct-2026, recorrido-real.md):
 * un pedido aceptado trae sólo `taken_visible_order`, y uno nunca aceptado trae `[]`.
 */
import * as fs from 'fs'
import * as path from 'path'

import prisma from '../../../../src/utils/prismaClient'
import logger from '../../../../src/config/logger'
import {
  analizarHistorial,
  anotarAceptacion,
  cerrarListo,
  devolverLlamadaDeListo,
  esTransicionInvalida,
  leerEstado,
  leerHistorial,
  leerRespuestaDelHistorial,
  MAX_LLAMADAS_LISTO,
  reservarLlamadaDeListo,
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

// Tarea 10 (decisión del controlador sobre la revisión de la Tarea 9): los logs llevan los NOMBRES del historial, y
// «aceptado y después cerrado» se distingue de «nunca aceptado y vencido» (el primero pide a una persona).
describe('analizarHistorial — el veredicto, los nombres y si traía la aceptación', () => {
  it('aceptado y después cancelado: YA_NO_ACTIVO, pero con la aceptación a la vista', () => {
    expect(analizarHistorial([{ event: 'canceled_with_charge' }, { event: ' taken_visible_order ' }])).toEqual({
      veredicto: 'YA_NO_ACTIVO',
      nombres: ['canceled_with_charge', 'taken_visible_order'],
      traeAceptacion: true,
    })
  })

  it('nunca aceptado y vencido: YA_NO_ACTIVO sin aceptación', () => {
    expect(analizarHistorial([{ event: 'canceled_by_timeout' }])).toEqual({
      veredicto: 'YA_NO_ACTIVO',
      nombres: ['canceled_by_timeout'],
      traeAceptacion: false,
    })
  })

  it('el historial REAL vacío: INCIERTO, sin nombres; un evento sin nombre no aparece', () => {
    expect(analizarHistorial(JSON.parse(crudo('eventos-vacio.json')))).toEqual({
      veredicto: 'INCIERTO',
      nombres: [],
      traeAceptacion: false,
    })
    expect(analizarHistorial([{}, { event: 'courier_assigned' }])).toEqual({
      veredicto: 'INCIERTO',
      nombres: ['courier_assigned'],
      traeAceptacion: false,
    })
  })

  it('leerHistorial sigue diciendo lo mismo que el veredicto del análisis', () => {
    const casos = [[], [{ event: 'taken_visible_order' }], [{ event: 'taken_visible_order' }, { event: 'Order_Timeout' }]]
    for (const eventos of casos) expect(leerHistorial(eventos)).toBe(analizarHistorial(eventos).veredicto)
  })

  it('los nombres se acotan a 30 (un historial largo de repartidor no llena el log)', () => {
    const largo = Array.from({ length: 40 }, (_, i) => ({ event: `courier_${i}` }))
    expect(analizarHistorial(largo).nombres).toHaveLength(30)
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
    expect(leerEstado({ aceptacion: { en: 'ayer', evidencia: 'HTTP_2XX' } })).toEqual({})
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
    const en = new Date('2026-10-22T10:01:00.000Z')
    await anotarAceptacion('evt1', 'tok-1', 'HISTORIAL_TAKEN', en)

    expect(sql()).toMatch(/"resourcePayload" = .*\|\| jsonb_build_object\('aceptacion'/s)
    const marca = JSON.parse(valores().find((v: unknown) => typeof v === 'string' && v.startsWith('{')))
    expect(marca).toEqual({ en: en.toISOString(), evidencia: 'HISTORIAL_TAKEN' })
    expect(new Date(marca.en).toISOString()).toBe(marca.en)
  })

  it('con el reclamo de otro (0 filas) devuelve false: quien llama no ingiere', async () => {
    ejecutar.mockResolvedValueOnce(0)

    expect(await anotarAceptacion('evt1', 'tok-viejo', 'HTTP_2XX')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────────────
//  Tarea 13: el «listo» de Rappi, a lo más 3 llamadas por pedido, contadas en la base ANTES de llamar
// ────────────────────────────────────────────────────────────────────────────────────

/** El cuerpo REAL del 424 del sandbox DEV (M4, recorrido-real.md, 21-oct): antes y después del tiempo de cocina. */
const CUERPO_424_REAL =
  '{"message":"424 {\\"code\\":\\"error.ready_for_pickup.unsuccessful\\",\\"message\\":\\"No se pudo procesar su solicitud, por favor intentelo mas tarde.\\"}"}'
/** El texto REAL de «transición inválida» que dio Rappi al rechazar un pedido TOMADO (M11, 21-oct). */
const TRANSICION_INVALIDA_REAL =
  '[ORDER 722609056] Invalid transition from {TAKEN} to {REJECTED} state, check out https://dev-portal.rappi.com/managing-user-orders/#order-status for further details'

describe('esTransicionInvalida', () => {
  it('el cuerpo real del 424 tiene la forma esperada (envuelto en otro `message`)', () => {
    const exterior = JSON.parse(CUERPO_424_REAL) as { message: string }
    expect(exterior.message.startsWith('424 {')).toBe(true)
    expect(JSON.parse(exterior.message.slice(4))).toEqual({
      code: 'error.ready_for_pickup.unsuccessful',
      message: 'No se pudo procesar su solicitud, por favor intentelo mas tarde.',
    })
  })

  it('🔴 el 424 REAL («inténtelo más tarde») NO es transición inválida: no cierra el «listo»', () => {
    expect(esTransicionInvalida(CUERPO_424_REAL)).toBe(false)
  })

  it('el texto real de Rappi («Invalid transition from {TAKEN} to …»), suelto o como `message` de un JSON', () => {
    expect(esTransicionInvalida(TRANSICION_INVALIDA_REAL)).toBe(true)
    expect(esTransicionInvalida(JSON.stringify({ message: TRANSICION_INVALIDA_REAL }))).toBe(true)
  })

  it('🔴 lo encuentra ADENTRO aunque venga envuelto como el 424 («400 {…}» dentro de otro `message`)', () => {
    const interior = JSON.stringify({ code: 'error.ready_for_pickup.invalid', message: TRANSICION_INVALIDA_REAL })
    expect(esTransicionInvalida(JSON.stringify({ message: `400 ${interior}` }))).toBe(true)
  })

  it('en español, con o sin acentos, aunque los acentos lleguen escapados dentro del JSON envuelto', () => {
    expect(esTransicionInvalida('Transición inválida')).toBe(true)
    expect(esTransicionInvalida('transicion invalida')).toBe(true)
    const escapado = '{"message":"400 {\\"message\\":\\"Transici\\\\u00f3n inv\\\\u00e1lida\\"}"}'
    expect(escapado).toContain('\\u00f3') // el acento viaja escapado: sin desenvolver, la expresión no lo vería
    expect(esTransicionInvalida(escapado)).toBe(true)
  })

  it('🔴 también en masculino: «Estado de transición inválido» (así lo dice la documentación de Rappi)', () => {
    expect(esTransicionInvalida('Estado de transición inválido')).toBe(true)
    expect(esTransicionInvalida('estado de transicion invalido')).toBe(true)
    expect(esTransicionInvalida(JSON.stringify({ message: '400 {"message":"Estado de transición inválido"}' }))).toBe(true)
  })

  it.each([
    ['vacío', ''],
    ['un 400 de otra cosa', '{"message":"Bad request: cookingTime out of range"}'],
    ['HTML', '<html>error</html>'],
    ['JSON roto', '{"message": "400 {roto'],
  ])('%s ⇒ false, sin lanzar', (_caso, raw) => {
    expect(esTransicionInvalida(raw)).toBe(false)
  })
})

describe('reservarLlamadaDeListo — la llamada se cuenta en la fila del NEW_ORDER, ANTES de llamar', () => {
  const consultar = (prisma as any).$queryRaw as jest.Mock
  const ejecutar = (prisma as any).$executeRaw as jest.Mock
  const sqlDe = (m: jest.Mock, i = 0) => (m.mock.calls[i][0] as TemplateStringsArray).join('?')
  const valoresDe = (m: jest.Mock, i = 0) => m.mock.calls[i].slice(1)
  const buscar = (prisma as any).deliveryOrderEvent.findFirst as jest.Mock
  const LLAVE = 'RAPPI:NEW_ORDER:900175625:722609056'

  beforeEach(() => {
    consultar.mockReset()
    ejecutar.mockReset().mockResolvedValue(1)
    buscar.mockReset().mockResolvedValue(null)
  })

  it('el tope es 3: Rappi deja de hacer caso después de la TERCERA solicitud (doc «managing-user-orders»)', () => {
    expect(MAX_LLAMADAS_LISTO).toBe(3)
  })

  it('🔴 busca la fila por la llave ÚNICA del aviso (dedupKey), en una transacción y con FOR UPDATE', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: null }])

    await reservarLlamadaDeListo('722609056', '900175625')

    expect((prisma as any).$transaction).toHaveBeenCalled()
    expect(sqlDe(consultar)).toMatch(/FROM "DeliveryOrderEvent"\s+WHERE "dedupKey" = \?\s+FOR UPDATE/)
    expect(valoresDe(consultar)).toEqual([LLAVE])
    // Con la llave exacta no hace falta la búsqueda por el pedido (el camino raro).
    expect(buscar).not.toHaveBeenCalled()
  })

  // ── Codex b1 #4: un vínculo manual cambió de tienda desde SUPERADMIN ──
  // La llave guardada lleva la tienda ORIGINAL del pedido y el «listo» llega con la de HOY: por la llave no se encuentra, y
  // permitir «sin contar» dejaba salir una cuarta llamada. El contador se resuelve con lo que no cambia: el pedido.
  const BUSQUEDA_POR_EL_PEDIDO = {
    where: {
      provider: 'RAPPI',
      eventType: 'NEW_ORDER',
      externalOrderId: '722609056',
      channelLink: { is: { provider: 'RAPPI', externalLocationId: '900175625' } },
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  }

  it('🔴 sin fila por la llave de la tienda de HOY: la busca por el pedido (acotada al vínculo que hoy tiene esa tienda) y la bloquea igual', async () => {
    consultar.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'evt-original', resourcePayload: { listo: { llamadas: 1 } } }])
    buscar.mockResolvedValueOnce({ id: 'evt-original' })

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: true })

    expect(buscar).toHaveBeenCalledTimes(1)
    expect(buscar).toHaveBeenCalledWith(BUSQUEDA_POR_EL_PEDIDO)
    // La fila encontrada se bloquea por su id ANTES de leer el contador: dos «listos» a la vez cuentan en fila.
    expect(sqlDe(consultar, 1)).toMatch(/FROM "DeliveryOrderEvent"\s+WHERE "id" = \?\s+FOR UPDATE/)
    expect(valoresDe(consultar, 1)).toEqual(['evt-original'])
    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 2 })
    expect(valoresDe(ejecutar)).toContain('evt-original')
  })

  it('🔴 con las 3 llamadas ya contadas en el aviso ORIGINAL, la cuarta no sale aunque llegue con la tienda nueva', async () => {
    consultar.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'evt-original', resourcePayload: { listo: { llamadas: 3 } } }])
    buscar.mockResolvedValueOnce({ id: 'evt-original' })

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: false })
    expect(ejecutar).not.toHaveBeenCalled()
  })

  it('sin llamadas previas: permite, y guarda 1 MEZCLANDO en resourcePayload (no lo reemplaza)', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { aceptacion: { en: 'x', evidencia: 'HTTP_2XX' } } }])

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: true })

    expect(sqlDe(ejecutar)).toMatch(/"resourcePayload" = .*\|\| jsonb_build_object\('listo'/s)
    expect(sqlDe(ejecutar)).toMatch(/"id" = \?/)
    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 1 })
    expect(valoresDe(ejecutar)).toContain('evt1')
  })

  it('con 2 llamadas: permite la tercera y guarda 3', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 2 } } }])

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: true })

    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 3 })
  })

  it('🔴 con 3 llamadas: NO permite y no escribe nada (la cuarta no sale)', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 3 } } }])

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: false })
    expect(ejecutar).not.toHaveBeenCalled()
  })

  it.each(['HTTP_2XX', 'TRANSICION_INVALIDA', 'TOPE'])('ya cerrado (%s): NO permite aunque queden llamadas', async cerrado => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 1, cerrado } } }])

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: false })
    expect(ejecutar).not.toHaveBeenCalled()
  })

  it('🔴 sin el aviso por ningún camino: NO se permite (🚨, no hay dónde contar) y no escribe', async () => {
    // Permitir «sin contar» es lo que dejaba salir la cuarta llamada: el KDS y el barrido reintentan, y cada intento salía.
    // Un «listo» que no sale lo cierra Rappi solo en modo automático; uno de más es el mal uso que amenaza con revocar el acceso.
    consultar.mockResolvedValueOnce([])

    expect(await reservarLlamadaDeListo('722609056', '900175625')).toEqual({ permitido: false, sinAviso: true })
    expect(buscar).toHaveBeenCalledWith(BUSQUEDA_POR_EL_PEDIDO)
    expect(ejecutar).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/🚨.*listo/i),
      expect.objectContaining({ externalOrderId: '722609056', storeId: '900175625' }),
    )
  })
})

describe('cerrarListo — el «listo» ya no se intenta más (y por qué)', () => {
  const consultar = (prisma as any).$queryRaw as jest.Mock
  const ejecutar = (prisma as any).$executeRaw as jest.Mock
  const sqlDe = (m: jest.Mock, i = 0) => (m.mock.calls[i][0] as TemplateStringsArray).join('?')
  const valoresDe = (m: jest.Mock, i = 0) => m.mock.calls[i].slice(1)
  const buscar = (prisma as any).deliveryOrderEvent.findFirst as jest.Mock

  beforeEach(() => {
    consultar.mockReset()
    ejecutar.mockReset().mockResolvedValue(1)
    buscar.mockReset().mockResolvedValue(null)
  })

  it('🔴 usa la MISMA resolución que la reserva: con el vínculo cambiado de tienda, cierra el aviso ORIGINAL (Codex b1 #4)', async () => {
    consultar.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'evt-original', resourcePayload: { listo: { llamadas: 3 } } }])
    buscar.mockResolvedValueOnce({ id: 'evt-original' })

    await cerrarListo('722609056', '900175625', 'TOPE')

    expect(buscar).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ externalOrderId: '722609056' }) }))
    expect(valoresDe(consultar, 1)).toEqual(['evt-original'])
    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 3, cerrado: 'TOPE' })
    expect(valoresDe(ejecutar)).toContain('evt-original')
  })

  it('anota el cierre CONSERVANDO las llamadas, mezclando en resourcePayload', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 2 } } }])

    await cerrarListo('722609056', '900175625', 'HTTP_2XX')

    expect(sqlDe(consultar)).toMatch(/WHERE "dedupKey" = \?\s+FOR UPDATE/)
    expect(sqlDe(ejecutar)).toMatch(/\|\| jsonb_build_object\('listo'/)
    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 2, cerrado: 'HTTP_2XX' })
  })

  it('el PRIMER cierre manda: un TOPE posterior no borra que Rappi ya contestó 2xx', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 1, cerrado: 'HTTP_2XX' } } }])

    await cerrarListo('722609056', '900175625', 'TOPE')

    expect(ejecutar).not.toHaveBeenCalled()
  })

  it('sin la fila del aviso no hace nada y no lanza', async () => {
    consultar.mockResolvedValueOnce([])

    await expect(cerrarListo('722609056', '900175625', 'TOPE')).resolves.toBeUndefined()
    expect(ejecutar).not.toHaveBeenCalled()
  })
})

describe('devolverLlamadaDeListo — la llamada que NO salió (candado de tiendas) no gasta una de las 3', () => {
  const consultar = (prisma as any).$queryRaw as jest.Mock
  const ejecutar = (prisma as any).$executeRaw as jest.Mock
  const sqlDe = (m: jest.Mock, i = 0) => (m.mock.calls[i][0] as TemplateStringsArray).join('?')
  const valoresDe = (m: jest.Mock, i = 0) => m.mock.calls[i].slice(1)
  const buscar = (prisma as any).deliveryOrderEvent.findFirst as jest.Mock

  beforeEach(() => {
    consultar.mockReset()
    ejecutar.mockReset().mockResolvedValue(1)
    buscar.mockReset().mockResolvedValue(null)
  })

  it('🔴 resta 1 con la fila bloqueada (la misma resolución que la reserva), mezclando en resourcePayload', async () => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 2 } } }])

    await devolverLlamadaDeListo('722609056', '900175625')

    expect(sqlDe(consultar)).toMatch(/WHERE "dedupKey" = \?\s+FOR UPDATE/)
    expect(sqlDe(ejecutar)).toMatch(/\|\| jsonb_build_object\('listo'/)
    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 1 })
    expect(valoresDe(ejecutar)).toContain('evt1')
  })

  it('con el vínculo cambiado de tienda, devuelve sobre el aviso ORIGINAL (igual que la reserva)', async () => {
    consultar.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'evt-original', resourcePayload: { listo: { llamadas: 1 } } }])
    buscar.mockResolvedValueOnce({ id: 'evt-original' })

    await devolverLlamadaDeListo('722609056', '900175625')

    expect(valoresDe(consultar, 1)).toEqual(['evt-original'])
    const marca = valoresDe(ejecutar).find((v: unknown) => typeof v === 'string' && v.startsWith('{'))
    expect(JSON.parse(marca)).toEqual({ llamadas: 0 })
    expect(valoresDe(ejecutar)).toContain('evt-original')
  })

  it.each(['HTTP_2XX', 'TRANSICION_INVALIDA', 'TOPE'])(
    '🔴 si el «listo» ya cerró (%s) NO resta nada: lo cerrado no se reabre',
    async cerrado => {
      consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload: { listo: { llamadas: 2, cerrado } } }])

      await devolverLlamadaDeListo('722609056', '900175625')

      expect(ejecutar).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['contador en 0', { listo: { llamadas: 0 } }],
    ['sin contador', { aceptacion: { en: 'x', evidencia: 'HTTP_2XX' } }],
    ['sin payload', null],
  ])('🔴 con %s NO resta: nunca queda negativo', async (_caso, resourcePayload) => {
    consultar.mockResolvedValueOnce([{ id: 'evt1', resourcePayload }])

    await devolverLlamadaDeListo('722609056', '900175625')

    expect(ejecutar).not.toHaveBeenCalled()
  })

  it('sin la fila del aviso no hace nada y no lanza', async () => {
    consultar.mockResolvedValueOnce([])

    await expect(devolverLlamadaDeListo('722609056', '900175625')).resolves.toBeUndefined()
    expect(ejecutar).not.toHaveBeenCalled()
  })
})
