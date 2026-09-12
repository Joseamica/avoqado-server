/**
 * Diseño §C.6 + auditoría Fable 11-sep (P2-7): inventario de TODOS los sitios que escriben una orden en CANCELLED o
 * DELETED. Cada uno declara su clase:
 *
 *  - PROTEGIDA: cancela bajo el candado de la orden y rechaza con un cobro de terminal vivo (`orderCancelGuard`).
 *  - VERDAD_EXTERNA: el hecho ya ocurrió fuera (POS externo, marketplace): no se rechaza, pero se marca bajo el candado
 *    y, si quedaba un cobro vivo, grita (🚨 + ActivityLog) para conciliar.
 *  - EXENTA: con el motivo escrito AQUÍ y declarado en el código (marcador «EXENTA de §C.6»).
 *
 * Un escritor NUEVO sin clasificar tumba esta prueba: es lo que impide que vuelva a aparecer una quinta puerta que
 * cancela sin mirar el cobro. Sólo ve escrituras con el estado LITERAL; las de estado variable van en la lista de abajo.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivosTs(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const ESCRITURA_DE_ORDEN = /\.order\s*\.\s*update(?:Many)?\s*\(/
const ESTADO_QUE_CANCELA = /status:\s*(?:'CANCELLED'|'DELETED'|OrderStatus\.(?:CANCELLED|DELETED)\b)/
const INICIO_DE_FUNCION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/

function funcionQueContiene(lineas: string[], i: number): { nombre: string; cuerpo: string } {
  let inicio = i
  while (inicio >= 0 && !INICIO_DE_FUNCION.test(lineas[inicio])) inicio--
  const nombre = inicio >= 0 ? (lineas[inicio].match(INICIO_DE_FUNCION) as RegExpMatchArray)[1] : '(nivel de módulo)'
  let fin = i + 1
  while (fin < lineas.length && !INICIO_DE_FUNCION.test(lineas[fin])) fin++
  return { nombre, cuerpo: lineas.slice(Math.max(0, inicio), fin).join('\n') }
}

function escritoresDetectados(): Map<string, string> {
  const sitios = new Map<string, string>()
  for (const archivo of archivosTs(SRC)) {
    const lineas = fs.readFileSync(archivo, 'utf8').split('\n')
    lineas.forEach((linea, i) => {
      if (!ESTADO_QUE_CANCELA.test(linea)) return
      // La escritura (`.order.update(` / `.updateMany(`) está en las ~25 líneas previas: el `data` de la misma llamada.
      if (!ESCRITURA_DE_ORDEN.test(lineas.slice(Math.max(0, i - 25), i + 1).join('\n'))) return
      const { nombre, cuerpo } = funcionQueContiene(lineas, i)
      sitios.set(`${path.relative(SRC, archivo)}#${nombre}`, cuerpo)
    })
  }
  return sitios
}

type Clase =
  | { clase: 'PROTEGIDA'; marcadores: string[] }
  | { clase: 'VERDAD_EXTERNA'; marcadores: string[] }
  | { clase: 'EXENTA'; motivo: string; marcadores: string[] }

const PROTEGIDA_POR_EL_GUARD = ['assertOrderCancellableUnderLock']
const VERDAD_EXTERNA_VIGILADA = ['lockExistingOrderForPayment', 'findLiveTerminalCharge']

const INVENTARIO: Record<string, Clase> = {
  'services/mobile/order.mobile.service.ts#cancelOrder': { clase: 'PROTEGIDA', marcadores: PROTEGIDA_POR_EL_GUARD },
  'services/dashboard/order.dashboard.service.ts#deleteOrder': { clase: 'PROTEGIDA', marcadores: PROTEGIDA_POR_EL_GUARD },
  'services/mobile/areaTicketV7.mobile.service.ts#cancelAreaTicketCheckout': { clase: 'PROTEGIDA', marcadores: PROTEGIDA_POR_EL_GUARD },
  // Fusión: candado de LAS DOS órdenes en una sentencia + cobro vivo del ORIGEN.
  'services/mobile/order.mobile.service.ts#mergeOrders': {
    clase: 'PROTEGIDA',
    marcadores: ['ORDER BY id FOR UPDATE', 'assertNoLiveTerminalCharge'],
  },
  // Anular: candado + relectura con CAS de versión + G2 (cualquier anulación con cobro vivo).
  'services/tpv/order.tpv.service.ts#voidItems': {
    clase: 'PROTEGIDA',
    marcadores: ['lockAndReadOrderForCancel', 'assertNoLiveTerminalCharge'],
  },
  'services/pos-sync/posSyncOrder.service.ts#processPosOrderDeleteEvent': { clase: 'VERDAD_EXTERNA', marcadores: VERDAD_EXTERNA_VIGILADA },
  'services/delivery-channels/core/cancelDeliveryOrder.service.ts#cancelDeliveryOrder': {
    clase: 'VERDAD_EXTERNA',
    marcadores: VERDAD_EXTERNA_VIGILADA,
  },
  'services/mobile/order.mobile.service.ts#createOrderWithItems': {
    clase: 'EXENTA',
    motivo:
      'Limpieza de una promoción fallida: la orden nace y muere en la MISMA llamada (se crea, falla la promoción y se ' +
      'anula antes de devolver su id y antes del aviso por socket), así que ningún cobro de terminal pudo apuntarle.',
    marcadores: ['EXENTA de §C.6'],
  },
}

/** Escritores con el estado en una VARIABLE (el regex no los ve): se vigilan por nombre. */
const ESCRITORES_CON_ESTADO_VARIABLE: Record<string, string[]> = {
  // El PUT del dashboard escribe `status` del cuerpo: a CANCELLED/DELETED va por la cancelación protegida.
  'services/dashboard/order.dashboard.service.ts#updateOrder': PROTEGIDA_POR_EL_GUARD,
}

describe('Inventario de escritores que cancelan una orden (§C.6)', () => {
  const detectados = escritoresDetectados()

  it('cada escritura a CANCELLED/DELETED de una orden está clasificada — ninguna nueva sin revisar', () => {
    expect([...detectados.keys()].sort()).toEqual(Object.keys(INVENTARIO).sort())
  })

  it.each(Object.entries(INVENTARIO))('%s cumple su clase', (sitio, clase) => {
    const cuerpo = detectados.get(sitio) ?? ''
    for (const marcador of clase.marcadores) expect({ sitio, tiene: marcador, ok: cuerpo.includes(marcador) }).toMatchObject({ ok: true })
    if (clase.clase === 'EXENTA') expect(clase.motivo.length).toBeGreaterThan(40)
  })

  it.each(Object.entries(ESCRITORES_CON_ESTADO_VARIABLE))('%s (estado variable) pasa por la cancelación protegida', (sitio, marcadores) => {
    const [archivo, funcion] = sitio.split('#')
    const lineas = fs.readFileSync(path.join(SRC, archivo), 'utf8').split('\n')
    const i = lineas.findIndex(l => (l.match(INICIO_DE_FUNCION) ?? [])[1] === funcion)
    expect(i).toBeGreaterThanOrEqual(0)
    const { cuerpo } = funcionQueContiene(lineas, i)
    for (const marcador of marcadores) expect(cuerpo).toContain(marcador)
  })
})
