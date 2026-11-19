/**
 * Founder 3-oct-2026 («No, como Square y Toast»): todo `payment.create` declara qué hace si su cuenta está CANCELADA o borrada.
 * Un escritor nuevo sin clasificar —o uno que pierde su marcador— tumba esta prueba. Cada marcador es [función del MISMO archivo,
 * texto que su cuerpo debe contener]. «PREVIO» = sigue como hoy; su arreglo vive en `2026-10-03-registro-de-cobros-sin-huecos.md`.
 * La reasignación (que mueve un cobro, no lo crea) la cubre la Tarea 6d.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

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
// S9 v5 (R12, B3): todo escritor que deja dinero en la cuenta de un folio deja la NOTA (aviso una vez por folio y renovación).
const NOTA = 'notarDineroEnFolioCerradoEnTx('
const ESCRITORES: Record<string, { clase: string; marcadores: Array<[string, string]> }> = {
  // Tarea A7: el `payment.create` vive en el núcleo extraído; las reglas de cuenta cancelada se movieron con él, intactas.
  'services/mobile/order.mobile.service.ts#registrarAbonoEnTx': {
    clase: 'RECHAZA el efectivo en vivo / REABRE lo ya capturado (cuentas de Avoqado)',
    marcadores: [
      ['registrarAbonoEnTx', CLASIFICA],
      ['registrarAbonoEnTx', LLAVE],
      ['registrarAbonoEnTx', RECHAZA],
      ['registrarAbonoEnTx', REABRE],
      ['registrarAbonoEnTx', CIERRE],
      ['registrarAbonoEnTx', NOTA],
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
      ['settleStandalonePaymentInTx', NOTA],
      ['updateOrderTotalsForStandalonePayment', NOTA],
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
  // Plan B8: el registro manual rechaza una cancelada, como hoy, salvo la cuenta anulada de un FOLIO (tienda híbrida S9, P2-5): ahí es
  // dinero ya capturado (una transferencia tardía) y la REABRE con la regla de siempre, en su transacción.
  'services/dashboard/manualPayment.service.ts#createManualPayment': {
    clase: 'RECHAZA otra cuenta cancelada / REABRE la de un folio (S9)',
    marcadores: [
      ['createManualPayment', 'No se puede registrar un pago en una orden cancelada'],
      ['createManualPayment', 'esCuentaDeFolioEnTx('],
      ['createManualPayment', REABRE],
      ['createManualPayment', NOTA],
    ],
  },
  // v14 (Codex r13 #3): «liquidar» crea un efectivo en ese momento: es un cobro nuevo y se rechaza.
  'services/dashboard/order.dashboard.service.ts#settleOrder': {
    clase: 'RECHAZA (cobro nuevo)',
    marcadores: [
      ['settleOrder', RECHAZA],
      ['settleOrder', NOTA],
    ],
  },
  'services/dashboard/customer.dashboard.service.ts#settleCustomerBalance': {
    clase: 'YA RECHAZA',
    marcadores: [
      ['settleCustomerBalance', 'CUENTA_NO_CANCELADA'],
      ['settleCustomerBalance', NOTA],
    ],
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
  // Fase 2 (T6): el cobro de la tarjeta sólo se registra si la aceptación gana bajo el mismo candado; una cuenta cancelada no se
  // acepta (R2), así que se revierte todo y el cargo queda en duda para el conciliador.
  'services/online-ordering/card/capture.service.ts#finishCapture': {
    clase: 'RECHAZA (la aceptación bajo el candado revierte el cobro)',
    marcadores: [['finishCapture', 'throw new CaptureNotAccepted(`ACCEPT_${r.r}`)']],
  },
  // r2 R1 (founder: no devolver solo): Stripe YA cobró a mano una tarjeta cuyo pedido se rechazó, venció o canceló. Se registra el
  // cobro sobre la cuenta tal como está (no la reabre) y queda MoneyAnomaly + alerta para devolverlo a la tarjeta.
  'services/online-ordering/card/release.service.ts#recordCapturedOutsideOnRelease': {
    clase: 'VERDAD EXTERNA (cobrado a mano en Stripe; queda como esté, con anomalía)',
    marcadores: [['recordCapturedOutsideOnRelease', "category: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE'"]],
  },
  'services/onboarding/demoSeed.service.ts#seedOrders': { clase: 'ORDEN PROPIA (demo)', marcadores: [] },
  'services/demo/negociosDemo.service.ts#seedHistory': { clase: 'ORDEN PROPIA (demo)', marcadores: [] },
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
  // D19: sólo marca lo reabierto en el REFUND recién creado; con la cuenta cancelada no reabre nada ni escribe.
  'services/shared/saldoReabiertoAlReembolsar.ts#fijarSaldoReabiertoEnTx': { clase: 'REEMBOLSO', marcadores: [] },
}

// R-P2-S2-5: única clasificación de TODOS los métodos Payment; create conserva sus marcadores previos.
Object.assign(ESCRITORES, {
  'jobs/playtelecomEventSimReassignment.job.ts#reassignEventSimSalesForRule': {
    clase: 'ADMIN: reasigna el cobro al negocio de origen del evento SIM; no cambia importe ni reabre ventas.',
    marcadores: [],
  },
  'services/b4bit/b4bit.service.ts#failB4BitPaymentInTx': {
    clase: 'DINERO_TARDIO: marca fallido el intento B4Bit y su conciliación según evidencia del procesador.',
    marcadores: [],
  },
  'services/b4bit/b4bit.service.ts#processWebhook': {
    clase: 'DINERO_TARDIO: guarda evidencia/metadatos del webhook recibido, no inicia otro cobro.',
    marcadores: [],
  },
  'services/b4bit/b4bit.service.ts#completeAndAttributeB4BitPaymentInTx': {
    clase: 'DINERO_TARDIO: confirma y atribuye dinero B4Bit ya capturado; conserva liquidación canónica. S9 v5: deja la nota (plan B).',
    marcadores: [['completeAndAttributeB4BitPaymentInTx', NOTA]],
  },
  'services/b4bit/b4bit.service.ts#cancelCryptoPayment': {
    clase: 'DINERO_TARDIO: cancela un intento B4Bit según el estado del procesador, no edita artículos ni beneficios.',
    marcadores: [],
  },
  'services/cleanup/liveDemoCleanup.service.ts#deleteVenueDataTx': {
    clase: 'ADMIN: limpieza transaccional acotada al negocio demo bajo su fence; sin edición del POS.',
    marcadores: [],
  },
  'services/dashboard/payment.dashboard.service.ts#updatePayment': {
    clase: 'REEMBOLSO: corrección del cobro con las restricciones actuales sobre dinero hecho, conservadas por S2.',
    marcadores: [],
  },
  'services/dashboard/payment.dashboard.service.ts#deletePayment': {
    clase: 'REEMBOLSO: borrado/corrección del registro con las restricciones actuales del cobro hecho, conservadas por S2.',
    marcadores: [],
  },
  'services/dashboard/sale-verification.org.dashboard.service.ts#editOrgSaleVerification': {
    clase: 'REEMBOLSO: corrección auditada de importe/método del cobro SIM; la cuenta simple se verifica y relee bajo lock.',
    marcadores: [],
  },
  'services/dashboard/testing.dashboard.service.ts#createTestPayment': {
    clase: 'ADMIN: crea/corrige únicamente el cobro marcado de prueba del negocio de testing.',
    marcadores: [],
  },
  'services/dashboard/testing.dashboard.service.ts#deleteTestPayment': {
    clase: 'ADMIN: borra únicamente el registro de prueba seleccionado por el operador autorizado.',
    marcadores: [],
  },
  'services/dashboard/venue.dashboard.service.ts#deleteVenue': {
    clase: 'ADMIN: borrado del negocio entero autorizado; no es edición de una venta desde el POS.',
    marcadores: [],
  },
  'services/onboarding/demoCleanup.service.ts#cleanDemoData': {
    clase: 'ADMIN: elimina datos demo durante el onboarding, acotados al negocio correspondiente.',
    marcadores: [],
  },
  'services/online-ordering/card/refund.service.ts#reverseRecordedRefund': {
    clase: 'REEMBOLSO: revierte el registro de devolución fallida según evidencia de la tarjeta en línea.',
    marcadores: [],
  },
  'services/payments/deferredTransactionCost.service.ts#proyectarCostoDelReembolso': {
    clase: 'REEMBOLSO: proyecta costos de una devolución, sin tocar importe cobrado ni artículos.',
    marcadores: [],
  },
  'services/payments/deferredTransactionCost.service.ts#convergerCostoDeTransaccion': {
    clase: 'DINERO_TARDIO: concilia costos del procesador, sin iniciar cargo ni modificar artículos.',
    marcadores: [],
  },
  'services/superadmin/rateCorrection/rateCorrectionApply.ts#applyRateCorrection': {
    clase: 'ADMIN: corrección privilegiada y auditada de tasa/costos del procesador; no cambia dinero cobrado al cliente.',
    marcadores: [],
  },
  'services/superadmin/rateCorrection/rateCorrectionReverse.ts#reverseRateCorrection': {
    clase: 'ADMIN: revierte la corrección privilegiada de tasa/costos al valor auditado anterior.',
    marcadores: [],
  },
  'services/terminal-payment.service.ts#closeRowFromPaymentTx': {
    clase: 'DINERO_TARDIO: liga la procedencia de la solicitud al pago ya existente, sin cargo nuevo.',
    marcadores: [],
  },
})

// Siete métodos: create|createMany|update|updateMany|upsert|delete|deleteMany, incluidos callbacks y métodos de clase.
function esEscrituraDePago(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(n.expression.name.text) &&
    ts.isPropertyAccessExpression(n.expression.expression) &&
    n.expression.expression.name.text === 'payment'
  )
}
it('el detector financiero ve los siete métodos y no confunde lecturas u otro modelo', () => {
  const sf = ts.createSourceFile(
    'probe.ts',
    'async function f(tx){' +
      ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'findMany']
        .map(method => `tx.payment.${method}({})`)
        .join(';') +
      ';tx.order.create({})}',
    ts.ScriptTarget.Latest,
    true,
  )
  let writes = 0
  function visit(n: ts.Node) {
    if (esEscrituraDePago(n)) writes++
    ts.forEachChild(n, visit)
  }
  visit(sf)
  expect(writes).toBe(7)
})

it('🔴 todo escritor de Payment de src/ está clasificado ante una cuenta CANCELADA y cada marcador sigue en su sitio', () => {
  const vistos = new Set<string>()
  const faltan: string[] = []
  for (const archivo of archivos(SRC)) {
    const lineas = fs.readFileSync(archivo, 'utf8').split('\n')
    const sf = ts.createSourceFile(archivo, lineas.join('\n'), ts.ScriptTarget.Latest, true)
    function visit(n: ts.Node) {
      if (esEscrituraDePago(n)) {
        let owner = '(módulo)'
        for (let p: ts.Node | undefined = n; p && !ts.isSourceFile(p); p = p.parent) {
          if (ts.isFunctionDeclaration(p) && p.name && ts.isSourceFile(p.parent)) owner = p.name.text
          if (ts.isMethodDeclaration(p)) owner = p.name.getText(sf)
        }
        const clave = `${path.relative(SRC, archivo)}#${owner}`
        vistos.add(clave)
        const escritor = ESCRITORES[clave]
        if (!escritor) faltan.push(`${clave}: sin clasificar`)
        else
          for (const [funcion, texto] of escritor.marcadores)
            if (!cuerpo(lineas, funcion)?.includes(texto)) faltan.push(`${clave}: falta «${texto}» en ${funcion}`)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
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
  expect(COMO_HOY.length).toBeGreaterThanOrEqual(6) // b4bit, liberación de tarjeta, ingesta, pos-sync, cancelación externa, MCP
  const reabren = COMO_HOY.flatMap(rel => {
    const texto = fs.readFileSync(path.join(SRC, rel), 'utf8')
    return REGLA_DE_REAPERTURA.filter(t => texto.includes(t)).map(t => `${rel}: «${t}»`)
  })
  expect(reabren).toEqual([])
})

it('S9 v5 (U9): el embudo de la anulación sella; la conciliación de un folio «Nadie» sella y renueva pero no deja la nota', () => {
  const leer = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n')
  expect(cuerpo(leer('services/shared/orderCancelGuard.ts'), 'devolverCanjesDeVentaAnuladaEnTx')).toContain('sellarFolioAnuladoEnTx(')
  const conciliacion = cuerpo(leer('services/shared/cuentaCancelada.ts'), 'conciliarPedidoEnLinea') ?? ''
  const ramaNadie = conciliacion.slice(
    conciliacion.indexOf('if (esFolio) {'),
    conciliacion.indexOf('return\n', conciliacion.indexOf('if (esFolio) {')),
  )
  expect(ramaNadie).toContain('sellarFolioAnuladoEnTx(')
  expect(ramaNadie).toContain('renovarRecuperacionDeFolioEnTx(')
  expect(ramaNadie).not.toContain(NOTA)
  expect(ramaNadie).not.toContain('avisarDelCobroTardioEnTx(')
  // La trampa de la v1: el `updateMany` de `OnlineOrder` nunca vive en el archivo de cripto.
  expect(fs.readFileSync(path.join(SRC, 'services/b4bit/b4bit.service.ts'), 'utf8')).not.toMatch(/onlineOrder\.updateMany/)
  // La conversión de cortesías no ganó una bitácora nueva con el sello.
  expect(
    (fs.readFileSync(path.join(SRC, 'services/online-ordering/cortesiaDeFolio.ts'), 'utf8').match(/activityLog\.create\(/g) ?? []).length,
  ).toBe(1)
})
