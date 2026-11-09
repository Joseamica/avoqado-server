/** S3: cada llamada real que puede escribir PAID deja la obligación, o acredita una excepción semántica concreta. */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { createHash } from 'crypto'

const SRC = path.join(__dirname, '../../../src')
function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

type Fuente = { file: string; source: string }
type Escritura = { texto: string; campos: Set<string> }
// Fragmentos revisados R9: los cuerpos reales sólo aportan cliente o fechas de operación, nunca paymentStatus.
// Una modificación de cuerpo/binding/import o un proveedor orderExtra nuevo vuelve a fallar cerrado.
const ORDER_EXTRA = {
  'services/online-ordering/card/capture.service.ts#finishCapture': 'cc89539c8ab07f50fa23da72755a4178b2dc306a362d327f6696ad5f9723c974',
  'services/online-ordering/folios.service.ts#prepararFolioPagadoEnTx': '03492385cd13ca22511f898001f83b08d5e98d4967e05491fb845a3920c3f80f',
  'services/online-ordering/transitions.service.ts#acceptWithoutCapture':
    'cc89539c8ab07f50fa23da72755a4178b2dc306a362d327f6696ad5f9723c974',
  'services/online-ordering/transitions.service.ts#markOnlineOrderDelivered':
    'bdbc94690bb1489b7c3a76c3b240d30163fc5d609107533683394ab0b7d746fd',
}
const CALLERS_EXTRA = {
  'services/online-ordering/card/capture.service.ts#finishCapture:casTransitionInTx':
    '02c982331f52c1f8c6eefd9f5dd2742c45681962c25d8914f95af0d2d1377b5c',
  'services/online-ordering/folios.service.ts#prepararFolioPagadoEnTx:casTransitionInTx':
    'e949dbd631f6397166abd46c236f261f76d09d73170e1b697e276bce27a054ed',
  'services/online-ordering/transitions.service.ts#casTransition:casTransitionInTx':
    '7f1c56ed0daae0c337e928cf803e6b1619e853ceba2251517e95ddbf6198a0d8',
  'services/online-ordering/transitions.service.ts#acceptWithoutCapture:casTransition':
    'f27df0037107bfb8b06bc8e86fd3a375338f0a26008d9932067756c726c9900b',
  'services/online-ordering/transitions.service.ts#rejectOnlineOrder:casTransition':
    'df0ca08ed26053dd6507de5a955c096c6a76bfd5e799e3eb3a3207b4b8199d03',
  'services/online-ordering/transitions.service.ts#expireOnlineOrder:casTransition':
    '43ec329eb5714ea1ddb13eb7cda9c41b603ce84286521cacb3b3b91dac3329ff',
  'services/online-ordering/transitions.service.ts#markOnlineOrderReady:casTransition':
    '146f2f95738dd2779b647778cdc6f854feb05e275b93f218c2abe7a59208471e',
  'services/online-ordering/transitions.service.ts#markOnlineOrderDelivered:casTransition':
    'ca255c4fcb193a941a82b8014b6e36e66144cb1eeadfe7edab0809b9b07e5cfd',
  'services/online-ordering/transitions.service.ts#cancelOnlineOrderByCustomer:casTransition':
    'eb3207b45e3b92ed3046c322c546d4e0680f9af66d66f921fc52584d7db96da2',
}
function escritores(
  fuentes: Fuente[] = archivos(SRC).map(file => ({ file, source: fs.readFileSync(file, 'utf8') })),
): Map<string, Escritura> {
  const out = new Map<string, Escritura>()
  const opacos: string[] = []
  const parsed = new Map<string, ts.SourceFile>()
  const parsear = ({ file, source }: Fuente) => {
    if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))
    return parsed.get(file)!
  }
  const hash = (n: ts.Node) => createHash('sha256').update(n.getText()).digest('hex')
  const contrato = (ruta: string, elegir: (n: ts.Node) => boolean, esperado: string) => {
    const fuente = fuentes.find(f => path.relative(SRC, f.file) === ruta)
    const encontrados: ts.Node[] = []
    const visitar = (n: ts.Node) => {
      if (elegir(n)) encontrados.push(n)
      ts.forEachChild(n, visitar)
    }
    if (fuente) visitar(parsear(fuente))
    if (encontrados.length !== 1 || hash(encontrados[0]) !== esperado) throw new Error(`contrato opaco cambiado ${ruta}`)
  }
  let extrasComprobados = false
  const comprobarExtras = () => {
    if (extrasComprobados) return
    const actuales: Record<string, string> = {}
    const callers: Record<string, string> = {}
    for (const fuente of fuentes) {
      const sf = parsear(fuente)
      const visitar = (n: ts.Node) => {
        const esProveedor =
          (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
          (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
          n.name.text === 'orderExtra'
        const esCaller = ts.isCallExpression(n) && ['casTransitionInTx', 'casTransition'].includes(n.expression.getText(sf))
        if (ts.isBinaryExpression(n) && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'orderExtra')
          throw new Error('contrato opaco orderExtra: asignación fuera de los proveedores revisados')
        if (esProveedor || esCaller) {
          let f: ts.Node | undefined = n.parent
          while (f && !ts.isFunctionDeclaration(f)) f = f.parent
          const key = `${path.relative(SRC, fuente.file)}#${f && ts.isFunctionDeclaration(f) ? f.name?.text : '(módulo)'}`
          if (esProveedor && (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n))) {
            if (actuales[key]) throw new Error(`proveedor orderExtra opaco repetido ${key}`)
            actuales[key] = hash(ts.isPropertyAssignment(n) ? n.initializer : n.name)
          }
          if (esCaller && ts.isCallExpression(n)) {
            const caller = `${key}:${n.expression.getText(sf)}`
            if (callers[caller]) throw new Error(`caller orderExtra opaco repetido ${caller}`)
            callers[caller] = hash(n)
          }
        }
        ts.forEachChild(n, visitar)
      }
      visitar(sf)
    }
    if (
      JSON.stringify(Object.entries(actuales).sort()) !== JSON.stringify(Object.entries(ORDER_EXTRA).sort()) ||
      JSON.stringify(Object.entries(callers).sort()) !== JSON.stringify(Object.entries(CALLERS_EXTRA).sort())
    )
      throw new Error('contrato opaco orderExtra: proveedor nuevo, modificado o ausente')
    extrasComprobados = true
  }
  for (const { file, source } of fuentes) {
    const sf = parsear({ file, source })
    const variables: ts.VariableDeclaration[] = []
    const asignaciones: ts.BinaryExpression[] = []
    const recolectar = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) variables.push(n)
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) asignaciones.push(n)
      ts.forEachChild(n, recolectar)
    }
    recolectar(sf)
    const esAmbito = (n: ts.Node) => ts.isBlock(n) || ts.isSourceFile(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
    const ambito = (n: ts.Node): ts.Node => (n.parent && !esAmbito(n.parent) ? ambito(n.parent) : n.parent)
    const binding = (id: ts.Identifier) => {
      for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
        if (!esAmbito(n)) continue
        const v = variables.find(v => (v.name as ts.Identifier).text === id.text && ambito(v) === n)
        if (v) return v
      }
      return undefined
    }
    const desenvolver = (e: ts.Expression): ts.Expression =>
      ts.isAsExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isSatisfiesExpression(e)
        ? desenvolver(e.expression)
        : e
    const nombre = (n: ts.PropertyName) => {
      if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text
      if (ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression)) return n.expression.text
      throw new Error(`nombre opaco ${n.getText(sf)}`)
    }
    type Campo = { nombre: string; valor: ts.Expression; texto: string }
    const valores = (v: ts.VariableDeclaration, hasta: number) => [
      ...(v.initializer ? [v.initializer] : []),
      ...asignaciones.filter(a => a.getStart(sf) < hasta && ts.isIdentifier(a.left) && binding(a.left) === v).map(a => a.right),
    ]
    const campos = (entrada: ts.Expression, hasta: number, vistos = new Set<ts.Node>()): Campo[] => {
      const e = desenvolver(entrada)
      if (ts.isIdentifier(e)) {
        const v = binding(e)
        if (!v || vistos.has(v)) throw new Error(`binding opaco ${e.text}`)
        const siguientes = new Set(vistos).add(v)
        const bases = valores(v, hasta)
        if (!bases.length) throw new Error(`binding opaco sin valor ${e.text}`)
        const resultado = bases.flatMap(b => campos(b, hasta, siguientes))
        for (const a of asignaciones) {
          if (a.getStart(sf) >= hasta) continue
          const l = a.left
          if (ts.isPropertyAccessExpression(l) && ts.isIdentifier(l.expression) && binding(l.expression) === v)
            resultado.push({ nombre: l.name.text, valor: a.right, texto: a.getText(sf) })
          if (ts.isElementAccessExpression(l) && ts.isIdentifier(l.expression) && binding(l.expression) === v) {
            if (!ts.isStringLiteral(l.argumentExpression)) throw new Error(`asignación opaca ${l.getText(sf)}`)
            resultado.push({ nombre: l.argumentExpression.text, valor: a.right, texto: a.getText(sf) })
          }
        }
        return resultado
      }
      if (ts.isConditionalExpression(e)) return [...campos(e.whenTrue, hasta, vistos), ...campos(e.whenFalse, hasta, vistos)]
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return campos(e.right, hasta, vistos)
      const fragmento = e.getText(sf)
      const ruta = path.relative(SRC, file)
      if (ruta === 'services/mobile/order.mobile.service.ts' && fragmento === 'clienteDeLaParteSeparada(source)') {
        contrato(
          ruta,
          n => ts.isFunctionDeclaration(n) && n.name?.text === 'clienteDeLaParteSeparada',
          'cdb74efe4a79e0dbc8ae5f724fd78eff69555afe2dfbe590b5644ff879795e08',
        )
        return []
      }
      if (ruta === 'services/tpv/payment.tpv.service.ts' && fragmento === 'customerOrderData ?? {}') {
        contrato(
          'services/tpv/fastPaymentCustomer.ts',
          n => ts.isFunctionDeclaration(n) && n.name?.text === 'resolveFastOrderCustomer',
          '8e0329a5bceb4b21723294a4438acf7c1979544c9c3b6f9289a35aaef1629c70',
        )
        contrato(
          ruta,
          n => ts.isVariableDeclaration(n) && n.name.getText().includes('customerOrderData'),
          '1f78733710f376d9a4960241110d143dc1fe8f16d3d912ffe58bd212f09d76b4',
        )
        contrato(
          ruta,
          n => ts.isImportDeclaration(n) && n.moduleSpecifier.getText() === "'./fastPaymentCustomer'",
          '949905ffc3e4c84cdd46efe0b9aa808cf3799ed9fa45a05dddfd6512c90d4dc8',
        )
        return []
      }
      if (ruta === 'services/online-ordering/transitions.service.ts' && fragmento === 'a.orderExtra?.(now) ?? {}') {
        comprobarExtras()
        return []
      }
      if (!ts.isObjectLiteralExpression(e)) throw new Error(`datos opacos ${e.getText(sf)}`)
      return e.properties.flatMap(p => {
        if (ts.isSpreadAssignment(p)) return campos(p.expression, hasta, vistos)
        if (ts.isPropertyAssignment(p)) return [{ nombre: nombre(p.name), valor: p.initializer, texto: p.getText(sf) }]
        if (ts.isShorthandPropertyAssignment(p)) return [{ nombre: p.name.text, valor: p.name, texto: p.getText(sf) }]
        throw new Error(`propiedad opaca ${p.getText(sf)}`)
      })
    }
    const puedeSerPaid = (entrada: ts.Expression, hasta: number, vistos = new Set<ts.Node>()): boolean => {
      const e = desenvolver(entrada)
      if (ts.isStringLiteral(e)) return !['PENDING', 'PARTIAL', 'REFUNDED'].includes(e.text)
      if (/^PaymentStatus\.(PENDING|PARTIAL|REFUNDED)$/.test(e.getText(sf))) return false
      if (ts.isConditionalExpression(e)) return puedeSerPaid(e.whenTrue, hasta, vistos) || puedeSerPaid(e.whenFalse, hasta, vistos)
      if (ts.isIdentifier(e)) {
        const v = binding(e)
        if (v && !vistos.has(v)) {
          const values = valores(v, hasta)
          if (values.length) return values.some(b => puedeSerPaid(b, hasta, new Set(vistos).add(v)))
        }
      }
      return true // estado derivado desconocido: nunca se descarta como no-PAID.
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && /\.order\.(?:create|update|updateMany|upsert)$/.test(n.expression.getText(sf))) {
        let f: ts.Node | undefined = n.parent
        while (f && !ts.isFunctionDeclaration(f) && !(ts.isArrowFunction(f) && ts.isVariableDeclaration(f.parent))) f = f.parent
        const name =
          f && ts.isFunctionDeclaration(f)
            ? f.name?.getText(sf)
            : f && ts.isVariableDeclaration(f.parent)
              ? f.parent.name.getText(sf)
              : '(módulo)'
        const raiz = `${path.relative(SRC, file)}#${name}:${(n.expression as ts.PropertyAccessExpression).name.text}`
        try {
          if (!n.arguments[0]) throw new Error('argumento opaco ausente')
          const ramas = campos(n.arguments[0], n.getStart(sf)).filter(p => ['data', 'update', 'create'].includes(p.nombre))
          if (!ramas.length) throw new Error('argumento opaco sin data/create/update')
          for (const rama of new Set(ramas.map(p => p.nombre))) {
            const data = ramas.filter(p => p.nombre === rama).flatMap(p => campos(p.valor, n.getStart(sf)))
            if (!data.some(p => p.nombre === 'paymentStatus' && puedeSerPaid(p.valor, n.getStart(sf)))) continue
            const key = `${raiz}:${rama}`
            if (out.has(key)) throw new Error(`segunda llamada sin identidad propia ${key}`)
            out.set(key, { texto: data.map(p => p.texto).join('\n'), campos: new Set(data.map(p => p.nombre)) })
          }
        } catch (error) {
          opacos.push(`${raiz}: ${String(error)}`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  if (opacos.length) throw new Error(`Datos opacos o sin clasificar:\n${opacos.join('\n')}`)
  return out
}

const PROTEGIDAS = [
  // S3-4: sólo el primer saldado de OnlineOrder del mismo venue marca; el genérico sigue sin lealtad.
  'services/b4bit/b4bit.service.ts#settleOrderForConfirmedCryptoPayment:updateMany:data',
  'services/dashboard/customer.dashboard.service.ts#settleCustomerBalance:updateMany:data',
  'services/dashboard/order.dashboard.service.ts#settleOrder:updateMany:data',
  'services/dashboard/manualPayment.service.ts#createManualPayment:update:data',
  'services/dashboard/sale-verification.org.dashboard.service.ts#moverCuentaAlImporte:update:data',
  'services/mobile/areaTicketV7.mobile.service.ts#finalizeAreaTicketPaymentInTransaction:update:data',
  'services/mobile/order.mobile.service.ts#registrarAbonoEnTx:updateMany:data',
  'services/online-ordering/card/capture.service.ts#finishCapture:update:data',
  'services/online-ordering/card/release.service.ts#recordCapturedOutsideOnRelease:update:data',
  'services/tpv/payment.tpv.service.ts#settleStandalonePaymentInTx:update:data',
  'services/tpv/payment.tpv.service.ts#updateOrderTotalsForStandalonePayment:update:data',
]

// La excepción es por llamada/ramas alcanzables, no por un nombre de servicio mixto.
const EXENTAS: Record<string, { motivo: string; prueba: string }> = {
  'services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder:upsert:create': {
    motivo: 'INSERT de pedido de marketplace; cobra un tercero, no paga el folio de nuestra tienda.',
    prueba: 'originSystem: OriginSystem.DELIVERY_PLATFORM',
  },

  'services/dashboard/manualPayment.service.ts#createManualPayment:create:data': {
    motivo: 'Sólo Modo2, INSERT de sombra MANUAL_ENTRY; Modo1 update está protegido por separado.',
    prueba: "type: 'MANUAL_ENTRY'",
  },
  'services/dashboard/manualSale.service.ts#createOneManualSale:create:data': {
    motivo: 'Importación de venta serializada histórica: INSERT MANUAL_ENTRY, nunca paga un folio existente.',
    prueba: "type: 'MANUAL_ENTRY'",
  },
  'services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout:create:data': {
    motivo: 'INSERT de cuenta para sesión de liga, nunca update de folio.',
    prueba: "source: 'PAYMENT_LINK'",
  },
  'services/dashboard/paymentLink.service.ts#completeCharge:create:data': {
    motivo: 'Cobro directo de liga crea cuenta propia, sin OnlineOrder.',
    prueba: "source: 'PAYMENT_LINK'",
  },
  'services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout:create:data': {
    motivo: 'MercadoPago liga/checkout crea cuenta propia según isLink; ninguna rama paga un folio.',
    prueba: "source: isLink ? 'PAYMENT_LINK' : 'WEB'",
  },
  'services/dashboard/venueCheckout.service.ts#finalizeVenueCheckout:create:data': {
    motivo: 'Checkout genérico INSERT MANUAL_ENTRY, sin folio.',
    prueba: "type: 'MANUAL_ENTRY'",
  },
  'services/demo/negociosDemo.service.ts#seedHistory:create:data': {
    motivo: 'Semilla de historial ficticio nuevo, no cobro ni OnlineOrder.',
    prueba: 'paymentStatus:',
  },
  'services/onboarding/demoSeed.service.ts#seedOrders:create:data': {
    motivo: 'Semilla de órdenes ficticias al dar de alta demo, no folios cobrados.',
    prueba: 'paymentStatus: PaymentStatus.PAID',
  },
  'services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent:upsert:create': {
    motivo: 'Rama create de cuenta SoftRestaurant con identidad externa; update de la misma cuenta externa, no folio Avoqado.',
    prueba: 'originSystem: OriginSystem.POS_SOFTRESTAURANT',
  },
  'services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent:upsert:update': {
    motivo:
      'Update por la llave externa del productor POS. Folio oficial web:key tiene dos componentes y key pública sin dos puntos; no comparte la identidad exacta ni el alias instance:0:folio del productor.',
    prueba: 'paymentStatus: orderData.paymentStatus',
  },
  'services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent:update:data': {
    motivo:
      'Sólo alias POS existingOrder.externalId distinto: resolución exacta o de tres componentes a instance:0:folio, releída bajo lock. El namespace oficial web:key de dos componentes no llega a ese alias.',
    prueba: 'paymentStatus: orderData.paymentStatus',
  },
  'services/tpv/order.tpv.service.ts#runCreateOrderTransaction:create:data': {
    motivo: 'Orden nueva gratuita: cierre en cero sin dinero no suma (P2-4); con dinero nace pendiente. No implementa S11.',
    prueba: 'paymentStatus: isFreeCart',
  },
  'services/tpv/payment.tpv.service.ts#recordFastPayment:create:data': {
    motivo: 'INSERT de venta rápida nueva, nunca folio. Su marca posterior permanece en la MISMA tx (pruebas TPV).',
    prueba: "source: 'TPV'",
  },
}

let inventario: Map<string, Escritura> | undefined
const inventarioReal = () => (inventario ??= escritores())
describe('inventario de PAID y lealtad (incluye estados derivados)', () => {
  it('I3 descubre la rama REAL upsert:update de SoftRestaurant aunque updateData sea una variable', () => {
    expect(inventarioReal().has('services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent:upsert:update')).toBe(true)
    expect(inventarioReal().has('services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent:update:data')).toBe(true)
  })
  it('no admite un escritor nuevo sin clasificar ni una excepción que ya no existe', () => {
    expect([...inventarioReal().keys()].sort()).toEqual([...PROTEGIDAS, ...Object.keys(EXENTAS)].sort())
  })
  it('cada llamada protegida pone loyaltyEligibleAt junto al estado, sin contar otra llamada vecina', () => {
    const all = inventarioReal()
    for (const key of PROTEGIDAS) expect({ key, marca: all.get(key)?.campos.has('loyaltyEligibleAt') }).toEqual({ key, marca: true })
  })
  it('cada excepción conserva su condición particular de rama/caller', () => {
    const all = inventarioReal()
    for (const [key, { motivo, prueba }] of Object.entries(EXENTAS)) {
      expect(motivo.length).toBeGreaterThan(30)
      expect({ key, rama: all.get(key)?.texto.includes(prueba) }).toEqual({ key, rama: true })
    }
  })
})

describe('probe del escáner REAL de escritores', () => {
  const escanear = (source: string) => escritores([{ file: path.join(SRC, 'probe.ts'), source }])
  it.each([
    "const data = {paymentStatus: 'PAID'}; tx.order.update({where: {id}, data})",
    "const args = {where: {id}, data: {paymentStatus: 'PAID'}}; tx.order.update(args)",
    "const base = {paymentStatus: 'PAID'}; tx.order.update({where: {id}, data: {...base}})",
    "const data = {}; data.paymentStatus = 'PAID'; tx.order.update({where: {id}, data})",
    "let args = {data: {paymentStatus: 'PAID'}}; args = {data: {paymentStatus: 'PAID'}}; tx.order.update(args)",
  ])('no pierde datos locales: %s', body => {
    expect([...escanear(`function pagar(tx, id) {${body}}`).keys()]).toEqual(['probe.ts#pagar:update:data'])
  })
  it('falla cerrado si los datos o el argumento entero quedan opacos', () => {
    expect(() => escanear('function pagar(tx, data) {tx.order.update({where: {id}, data})}')).toThrow(/opaco/i)
    expect(() => escanear('function pagar(tx, args) {tx.order.update(args)}')).toThrow(/opaco/i)
  })
  it.each(['PENDING', 'PARTIAL', 'REFUNDED'])('no clasifica %s como PAID', estado => {
    expect([...escanear(`function pagar(tx) {const data = {paymentStatus: '${estado}'}; tx.order.update({data})}`).keys()]).toEqual([])
  })
  it('respeta el binding sombreado y no considera un comentario como campo escrito', () => {
    expect([
      ...escanear(
        "function pagar(tx) {const data={paymentStatus:'PAID'}; {const data={paymentStatus:'PENDING'}; tx.order.update({data})}}",
      ).keys(),
    ]).toEqual([])
    const row = escanear("function pagar(tx) {tx.order.update({data:{paymentStatus:'PAID' /* loyaltyEligibleAt: new Date() */}})}").get(
      'probe.ts#pagar:update:data',
    )
    expect(row?.campos.has('loyaltyEligibleAt')).toBe(false)
  })
  it('un cambio al cuerpo REAL de un fragmento revisado vuelve a fallar cerrado', () => {
    const file = path.join(SRC, 'services/mobile/order.mobile.service.ts')
    const original = fs.readFileSync(file, 'utf8')
    expect(() => escritores([{ file, source: original }])).not.toThrow()
    const source = original.replace('customerId: cliente.dueno,', "paymentStatus: 'PAID',")
    expect(() => escritores([{ file, source }])).toThrow(/contrato opaco cambiado/)
  })
  it('orderExtra comprueba los cuatro cuerpos y no admite un caller opaco nuevo', () => {
    const fuentes = [
      'services/online-ordering/transitions.service.ts',
      'services/online-ordering/card/capture.service.ts',
      'services/online-ordering/folios.service.ts',
    ].map(p => ({ file: path.join(SRC, p), source: fs.readFileSync(path.join(SRC, p), 'utf8') }))
    expect(() => escritores(fuentes)).not.toThrow()
    const cambiado = fuentes.map((f, i) =>
      i
        ? f
        : { ...f, source: f.source.replace('orderExtra: now => ({ completedAt: now })', "orderExtra: now => ({ paymentStatus: 'PAID' })") },
    )
    expect(() => escritores(cambiado)).toThrow(/contrato opaco orderExtra/)
    const nuevo = fuentes.map((f, i) =>
      i ? f : { ...f, source: f.source + '\nfunction nuevo(tx, args) { return casTransitionInTx(tx, args) }' },
    )
    expect(() => escritores(nuevo)).toThrow(/contrato opaco orderExtra/)
  })
})
