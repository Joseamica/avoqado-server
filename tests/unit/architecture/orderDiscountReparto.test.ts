/**
 * IVA por producto, bloque B2 (spec planes 6-7 §4.1, D7): inventario COMPLETO de quien escribe descuentos de una orden.
 *  1. Toda función de src/ que escribe una fila `OrderDiscount` guarda su reparto, lo sincroniza o revierte el renglón al
 *     quitar — marca presente en su código (sin comentarios).
 *  2. Los recalculadores (los que re-derivan un % de cuenta) son exactamente los declarados y sincronizan los repartos.
 *  3. Toda función que escribe `Order.discountAmount` declara de dónde sale ese número.
 * Un escritor nuevo truena aquí hasta que alguien lo clasifique. Es inventario: la evidencia de dinero son las pruebas de cada
 * escritor y `tests/integration/payments/repartoDescuento.integration.test.ts`.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')
const WRITE = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
])
const ORDER_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert'])

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivos(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}
const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e
function dueño(node: ts.Node): string {
  let owner = '(module)'
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && ts.isSourceFile(n.parent)) owner = n.name.text
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent.parent.parent)) owner = n.name.text
    else if (ts.isMethodDeclaration(n) && ts.isClassDeclaration(n.parent) && n.parent.name)
      owner = `${n.parent.name.text}.${n.name.getText()}`
  }
  return owner
}
/** true: el literal nombra `discountAmount`; 'opaco': no se puede leer; false: no lo nombra. */
function nombraDescuento(e: ts.Expression | undefined): boolean | 'opaco' {
  if (!e) return false
  const o = unwrap(e)
  if (!ts.isObjectLiteralExpression(o)) return 'opaco'
  let opaco = false
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) {
      const s = unwrap(p.expression)
      const r = ts.isObjectLiteralExpression(s)
        ? nombraDescuento(s)
        : ts.isConditionalExpression(s)
          ? ([nombraDescuento(s.whenTrue), nombraDescuento(s.whenFalse)].find(x => x === true) ?? false)
          : ts.isBinaryExpression(s)
            ? nombraDescuento(s.right)
            : 'opaco'
      if (r === true) return true
      if (r === 'opaco') opaco = true
      continue
    }
    if (p.name && p.name.getText().replace(/['"]/g, '') === 'discountAmount') return true
  }
  return opaco ? 'opaco' : false
}

function escanear() {
  const printer = ts.createPrinter({ removeComments: true })
  const filas = new Set<string>()
  const cabecera = new Set<string>()
  const opacos = new Set<string>()
  const codigo = new Map<string, string>()
  for (const file of archivos(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) codigo.set(`${rel}#${st.name.text}`, printer.printNode(ts.EmitHint.Unspecified, st, sf))
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name)) codigo.set(`${rel}#${d.name.text}`, printer.printNode(ts.EmitHint.Unspecified, st, sf))
      // Los métodos de clase también son dueños (`dueño` los nombra `Clase.método`): sin esto un payload opaco en un job pasaría.
      if (ts.isClassDeclaration(st) && st.name)
        for (const m of st.members)
          if (ts.isMethodDeclaration(m))
            codigo.set(`${rel}#${st.name.text}.${m.name.getText()}`, printer.printNode(ts.EmitHint.Unspecified, m, sf))
    }
    const visitar = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)) {
        const metodo = n.expression.name.text
        const modelo = n.expression.expression.name.text
        const llave = `${rel}#${dueño(n)}`
        if (modelo === 'orderDiscount' && WRITE.has(metodo)) filas.add(llave)
        if (modelo === 'order' && ORDER_WRITE.has(metodo)) {
          const arg = n.arguments[0] && unwrap(n.arguments[0])
          // `{ where, data }` (shorthand) o `{ ...args }` no se pueden leer: cuentan como carga opaca, igual que `data: variable`.
          const cargas =
            arg && ts.isObjectLiteralExpression(arg)
              ? arg.properties
                  .filter(p => ts.isSpreadAssignment(p) || ['data', 'create', 'update'].includes(p.name?.getText() ?? ''))
                  .map(p => (ts.isPropertyAssignment(p) ? nombraDescuento(p.initializer) : ('opaco' as const)))
              : ['opaco' as const]
          if (cargas.includes(true)) cabecera.add(llave)
          else if (cargas.includes('opaco')) opacos.add(llave)
        }
      }
      if (
        ts.isTaggedTemplateExpression(n) &&
        /(UPDATE|INSERT INTO)\s+"Order"/.test(n.template.getText(sf)) &&
        /"discountAmount"/.test(n.template.getText(sf))
      )
        cabecera.add(`${rel}#${dueño(n)}`)
      ts.forEachChild(n, visitar)
    }
    visitar(sf)
  }
  // Un payload que no se puede leer cuenta si su función nombra `discountAmount` (así entran delivery y el POS).
  for (const llave of opacos) if ((codigo.get(llave) ?? '').includes('discountAmount')) cabecera.add(llave)
  return { filas, cabecera, codigo }
}

type Fila = { clase: 'ESCRIBE' | 'QUITA' | 'SINCRONIZA' | 'CONSERVA' | 'RECORTA'; marcas: string[] }
const SYNC = 'sincronizarRepartos('
// Codex r1 P1: todo escritor que crea una fila sobre una orden YA existente conserva antes el descuento histórico de cabecera.
const HISTORICO = 'conservarDescuentoHistorico('
const RECORTA = 'recortarDescuentosDeRenglones('
const ESCRITORES_DE_FILAS: Record<string, Fila> = {
  'src/services/mobile/order.mobile.service.ts#createOrderWithItems': {
    clase: 'ESCRIBE',
    marcas: ['buildItemDiscountRow(', 'filaDeDescuentoDeCuenta(', SYNC],
  },
  'src/services/mobile/order.mobile.service.ts#applyOrderDiscount': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, 'nuevoRepartoDeCuenta(', 'recalculateOrderTotals('],
  },
  // B2c T3 (R7-1): conserva el resto histórico de la cabecera antes de quitar la fila (el recálculo es Σ filas).
  'src/services/mobile/order.mobile.service.ts#removeOrderDiscount': {
    clase: 'QUITA',
    marcas: [HISTORICO, 'revertirDescuentoDelRenglon(', 'recalculateOrderTotals('],
  },
  'src/services/tpv/order.tpv.service.ts#createOrderWithItems': {
    clase: 'ESCRIBE',
    marcas: ['nuevoRepartoDirigido(', 'buildItemDiscountRow(', 'nuevoRepartoDeCuenta(', SYNC],
  },
  'src/services/tpv/order.tpv.service.ts#applyDiscount': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, 'nuevoRepartoDirigido(', 'nuevoRepartoDeCuenta(', SYNC],
  },
  // B2c T4 (P5): la cortesía de la terminal conserva el resto histórico (R7-1), recorta lo dirigido a lo que regala y gana su fila
  // ESPEJO (como «Cobrar»): el siguiente recálculo ya no la borra. B2c T4b: además RECALCULA (R8) como los demás recalculadores.
  'src/services/tpv/order.tpv.service.ts#compItems': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, RECORTA, 'nuevoRepartoDirigido(', 'importesDeLasFilas(', SYNC],
  },
  'src/services/tpv/discount.tpv.service.ts#applyCouponCode': { clase: 'ESCRIBE', marcas: [HISTORICO, 'nuevoRepartoDeCuenta(', SYNC] },
  // B2c T5 (P5): cada descuento de artículo del vale gana su fila ESPEJO (abrir el vale y agregarle renglones la llaman).
  'src/services/mobile/areaTicket.mobile.service.ts#crearEspejosDelVale': { clase: 'ESCRIBE', marcas: ['buildItemDiscountRow('] },
  'src/services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, 'nuevoRepartoDirigido(', 'nuevoRepartoDeCuenta(', SYNC],
  },
  'src/services/dashboard/discountEngine.service.ts#applyManualDiscount': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, 'nuevoRepartoDeCuenta(', SYNC],
  },
  'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder': {
    clase: 'QUITA',
    marcas: ['revertirDescuentoDelRenglon(', 'refundLoyaltyForOrderDiscount(', 'refundStampRewardForOrderDiscount(', SYNC],
  },
  'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrder': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, 'nuevoRepartoDeCuenta(', 'recalculateOrderTotals('],
  },
  'src/services/wallet/redeemStampReward.service.ts#redeemStampReward': {
    clase: 'ESCRIBE',
    marcas: [HISTORICO, 'nuevoRepartoDirigido(', 'nuevoRepartoDeCuenta(', 'recalculateOrderTotals('],
  },
  'src/services/shared/repartoDescuentoTx.ts#sincronizarRepartos': { clase: 'SINCRONIZA', marcas: ['repartosDeLaOrden('] },
  // B2c T2 (P4 + P13): conserva el resto histórico (R7-1), recorta lo dirigido a lo anulado, recalcula como borrar y sincroniza;
  // anular TODO además cierra las reducciones de impuesto que le queden (B2b T6, Codex r5, V5).
  'src/services/tpv/order.tpv.service.ts#voidItems': {
    clase: 'SINCRONIZA',
    marcas: [HISTORICO, RECORTA, 'importesDeLasFilas(', SYNC, 'taxReduction: { not: 0 }'],
  },
  // El resto de la cabecera que no está en ninguna fila, congelado en su propia fila SIN reparto (D8). B2c F2 (Codex r1 #3, #4):
  // antes, la parte que es de un renglón identificable sin espejo (la cortesía vieja de la terminal, el descuento propio de un
  // vale viejo) gana su fila ESPEJO —COMP como `compItems`, o la de `buildItemDiscountRow`—, sólo con lo que alcanza el resto.
  'src/services/shared/repartoDescuentoTx.ts#conservarDescuentoHistorico': {
    clase: 'CONSERVA',
    marcas: ['filasDeLaOrden(', "'FIXED_AMOUNT'", 'renglonesConEspejo(', 'buildItemDiscountRow(', 'nuevoRepartoDirigido(', "'COMP'"],
  },
  // B2c T1 (P4, P5): lo dirigido a los renglones que salen o se regalan se recorta por su parte guardada o se retira, devolviendo
  // puntos, premio y la reducción de impuesto (B2b).
  'src/services/shared/repartoDescuentoTx.ts#recortarDescuentosDeRenglones': {
    clase: 'RECORTA',
    marcas: ['recorteDeFila(', 'refundLoyaltyForOrderDiscount(', 'refundStampRewardForOrderDiscount(', 'reduccionDeImpuestoCobrado('],
  },
}
const RECALCULADORES = [
  // B2c T5 (P5): agregar al vale re-deriva los % de cuenta sobre la base nueva, como los otros caminos de agregar.
  'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems',
  'src/services/mobile/comp-item.mobile.service.ts#recalculateOrderTotals',
  'src/services/tpv/order.tpv.service.ts#addItemsToOrder',
  // B2c T4b (ruling de la revisión de T4): la cortesía de la terminal re-deriva los % sin lo regalado, como la del móvil.
  'src/services/tpv/order.tpv.service.ts#compItems',
  'src/services/tpv/order.tpv.service.ts#removeOrderItem',
  'src/services/tpv/order.tpv.service.ts#voidItems',
]

type Origen = { origen: 'FILAS' | 'RECALCULO' | 'CERO' | 'RENGLON' | 'D8'; nota: string }
const ORIGEN_DE_LA_CABECERA: Record<string, Origen> = {
  'src/services/mobile/order.mobile.service.ts#createOrderWithItems': {
    origen: 'FILAS',
    nota: 'espejos de artículo + fila de cuenta del POS; con promociones, reafirmada',
  },
  'src/services/tpv/order.tpv.service.ts#createOrderWithItems': {
    origen: 'FILAS',
    nota: 'cortesía, artículo, orden y el descuento libre (P2), cada uno con fila',
  },
  'src/services/tpv/order.tpv.service.ts#applyDiscount': {
    origen: 'FILAS',
    nota: 'P2: el descuento heredado de la terminal ya tiene fila',
  },
  'src/services/tpv/discount.tpv.service.ts#applyCouponCode': {
    origen: 'FILAS',
    nota: 'cabecera += la fila del cupón, que trae su reparto',
  },
  'src/services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount': {
    origen: 'FILAS',
    nota: 'cabecera += la fila del motor, que trae su reparto',
  },
  'src/services/dashboard/discountEngine.service.ts#applyManualDiscount': {
    origen: 'FILAS',
    nota: 'cabecera += la fila manual, que trae su reparto',
  },
  'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder': {
    origen: 'FILAS',
    nota: 'cabecera −= la fila quitada; espejo revertido, beneficios devueltos (P3)',
  },
  'src/services/mobile/comp-item.mobile.service.ts#recalculateOrderTotals': {
    origen: 'RECALCULO',
    nota: 'cabecera = Σ filas; re-deriva % y sincroniza repartos',
  },
  'src/services/tpv/order.tpv.service.ts#addItemsToOrder': {
    origen: 'RECALCULO',
    nota: 'cabecera = Σ filas (o la de antes sin filas); sincroniza repartos',
  },
  'src/services/tpv/order.tpv.service.ts#removeOrderItem': {
    origen: 'RECALCULO',
    nota: 'igual que addItemsToOrder con los renglones que quedan; antes recorta lo dirigido al borrado (P4)',
  },
  'src/services/tpv/order.tpv.service.ts#voidItems': {
    origen: 'RECALCULO',
    nota: 'P4 + P13: recorta lo dirigido a lo anulado y recalcula como borrar',
  },
  'src/services/tpv/order.tpv.service.ts#createOrder': { origen: 'CERO', nota: 'la cuenta nace vacía, sin descuento' },
  'src/services/tpv/table.tpv.service.ts#assignTable': { origen: 'CERO', nota: 'la cuenta de la mesa nace vacía, sin descuento' },
  'src/services/dashboard/venueCheckout.service.ts#finalizeVenueCheckout': {
    origen: 'CERO',
    nota: 'cobro en línea sin descuento de cuenta',
  },
  'src/services/dashboard/paymentLink.service.ts#completeCharge': { origen: 'CERO', nota: 'liga de pago: la orden nace sin descuento' },
  'src/services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout': {
    origen: 'CERO',
    nota: 'liga de pago: la orden nace sin descuento',
  },
  'src/services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout': {
    origen: 'CERO',
    nota: 'liga de pago: la orden nace sin descuento',
  },
  'src/services/mobile/estimate.mobile.service.ts#convertToOrder': {
    origen: 'CERO',
    nota: 'el presupuesto convertido nace con descuento 0',
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderItems': {
    origen: 'CERO',
    nota: 'la cuenta hija nace en 0 y la recalcula recalculateOrderTotals',
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderBySeat': { origen: 'CERO', nota: 'igual que splitOrderItems, por puesto' },
  'src/services/mobile/order.mobile.service.ts#mergeOrders': {
    origen: 'CERO',
    nota: 'la cuenta origen fusionada queda en 0; el destino lo recalcula recalculateOrderTotals',
  },
  'src/services/tpv/order.tpv.service.ts#compItems': {
    origen: 'RECALCULO',
    nota: 'B2c T4b: cabecera = Σ filas SIN tope (sin filas, la de antes − lo recortado + la cortesía, topada al subtotal), con los % re-derivados sin lo regalado (R8) y la cortesía en su fila espejo (P5)',
  },
  'src/services/mobile/areaTicket.mobile.service.ts#openAreaTicket': {
    origen: 'RENGLON',
    nota: 'el descuento del vale vive en cada renglón; su fila espejo la escribe crearEspejosDelVale (B2c, P5)',
  },
  'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems': {
    origen: 'RECALCULO',
    nota: 'B2c (P5): lo propio de cada renglón cobrable (la cortesía de la terminal aunque esté en promoción) + las filas no espejo con los % re-derivados',
  },
  'src/services/mobile/areaTicketV7.mobile.service.ts#materializeAreaTicketCheckout': {
    origen: 'RENGLON',
    nota: 'los vales V7 traen su descuento por renglón (residual, ver B2c)',
  },
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder': {
    origen: 'D8',
    nota: 'descuento del marketplace en cabecera, sin reparto',
  },
  'src/services/delivery-channels/core/deliveryReconciliation.service.ts#reprecio': {
    origen: 'D8',
    nota: 'reprecio del marketplace en cabecera, sin reparto',
  },
  'src/services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent': {
    origen: 'D8',
    nota: 'POS importado: la cabecera es la del POS externo',
  },
  'src/services/dashboard/manualPayment.service.ts#createManualPayment': {
    origen: 'D8',
    nota: 'cobro manual: orden sombra pagada, descuento de cabecera',
  },
}

describe('B2: inventario de quien escribe descuentos (spec §4.1)', () => {
  const { filas, cabecera, codigo } = escanear()
  const de = (llave: string) => codigo.get(llave) ?? ''
  it('encuentra a los escritores (si colapsa, se rompió el escáner)', () => {
    // B2c T6: 12 de B2 + voidItems + conservar + recortar (T1) + compItems (T4) + crearEspejosDelVale (T5, una sola clave por
    // los espejos de abrir y agregar al vale) = 17; la cabecera suma voidItems (T2) = 29; los recalculadores, 6.
    expect(filas.size).toBeGreaterThanOrEqual(17)
    expect(cabecera.size).toBeGreaterThanOrEqual(29)
    const recalculan = [...codigo.entries()].filter(
      ([k, c]) => c.includes('importesDeLasFilas(') && !k.startsWith('src/services/shared/repartoDescuento'),
    )
    expect(recalculan.length).toBeGreaterThanOrEqual(6)
  })
  it('toda función que escribe OrderDiscount está clasificada exactamente una vez', () => {
    expect([...filas].sort()).toEqual(Object.keys(ESCRITORES_DE_FILAS).sort())
  })
  it.each(Object.entries(ESCRITORES_DE_FILAS))('%s lleva sus marcas', (llave, f) => {
    for (const marca of f.marcas) expect({ llave, marca, presente: de(llave).includes(marca) }).toEqual({ llave, marca, presente: true })
  })
  it('los recalculadores son exactamente los de la lista y sincronizan con los importes re-derivados', () => {
    const conPredicado = [...codigo.entries()].filter(([, c]) => c.includes('importesDeLasFilas(')).map(([k]) => k)
    expect(conPredicado.filter(k => !k.startsWith('src/services/shared/repartoDescuento')).sort()).toEqual([...RECALCULADORES].sort())
    // Los importes re-derivados tienen que viajar DENTRO de la llamada a sincronizarRepartos (no basta con que la función los
    // desestructure): sin ellos la cabecera cambia y la fila de cada descuento se queda con el importe de antes.
    const sincronizaConLosImportes = /sincronizarRepartos\([^)]*\bmontosRederivados\b/
    for (const llave of RECALCULADORES)
      expect({ llave, sincroniza: sincronizaConLosImportes.test(de(llave)) }).toEqual({ llave, sincroniza: true })
  })
  // Codex r1 P1: el resto histórico se congela (D8). Con un reparto, la sincronización lo re-repartiría como si fuera de hoy.
  // B2c F2: los únicos repartos que escribe son los de los espejos de renglón —siempre espejo: la factura no los cuenta dos veces—.
  it('conservarDescuentoHistorico no le inventa reparto a lo histórico; sólo sus espejos de renglón llevan reparto (espejo)', () => {
    const codigo = de('src/services/shared/repartoDescuentoTx.ts#conservarDescuentoHistorico')
    const anterior = codigo.match(/\{[^{}]*name: 'Descuento anterior'[^{}]*\}/)?.[0] ?? ''
    expect(anterior).toContain('Descuento anterior')
    expect(anterior).not.toMatch(/reparto/)
    expect(codigo.match(/nuevoReparto\w*\(/g)).toEqual(['nuevoRepartoDirigido('])
    expect(codigo).toMatch(/nuevoRepartoDirigido\([^()]*\{\s*espejo: true\s*\}\s*\)/)
  })
  it('buildItemDiscountRow guarda el reparto espejo', () => {
    expect(de('src/services/shared/discount.service.ts#buildItemDiscountRow')).toContain('nuevoRepartoDirigido(')
  })
  it('toda función que escribe Order.discountAmount declara de dónde sale', () => {
    expect([...cabecera].sort()).toEqual(Object.keys(ORIGEN_DE_LA_CABECERA).sort())
  })
  it.each(Object.entries(ORIGEN_DE_LA_CABECERA))('%s: su origen es coherente', (llave, o) => {
    expect(o.nota.length).toBeGreaterThan(20)
    if (o.origen === 'FILAS') expect({ llave, enFilas: llave in ESCRITORES_DE_FILAS }).toEqual({ llave, enFilas: true })
    if (o.origen === 'RECALCULO') expect({ llave, recalcula: RECALCULADORES.includes(llave) }).toEqual({ llave, recalcula: true })
  })
})

/**
 * B2c (P4, P5): toda función de src/ que escribe renglones (`OrderItem`: llamada directa, `items: { <escritura> }` anidado en
 * una escritura de `Order`, o SQL crudo) declara qué pasa con los descuentos ya repartidos de la orden.
 */
function escanearRenglones(): Set<string> {
  const mutadores = new Set<string>()
  for (const file of archivos(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visitar = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)) {
        if (n.expression.expression.name.text === 'orderItem' && WRITE.has(n.expression.name.text)) mutadores.add(`${rel}#${dueño(n)}`)
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'items' && ts.isObjectLiteralExpression(n.initializer)) {
        const escribe = n.initializer.properties.some(p => p.name && WRITE.has(p.name.getText()))
        let llamada: ts.Node | undefined = n.parent
        while (llamada && !ts.isCallExpression(llamada)) llamada = llamada.parent
        const enOrder =
          !!llamada &&
          ts.isCallExpression(llamada) &&
          ts.isPropertyAccessExpression(llamada.expression) &&
          ts.isPropertyAccessExpression(llamada.expression.expression) &&
          llamada.expression.expression.name.text === 'order'
        if (escribe && enOrder) mutadores.add(`${rel}#${dueño(n)}`)
      }
      if (ts.isTaggedTemplateExpression(n) && /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+"OrderItem"/.test(n.template.getText(sf)))
        mutadores.add(`${rel}#${dueño(n)}`)
      ts.forEachChild(n, visitar)
    }
    visitar(sf)
  }
  return mutadores
}

type Mutador = {
  clase: 'SINCRONIZA' | 'CREACION' | 'SIN_FILAS' | 'METADATA' | 'SELLO_FISCAL' | 'TEARDOWN' | 'NO_INVALIDA'
  marcas?: string[]
  nota: string
}
const RECALC = 'recalculateOrderTotals('
const R9 = 'retirarImpuestoDeRenglones(' // B2b v5 (Codex r4 R4-1): lo que sale se lleva su IVA de la cabecera
const GUARDA = 'rechazarSiEsImportada(' // B2b v6 (Codex r5 #2): una cuenta importada no se rearma desde Avoqado
const MUTADORES_DE_RENGLONES: Record<string, Mutador> = {
  // Dejan filas y repartos coherentes en su transacción.
  'src/services/tpv/order.tpv.service.ts#addItemsToOrder': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, SYNC],
    nota: 'recalcula los % de cuenta y sincroniza los repartos (B2)',
  },
  'src/services/tpv/order.tpv.service.ts#removeOrderItem': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, R9, HISTORICO, RECORTA, SYNC],
    nota: 'R11 + R9 + P4: rechaza importadas, retira el IVA del renglón borrado, recorta lo dirigido a él y sincroniza',
  },
  'src/services/tpv/order.tpv.service.ts#voidItems': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, R9, HISTORICO, RECORTA, 'importesDeLasFilas(', SYNC],
    nota: 'R11 + R9 + P4 + P13: rechaza importadas, retira el IVA de lo anulado, recorta lo dirigido a él y recalcula como borrar',
  },
  'src/services/tpv/order.tpv.service.ts#compItems': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, HISTORICO, RECORTA, 'nuevoRepartoDirigido(', 'importesDeLasFilas(', SYNC],
    nota: 'P5: recorta lo dirigido a lo regalado, crea la cortesía espejo y re-deriva los % sin lo regalado (T4b, R8)',
  },
  'src/services/mobile/comp-item.mobile.service.ts#compOrderItem': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, HISTORICO, RECORTA, RECALC],
    nota: 'P5: retira el descuento propio del renglón regalado; el recálculo sincroniza',
  },
  'src/services/mobile/comp-item.mobile.service.ts#compWholeOrder': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, HISTORICO, RECORTA, RECALC],
    nota: 'P5: igual que compOrderItem, para toda la cuenta',
  },
  'src/services/promotions/promotion.service.ts#removePromotionFromOrder': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, HISTORICO, RECORTA, RECALC],
    nota: 'P4: retira lo dirigido a las líneas del combo y recalcula',
  },
  'src/services/promotions/promotion.service.ts#applyPromotionInTransaction': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, RECALC],
    nota: 'agrega líneas de promoción; el recálculo sincroniza los repartos',
  },
  'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems': {
    clase: 'SINCRONIZA',
    // Sin GUARDA a propósito: el vale nace en Avoqado (`openAreaTicket`), nunca es importado (exento de la red R11).
    marcas: ['crearEspejosDelVale(', 'importesDeLasFilas(', SYNC],
    nota: 'P5: espejo de los renglones nuevos (crearEspejosDelVale), % de cuenta re-derivados y repartos sincronizados',
  },
  'src/services/mobile/order.mobile.service.ts#mergeOrders': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, RECALC, 'Quita los descuentos'],
    nota: 'la cuenta origen no puede traer descuentos; su IVA pasa al destino (B2b v6) y el destino se recalcula',
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderItems': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, RECALC, 'Quita los descuentos'],
    nota: 'la guarda exige una cuenta sin descuentos; las dos se recalculan',
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderBySeat': {
    clase: 'SINCRONIZA',
    marcas: [GUARDA, RECALC, 'Quita los descuentos'],
    nota: 'igual que splitOrderItems, por puesto',
  },
  // La orden nace en la misma transacción: no hay repartos anteriores.
  'src/services/tpv/order.tpv.service.ts#createOrderWithItems': {
    clase: 'CREACION',
    nota: '«Cobrar»: orden, renglones y filas con su reparto (B2)',
  },
  'src/services/mobile/order.mobile.service.ts#createOrderWithItems': {
    clase: 'CREACION',
    nota: 'venta del móvil: espejos y fila de cuenta con su reparto (B2)',
  },
  'src/services/mobile/areaTicket.mobile.service.ts#openAreaTicket': {
    clase: 'CREACION',
    marcas: ['crearEspejosDelVale('],
    nota: 'P5: el vale nace con la fila espejo de cada descuento de artículo (crearEspejosDelVale)',
  },
  'src/services/mobile/areaTicketV7.mobile.service.ts#materializeAreaTicketCheckout': {
    clase: 'CREACION',
    nota: 'residual R1: los vales V7 traen su descuento por renglón, sin fila espejo',
  },
  'src/services/mobile/estimate.mobile.service.ts#convertToOrder': {
    clase: 'CREACION',
    nota: 'el presupuesto convertido nace sin descuentos',
  },
  'src/services/dashboard/manualSale.service.ts#createOneManualSale': {
    clase: 'CREACION',
    nota: 'venta manual: orden y renglones nuevos, sin filas de descuento',
  },
  'src/services/dashboard/paymentLink.service.ts#completeCharge': {
    clase: 'CREACION',
    nota: 'liga de pago: la orden nace sin descuentos',
  },
  'src/services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout': {
    clase: 'CREACION',
    nota: 'liga de pago: la orden nace sin descuentos',
  },
  'src/services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout': {
    clase: 'CREACION',
    nota: 'liga de pago: la orden nace sin descuentos',
  },
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder': {
    clase: 'CREACION',
    nota: 'pedido de delivery: el descuento del marketplace va en cabecera (D8)',
  },
  'src/services/onboarding/demoSeed.service.ts#seedOrders': {
    clase: 'CREACION',
    nota: 'datos demo: órdenes sembradas sin filas de descuento',
  },
  'src/services/reservation/createOrderFromReservation.ts#createOrderFromReservation': {
    clase: 'CREACION',
    nota: 'la reservación crea su orden con renglones nuevos',
  },
  'src/services/tpv/order.tpv.service.ts#sellSerializedItem': {
    clase: 'CREACION',
    nota: 'venta serializada: orden nueva de un solo renglón',
  },
  // Órdenes que nunca llevan filas con reparto.
  'src/services/delivery-channels/core/lineRemoval.service.ts#applyLineRemoval': {
    clase: 'SIN_FILAS',
    nota: 'pedidos de delivery: sin filas con reparto (D8); sólo marca el retiro',
  },
  'src/services/pos-sync/posSyncOrderItem.service.ts#applyPosOrderItemEvent': {
    clase: 'SIN_FILAS',
    nota: 'POS importado: la cabecera es la del POS externo (D8)',
  },
  // No mueven total ni descuento.
  'src/services/kds/kitchenTicketAuthoring.service.ts#authorKitchenTickets': {
    clase: 'METADATA',
    nota: 'marca las comandas del renglón; no mueve total ni descuento',
  },
  'src/services/fiscal/sellosIva.ts#sellarRenglones': {
    clase: 'SELLO_FISCAL',
    nota: 'escribe sólo el IVA sellado del renglón (ivaTratamiento)',
  },
  'src/services/fiscal/sellosIva.ts#liberarSellosDe': {
    clase: 'SELLO_FISCAL',
    nota: 'libera el IVA sellado del renglón; no mueve dinero',
  },
  'src/services/cleanup/liveDemoCleanup.service.ts#deleteVenueDataTx': {
    clase: 'TEARDOWN',
    nota: 'limpieza del demo en vivo: borra el negocio entero',
  },
  'src/services/dashboard/venue.dashboard.service.ts#deleteVenue': {
    clase: 'TEARDOWN',
    nota: 'borrar un negocio: se va todo con él',
  },
  'src/services/onboarding/demoCleanup.service.ts#cleanDemoData': {
    clase: 'TEARDOWN',
    nota: 'limpieza de datos demo del onboarding',
  },
  'src/services/tpv/order.tpv.service.ts#addSerializedItemToOrder': {
    clase: 'NO_INVALIDA',
    nota: 'agrega un renglón sin tocar los demás: las partes guardadas siguen dentro de su capacidad; el % de cuenta no se re-deriva aquí (límite de hoy)',
  },
  // Escaneo previo T-27: la tabla del plan no lo traía (B2 T7).
  'src/services/shared/repartoDescuentoTx.ts#revertirDescuentoDelRenglon': {
    clase: 'NO_INVALIDA',
    nota: 'sólo BAJA el descuento del renglón cuyo espejo se quita (la capacidad de los demás repartos crece); sus dos llamadores (removeDiscountFromOrder, removeOrderDiscount) sincronizan o recalculan después',
  },
}

describe('B2c: quien escribe renglones declara qué pasa con los descuentos repartidos (P4, P5)', () => {
  const mutadores = escanearRenglones()
  const { codigo } = escanear()
  it('encuentra a los escritores de renglones (si colapsa, se rompió el escáner)', () => {
    expect(mutadores.size).toBeGreaterThanOrEqual(35)
  })
  it('toda función que escribe OrderItem está clasificada exactamente una vez', () => {
    expect([...mutadores].sort()).toEqual(Object.keys(MUTADORES_DE_RENGLONES).sort())
  })
  it.each(Object.entries(MUTADORES_DE_RENGLONES))('%s: motivo y marcas', (llave, m) => {
    expect(m.nota.length).toBeGreaterThan(20)
    if (m.clase === 'SINCRONIZA') expect((m.marcas ?? []).length).toBeGreaterThan(0)
    for (const marca of m.marcas ?? [])
      expect({ llave, marca, presente: (codigo.get(llave) ?? '').includes(marca) }).toEqual({ llave, marca, presente: true })
  })
})
