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
  /**
   * S9 (P2-5): una PROTEGIDA que puede anular una cuenta con `OnlineOrder` (cuenta de folio) lleva `devolverCanjesDeVentaAnuladaEnTx`,
   * que ahí convierte los beneficios en cortesía. Si no, `sinCuentaDeFolio` dice por qué nunca anula una (motivo + marcadores).
   */
  | { clase: 'PROTEGIDA'; marcadores: string[]; sinCuentaDeFolio?: { motivo: string; marcadores: string[] } }
  | { clase: 'VERDAD_EXTERNA'; marcadores: string[] }
  | { clase: 'EXENTA'; motivo: string; marcadores: string[] }

const PROTEGIDA_POR_EL_GUARD = ['assertOrderCancellableUnderLock']
/** 🔴 LEALTAD (hz:a8104ac8:D1): anular una venta que pudo traer canjes le devuelve al cliente su premio de sellos y sus puntos. */
const DEVUELVE_CANJES = 'devolverCanjesDeVentaAnuladaEnTx'
const PROTEGIDA_Y_DEVUELVE = [...PROTEGIDA_POR_EL_GUARD, DEVUELVE_CANJES]
const VERDAD_EXTERNA_VIGILADA = ['lockExistingOrderForPayment', 'findLiveTerminalCharge']

const INVENTARIO: Record<string, Clase> = {
  'services/mobile/order.mobile.service.ts#cancelOrderInTransaction': { clase: 'PROTEGIDA', marcadores: PROTEGIDA_Y_DEVUELVE },
  // Tarjetas de regalo (spec § 5.4.4): regresar el saldo y cancelar. Candado de topología (comandas → Order → mesas) +
  // cobro de terminal vivo; el guardia general no se relaja: este camino exige que TODOS los pagos sean de saldo.
  // S9 (decisión 30 del plan): en una cuenta de folio convierte sus beneficios (`soloSiEsFolio`); en otra, como hoy (no devuelve canjes).
  'services/mobile/order.mobile.service.ts#returnGiftBalanceAndCancelOrder': {
    clase: 'PROTEGIDA',
    marcadores: ['lockTableOrderScope(', 'assertNoLiveTerminalCharge', DEVUELVE_CANJES, 'soloSiEsFolio: true'],
  },
  // Tarjetas de regalo (B1 r1, clasificada en B2): el reembolso que deja en $0 una venta de tarjetas SIN pagar la cancela en la MISMA
  // tx del reembolso, que ya tiene el candado de la Order (issueRefund / recordRefund → lockExistingOrderForPayment). Con un cobro de
  // terminal vivo NO cancela (la cuenta sigue y su desenlace decide), igual que el guardia general; CAS sobre el estado + versión.
  'services/giftCards/giftCardCancel.service.ts#cerrarVentaSinPagarSiYaNoQuedaDinero': {
    clase: 'PROTEGIDA',
    marcadores: ['findLiveTerminalCharge(tx', 'if (vivo)', "status: { notIn: ['CANCELLED', 'DELETED'] }", 'version: { increment: 1 }'],
    sinCuentaDeFolio: {
      motivo:
        'Sólo cierra una cuenta de tarjetas de regalo (todos sus renglones con giftCardId, que escribe únicamente la venta de tarjetas); un pedido en línea arma sus renglones del menú y nunca la tiene.',
      marcadores: ['devolverVentaDeTarjetasEnTx'],
    },
  },
  'services/dashboard/order.dashboard.service.ts#deleteOrder': { clase: 'PROTEGIDA', marcadores: PROTEGIDA_Y_DEVUELVE },
  'services/mobile/areaTicketV7.mobile.service.ts#cancelAreaTicketCheckout': { clase: 'PROTEGIDA', marcadores: PROTEGIDA_Y_DEVUELVE },
  // Fusión: candado de LAS DOS órdenes en una sentencia + cobro vivo del ORIGEN.
  'services/mobile/order.mobile.service.ts#mergeOrdersInTransaction': {
    clase: 'PROTEGIDA',
    marcadores: ['lockTableOrderScope(', 'assertNoLiveTerminalCharge'],
    sinCuentaDeFolio: {
      motivo:
        'Juntar no anula beneficios: un folio no se junta (R53, assertNotFolioInTx) y una cuenta origen con cualquier descuento o recompensa se rechaza antes de cancelarla, así que nunca cancela una cuenta con beneficios que devolver.',
      marcadores: ['assertNotFolioInTx(tx', 'Quita los descuentos (o la recompensa) de la cuenta origen'],
    },
  },
  // Anular: candado + relectura con CAS de versión + G2 (cualquier anulación con cobro vivo).
  'services/tpv/order.tpv.service.ts#voidItems': {
    clase: 'PROTEGIDA',
    marcadores: [
      'bloquearCuentaParaEditar',
      'tx.order.findUnique',
      'assertNoLiveTerminalCharge',
      DEVUELVE_CANJES,
      // S9: anular TODOS los renglones de un folio se rechaza ANTES de devolver (se cancela como pedido, que conserva su precio).
      'FOLIO_SE_CANCELA_COMO_PEDIDO',
    ],
  },
  // hz:a8104ac8:D1 (Codex r2 #2): una venta vacía y abandonada que traía canjes no se borra: se devuelven y se ANULA (borrada, un
  // reintento de su creación la volvería a crear y quemaría otra vez el premio). Bajo el candado de la orden y con la MISMA regla
  // de abandonada releída: sin renglones, sin pagos y sin cobro de terminal. Es un método de clase: el detector lo ve a nivel de módulo.
  'jobs/abandoned-orders-cleanup.job.ts#(nivel de módulo)': {
    clase: 'PROTEGIDA',
    marcadores: ['lockExistingOrderForPayment', 'abandonada(thresholdDate)', DEVUELVE_CANJES, 'canjes.filasQuitadas > 0'],
  },
  'services/pos-sync/posSyncOrder.service.ts#processPosOrderDeleteEvent': { clase: 'VERDAD_EXTERNA', marcadores: VERDAD_EXTERNA_VIGILADA },
  'services/delivery-channels/core/cancelDeliveryOrder.service.ts#cancelDeliveryOrder': {
    clase: 'VERDAD_EXTERNA',
    marcadores: VERDAD_EXTERNA_VIGILADA,
  },
}

/** Escritores con el estado en una VARIABLE (el regex no los ve): se vigilan por nombre. */
const ESCRITORES_CON_ESTADO_VARIABLE: Record<string, string[]> = {
  // El PUT del dashboard escribe `status` del cuerpo: a CANCELLED/DELETED va por la cancelación protegida.
  'services/dashboard/order.dashboard.service.ts#updateOrder': PROTEGIDA_Y_DEVUELVE,
  // Pedidos en línea (plan 1a, R1/R2/R22): rechazar, vencer y cancelar el comensal escriben el estado de la regla de la
  // transición bajo el candado de la orden, sin dinero y sin cobro de terminal vivo. Cancelar por personal usa
  // `cancelOrderInTransaction` (PROTEGIDA arriba); las cancelaciones de otras vías se sincronizan al leer.
  'services/online-ordering/transitions.service.ts#casTransitionInTx': [
    'lockExistingOrderForPayment',
    'findLiveTerminalCharge',
    DEVUELVE_CANJES,
  ],
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

  // S9 (P2-5): «ningún escritor PROTEGIDO que pueda anular una cuenta con OnlineOrder omite la conversión».
  it.each(Object.entries(INVENTARIO).filter(([, c]) => c.clase === 'PROTEGIDA'))(
    '%s devuelve los beneficios de una cuenta de folio, o dice por qué nunca anula una',
    (sitio, clase) => {
      const c = clase as Extract<Clase, { clase: 'PROTEGIDA' }>
      if (c.marcadores.includes(DEVUELVE_CANJES)) return expect(c.sinCuentaDeFolio).toBeUndefined()
      expect({ sitio, motivo: (c.sinCuentaDeFolio?.motivo.length ?? 0) > 60 }).toEqual({ sitio, motivo: true })
      // Sus marcadores se buscan en el ARCHIVO (la regla vive en la función que la llama o en otra del mismo archivo).
      const archivo = fs.readFileSync(path.join(SRC, sitio.split('#')[0]), 'utf8')
      for (const marcador of c.sinCuentaDeFolio!.marcadores)
        expect({ sitio, tiene: marcador, ok: archivo.includes(marcador) }).toMatchObject({ ok: true })
    },
  )

  it.each(Object.entries(ESCRITORES_CON_ESTADO_VARIABLE))('%s (estado variable) pasa por la cancelación protegida', (sitio, marcadores) => {
    const [archivo, funcion] = sitio.split('#')
    const lineas = fs.readFileSync(path.join(SRC, archivo), 'utf8').split('\n')
    const i = lineas.findIndex(l => (l.match(INICIO_DE_FUNCION) ?? [])[1] === funcion)
    expect(i).toBeGreaterThanOrEqual(0)
    const { cuerpo } = funcionQueContiene(lineas, i)
    for (const marcador of marcadores) expect(cuerpo).toContain(marcador)
  })
})

describe('Mesas merge cancellation keeps the ordered Order lock', () => {
  it('the transaction helper delegates to the topology lock whose raw Order claim remains ordered', () => {
    const helper = fs.readFileSync(path.join(SRC, 'services/shared/tableOrderLock.ts'), 'utf8')
    expect(helper).toMatch(/FROM "Order"[\s\S]*?ORDER BY "createdAt" DESC, id DESC FOR UPDATE/)
    expect(helper).toContain('locked.length !== ids.length')
    expect(helper).toContain('shape(before) !== shape(after)')
  })
})
