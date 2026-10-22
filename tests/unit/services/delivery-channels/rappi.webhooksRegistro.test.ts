/**
 * Registro de los avisos de Rappi — el plan (`planDeWebhooks`) y las dos lecturas puras que usa el script.
 *
 * Lo que estos tests protegen: que correr el script dos veces no duplique ni pise nada (la segunda vez todo es NADA),
 * que cada URL termine en un segmento que el ingreso SÍ entiende, y que nunca salga un CREAR sin tiendas — en Rappi,
 * un webhook sin `stores` aplica a TODAS las tiendas del cliente.
 */
import { eventoDeLaRuta, RUTA_POR_EVENTO } from '../../../../src/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { RAPPI_EVENTS } from '../../../../src/services/delivery-channels/providers/rappi/rappi.adapter'
import {
  azpDelJwt,
  eventosARotar,
  planDeWebhooks,
  registradosDeRespuesta,
  secretoDeLaIntegracion,
  type AccionWebhook,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.webhooksRegistro'

const BASE = 'https://abc.ngrok.app'
const TIENDAS = ['900175499', '900175500']
const EVENTOS_DE_TIENDA = Object.values(RUTA_POR_EVENTO).filter(e => e !== RAPPI_EVENTS.STORE_PROVISIONING_STATUS)
const urlDe = (segmento: string, base = BASE) => `${base}/api/v1/webhooks/delivery/rappi/${segmento}`
const segmentoDe = (evento: string) => Object.entries(RUTA_POR_EVENTO).find(([, e]) => e === evento)![0]

type Registrado = { evento: string; url: string; tiendas: string[] }
type DeIntegracion = { evento: string; url: string }

/** Lo que Rappi tendría guardado después de ejecutar el plan: el espejo de lo que hace el script. */
function aplicar(plan: AccionWebhook[], registrados: Registrado[], deIntegracion: DeIntegracion[]) {
  const reg = registrados.map(r => ({ ...r, tiendas: [...r.tiendas] }))
  const integ = [...deIntegracion]
  for (const a of plan) {
    if (a.tipo === 'CREAR') reg.push({ evento: a.evento, url: a.url, tiendas: [...a.tiendas] })
    if (a.tipo === 'AGREGAR_TIENDAS') reg.push({ evento: a.evento, url: a.url, tiendas: [...a.tiendas] })
    if (a.tipo === 'CAMBIAR_URL') {
      for (const r of reg) if (r.evento === a.evento) r.tiendas = r.tiendas.filter(t => !a.tiendas.includes(t))
      reg.push({ evento: a.evento, url: a.url, tiendas: [...a.tiendas] })
    }
    if (a.tipo === 'CREAR_DE_INTEGRACION') {
      const i = integ.findIndex(x => x.evento === a.evento)
      if (i >= 0) integ.splice(i, 1)
      integ.push({ evento: a.evento, url: a.url })
    }
  }
  return { registrados: reg.filter(r => r.tiendas.length > 0), deIntegracion: integ }
}

/** Todo registrado como el plan lo quiere: punto de partida para tocar una sola cosa. */
function todoAlDia(): { registrados: Registrado[]; deIntegracion: DeIntegracion[] } {
  return aplicar(planDeWebhooks([], [], BASE, TIENDAS), [], [])
}

describe('planDeWebhooks', () => {
  // ── 1 · FUNCIÓN NUEVA ───────────────────────────────────────────────────────────────
  it('sin nada registrado ⇒ 10 CREAR (todas las tiendas) + 1 CREAR_DE_INTEGRACION', () => {
    const plan = planDeWebhooks([], [], BASE, TIENDAS)

    const crear = plan.filter(a => a.tipo === 'CREAR')
    expect(plan).toHaveLength(11)
    expect(crear).toHaveLength(10)
    expect(crear.map(a => a.evento).sort()).toEqual([...EVENTOS_DE_TIENDA].sort())
    for (const a of crear) {
      expect(a).toMatchObject({ tiendas: TIENDAS, url: urlDe(segmentoDe(a.evento)) })
    }
    expect(plan.filter(a => a.tipo === 'CREAR_DE_INTEGRACION')).toEqual([
      { tipo: 'CREAR_DE_INTEGRACION', evento: 'STORE_PROVISIONING_STATUS', url: urlDe('store-provisioning') },
    ])
  })

  it('🔴 correrlo dos veces: la segunda vez todo es NADA', () => {
    const primera = planDeWebhooks([], [], BASE, TIENDAS)
    const { registrados, deIntegracion } = aplicar(primera, [], [])

    const segunda = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS)

    expect(segunda).toHaveLength(11)
    expect(segunda.every(a => a.tipo === 'NADA')).toBe(true)
    expect(segunda.map(a => a.evento).sort()).toEqual([...EVENTOS_DE_TIENDA, RAPPI_EVENTS.STORE_PROVISIONING_STATUS].sort())
  })

  it('misma tienda con otra URL (túnel nuevo) ⇒ CAMBIAR_URL sólo de esa tienda y de ese evento', () => {
    const { registrados, deIntegracion } = todoAlDia()
    const viejo = registrados.map(r =>
      r.evento === RAPPI_EVENTS.NEW_ORDER ? { ...r, url: urlDe('new-order', 'https://viejo.ngrok.app') } : r,
    )

    const plan = planDeWebhooks(viejo, deIntegracion, BASE, TIENDAS)

    expect(plan.filter(a => a.tipo !== 'NADA')).toEqual([
      { tipo: 'CAMBIAR_URL', evento: RAPPI_EVENTS.NEW_ORDER, url: urlDe('new-order'), tiendas: TIENDAS },
    ])
  })

  it('falta una tienda de la lista ⇒ AGREGAR_TIENDAS con sólo la que falta (nunca un CREAR sobre un evento ya registrado)', () => {
    const { registrados, deIntegracion } = todoAlDia()
    const sinLaSegunda = registrados.map(r => (r.evento === RAPPI_EVENTS.PING ? { ...r, tiendas: [TIENDAS[0]] } : r))

    const plan = planDeWebhooks(sinLaSegunda, deIntegracion, BASE, TIENDAS)

    expect(plan.filter(a => a.tipo !== 'NADA')).toEqual([
      { tipo: 'AGREGAR_TIENDAS', evento: RAPPI_EVENTS.PING, url: urlDe('ping'), tiendas: [TIENDAS[1]] },
    ])
  })

  it('una tienda con otra URL y otra que falta, en el mismo evento ⇒ CAMBIAR_URL y AGREGAR_TIENDAS', () => {
    const { deIntegracion } = todoAlDia()
    const registrados = [
      { evento: RAPPI_EVENTS.MENU_APPROVED, url: urlDe('menu-approved', 'https://viejo.ngrok.app'), tiendas: [TIENDAS[0]] },
    ]

    const plan = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS).filter(a => a.evento === RAPPI_EVENTS.MENU_APPROVED)

    expect(plan).toEqual([
      { tipo: 'CAMBIAR_URL', evento: RAPPI_EVENTS.MENU_APPROVED, url: urlDe('menu-approved'), tiendas: [TIENDAS[0]] },
      { tipo: 'AGREGAR_TIENDAS', evento: RAPPI_EVENTS.MENU_APPROVED, url: urlDe('menu-approved'), tiendas: [TIENDAS[1]] },
    ])
  })

  it('un evento ya registrado sólo para OTRA tienda ⇒ AGREGAR_TIENDAS (un CREAR podría pisar lo que ya hay)', () => {
    const registrados = [{ evento: RAPPI_EVENTS.NEW_ORDER, url: urlDe('new-order'), tiendas: ['999'] }]

    const plan = planDeWebhooks(registrados, [], BASE, TIENDAS).filter(a => a.evento === RAPPI_EVENTS.NEW_ORDER)

    expect(plan).toEqual([{ tipo: 'AGREGAR_TIENDAS', evento: RAPPI_EVENTS.NEW_ORDER, url: urlDe('new-order'), tiendas: TIENDAS }])
  })

  it('el aviso de la integración con otra URL ⇒ CREAR_DE_INTEGRACION (el POST de Rappi también actualiza)', () => {
    const { registrados } = todoAlDia()
    const viejo = [
      { evento: 'STORE_PROVISIONING_STATUS', url: 'https://viejo.ngrok.app/api/v1/webhooks/delivery/rappi/store-provisioning' },
    ]

    const plan = planDeWebhooks(registrados, viejo, BASE, TIENDAS)

    expect(plan.filter(a => a.tipo !== 'NADA')).toEqual([
      { tipo: 'CREAR_DE_INTEGRACION', evento: 'STORE_PROVISIONING_STATUS', url: urlDe('store-provisioning') },
    ])
  })

  // 🔴 El secreto de la integración es NUESTRO y Rappi no lo vuelve a mostrar ni tiene `reset-secret` para ese aviso. Si el
  // archivo no lo tiene (POST con timeout que Rappi sí guardó, o un --salida distinto), el único remedio es volver a mandarlo.
  it('🔴 sin el secreto de la integración guardado ⇒ CREAR_DE_INTEGRACION aunque la URL ya coincida (el POST es un upsert)', () => {
    const { registrados, deIntegracion } = todoAlDia()

    const plan = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS, false)

    expect(plan.filter(a => a.tipo !== 'NADA')).toEqual([
      { tipo: 'CREAR_DE_INTEGRACION', evento: 'STORE_PROVISIONING_STATUS', url: urlDe('store-provisioning') },
    ])
    // los 10 de tienda no se tocan: su secreto lo devolvió Rappi y no depende de esto
    expect(plan.filter(a => a.tipo === 'NADA')).toHaveLength(10)
  })

  it('con el secreto guardado y la misma URL ⇒ NADA (explícito y por omisión)', () => {
    const { registrados, deIntegracion } = todoAlDia()

    for (const plan of [
      planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS, true),
      planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS),
    ]) {
      expect(plan.every(a => a.tipo === 'NADA')).toBe(true)
    }
  })

  it('sin el secreto guardado y sin nada registrado: sigue siendo UN solo CREAR_DE_INTEGRACION', () => {
    const plan = planDeWebhooks([], [], BASE, TIENDAS, false)

    expect(plan.filter(a => a.tipo === 'CREAR_DE_INTEGRACION')).toHaveLength(1)
    expect(plan.filter(a => a.tipo === 'CREAR')).toHaveLength(10)
  })

  it('nunca incluye STORE_PROVISIONING_STATUS entre los de tienda', () => {
    const plan = planDeWebhooks([], [], BASE, TIENDAS)

    const porTienda = plan.filter(a => a.tipo === 'CREAR' || a.tipo === 'CAMBIAR_URL' || a.tipo === 'AGREGAR_TIENDAS')
    expect(porTienda.map(a => a.evento)).not.toContain('STORE_PROVISIONING_STATUS')
    expect(plan.filter(a => a.evento === 'STORE_PROVISIONING_STATUS').map(a => a.tipo)).toEqual(['CREAR_DE_INTEGRACION'])
  })

  it('🔴 sin tiendas escribibles LANZA: un webhook sin `stores` aplicaría a TODAS las tiendas del cliente', () => {
    expect(() => planDeWebhooks([], [], BASE, [])).toThrow(/tiendas/i)
  })

  it('una base con barra final no deja «//» en la URL', () => {
    const plan = planDeWebhooks([], [], `${BASE}/`, TIENDAS)

    expect(plan.find(a => a.evento === RAPPI_EVENTS.PING)).toMatchObject({ url: urlDe('ping') })
  })

  // ── 2 · REGRESIÓN: lo que ya existía y el plan no debe romper ───────────────────────
  it('cada URL del plan termina en una ruta que el ingreso traduce al MISMO evento', () => {
    const plan = planDeWebhooks([], [], BASE, TIENDAS)

    for (const a of plan) {
      if (a.tipo === 'NADA') continue
      const segmento = a.url.split('/').pop()
      expect(eventoDeLaRuta(segmento)).toBe(a.evento)
    }
  })
})

describe('secretoDeLaIntegracion', () => {
  const nuncaGenerar = () => {
    throw new Error('no debía generar un secreto nuevo')
  }

  it('🔴 reutiliza el CONFIRMADO del archivo (un túnel nuevo no rota un secreto que el env del servidor ya tiene)', () => {
    expect(secretoDeLaIntegracion({ STORE_PROVISIONING_STATUS: 'el-de-siempre', NEW_ORDER: 'otro' }, undefined, nuncaGenerar)).toEqual({
      secreto: 'el-de-siempre',
      origen: 'ARCHIVO',
    })
    // el confirmado manda sobre un pendiente viejo
    expect(secretoDeLaIntegracion({ STORE_PROVISIONING_STATUS: 'el-de-siempre' }, 'pendiente-viejo', nuncaGenerar)).toEqual({
      secreto: 'el-de-siempre',
      origen: 'ARCHIVO',
    })
  })

  it('🔴 sin confirmado pero con uno PENDIENTE (un POST que no se confirmó) reintenta con ESE mismo, sin inventar otro', () => {
    expect(secretoDeLaIntegracion({ NEW_ORDER: 'abc' }, ' el-pendiente \n', nuncaGenerar)).toEqual({
      secreto: 'el-pendiente',
      origen: 'PENDIENTE',
    })
  })

  it('sin nada genera uno NUEVO (aunque haya secretos de otros eventos)', () => {
    expect(secretoDeLaIntegracion({ NEW_ORDER: 'abc' }, undefined, () => 'recien-hecho')).toEqual({
      secreto: 'recien-hecho',
      origen: 'NUEVO',
    })
    expect(secretoDeLaIntegracion({}, '   ', () => 'recien-hecho')).toEqual({ secreto: 'recien-hecho', origen: 'NUEVO' })
  })

  it('un valor vacío o que no es texto en el archivo cuenta como «sin secreto»; una lista usa el primero', () => {
    expect(secretoDeLaIntegracion({ STORE_PROVISIONING_STATUS: '  ' }, undefined, () => 'x')).toEqual({ secreto: 'x', origen: 'NUEVO' })
    expect(secretoDeLaIntegracion({ STORE_PROVISIONING_STATUS: 123 }, undefined, () => 'x')).toEqual({ secreto: 'x', origen: 'NUEVO' })
    expect(secretoDeLaIntegracion({ STORE_PROVISIONING_STATUS: ['uno', 'dos'] }, undefined, nuncaGenerar)).toEqual({
      secreto: 'uno',
      origen: 'ARCHIVO',
    })
  })
})

// 🔴 Hallazgo #1 de Codex (bloque 0): Rappi crea el aviso pero la respuesta (con su secreto) se pierde. Al repetir, el plan ve la
// tienda y la URL bien ⇒ NADA, y el archivo se queda sin ese secreto para siempre (el servidor rechaza esos avisos con 401).
describe('eventosARotar', () => {
  const INTEGRACION = RAPPI_EVENTS.STORE_PROVISIONING_STATUS
  /** El archivo de secretos completo (los 10 de tienda + el de la integración), menos los eventos que se pidan. */
  const archivoSin = (...faltan: string[]): Record<string, unknown> =>
    Object.fromEntries([...EVENTOS_DE_TIENDA, INTEGRACION].filter(e => !faltan.includes(e)).map(e => [e, `secreto-${e}`]))
  /** Cada acción del plan con su desenlace: `aceptada` = Rappi contestó 2xx. */
  const resultados = (plan: AccionWebhook[], rechazadas: string[] = []) =>
    plan.map(accion => ({ accion, aceptada: !rechazadas.includes(accion.evento) }))

  // ── 1 · FUNCIÓN NUEVA ───────────────────────────────────────────────────────────────
  it('🔴 un aviso que Rappi YA tiene y el archivo no (la respuesta del CREAR se perdió) ⇒ se rota', () => {
    const { registrados, deIntegracion } = todoAlDia()
    const plan = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS) // todo NADA: la URL y la tienda están bien

    expect(eventosARotar(registrados, resultados(plan), archivoSin(RAPPI_EVENTS.NEW_ORDER))).toEqual([RAPPI_EVENTS.NEW_ORDER])
  })

  it('los que tienen secreto en el archivo NO se rotan (tampoco con una lista de rotación)', () => {
    const { registrados, deIntegracion } = todoAlDia()
    const plan = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS)

    expect(eventosARotar(registrados, resultados(plan), archivoSin())).toEqual([])
    expect(eventosARotar(registrados, resultados(plan), { ...archivoSin(), PING: ['nuevo', 'viejo'] })).toEqual([])
  })

  it('🔴 el de la INTEGRACIÓN nunca se rota así (no tiene reset-secret), aunque falte y aunque Rappi lo muestre', () => {
    const { registrados, deIntegracion } = todoAlDia()
    const plan = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS, false) // ⇒ CREAR_DE_INTEGRACION aceptado
    const conIntegracionLeida = [...registrados, { evento: INTEGRACION, url: urlDe('store-provisioning'), tiendas: TIENDAS }]

    expect(eventosARotar(conIntegracionLeida, resultados(plan), archivoSin(INTEGRACION))).toEqual([])
  })

  it('🔴 un CREAR que FALLÓ en esta corrida, si el aviso no existía, NO se rota (no hay nada que rotar en Rappi)', () => {
    const plan = planDeWebhooks([], [], BASE, TIENDAS) // nada existía: 10 CREAR

    expect(eventosARotar([], resultados(plan, [RAPPI_EVENTS.NEW_ORDER]), archivoSin(RAPPI_EVENTS.NEW_ORDER))).toEqual([])
  })

  it('un CREAR que Rappi ACEPTÓ pero cuya respuesta no trajo el secreto ⇒ se rota (ya existe allá)', () => {
    const plan = planDeWebhooks([], [], BASE, TIENDAS)

    expect(eventosARotar([], resultados(plan), archivoSin(RAPPI_EVENTS.PING))).toEqual([RAPPI_EVENTS.PING])
  })

  it('un CAMBIAR_URL o AGREGAR_TIENDAS que falló sobre un aviso ya leído ⇒ se rota igual: existía en Rappi', () => {
    const { deIntegracion } = todoAlDia()
    const registrados = [
      { evento: RAPPI_EVENTS.MENU_APPROVED, url: urlDe('menu-approved', 'https://viejo.ngrok.app'), tiendas: [TIENDAS[0]] },
    ]
    const plan = planDeWebhooks(registrados, deIntegracion, BASE, TIENDAS)

    const rotar = eventosARotar(
      registrados,
      resultados(plan, [RAPPI_EVENTS.MENU_APPROVED]),
      archivoSin(RAPPI_EVENTS.MENU_APPROVED, RAPPI_EVENTS.NEW_ORDER),
    )

    // MENU_APPROVED existía (leído); NEW_ORDER lo creó esta corrida (CREAR aceptado). Los dos, sin secreto ⇒ se rotan.
    expect(rotar.sort()).toEqual([RAPPI_EVENTS.MENU_APPROVED, RAPPI_EVENTS.NEW_ORDER].sort())
  })

  it('cada evento sale UNA vez y en el orden de los avisos, aunque tenga varias acciones o varias URLs leídas', () => {
    const registrados = [
      { evento: RAPPI_EVENTS.PING, url: urlDe('ping', 'https://viejo.ngrok.app'), tiendas: [TIENDAS[0]] },
      { evento: RAPPI_EVENTS.PING, url: urlDe('ping', 'https://otro.ngrok.app'), tiendas: ['999'] },
      { evento: RAPPI_EVENTS.NEW_ORDER, url: urlDe('new-order'), tiendas: TIENDAS },
    ]
    const plan = planDeWebhooks(registrados, [], BASE, TIENDAS)

    const rotar = eventosARotar(registrados, resultados(plan), archivoSin(RAPPI_EVENTS.PING, RAPPI_EVENTS.NEW_ORDER))

    expect(rotar).toEqual(EVENTOS_DE_TIENDA.filter(e => e === RAPPI_EVENTS.PING || e === RAPPI_EVENTS.NEW_ORDER))
  })
})

describe('registradosDeRespuesta', () => {
  it('agrupa las tiendas por URL, con el formato de GET /webhook/{evento}', () => {
    const cuerpo = [
      {
        event: 'NEW_ORDER',
        stores: [
          { store_id: '1', url: 'https://a/x', state: 'ENABLE' },
          { store_id: '2', url: 'https://a/x', state: 'ENABLE' },
          { store_id: '3', url: 'https://b/x', state: 'ENABLE' },
        ],
      },
    ]

    expect(registradosDeRespuesta('NEW_ORDER', cuerpo)).toEqual({
      registrados: [
        { evento: 'NEW_ORDER', url: 'https://a/x', tiendas: ['1', '2'] },
        { evento: 'NEW_ORDER', url: 'https://b/x', tiendas: ['3'] },
      ],
      deshabilitadas: 0,
    })
  })

  it('acepta un objeto suelto en vez de una lista, y las listas vacías (nada registrado)', () => {
    expect(registradosDeRespuesta('PING', { event: 'PING', stores: [{ store_id: 7, url: 'https://a/p', state: 'ENABLE' }] })).toEqual({
      registrados: [{ evento: 'PING', url: 'https://a/p', tiendas: ['7'] }],
      deshabilitadas: 0,
    })
    expect(registradosDeRespuesta('PING', [])).toEqual({ registrados: [], deshabilitadas: 0 })
    expect(registradosDeRespuesta('PING', { event: 'PING', stores: [] })).toEqual({ registrados: [], deshabilitadas: 0 })
  })

  it('ignora otros eventos, cuenta las tiendas en DISABLE (siguen registradas) y no revienta con basura', () => {
    const cuerpo = [
      { event: 'OTRO', stores: [{ store_id: '9', url: 'https://a/o', state: 'ENABLE' }] },
      {
        event: 'PING',
        stores: [
          { store_id: '1', url: 'https://a/p', state: 'DISABLE' },
          { store_id: '2', url: 'https://a/p', state: 'ENABLE' },
          { url: 'https://a/p' },
          null,
        ],
      },
    ]

    expect(registradosDeRespuesta('PING', cuerpo)).toEqual({
      registrados: [{ evento: 'PING', url: 'https://a/p', tiendas: ['1', '2'] }],
      deshabilitadas: 1,
    })
    expect(registradosDeRespuesta('PING', null)).toEqual({ registrados: [], deshabilitadas: 0 })
    expect(registradosDeRespuesta('PING', 'no es json')).toEqual({ registrados: [], deshabilitadas: 0 })
  })
})

describe('azpDelJwt', () => {
  const jwt = (claims: unknown) => `cabecera.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.firma`

  it('lee el claim azp sin verificar la firma (base64url)', () => {
    expect(azpDelJwt(jwt({ azp: 'mi-client-id', aud: 'x' }))).toBe('mi-client-id')
  })

  it('sin azp falla en español, claro y sin copiar el token', () => {
    const token = jwt({ aud: 'x' })
    expect(() => azpDelJwt(token)).toThrow(/azp/)
    expect(() => azpDelJwt(token)).toThrow(/token/i)
    try {
      azpDelJwt(token)
    } catch (e) {
      expect((e as Error).message).not.toContain(token)
    }
  })

  it('un token que no es JWT falla igual de claro', () => {
    expect(() => azpDelJwt('esto-no-es-un-jwt')).toThrow(/JWT|token/i)
    expect(() => azpDelJwt('a.%%%.c')).toThrow(/JWT|token/i)
  })
})
