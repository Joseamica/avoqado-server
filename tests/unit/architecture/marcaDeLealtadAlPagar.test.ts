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
    type Binding = { nodo: ts.Node; variable?: ts.VariableDeclaration }
    const bindings = new Map<ts.Node, Map<string, Binding>>()
    const asignaciones: { nodo: ts.Node; destino: ts.Expression; valor?: ts.Expression; directa: boolean }[] = []
    const esAmbitoVar = (n: ts.Node) =>
      ts.isSourceFile(n) || ts.isFunctionLike(n) || ts.isModuleBlock(n) || ts.isClassStaticBlockDeclaration(n)
    const esAmbito = (n: ts.Node) =>
      esAmbitoVar(n) ||
      ts.isBlock(n) ||
      ts.isCaseBlock(n) ||
      ts.isCatchClause(n) ||
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isClassLike(n)
    const ambito = (n: ts.Node, deVar = false): ts.Node => {
      for (let a = n.parent; a; a = a.parent) {
        // var se eleva al CUERPO; los defaults de parámetros no atraviesan este bloque.
        if (deVar && ts.isBlock(a) && ts.isFunctionLike(a.parent)) return a
        if ((deVar ? esAmbitoVar : esAmbito)(a)) return a
      }
      return sf
    }
    const registrar = (nombre: ts.BindingName, scope: ts.Node, b: Binding) => {
      if (!ts.isIdentifier(nombre)) {
        for (const e of nombre.elements) if (ts.isBindingElement(e)) registrar(e.name, scope, b)
        return
      }
      let locales = bindings.get(scope)
      if (!locales) bindings.set(scope, (locales = new Map()))
      // var sin inicializador puede conservar el parámetro recibido; una asignación posterior no lo reemplaza.
      const comparteParametro = ts.isBlock(scope) && ts.isFunctionLike(scope.parent) && bindings.get(scope.parent)?.has(nombre.text)
      // Una redeclaración ambigua tampoco permite elegir por defecto el valor exterior.
      locales.set(nombre.text, locales.has(nombre.text) || comparteParametro ? { nodo: scope } : b)
    }
    const recolectar = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) {
        const scope = ts.isCatchClause(n.parent) ? n.parent : ambito(n, !(n.parent.flags & ts.NodeFlags.BlockScoped))
        registrar(n.name, scope, { nodo: n, variable: ts.isIdentifier(n.name) && !ts.isCatchClause(n.parent) ? n : undefined })
      }
      if (ts.isParameter(n)) registrar(n.name, n.parent, { nodo: n }) // El caller puede sustituir incluso un default.
      if (ts.isFunctionDeclaration(n) && n.name) registrar(n.name, ambito(n), { nodo: n })
      if (ts.isFunctionExpression(n) && n.name) registrar(n.name, n, { nodo: n })
      if (ts.isClassLike(n) && n.name) {
        if (ts.isClassDeclaration(n)) registrar(n.name, ambito(n), { nodo: n })
        registrar(n.name, n, { nodo: n })
      }
      if ((ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n)) && ts.isIdentifier(n.name)) registrar(n.name, ambito(n), { nodo: n })
      if (ts.isImportClause(n) && n.name) registrar(n.name, ambito(n), { nodo: n })
      if (ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n)) registrar(n.name, ambito(n), { nodo: n })
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        asignaciones.push({ nodo: n, destino: n.left, valor: n.right, directa: n.operatorToken.kind === ts.SyntaxKind.EqualsToken })
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)
      )
        asignaciones.push({ nodo: n, destino: n.operand, directa: false })
      if (ts.isDeleteExpression(n)) asignaciones.push({ nodo: n, destino: n.expression, directa: false })
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer))
        asignaciones.push({ nodo: n, destino: n.initializer, directa: false })
      ts.forEachChild(n, recolectar)
    }
    recolectar(sf)
    const binding = (id: ts.Identifier): Binding | undefined => {
      for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
        const local = bindings.get(n)?.get(id.text)
        if (local) return local
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
    type Destino = { id: ts.Identifier; campo?: string; opaco?: boolean }
    const destinos = (entrada: ts.Expression): Destino[] => {
      const e = desenvolver(entrada)
      if (ts.isIdentifier(e)) return [{ id: e }]
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return [{ id: e.expression, campo: e.name.text }]
      if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isStringLiteral(e.argumentExpression))
        return [{ id: e.expression, campo: e.argumentExpression.text }]
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
        return destinos(e.expression).map(d => ({ ...d, opaco: true }))
      if (ts.isObjectLiteralExpression(e))
        return e.properties.flatMap(p => {
          const destino = ts.isPropertyAssignment(p)
            ? p.initializer
            : ts.isShorthandPropertyAssignment(p)
              ? p.name
              : ts.isSpreadAssignment(p)
                ? p.expression
                : undefined
          return destino ? destinos(destino).map(d => ({ ...d, opaco: true })) : []
        })
      if (ts.isArrayLiteralExpression(e))
        return e.elements.flatMap(el => (ts.isOmittedExpression(el) ? [] : destinos(el).map(d => ({ ...d, opaco: true }))))
      if (ts.isSpreadElement(e)) return destinos(e.expression).map(d => ({ ...d, opaco: true }))
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return destinos(e.left).map(d => ({ ...d, opaco: true }))
      return []
    }
    const cambios = (v: Binding) =>
      asignaciones.flatMap(a =>
        destinos(a.destino)
          .filter(d => binding(d.id) === v)
          .map(d => ({ ...a, ...d })),
      )
    const valores = (v: Binding) => {
      if (!v.variable) throw new Error(`binding opaco ${v.nodo.getText(sf)}`)
      const writes = cambios(v)
      if (writes.some(a => !a.directa || a.opaco || !a.valor)) throw new Error(`asignación opaca ${v.variable.name.getText(sf)}`)
      // Unión conservadora, también después del sitio: un lazo/callback puede reutilizar ese binding.
      return [...(v.variable.initializer ? [v.variable.initializer] : []), ...writes.filter(a => !a.campo).map(a => a.valor!)]
    }
    const campos = (entrada: ts.Expression, hasta: number, vistos = new Set<Binding>()): Campo[] => {
      const e = desenvolver(entrada)
      if (ts.isIdentifier(e)) {
        const v = binding(e)
        if (!v || vistos.has(v)) throw new Error(`binding opaco ${e.text}`)
        // Un valor posterior puede ocurrir en otra vuelta, pero nunca acredita campos de esta escritura.
        if ((v.variable && v.variable.getStart(sf) >= hasta) || cambios(v).some(a => a.nodo.getStart(sf) >= hasta))
          throw new Error(`asignación opaca posterior ${e.text}`)
        const siguientes = new Set(vistos).add(v)
        const bases = valores(v)
        if (!bases.length) throw new Error(`binding opaco sin valor ${e.text}`)
        const resultado = bases.flatMap(b => campos(b, hasta, siguientes))
        for (const a of cambios(v)) if (a.campo) resultado.push({ nombre: a.campo, valor: a.valor!, texto: a.nodo.getText(sf) })
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
    const puedeSerPaid = (entrada: ts.Expression, hasta: number, vistos = new Set<Binding>()): boolean => {
      const e = desenvolver(entrada)
      if (ts.isStringLiteral(e)) return !['PENDING', 'PARTIAL', 'REFUNDED'].includes(e.text)
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ['PENDING', 'PARTIAL', 'REFUNDED'].includes(e.name.text)) {
        const b = binding(e.expression)
        const spec = b?.nodo
        if (spec && ts.isImportSpecifier(spec) && (spec.propertyName ?? spec.name).text === 'PaymentStatus' && !spec.isTypeOnly) {
          const clause = spec.parent.parent
          const declaration = clause.parent
          if (
            ts.isImportClause(clause) &&
            !clause.isTypeOnly &&
            ts.isImportDeclaration(declaration) &&
            ts.isStringLiteral(declaration.moduleSpecifier) &&
            declaration.moduleSpecifier.text === '@prisma/client' &&
            !cambios(b!).length
          )
            return false
        }
      }
      if (ts.isConditionalExpression(e)) return puedeSerPaid(e.whenTrue, hasta, vistos) || puedeSerPaid(e.whenFalse, hasta, vistos)
      if (ts.isIdentifier(e)) {
        const v = binding(e)
        if (v?.variable && !vistos.has(v)) {
          const values = valores(v)
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

describe('I3 fixround2: familia léxica del escáner REAL', () => {
  const escanear = (source: string) => escritores([{ file: path.join(SRC, 'probe.ts'), source }])
  const exterior = "const data = {paymentStatus: 'PENDING'}; "
  it.each([
    ['parámetro exacto del revisor', 'function pagar(tx, data) { tx.order.update({data}) }'],
    ['parámetro default sustituible', "function pagar(tx, data = {paymentStatus:'PENDING'}) {tx.order.update({data})}"],
    ['parámetro rest', 'function pagar(tx, ...data) {tx.order.update({data})}'],
    ['arrow', 'const pagar = (tx, data) => tx.order.update({data})'],
    ['función expresión', 'const pagar = function(tx, data) {tx.order.update({data})}'],
    ['método de objeto', 'const acciones = {pagar(tx, data) {tx.order.update({data})}}'],
    ['método de clase', 'class Acciones {pagar(tx, data) {tx.order.update({data})}}'],
    ['setter', 'const acciones = {set pagar(data) {tx.order.update({data})}}'],
    ['parámetro patrón renombrado', 'function pagar(tx, {payload: data}) {tx.order.update({data})}'],
    ['parámetro patrón nested con default', "function pagar(tx, {payload: {data = {paymentStatus:'PENDING'}}}) {tx.order.update({data})}"],
    ['parámetro patrón array/rest', 'function pagar(tx, [id, ...data]) {tx.order.update({data})}'],
    ['variable patrón const', 'function pagar(tx, payload) {const {value: data} = payload; tx.order.update({data})}'],
    ['variable patrón var array', 'function pagar(tx, payload) {{var [data] = payload} tx.order.update({data})}'],
    ['catch simple', 'function pagar(tx) {try {throw payload} catch (data) {tx.order.update({data})}}'],
    ['catch patrón', 'function pagar(tx) {try {throw payload} catch ({value: data}) {tx.order.update({data})}}'],
    ['for let', 'function pagar(tx, payload) {for (let data = payload; seguir;) {tx.order.update({data})}}'],
    ['for-of const', 'function pagar(tx, rows) {for (const data of rows) {tx.order.update({data})}}'],
    ['for-in let', 'function pagar(tx, rows) {for (let data in rows) {tx.order.update({data})}}'],
    ['for-of var hoisted', 'function pagar(tx, rows) {for (var data of rows) {} tx.order.update({data})}'],
    ['var sin inicializador en bloque', 'function pagar(tx) {{var data} tx.order.update({data})}'],
    ['let sin valor corta exterior', 'function pagar(tx) {let data; tx.order.update({data})}'],
    [
      'reutilización en lazo posterior',
      "function pagar(tx) {let data={paymentStatus:'PENDING'}; for (let i=0;i<2;i++) {tx.order.update({data}); data={paymentStatus:'PAID'}}}",
    ],
    ['función local', 'function pagar(tx) {function data() {} tx.order.update({data})}'],
    ['nombre propio función expresión', 'const pagar = function data(tx) {tx.order.update({data})}'],
    ['clase local', 'function pagar(tx) {class data {} tx.order.update({data})}'],
    ['enum local', 'function pagar(tx) {enum data {value} tx.order.update({data})}'],
    ['asignación patrón objeto', 'function pagar(tx, payload) {let data = {}; ({data} = payload); tx.order.update({data})}'],
    ['asignación patrón array', 'function pagar(tx, payload) {let data = {}; [data] = payload; tx.order.update({data})}'],
    [
      'asignación patrón default',
      "function pagar(tx, payload) {let data = {}; ({value: data = {paymentStatus:'PENDING'}} = payload); tx.order.update({data})}",
    ],
    ['asignación patrón rest', 'function pagar(tx, payload) {let data = {}; [...data] = payload; tx.order.update({data})}'],
    ['switch con binding local opaco', 'function pagar(tx, payload) {switch (tipo) {case 0: let data=payload; tx.order.update({data})}}'],
    [
      'asignación patrón a propiedad',
      'function pagar(tx, payload) {const data = {}; ({value: data.paymentStatus} = payload); tx.order.update({data})}',
    ],
    ['asignación compuesta', 'function pagar(tx, payload) {let data = {}; data &&= payload; tx.order.update({data})}'],
    [
      'propiedad con asignación lógica',
      'function pagar(tx, payload) {const data = {}; data.paymentStatus ||= payload; tx.order.update({data})}',
    ],
    ['incremento', 'function pagar(tx) {let data = {}; data++; tx.order.update({data})}'],
    ['delete', 'function pagar(tx) {const data = {}; delete data.paymentStatus; tx.order.update({data})}'],
    ['for-of asigna binding existente', 'function pagar(tx, rows) {let data = {}; for (data of rows) {tx.order.update({data})}}'],
    ['for-in asigna binding existente', 'function pagar(tx, rows) {let data = {}; for (data in rows) {tx.order.update({data})}}'],
    [
      'propiedad computed desconocida',
      'function pagar(tx, campo, payload) {const data = {}; data[campo] = payload; tx.order.update({data})}',
    ],
    [
      'propiedad anidada no resuelta',
      'function pagar(tx, payload) {const data = {}; data.nested.value = payload; tx.order.update({data})}',
    ],
  ])('un binding o write opaco no cae al exterior: %s', (_caso, source) => {
    expect(() => escanear(exterior + source)).toThrow(/opaco/i)
  })
  it.each([
    [
      'estado parámetro sombreado',
      "const paymentStatus='PENDING'; function pagar(tx, paymentStatus) {tx.order.update({data:{paymentStatus}})}",
    ],
    ['namespace enum parámetro', 'function pagar(tx, PaymentStatus) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}'],
    ['namespace sin binding', 'function pagar(tx) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}'],
    [
      'namespace Prisma sombreado',
      "import {PaymentStatus} from '@prisma/client'; function pagar(tx, PaymentStatus) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}",
    ],
    [
      'namespace import sólo tipo',
      "import type {PaymentStatus} from '@prisma/client'; function pagar(tx) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}",
    ],
    [
      'namespace specifier sólo tipo',
      "import {type PaymentStatus} from '@prisma/client'; function pagar(tx) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}",
    ],
    [
      'namespace import de otro origen',
      "import {PaymentStatus} from './other'; function pagar(tx) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}",
    ],
    [
      'namespace enum local',
      "function pagar(tx) {const PaymentStatus={PENDING:'PAID'}; tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}",
    ],
    ['var de bloque pertenece a función', exterior + "function pagar(tx) {{var data={paymentStatus:'PAID'}} tx.order.update({data})}"],
    [
      'var de for pertenece a función',
      exterior + "function pagar(tx) {for (var data={paymentStatus:'PAID'}; false;) {} tx.order.update({data})}",
    ],
    [
      'for-in no sombrea afuera',
      "const data={paymentStatus:'PAID'}; function pagar(tx, rows) {for (const data in rows) {} tx.order.update({data})}",
    ],
    [
      'for-of no sombrea afuera',
      "const data={paymentStatus:'PAID'}; function pagar(tx, rows) {for (const data of rows) {} tx.order.update({data})}",
    ],
    ['propiedad literal indexada', "function pagar(tx) {const data={}; data['paymentStatus']='PAID'; tx.order.update({data})}"],
    ['asignación directa conocida', "function pagar(tx) {let data; data={paymentStatus:'PAID'}; tx.order.update({data})}"],
  ])('conserva raíz si el estado puede ser PAID: %s', (_caso, source) => {
    expect([...escanear(source).keys()]).toEqual(['probe.ts#pagar:update:data'])
  })
  it.each([
    ['bloque hermano', exterior + "function pagar(tx) {{const data={paymentStatus:'PAID'}} tx.order.update({data})}"],
    ['otra función', exterior + "function otra() {var data={paymentStatus:'PAID'}} function pagar(tx) {tx.order.update({data})}"],
    ['write de sombra', exterior + "function pagar(tx) {{let data={}; data.paymentStatus='PAID'} tx.order.update({data})}"],
    ['catch fuera de alcance', exterior + 'function pagar(tx) {try {} catch(data) {} tx.order.update({data})}'],
    [
      'switch fuera de alcance',
      exterior + "function pagar(tx) {switch (tipo) {case 0: const data={paymentStatus:'PAID'}} tx.order.update({data})}",
    ],
    [
      'enum Prisma canónico',
      "import {PaymentStatus} from '@prisma/client'; function pagar(tx) {tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})}",
    ],
  ])('no contamina un negativo conocido: %s', (_caso, source) => {
    expect([...escanear(source).keys()]).toEqual([])
  })
  it('un valor futuro no acredita la marca de una escritura previa', () => {
    expect(() =>
      escanear(
        "function pagar(tx) {let data={paymentStatus:'PAID'}; tx.order.update({data}); data={paymentStatus:'PAID',loyaltyEligibleAt:new Date()}}",
      ),
    ).toThrow(/opaco/i)
  })
  it('sigue fallando cerrado sin homónimo y conserva marker como propiedad real', () => {
    expect(() => escanear('function pagar(tx, data) {tx.order.update({data})}')).toThrow(/opaco/i)
    const row = escanear(
      "function pagar(tx) {const data={paymentStatus:'PAID', loyaltyEligibleAt:new Date()}; tx.order.update({data})}",
    ).get('probe.ts#pagar:update:data')
    expect(row?.campos.has('loyaltyEligibleAt')).toBe(true)
  })
})

describe('I3 R16: parámetros/defaults y var del cuerpo en el escáner REAL', () => {
  const escanear = (source: string) => escritores([{ file: path.join(SRC, 'probe.ts'), source }])
  it.each([
    [
      'función',
      "const estado='PAID'; function pagar(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PENDING'}",
      'pagar',
    ],
    [
      'función expresión',
      "const estado='PAID'; const pagar=function(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PENDING'}",
      '(módulo)',
    ],
    [
      'arrow',
      "const estado='PAID'; const pagar=(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) => {var estado='PENDING'}",
      'pagar',
    ],
    [
      'método objeto',
      "const estado='PAID'; const acciones={pagar(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PENDING'}}",
      '(módulo)',
    ],
    [
      'método clase',
      "const estado='PAID'; class Acciones {pagar(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PENDING'}}",
      '(módulo)',
    ],
    [
      'constructor',
      "const estado='PAID'; class Acciones {constructor(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PENDING'}}",
      '(módulo)',
    ],
    [
      'var anidado',
      "const estado='PAID'; function pagar(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {{var estado='PENDING'}}",
      'pagar',
    ],
    [
      'parámetro real homónimo',
      "const estado='PENDING'; function pagar(tx, estado, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PENDING'}",
      'pagar',
    ],
    [
      'var redeclara parámetro y sólo se asigna después',
      "function pagar(tx, estado) {var estado; tx.order.update({data:{paymentStatus:estado}}); estado='PENDING'}",
      'pagar',
    ],
    [
      'constructor conserva parámetro recibido',
      "class Acciones {constructor(tx, estado) {var estado; tx.order.update({data:{paymentStatus:estado}}); estado='PENDING'}}",
      '(módulo)',
    ],
  ])('DEFAULT ve el exterior/parámetro y nunca var del CUERPO: %s', (_caso, source, owner) => {
    expect([...escanear(source).keys()]).toEqual([`probe.ts#${owner}:update:data`])
  })
  it.each([
    ['función', "const estado='PAID'; function pagar(tx, disparo) {var estado='PENDING'; tx.order.update({data:{paymentStatus:estado}})}"],
    [
      'función expresión',
      "const estado='PAID'; const pagar=function(tx, disparo) {var estado='PENDING'; tx.order.update({data:{paymentStatus:estado}})}",
    ],
    ['arrow', "const estado='PAID'; const pagar=(tx, disparo) => {var estado='PENDING'; tx.order.update({data:{paymentStatus:estado}})}"],
    [
      'método objeto',
      "const estado='PAID'; const acciones={pagar(tx, disparo) {var estado='PENDING'; tx.order.update({data:{paymentStatus:estado}})}}",
    ],
    [
      'método clase',
      "const estado='PAID'; class Acciones {pagar(tx, disparo) {var estado='PENDING'; tx.order.update({data:{paymentStatus:estado}})}}",
    ],
    [
      'constructor',
      "const estado='PAID'; class Acciones {constructor(tx, disparo) {var estado='PENDING'; tx.order.update({data:{paymentStatus:estado}})}}",
    ],
    [
      'var hoisted desde bloque',
      "const estado='PAID'; function pagar(tx) {{var estado='PENDING'} tx.order.update({data:{paymentStatus:estado}})}",
    ],
    [
      'exteriorPENDING no hereda bodyPAID',
      "const estado='PENDING'; function pagar(tx, disparo=tx.order.update({data:{paymentStatus:estado}})) {var estado='PAID'}",
    ],
    [
      'importPrisma visible desde default',
      "import {PaymentStatus} from '@prisma/client'; function pagar(tx, disparo=tx.order.update({data:{paymentStatus:PaymentStatus.PENDING}})) {var PaymentStatus={PENDING:'PAID'}}",
    ],
  ])('conserva el negativo del entorno que realmente lee: %s', (_caso, source) => {
    expect([...escanear(source).keys()]).toEqual([])
  })
  it('DATAdefault ya estaba protegido: conserva raíz u opaco, nunca omisión', () => {
    let all: Map<string, Escritura>
    try {
      all = escanear(
        "const data={paymentStatus:'PAID'}; function pagar(tx, disparo=tx.order.update({data})) {var data={paymentStatus:'PENDING'}}",
      )
    } catch (error) {
      expect(String(error)).toMatch(/opaco/i)
      return
    }
    expect([...all.keys()]).toEqual(['probe.ts#pagar:update:data'])
  })
  it('DATAcuerpo sigue leyendo su varPENDING y no el exteriorPAID', () => {
    expect([
      ...escanear(
        "const data={paymentStatus:'PAID'}; function pagar(tx, disparo) {var data={paymentStatus:'PENDING'}; tx.order.update({data})}",
      ).keys(),
    ]).toEqual([])
  })
  it('var sin valor no reemplaza un parámetro DATA recibido', () => {
    expect(() => escanear('function pagar(tx, data) {var data; tx.order.update({data})}')).toThrow(/opaco/i)
  })
})
