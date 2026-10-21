/**
 * R8 / Review Focus 3 (tarjetas de regalo): cada camino que deja una cuenta PAGADA por primera vez —los que crean el
 * vale de inventario dentro de su transacción— activa los sobres de una cuenta de tarjetas en ESA transacción, después
 * de crear el vale y con la `tx` del cobro. Un camino nuevo que crea el vale y no activa tumba esta prueba.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const INICIO = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivos(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

function funciones(archivo: string): Map<string, string> {
  const out = new Map<string, string>()
  let nombre: string | null = null
  let cuerpo: string[] = []
  const cerrar = () => {
    if (nombre) out.set(nombre, cuerpo.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))
  }
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    const m = INICIO.exec(linea)
    if (m) {
      cerrar()
      nombre = m[1]
      cuerpo = []
    }
    if (nombre) cuerpo.push(linea)
  }
  cerrar()
  return out
}

/** [archivo, función que activa, llamada que crea el vale en esa función] — los 11 sitios de hechos A § 2.3. */
const SITIOS: Array<[string, string, string]> = [
  ['services/mobile/order.mobile.service.ts', 'registrarAbonoEnTx', 'createSalePostingInTx('],
  ['services/tpv/payment.tpv.service.ts', 'settleStandalonePaymentInTx', 'createSalePostingInTx('],
  ['services/tpv/payment.tpv.service.ts', 'updateOrderTotalsForStandalonePayment', 'createSalePostingInTx('],
  ['services/b4bit/b4bit.service.ts', 'settleOrderForConfirmedCryptoPayment', 'crearValeDeInventario('],
  ['services/dashboard/customer.dashboard.service.ts', 'settleCustomerBalance', 'createSalePostingInTx('],
  ['services/dashboard/order.dashboard.service.ts', 'settleOrder', 'createSalePostingInTx('],
  ['services/dashboard/manualPayment.service.ts', 'createManualPayment', 'createSalePostingInTx('],
  ['services/dashboard/paymentLink.service.ts', 'finalizePaymentLinkCheckout', 'createSalePostingInTx('],
  ['services/dashboard/paymentLink.service.ts', 'completeCharge', 'createSalePostingInTx('],
  ['services/dashboard/paymentLink.service.ts', 'finalizeMercadoPagoCheckout', 'createSalePostingInTx('],
  ['services/delivery-channels/core/deliveryOrderIngestion.service.ts', 'ingestDeliveryOrder', 'createSalePostingInTx('],
]

/**
 * Funciones que crean un vale por donde una cuenta de tarjetas NO puede pasar: no activan, y la razón queda escrita. Si la razón
 * deja de ser cierta, el sitio pasa a SITIOS y activa como los demás.
 */
const NO_APLICAN: Record<string, string> = {
  // Sitio 12 (develop, R10-1 de sellos tardíos): la constancia SKIPPED (`items: []`) del consumo de la sesión de vales v7.
  'services/mobile/areaTicketV7.mobile.service.ts#finalizeAreaTicketPaymentInTransaction':
    'sólo corre con una sesión de vales v7, cuya orden nace en materializeAreaTicketCheckout con los renglones de sus vales y ' +
    'productos sueltos (ninguno con giftCardId; la sesión sólo toma orden ahí). Las líneas de tarjeta sólo nacen con ' +
    'createGiftCardOrder y no se agregan después (guardias de A5), unir cuentas con tarjetas o con vales está prohibido (A5, R14-1) ' +
    'y el cobro con saldo rechaza las ventas con vales.',
}

/**
 * Cierre (punto 18): un NO_APLICAN no se reconoce sólo por el nombre de su función. Cada `createSalePostingInTx(` que haga debe ser
 * la constancia SKIPPED de los vales (`items: []` + `skipReason: 'AREA_TICKET_TRANSACTIONAL'`): si algún día ahí nace un vale de
 * venta de verdad, esta prueba se pone roja y el sitio tiene que pasar a SITIOS (y activar).
 */
const LLAMADA_DE_NO_APLICAN = [/\bitems:\s*\[\]/, /\bskipReason:\s*'AREA_TICKET_TRANSACTIONAL'/]

/** Los argumentos de cada llamada `nombre(` del cuerpo, con los paréntesis balanceados. */
function argumentosDe(cuerpo: string, nombre: string): string[] {
  const out: string[] = []
  for (let i = cuerpo.indexOf(nombre); i >= 0; i = cuerpo.indexOf(nombre, i + nombre.length)) {
    let profundidad = 0
    let j = i + nombre.length - 1
    for (; j < cuerpo.length; j++) {
      if (cuerpo[j] === '(') profundidad++
      else if (cuerpo[j] === ')' && --profundidad === 0) break
    }
    out.push(cuerpo.slice(i + nombre.length, j))
  }
  return out
}

/** El cripto crea el vale por una envoltura que lo reintenta; el inventario cuenta la envoltura, y la activación va en su llamador. */
const ENVOLTURAS: Record<string, string> = {
  'services/b4bit/b4bit.service.ts#crearValeDeInventario': 'services/b4bit/b4bit.service.ts#settleOrderForConfirmedCryptoPayment',
}

describe('R8: la activación de sobres acompaña a cada vale de inventario', () => {
  it('el inventario está completo: toda función que crea el vale de una venta está en la lista (un camino nuevo la rompe)', () => {
    const encontrados: string[] = []
    for (const archivo of archivos(SRC)) {
      const rel = path.relative(SRC, archivo).split(path.sep).join('/')
      if (rel === 'services/inventory/inventoryPosting.service.ts') continue
      for (const [funcion, cuerpo] of funciones(archivo)) {
        if (cuerpo.includes('createSalePostingInTx(')) encontrados.push(ENVOLTURAS[`${rel}#${funcion}`] ?? `${rel}#${funcion}`)
      }
    }
    expect([...new Set(encontrados)].sort()).toEqual([...SITIOS.map(([a, f]) => `${a}#${f}`), ...Object.keys(NO_APLICAN)].sort())
  })

  it.each(Object.keys(NO_APLICAN))('%s sólo deja la constancia SKIPPED (items: [] y AREA_TICKET_TRANSACTIONAL)', sitio => {
    const [archivo, funcion] = sitio.split('#')
    const llamadas = argumentosDe(funciones(path.join(SRC, archivo)).get(funcion) ?? '', 'createSalePostingInTx(')
    expect(llamadas.length).toBeGreaterThan(0)
    for (const args of llamadas) {
      expect({ sitio, args: LLAMADA_DE_NO_APLICAN.map(patron => patron.test(args)) }).toEqual({ sitio, args: [true, true] })
    }
  })

  it.each(SITIOS)('%s#%s activa los sobres con la tx del cobro, DESPUÉS de crear el vale', (archivo, funcion, vale) => {
    const cuerpo = funciones(path.join(SRC, archivo)).get(funcion) ?? ''
    const iVale = cuerpo.indexOf(vale)
    const iActiva = cuerpo.indexOf('activarSobresDeCuentaPagadaEnTx(tx,')
    expect({ sitio: `${archivo}#${funcion}`, vale: iVale >= 0, activa: iActiva >= 0, despuesDelVale: iActiva > iVale }).toEqual({
      sitio: `${archivo}#${funcion}`,
      vale: true,
      activa: true,
      despuesDelVale: true,
    })
  })
})
