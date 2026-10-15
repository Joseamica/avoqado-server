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
    expect([...new Set(encontrados)].sort()).toEqual(SITIOS.map(([a, f]) => `${a}#${f}`).sort())
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
