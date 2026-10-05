/**
 * Founder 3-oct-2026 («No, como Square y Toast»): todo `payment.create` declara qué hace si su cuenta está CANCELADA o borrada.
 * Un escritor nuevo sin clasificar —o uno que pierde su marcador— tumba esta prueba. Cada marcador es [función del MISMO archivo,
 * texto que su cuerpo debe contener]. «PREVIO» = sigue como hoy; su arreglo vive en `2026-10-03-registro-de-cobros-sin-huecos.md`.
 * La reasignación (que mueve un cobro, no lo crea) la cubre la Tarea 6d.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const archivos = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
const INICIO = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
function cuerpo(lineas: string[], nombre: string): string | null {
  const i = lineas.findIndex(l => INICIO.exec(l)?.[1] === nombre)
  if (i < 0) return null
  let fin = i + 1
  while (fin < lineas.length && !INICIO.test(lineas[fin])) fin++
  return lineas.slice(i, fin).join('\n')
}

const REABRE = 'reabrirSiRecibeDinero('
const RECHAZA = 'rechazarCobroNuevoSobreCancelada('
const CLASIFICA = 'esCobroNuevo('
const LLAVE = 'salirSiLaLlaveYaTienePago('
// Revisión de 6a-2, M-1: el cierre que da por saldada una cuenta pasa por la regla; sin ella una cancelada volvía a cerrarse.
const CIERRE = 'cierreAutomaticoPermitido('
const PROPIA = '.order.create('
const ESCRITORES: Record<string, { clase: string; marcadores: Array<[string, string]> }> = {
  'services/mobile/order.mobile.service.ts#payCashOrder': {
    clase: 'RECHAZA el efectivo en vivo / REABRE lo ya capturado (cuentas de Avoqado)',
    marcadores: [
      ['payCashOrder', CLASIFICA],
      ['payCashOrder', LLAVE],
      ['payCashOrder', RECHAZA],
      ['payCashOrder', REABRE],
      ['payCashOrder', CIERRE],
    ],
  },
  'services/tpv/payment.tpv.service.ts#recordOrderPayment': {
    clase: 'RECHAZA el efectivo con cobroNuevo / REABRE en sus dos cierres (cuentas de Avoqado)',
    marcadores: [
      ['recordOrderPayment', CLASIFICA],
      ['recordOrderPayment', LLAVE],
      ['recordOrderPayment', RECHAZA],
      ['settleStandalonePaymentInTx', REABRE],
      ['updateOrderTotalsForStandalonePayment', REABRE],
      ['settleStandalonePaymentInTx', CIERRE],
      ['updateOrderTotalsForStandalonePayment', CIERRE],
    ],
  },
  // PREVIO (Plan B7): la confirmación deja la cancelada como hoy; la iniciación ya rechaza.
  'services/b4bit/b4bit.service.ts#initiateCryptoPayment': {
    clase: 'YA RECHAZA al iniciar / PREVIO al confirmar',
    marcadores: [
      ['initiateCryptoPayment', 'La cuenta está cancelada y no admite cobros'],
      ['settleOrderForConfirmedCryptoPayment', 'UNA ORDEN CANCELADA NO SE RESUCITA'],
    ],
  },
  // PREVIO (Plan B8): el registro manual rechaza una cancelada, como hoy.
  'services/dashboard/manualPayment.service.ts#createManualPayment': {
    clase: 'YA RECHAZA (PREVIO)',
    marcadores: [['createManualPayment', 'No se puede registrar un pago en una orden cancelada']],
  },
  // v14 (Codex r13 #3): «liquidar» crea un efectivo en ese momento: es un cobro nuevo y se rechaza.
  'services/dashboard/order.dashboard.service.ts#settleOrder': { clase: 'RECHAZA (cobro nuevo)', marcadores: [['settleOrder', RECHAZA]] },
  'services/dashboard/customer.dashboard.service.ts#settleCustomerBalance': {
    clase: 'YA RECHAZA',
    marcadores: [['settleCustomerBalance', 'CUENTA_NO_CANCELADA']],
  },
  'services/tpv/payment.tpv.service.ts#recordFastPayment': {
    clase: 'ORDEN PROPIA (una existente la delega)',
    marcadores: [['recordFastPayment', 'recordOrderPayment(']],
  },
  'services/tpv/order.tpv.service.ts#createOrderWithItems': { clase: 'ORDEN PROPIA', marcadores: [['createOrderWithItems', PROPIA]] },
  'services/dashboard/manualSale.service.ts#createOneManualSale': { clase: 'ORDEN PROPIA', marcadores: [['createOneManualSale', PROPIA]] },
  'services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout': {
    clase: 'ORDEN PROPIA',
    marcadores: [['finalizePaymentLinkCheckout', PROPIA]],
  },
  'services/dashboard/paymentLink.service.ts#completeCharge': { clase: 'ORDEN PROPIA', marcadores: [['completeCharge', PROPIA]] },
  'services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout': {
    clase: 'ORDEN PROPIA',
    marcadores: [['finalizeMercadoPagoCheckout', PROPIA]],
  },
  'services/dashboard/venueCheckout.service.ts#finalizeVenueCheckout': {
    clase: 'ORDEN PROPIA',
    marcadores: [['finalizeVenueCheckout', PROPIA]],
  },
  'services/onboarding/demoSeed.service.ts#seedOrders': { clase: 'ORDEN PROPIA (demo)', marcadores: [] },
  'services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder': {
    clase: 'VERDAD EXTERNA',
    marcadores: [['ingestDeliveryOrder', '.order.upsert(']],
  },
  'services/pos-sync/posSyncOrder.service.ts#processPaymentsForOrder': { clase: 'VERDAD EXTERNA', marcadores: [] },
  'services/tpv/payment.tpv.service.ts#crearEvidenciaDeSegundaCaptura': {
    clase: 'EVIDENCIA (nunca COMPLETED)',
    marcadores: [['crearEvidenciaDeSegundaCaptura', "status: 'PENDING'"]],
  },
  'services/tpv/payment.tpv.service.ts#crearEvidenciaDeColisionDeReferencia': {
    clase: 'EVIDENCIA (nunca COMPLETED)',
    marcadores: [['crearEvidenciaDeColisionDeReferencia', "status: 'PENDING'"]],
  },
  'services/tpv/refund.tpv.service.ts#recordRefund': { clase: 'REEMBOLSO', marcadores: [] },
  'services/dashboard/refund.dashboard.service.ts#writeRefundInTx': { clase: 'REEMBOLSO', marcadores: [] },
  'services/mobile/refund.mobile.service.ts#createRefund': { clase: 'REEMBOLSO', marcadores: [] },
  'services/delivery-channels/core/applyDeliveryRefund.service.ts#applyDeliveryRefund': { clase: 'REEMBOLSO', marcadores: [] },
}

it('🔴 todo `payment.create` de src/ está clasificado ante una cuenta CANCELADA y cada marcador sigue en su sitio', () => {
  const vistos = new Set<string>()
  const faltan: string[] = []
  for (const archivo of archivos(SRC)) {
    const lineas = fs.readFileSync(archivo, 'utf8').split('\n')
    lineas.forEach((linea, i) => {
      if (!/\.payment\.create\(/.test(linea)) return
      let j = i
      while (j >= 0 && !INICIO.test(lineas[j])) j--
      const clave = `${path.relative(SRC, archivo)}#${j >= 0 ? INICIO.exec(lineas[j])![1] : '(módulo)'}`
      vistos.add(clave)
      const escritor = ESCRITORES[clave]
      if (!escritor) return void faltan.push(`${clave}: sin clasificar`)
      for (const [funcion, texto] of escritor.marcadores)
        if (!cuerpo(lineas, funcion)?.includes(texto)) faltan.push(`${clave}: falta «${texto}» en ${funcion}`)
    })
  }
  expect(faltan).toEqual([])
  expect([...vistos].sort()).toEqual(Object.keys(ESCRITORES).sort()) // un escritor que se va también se nota
})

/**
 * Revisión de 6a-2, M-1: lo que B2b dejó COMO HOY no puede ganar la reapertura «a medias» dentro de este bloque (la v12 reabría la
 * cripto y el registro manual). Los archivos de los escritores PREVIO / VERDAD EXTERNA, y los que la Tarea 6a no toca por la misma
 * razón (las cancelaciones externas y el registro manual del MCP), no contienen la regla de reapertura. Su arreglo vive en el plan
 * de registro de cobros.
 */
const COMO_HOY = [
  ...new Set([
    ...Object.entries(ESCRITORES)
      .filter(([, e]) => /PREVIO|VERDAD EXTERNA/.test(e.clase))
      .map(([clave]) => clave.split('#')[0]),
    'services/delivery-channels/core/cancelDeliveryOrder.service.ts',
    'mcp/tools/payments.ts',
  ]),
]
const REGLA_DE_REAPERTURA = [REABRE, 'estadoParaCobrar(', 'estadoAlRecibirDinero(']
it('control — M-1: los escritores que siguen como hoy (PREVIO / VERDAD EXTERNA) no reabren una cuenta cancelada', () => {
  expect(COMO_HOY.length).toBeGreaterThanOrEqual(6) // b4bit, manual, ingesta, pos-sync, cancelación externa, MCP
  const reabren = COMO_HOY.flatMap(rel => {
    const texto = fs.readFileSync(path.join(SRC, rel), 'utf8')
    return REGLA_DE_REAPERTURA.filter(t => texto.includes(t)).map(t => `${rel}: «${t}»`)
  })
  expect(reabren).toEqual([])
})
