/**
 * IVA por producto, Plan 3b (T7): final manifest of every function that writes what the documentary capture freezes.
 *
 * The capture (`emitirConEntrada` → `bloquearOrdenParaFacturar` + `loadOrderForCfdiFromDb` + `capturarEntrada`) reads
 * an Order's money, lines, modifiers, discounts, service charges, promotions and payments under `Order FOR UPDATE`.
 * Every function in src/ that writes those fiscal children, rewrites Order money or deletes Orders is a FISCAL writer
 * and is classified here exactly once:
 *   (a) LOCKED            takes the tenant Order lock, rereads and writes children + totals in one tx (proof named)
 *       CALLER_LOCKED     tx-only body: every call site belongs to a writer/holder that already holds the lock
 *   (b) PRIVATE_CREATION  creates the Order and its children in the same transaction
 *   (c) METADATA          opaque data map without money columns (checked: no money token in its code)
 *   (d) EXCLUDED          demo/cleanup/teardown, fiscal sealing — with the reason and any known residual
 * Every other function that writes an Order row is inventoried too (non-fiscal: metadata, nested creation, cancel
 * guard, contract confirmation), so a new Order writer anywhere fails this suite until someone classifies it.
 * The scan is an inventory net, not lock evidence: the named PostgreSQL tests are the evidence.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')

const CHILD_MODELS = new Set(['orderItem', 'orderItemModifier', 'orderDiscount', 'orderServiceCharge', 'orderPromotion'])
const WRITE_METHODS = new Set([
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
const MONEY_COLUMNS = [
  'subtotal',
  'taxAmount',
  'total',
  'discountAmount',
  'serviceChargeAmount',
  'deliveryFeeAmount',
  'tipAmount',
  'paidAmount',
  'remainingBalance',
  'paymentStatus',
]
const NESTED_CHILDREN = new Set(['items', 'orderDiscounts', 'serviceCharges', 'promotions', 'payments'])
const RAW_WRITE =
  /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+"(Order|OrderItem|OrderItemModifier|OrderDiscount|OrderServiceCharge|OrderPromotion)"/

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(p)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [p] : []
  })
}

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e

/** Outermost named unit that contains the node: top-level function or const, or `Class.method`. */
function ownerOf(node: ts.Node): string {
  let owner = '(module)'
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && ts.isSourceFile(n.parent)) owner = n.name.text
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent.parent.parent)) owner = n.name.text
    else if (ts.isMethodDeclaration(n) && ts.isClassDeclaration(n.parent) && n.parent.name)
      owner = `${n.parent.name.text}.${n.name.getText()}`
  }
  return owner
}

/** Property `name` of an object literal argument (shorthand included), or undefined. */
function property(arg: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!arg) return undefined
  const object = unwrap(arg)
  if (!ts.isObjectLiteralExpression(object)) return undefined
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name
  }
  return undefined
}

/** The payload of a write argument: its `name` property, or the whole argument when it is not an object literal (opaque). */
const payloadOf = (arg: ts.Expression | undefined, name: string) =>
  arg && !ts.isObjectLiteralExpression(unwrap(arg)) ? arg : property(arg, name)

/** A write payload is fiscal if it names a money column or a nested child, or cannot be read statically (opaque). */
function fiscalPayload(expression: ts.Expression | undefined): boolean {
  if (!expression) return false
  const e = unwrap(expression)
  if (!ts.isObjectLiteralExpression(e)) return true
  return e.properties.some(p => {
    if (ts.isSpreadAssignment(p)) {
      const spread = unwrap(p.expression)
      if (ts.isObjectLiteralExpression(spread)) return fiscalPayload(spread)
      if (ts.isBinaryExpression(spread) && spread.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return fiscalPayload(spread.right)
      if (ts.isConditionalExpression(spread)) return fiscalPayload(spread.whenTrue) || fiscalPayload(spread.whenFalse)
      return true
    }
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null
    return name === null || MONEY_COLUMNS.includes(name) || NESTED_CHILDREN.has(name)
  })
}

type Call = { callee: string; owner: string; file: string; args: string[]; argNodes: ts.NodeArray<ts.Expression> }
/** A `$transaction(callback, options?)` site and the calls its callback makes (a named callback counts as one call). */
type Transaction = {
  owner: string
  line: number
  options: ts.Expression | undefined
  callees: Array<{ name: string; argc: number; argNodes?: ts.NodeArray<ts.Expression> }>
}

const calleeName = (n: ts.CallExpression) =>
  ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ''

function calleesOf(node: ts.Node): Transaction['callees'] {
  if (ts.isIdentifier(node)) return [{ name: node.text, argc: 1 }]
  const found: Transaction['callees'] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) found.push({ name: calleeName(n), argc: n.arguments.length, argNodes: n.arguments })
    ts.forEachChild(n, walk)
  }
  walk(node)
  return found
}

/** Only an actual tx argument counts; (payload, undefined, options) opens inside the optional entry point. */
function hasCallerTransaction(arg: ts.Expression | undefined): boolean {
  if (!arg) return false
  const value = unwrap(arg)
  return !(ts.isIdentifier(value) && value.text === 'undefined') && !ts.isVoidExpression(value)
}

/** Resolve a named callback in its nearest lexical block, never an unrelated top-level homonym. */
function transactionCallback(callback: ts.Expression, call: ts.CallExpression): ts.Node {
  if (!ts.isIdentifier(callback)) return callback
  for (let scope: ts.Node | undefined = call.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === callback.text) return statement
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === callback.text) {
            const init = declaration.initializer && unwrap(declaration.initializer)
            // A shadowing non-function is unresolved, not the homonymous function from an outer scope.
            return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : callback
          }
        }
      }
    }
  }
  return callback
}

let cached: ReturnType<typeof scanSources> | undefined
const scan = () => (cached ??= scanSources())

function scanSources() {
  const printer = ts.createPrinter({ removeComments: true })
  const fiscal = new Set<string>()
  const orderWriters = new Set<string>()
  const code = new Map<string, string>()
  const calls: Call[] = []
  const transactions: Transaction[] = []
  const globalClients = new Map<string, Set<string>>()
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const keyOf = (n: ts.Node) => `${rel}#${ownerOf(n)}`
    const clients = new Set<string>()
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && (statement.moduleSpecifier as ts.StringLiteral).text.endsWith('utils/prismaClient')) {
        const local = statement.importClause?.name?.text
        if (local) clients.add(local)
      }
      const units: Array<[string, ts.Node]> = []
      if (ts.isFunctionDeclaration(statement) && statement.name) units.push([statement.name.text, statement])
      if (ts.isVariableStatement(statement))
        for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) units.push([d.name.text, statement])
      if (ts.isClassDeclaration(statement) && statement.name)
        for (const m of statement.members) if (ts.isMethodDeclaration(m)) units.push([`${statement.name.text}.${m.name.getText()}`, m])
      for (const [name, node] of units) code.set(`${rel}#${name}`, printer.printNode(ts.EmitHint.Unspecified, node, sf))
    }
    globalClients.set(rel, clients)
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = calleeName(n)
        if (callee) calls.push({ callee, owner: keyOf(n), file: rel, args: n.arguments.map(a => a.getText(sf)), argNodes: n.arguments })
        const callback = n.arguments[0]
        if (callee === '$transaction' && callback && !ts.isArrayLiteralExpression(callback))
          transactions.push({
            owner: keyOf(n),
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            options: n.arguments[1],
            callees: calleesOf(transactionCallback(callback, n)),
          })
        if (ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)) {
          const method = n.expression.name.text
          const model = n.expression.expression.name.text
          const arg = n.arguments[0]
          if (CHILD_MODELS.has(model) && WRITE_METHODS.has(method)) fiscal.add(keyOf(n))
          if (model === 'order' && WRITE_METHODS.has(method)) {
            orderWriters.add(keyOf(n))
            const orderFiscal =
              ((method === 'update' || method === 'updateMany' || method === 'updateManyAndReturn') &&
                fiscalPayload(payloadOf(arg, 'data'))) ||
              (method === 'upsert' && fiscalPayload(payloadOf(arg, 'update'))) ||
              method === 'delete' ||
              method === 'deleteMany'
            if (orderFiscal) fiscal.add(keyOf(n))
          }
        }
      }
      if (ts.isTaggedTemplateExpression(n) && RAW_WRITE.test(n.template.getText(sf))) fiscal.add(keyOf(n))
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return { fiscal, orderWriters, code, calls, transactions, globalClients }
}

type Proof = { file: string; title: string; mentions: string }
type Writer =
  | { class: 'LOCKED'; lock: string[]; proof: Proof[]; note?: string }
  | { class: 'CALLER_LOCKED'; callers: string[]; proof: Proof[] }
  | { class: 'PRIVATE_CREATION'; creates: string[]; note: string; residual?: string }
  | { class: 'METADATA'; reason: string }
  | { class: 'EXCLUDED'; reason: string; residual?: string }

const TPV = 'tests/integration/payments/tpvMoney.atomic.integration.test.ts'
const DISCOUNTS = 'tests/integration/payments/discountMoney.atomic.integration.test.ts'
const MOBILE_T1 = 'tests/integration/mobile/mobileMoney.atomic.integration.test.ts'
const MOBILE_T4 = 'tests/integration/mobile/mobileWriters.atomic.integration.test.ts'
const KDS = 'tests/integration/mobile/outOfStock.test.ts'
const POS = 'tests/integration/pos-sync/posSyncWriters.atomic.integration.test.ts'
const CAPTURE = 'tests/integration/fiscal/writerCapture.test.ts'
const RECONCILE = 'tests/integration/payments/reconcileFromPayments.atomic.integration.test.ts'
const PAYMENT_GUARD = 'tests/unit/services/shared/paymentShiftClaim.callers.guard.test.ts'
const REPARTO = 'tests/integration/payments/repartoDescuento.integration.test.ts'
const proof = (file: string, mentions: string, ...titles: string[]): Proof[] => titles.map(title => ({ file, title, mentions }))

const LOCK = ['lockExistingOrderForPayment(']
const VENUE_FENCE_THEN_LOCK = ['FOR KEY SHARE', 'lockExistingOrderForPayment(']
const T2 = (mentions: string) =>
  proof(TPV, mentions, 'waits for fiscal admission and rereads PAID', 'holds Order until the fiscal reader sees the complete operation')
const T3 = (mentions: string) =>
  proof(DISCOUNTS, mentions, 'waits for fiscal admission and rereads PAID', 'holds Order until fiscal reads the entire committed operation')
const T1 = (mentions: string) => proof(MOBILE_T1, mentions, 'waits for fiscal Order lock, then rereads PAID without a version bump')
const T4 = (mentions: string) =>
  proof(MOBILE_T4, mentions, 'waits for the fiscal Order lock, then rereads PAID', 'holds the Order until fiscal admission can read')
const PAYMENT_LANE = (mentions: string) =>
  proof(PAYMENT_GUARD, mentions, 'las rutas con Order existente bloquean Order antes de Payment/Shift')

/** Fiscal writers (detected by the scan). Keys are `file#owner`. */
const WRITERS: Record<string, Writer> = {
  // ── TPV line and inline-discount writers (T2) ─────────────────────────────────────────────────
  'src/services/tpv/order.tpv.service.ts#addItemsToOrder': {
    class: 'LOCKED',
    lock: LOCK,
    proof: [...T2('addItemsToOrder'), ...proof(CAPTURE, 'addItemsToOrder', 'freezes the complete operation')],
  },
  'src/services/tpv/order.tpv.service.ts#removeOrderItem': { class: 'LOCKED', lock: LOCK, proof: T2('removeOrderItem') },
  'src/services/tpv/order.tpv.service.ts#compItems': {
    class: 'LOCKED',
    lock: LOCK,
    proof: [...T2('compItems'), ...proof(CAPTURE, 'compItems', 'freezes the complete operation')],
  },
  'src/services/tpv/order.tpv.service.ts#voidItems': { class: 'LOCKED', lock: LOCK, proof: T2('voidItems') },
  'src/services/tpv/order.tpv.service.ts#applyDiscount': { class: 'LOCKED', lock: LOCK, proof: T2('applyDiscount') },
  'src/services/tpv/order.tpv.service.ts#addSerializedItemToOrder': {
    class: 'LOCKED',
    lock: VENUE_FENCE_THEN_LOCK,
    proof: T2('addSerializedItemToOrder'),
    note: 'Venue FOR KEY SHARE before Order (T2 ruling: deleteVenue holds Venue FOR UPDATE, then touches Orders)',
  },
  'src/services/tpv/order.tpv.service.ts#createOrderWithItems': {
    class: 'PRIVATE_CREATION',
    creates: ['.order.create('],
    note: 'new Order, lines, discounts and FREE_CART payment in one transaction; replays return the committed order',
    residual:
      'R3: its discount.updateMany({ id: { in } }) is ONE statement whose row-lock order follows the plan, vs the automatic-discount batch locking ascending ids (T3-R2): theoretical 40P01 only, no partial writes (fix: sorted per-id updates).',
  },
  // ── Discount engine and coupons (T3) ────────────────────────────────────────────────────────
  'src/services/dashboard/discountEngine.service.ts#applyManualDiscount': {
    class: 'LOCKED',
    lock: ['lockDiscountOrder('],
    proof: [...T3('applyManualDiscount'), ...proof(CAPTURE, 'applyManualDiscount', 'freezes the complete operation')],
  },
  'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder': {
    class: 'LOCKED',
    lock: ['lockDiscountOrder('],
    proof: T3('removeDiscount'),
  },
  'src/services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/dashboard/discountEngine.service.ts#applyDiscountToOrder',
      'src/services/dashboard/discountEngine.service.ts#applyAutomaticDiscounts',
    ],
    proof: T3('applyPredefinedDiscount'),
  },
  'src/services/tpv/discount.tpv.service.ts#applyCouponCode': { class: 'LOCKED', lock: LOCK, proof: T3('applyCouponCode') },
  // IVA por producto B2: la ÚNICA escritura de repartos, con el tx de quien ya tiene el candado. Cada tarea suma sus llamadores.
  'src/services/shared/repartoDescuentoTx.ts#sincronizarRepartos': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount',
      'src/services/dashboard/discountEngine.service.ts#applyManualDiscount',
      'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder',
      'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems',
      'src/services/mobile/comp-item.mobile.service.ts#recalculateOrderTotals',
      'src/services/mobile/order.mobile.service.ts#createOrderWithItems',
      'src/services/tpv/discount.tpv.service.ts#applyCouponCode',
      'src/services/tpv/order.tpv.service.ts#addItemsToOrder',
      'src/services/tpv/order.tpv.service.ts#applyDiscount',
      'src/services/tpv/order.tpv.service.ts#compItems',
      'src/services/tpv/order.tpv.service.ts#createOrderWithItems',
      'src/services/tpv/order.tpv.service.ts#removeOrderItem',
      'src/services/tpv/order.tpv.service.ts#voidItems',
    ],
    proof: proof(
      REPARTO,
      'sincronizarRepartos',
      'agregar un artículo tras un % de cuenta re-deriva el importe como hoy y reescribe el reparto en la misma transacción',
    ),
  },
  // B2b T6b (R9, Codex r4 R4-1): los renglones que se borran o se anulan se llevan su IVA de la cabecera, con el tx y el candado
  // de quien los quita. La lista EXACTA de llamadores impide además que el evento del POS externo (`applyPosOrderItemEvent`)
  // la llame sin que alguien lo decida: ahí la cabecera la reescribe el POS (D8).
  'src/services/shared/repartoDescuentoTx.ts#retirarImpuestoDeRenglones': {
    class: 'CALLER_LOCKED',
    callers: ['src/services/tpv/order.tpv.service.ts#removeOrderItem', 'src/services/tpv/order.tpv.service.ts#voidItems'],
    proof: proof(REPARTO, 'retirarImpuestoDeRenglones', 'R9: borrar el ÚLTIMO artículo de una cuenta con IVA aparte deja el impuesto en 0'),
  },
  // Revisión final de B2 (Codex r1 P1): el descuento histórico de cabecera se congela en su fila antes de la primera fila nueva,
  // con el tx y el candado del escritor que la crea; desde B2c (R7-1) también antes de recortar o recalcular con los renglones
  // que cambian (borrar y anular, quitar promoción, las tres cortesías) y antes de quitar una fila desde el móvil. B2c F2: con
  // resto, además lee los renglones y crea los espejos de los descuentos de renglón viejos — por eso también necesita el candado.
  'src/services/shared/repartoDescuentoTx.ts#conservarDescuentoHistorico': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount',
      'src/services/dashboard/discountEngine.service.ts#applyManualDiscount',
      'src/services/mobile/comp-item.mobile.service.ts#compOrderItemInTransaction',
      'src/services/mobile/comp-item.mobile.service.ts#compWholeOrderInTransaction',
      'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrderInTransaction',
      'src/services/mobile/order.mobile.service.ts#applyOrderDiscountInTransaction',
      'src/services/mobile/order.mobile.service.ts#removeOrderDiscountInTransaction',
      'src/services/promotions/promotion.service.ts#removePromotionFromOrder',
      'src/services/tpv/discount.tpv.service.ts#applyCouponCode',
      'src/services/tpv/order.tpv.service.ts#applyDiscount',
      'src/services/tpv/order.tpv.service.ts#compItems',
      'src/services/tpv/order.tpv.service.ts#removeOrderItem',
      'src/services/tpv/order.tpv.service.ts#voidItems',
      'src/services/wallet/redeemStampReward.service.ts#redeemStampReward',
    ],
    proof: proof(
      REPARTO,
      'conservarDescuentoHistorico',
      '🔴 P1 antes/después: $20 HISTÓRICOS de cabecera sobreviven al applyDiscount heredado y a agregar un artículo ($30/$120; B2 $10/$140)',
    ),
  },
  // B2 T7 (R3-2): quitar una fila espejo limpia su renglón, con el tx y el candado de quien quita.
  'src/services/shared/repartoDescuentoTx.ts#revertirDescuentoDelRenglon': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/mobile/order.mobile.service.ts#removeOrderDiscountInTransaction',
      'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder',
    ],
    proof: proof(
      REPARTO,
      'revertirDescuentoDelRenglon',
      'quitar un descuento de artículo deja el renglón sin descuento y la cuenta cobra completo (móvil)',
    ),
  },
  // B2c T1 (P4, P5): recorta o retira las filas dirigidas a los renglones que salen o se regalan, y devuelve su reducción de
  // impuesto a `Order.taxAmount`, con el tx y el candado de quien los toca. Llamadores: borrar y anular (T2), quitar promoción
  // (T3) y las tres cortesías (T4).
  'src/services/shared/repartoDescuentoTx.ts#recortarDescuentosDeRenglones': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/mobile/comp-item.mobile.service.ts#compOrderItemInTransaction',
      'src/services/mobile/comp-item.mobile.service.ts#compWholeOrderInTransaction',
      'src/services/promotions/promotion.service.ts#removePromotionFromOrder',
      'src/services/tpv/order.tpv.service.ts#compItems',
      'src/services/tpv/order.tpv.service.ts#removeOrderItem',
      'src/services/tpv/order.tpv.service.ts#voidItems',
    ],
    proof: proof(
      REPARTO,
      'recortarDescuentosDeRenglones',
      '🔴 P4: borrar un artículo con su propio descuento ya no deja ese descuento sobre los demás',
    ),
  },
  // B2c T5 (P5): las filas ESPEJO de los descuentos de artículo del vale, con la transacción de quien abre el vale (creación
  // privada) o le agrega renglones (bajo el candado de la orden).
  'src/services/mobile/areaTicket.mobile.service.ts#crearEspejosDelVale': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems',
      'src/services/mobile/areaTicket.mobile.service.ts#openAreaTicket',
    ],
    proof: proof(
      'tests/unit/services/mobile/areaTicket.mobile.service.test.ts',
      'orderDiscount.create',
      'abrir un vale con descuento de artículo crea su fila ESPEJO',
      'el renglón nuevo con descuento de artículo trae su fila ESPEJO',
    ),
  },
  'src/services/shared/serviceCharges.ts#recalcularCargosPorServicio': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount',
      'src/services/dashboard/discountEngine.service.ts#applyManualDiscount',
      'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder',
      'src/services/tpv/discount.tpv.service.ts#applyCouponCode',
      'src/services/tpv/order.tpv.service.ts#addItemsToOrder',
      'src/services/tpv/order.tpv.service.ts#applyDiscount',
      'src/services/tpv/order.tpv.service.ts#compItems',
      'src/services/tpv/order.tpv.service.ts#removeOrderItem',
      'src/services/tpv/order.tpv.service.ts#voidItems',
    ],
    proof: T3('applyCouponCode'),
  },
  // ── Mobile courtesies, charges and merge (T1) ───────────────────────────────────────────────
  'src/services/mobile/comp-item.mobile.service.ts#compOrderItemInTransaction': { class: 'LOCKED', lock: LOCK, proof: T1('compOrderItem') },
  'src/services/mobile/comp-item.mobile.service.ts#compWholeOrderInTransaction': {
    class: 'LOCKED',
    lock: LOCK,
    proof: T1('compWholeOrder'),
  },
  'src/services/mobile/service-charge.mobile.service.ts#applyServiceChargeInTransaction': {
    class: 'LOCKED',
    lock: ['requireOpenOrder('],
    proof: T1('applyServiceCharge'),
  },
  'src/services/mobile/service-charge.mobile.service.ts#removeServiceChargeInTransaction': {
    class: 'LOCKED',
    lock: ['requireOpenOrder('],
    proof: T1('removeServiceCharge'),
  },
  'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceChargesInTransaction': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceCharges',
      'src/services/mobile/order.mobile.service.ts#mergeOrdersInTransaction',
      'src/services/mobile/order.mobile.service.ts#updateOrderDetailsInTransaction',
    ],
    proof: T1('syncAutomaticServiceCharges'),
  },
  'src/services/mobile/order.mobile.service.ts#mergeOrdersInTransaction': {
    class: 'LOCKED',
    lock: ['lockTableOrderScope('],
    proof: proof(MOBILE_T1, 'mergeOrders', 'merge rereads source membership after waiting'),
  },
  'src/services/mobile/order.mobile.service.ts#updateOrderDetailsInTransaction': {
    class: 'METADATA',
    reason:
      'Opaque data map carries only customerName/specialRequests/covers/type/customerId. Only a covers change composes money, and it does so under lockExistingOrderForPayment through syncAutomaticServiceCharges with the same tx (T1).',
  },
  // ── Mobile discounts, splits, promotions and redemptions (T4) ───────────────────────────────
  'src/services/mobile/comp-item.mobile.service.ts#recalculateOrderTotals': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/mobile/comp-item.mobile.service.ts#compOrderItemInTransaction',
      'src/services/mobile/comp-item.mobile.service.ts#compWholeOrderInTransaction',
      'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrderInTransaction',
      'src/services/mobile/order.mobile.service.ts#applyOrderDiscountInTransaction',
      'src/services/mobile/order.mobile.service.ts#mergeOrdersInTransaction',
      'src/services/mobile/order.mobile.service.ts#removeOrderDiscountInTransaction',
      'src/services/mobile/order.mobile.service.ts#splitOrderBySeatInTransaction',
      'src/services/mobile/order.mobile.service.ts#splitOrderItemsInTransaction',
      'src/services/mobile/service-charge.mobile.service.ts#applyServiceChargeInTransaction',
      'src/services/mobile/service-charge.mobile.service.ts#removeServiceChargeInTransaction',
      'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceChargesInTransaction',
      'src/services/promotions/promotion.service.ts#applyPromotionInTransaction',
      'src/services/promotions/promotion.service.ts#removePromotionFromOrder',
      'src/services/wallet/redeemStampReward.service.ts#redeemStampReward',
    ],
    proof: T4('applyOrderDiscount'),
  },
  'src/services/mobile/order.mobile.service.ts#applyOrderDiscountInTransaction': {
    class: 'LOCKED',
    lock: LOCK,
    proof: T4('applyOrderDiscount'),
  },
  'src/services/mobile/order.mobile.service.ts#removeOrderDiscountInTransaction': {
    class: 'LOCKED',
    lock: LOCK,
    proof: T4('removeOrderDiscount'),
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderItemsInTransaction': {
    class: 'LOCKED',
    lock: ['lockTableOrderScope('],
    proof: [...T4('splitOrderItems'), ...proof(MOBILE_T4, 'splitOrderItems', 'split writers take the Venue before the source Order')],
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderBySeatInTransaction': {
    class: 'LOCKED',
    lock: ['lockTableOrderScope('],
    proof: [...T4('splitOrderBySeat'), ...proof(MOBILE_T4, 'splitOrderBySeat', 'split writers take the Venue before the source Order')],
  },
  'src/services/promotions/promotion.service.ts#applyPromotionInTransaction': {
    class: 'LOCKED',
    lock: LOCK,
    proof: [...T4('applyPromotionToOrder'), ...proof(CAPTURE, 'applyPromotionToOrder', 'freezes the complete operation')],
  },
  'src/services/promotions/promotion.service.ts#removePromotionFromOrder': {
    class: 'LOCKED',
    lock: LOCK,
    proof: T4('removePromotionFromOrder'),
  },
  'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrderInTransaction': {
    class: 'LOCKED',
    lock: LOCK,
    proof: T4('redeemPointsToOrder'),
  },
  'src/services/wallet/redeemStampReward.service.ts#redeemStampReward': { class: 'LOCKED', lock: LOCK, proof: T4('redeemStampReward') },
  'src/services/mobile/order.mobile.service.ts#createOrderWithItems': {
    class: 'PRIVATE_CREATION',
    creates: ['.order.create('],
    note: 'T4-R1: promotions and the reaffirmed money run inside the transaction that creates the order (no reader sees it without its combo)',
  },
  // ── Area tickets and KDS line marks (T5) ────────────────────────────────────────────────────
  'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems': {
    class: 'LOCKED',
    lock: LOCK,
    proof: proof(
      MOBILE_T4,
      'addAreaTicketItems',
      'writer first: fiscal admission waits, then reads the new line, its modifier and the totals',
    ),
  },
  'src/services/delivery-channels/core/lineRemoval.service.ts#applyLineRemoval': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/delivery-channels/core/deliveryReconciliation.service.ts#reconcileDeliveryOrderFromProvider',
      'src/services/mobile/kdsOutOfStock.mobile.service.ts#enviarYAplicar',
    ],
    proof: proof(KDS, 'applyLineRemoval', 'the apply holds the Order until fiscal admission can read the complete removal'),
  },
  'src/services/delivery-channels/core/deliveryReconciliation.service.ts#reprecio': {
    class: 'CALLER_LOCKED',
    callers: ['src/services/delivery-channels/core/deliveryReconciliation.service.ts#reconcileDeliveryOrderFromProvider'],
    proof: proof(
      'tests/integration/delivery-channels/reconciliacionDinero.test.ts',
      'reconcileDeliveryOrderFromProvider',
      'la orden refleja al proveedor',
    ),
  },
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder': {
    class: 'PRIVATE_CREATION',
    creates: ['.order.upsert(', 'if (esNueva)'],
    note: 'lines and modifiers only for a NEW order, in its creating transaction; the existing branch refreshes metadata only',
  },
  // ── Imported POS (T6) — serialized locally; upstream completeness is NOT resolved (Plan 6 activation blocker) ──
  'src/services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent': {
    class: 'LOCKED',
    lock: LOCK,
    proof: proof(POS, 'processPosOrderEvent', 'fiscal capture arriving while a header event holds the Order sees the whole event'),
    note: 'imported header money is authoritative and never recomputed; see the §14 characterization in the same suite',
  },
  'src/services/pos-sync/posSyncOrderItem.service.ts#applyPosOrderItemEvent': {
    class: 'LOCKED',
    lock: LOCK,
    proof: [
      ...proof(POS, 'processPosOrderItemEvent', 'fiscal capture arriving while a line event holds the Order sees the finished line'),
      ...proof(CAPTURE, 'processPosOrderItemEvent', 'freezes the complete operation'),
    ],
  },
  // ── Payment lanes (pre-existing, unchanged by Plan 3b; lock order guarded by the payment inventory) ──
  'src/services/mobile/order.mobile.service.ts#payCashOrder': { class: 'LOCKED', lock: LOCK, proof: PAYMENT_LANE('payCashOrder') },
  'src/services/dashboard/order.dashboard.service.ts#settleOrder': { class: 'LOCKED', lock: LOCK, proof: PAYMENT_LANE('settleOrder') },
  'src/services/dashboard/manualPayment.service.ts#createManualPayment': {
    class: 'LOCKED',
    lock: LOCK,
    proof: PAYMENT_LANE('createManualPayment'),
  },
  'src/services/dashboard/customer.dashboard.service.ts#settleCustomerBalance': {
    class: 'LOCKED',
    lock: LOCK,
    proof: proof(PAYMENT_GUARD, 'settleCustomerBalance', 'adquiere el conjunto estable completo de Orders antes de cualquier Shift'),
  },
  'src/services/b4bit/b4bit.service.ts#settleOrderForConfirmedCryptoPayment': {
    class: 'LOCKED',
    lock: ['completeAndAttributeB4BitPaymentInTx('],
    proof: PAYMENT_LANE('completeAndAttributeB4BitPaymentInTx'),
  },
  'src/services/mobile/areaTicketV7.mobile.service.ts#finalizeAreaTicketPaymentInTransaction': {
    class: 'LOCKED',
    lock: ['FROM "AreaTicketCheckoutSession"', 'FROM "Order" WHERE id = ${input.orderId} AND "venueId" = ${input.venueId} FOR UPDATE'],
    proof: proof(PAYMENT_GUARD, 'areaTicketPayment.lockAreaTicketCheckoutHierarchy', 'preservan session → tickets → Order → Shift'),
  },
  'src/services/tpv/payment.tpv.service.ts#settleStandalonePaymentInTx': {
    class: 'CALLER_LOCKED',
    callers: ['src/services/tpv/payment.tpv.service.ts#recordOrderPayment'],
    proof: PAYMENT_LANE('recordOrderPayment'),
  },
  'src/services/tpv/payment.tpv.service.ts#updateOrderTotalsForStandalonePayment': {
    class: 'LOCKED',
    lock: ['lockExistingOrderForPayment(', 'standaloneTotalsInputs('],
    proof: [
      // The lock, on real PostgreSQL: a writer blocked after the reread; the capture waits for it and it for the capture.
      ...proof(
        RECONCILE,
        'reconcileOrderFromPayments',
        'a line arriving while the repair pass holds the Order waits for it, then sees the committed PAID and is refused',
      ),
      ...proof(CAPTURE, 'reconcileOrderFromPayments', 'freezes the complete operation', 'capture first: a later writer waits'),
      // The reread, the one rerun and the skip.
      ...proof(
        RECONCILE,
        'reconcileOrderFromPayments',
        'a line added while the repair pass computes is not overwritten by its stale totals',
        'a second change during the rerun leaves the order as that writer committed it, and warns',
      ),
      ...proof(
        'tests/unit/services/tpv/payment.reconcileFromPayments.test.ts',
        'reconcileOrderFromPayments',
        'takes the Order lock on the transaction, rereads under it, and only then writes',
        'inputs changed again during the rerun: writes nothing and warns',
      ),
    ],
    note: 'Direct branch (paid-order sweep, recordOrderPayment without in-tx settlement): Order lock, reread of the inputs, one rerun on a change, then skip + warn (Ruling T7-R1).',
  },
  'src/services/mobile/areaTicketV7.mobile.service.ts#materializeAreaTicketCheckout': {
    class: 'PRIVATE_CREATION',
    creates: ['.order.create('],
    note: 'checkout session and tickets are locked first; the new Order and its lines are created in that transaction',
  },
  'src/services/reservation/createOrderFromReservation.ts#createOrderFromReservation': {
    class: 'PRIVATE_CREATION',
    creates: ['.order.create('],
    note: 'runs on the caller transaction; the Order, lines and modifiers are new',
  },
  'src/services/dashboard/manualSale.service.ts#createOneManualSale': {
    class: 'PRIVATE_CREATION',
    creates: ['.order.create('],
    note: 'retroactive manual sale: new Order and line in one transaction',
  },
  // ── Fiscal sealing: runs inside the capture/cancel transaction that already holds the Order ──
  'src/services/fiscal/sellosIva.ts#sellarRenglones': {
    class: 'EXCLUDED',
    reason:
      'fiscal sealing of OrderItem.ivaTratamiento for the captured lines, inside the reservation transaction that holds the Order lock',
  },
  'src/services/fiscal/sellosIva.ts#liberarSellosDe': {
    class: 'EXCLUDED',
    reason:
      'fiscal seal release of the document own lines (rejection/cancel/recapture), inside the fiscal transaction that holds the Order lock',
  },
  // ── Demo, cleanup and teardown ───────────────────────────────────────────────────────────────
  'src/services/dashboard/venue.dashboard.service.ts#deleteVenue': {
    class: 'EXCLUDED',
    reason: 'teardown of a LIVE_DEMO/TRIAL venue (real venues cannot be deleted: SAT retention); not an edit of a live sale',
    residual:
      'Venue FOR UPDATE, then OrderItems/modifiers BEFORE Orders: inverse to every Order→line writer (40P01 possible, PG aborts one tx, no corruption).',
  },
  'src/services/cleanup/liveDemoCleanup.service.ts#deleteVenueDataTx': {
    class: 'EXCLUDED',
    reason: 'teardown of a disposable LIVE_DEMO venue under Venue FOR UPDATE; refuses any non-LIVE_DEMO venue',
    residual: 'OrderItems deleted before Orders under the Venue lock: same inverse order as deleteVenue (40P01 possible, no corruption).',
  },
  'src/services/onboarding/demoCleanup.service.ts#cleanDemoData': {
    class: 'EXCLUDED',
    reason: 'wipes the transactional demo data of a venue converting from demo to real (KYC approval); never an edit of a live sale',
    residual: 'OrderItems deleted before Orders (inverse to Order→line writers; 40P01 possible against a writer in flight, no corruption).',
  },
  'src/services/onboarding/demoSeed.service.ts#seedOrders': {
    class: 'EXCLUDED',
    reason: 'synthetic onboarding orders created with their lines; never a live sale',
  },
  // develop f97a82b1 (28-sep): the delete moved to runOnce and now rereads the rule under the canonical Order lock.
  'src/jobs/abandoned-orders-cleanup.job.ts#AbandonedOrdersCleanupJob.runOnce': {
    class: 'EXCLUDED',
    reason:
      'deletes old TAKEOUT orders that are PENDING with zero lines and no payments, rechecked one by one under lockExistingOrderForPayment; nothing invoiceable is ever deleted',
  },
  // KDS stage 3 (develop): stamps OrderItem.sentToKitchenAt and clears Order.kitchenPendingAt; no money, no line content.
  'src/services/kds/kitchenTicketAuthoring.service.ts#authorKitchenTickets': {
    class: 'METADATA',
    reason: 'kitchen ticket authoring: sentToKitchenAt stamp on lines and the kitchenPendingAt marker on the order',
  },
}

/** Functions that are not fiscal writers themselves but hold the Order lock for a CALLER_LOCKED helper. */
const LOCK_HOLDERS: Record<string, string[]> = {
  'src/services/mobile/order.mobile.service.ts#updateOrderDetailsInTransaction': LOCK,
  'src/services/dashboard/discountEngine.service.ts#applyDiscountToOrder': ['lockDiscountOrder('],
  'src/services/dashboard/discountEngine.service.ts#applyAutomaticDiscounts': ['lockDiscountOrder('],
  'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceCharges': LOCK,
  'src/services/delivery-channels/core/deliveryReconciliation.service.ts#reconcileDeliveryOrderFromProvider': [
    'withDeliveryOrderLock(',
    ...LOCK,
  ],
  'src/services/mobile/kdsOutOfStock.mobile.service.ts#enviarYAplicar': ['withDeliveryOrderLock(', ...LOCK],
  'src/services/tpv/payment.tpv.service.ts#recordOrderPayment': LOCK,
  // B2c T5: abrir el vale crea la orden en la MISMA transacción (creación privada, nadie más la ve) y ahí le escribe sus espejos.
  'src/services/mobile/areaTicket.mobile.service.ts#openAreaTicket': ['.order.create('],
}

/** Optional-tx entry points: a call that passes the tx must come from a writer that already holds the Order lock. */
const OPTIONAL_TX: Array<{ callee: string; txIndex: number; lockedCallers: string[] }> = [
  {
    callee: 'syncAutomaticServiceCharges',
    txIndex: 2,
    lockedCallers: [],
  },
  {
    callee: 'applyPromotionToOrder',
    txIndex: 1,
    lockedCallers: [
      'src/services/mobile/order.mobile.service.ts#createOrderWithItems',
      'src/services/tpv/order.tpv.service.ts#addItemsToOrder',
    ],
  },
]

type OrderWriter = { class: 'METADATA' | 'PRIVATE_CREATION' | 'CANCEL_GUARD' | 'EXCLUDED'; why: string; markers?: string[] }
const NEW_ORDER = ['.order.create(']
const CANCEL = (marker: string) => ({
  class: 'CANCEL_GUARD' as const,
  why: 'cancels under the order lock (orderCancelWriters)',
  markers: [marker],
})

/** Every other function that writes an Order row: none touches money columns or fiscal children. */
const NON_FISCAL_ORDER_WRITERS: Record<string, OrderWriter> = {
  'src/services/tpv/order.tpv.service.ts#updateGuestInfo': { class: 'METADATA', why: 'covers/name/phone/requests/customerId' },
  'src/services/dashboard/order.dashboard.service.ts#updateOrder': {
    class: 'METADATA',
    why: 'status/customer/table/staff/createdAt/number/type; money inputs ignored; CANCELLED/DELETED go through the cancel guard',
  },
  'src/services/mobile/order.mobile.service.ts#attachCustomerToOrder': {
    class: 'METADATA',
    why: 'links a customer: the fiscal receptor comes from explicit request parameters, never from the order customer',
  },
  'src/services/tpv/fastPaymentCustomer.ts#linkCustomerToExistingOrder': { class: 'METADATA', why: 'customer link only' },
  'src/services/tpv/table.tpv.service.ts#moveOrderToTableInTransaction': {
    class: 'METADATA',
    why: 'tableId only (residual: Table FOR UPDATE → Order vs split Order → child insert KEY SHARE Table)',
  },
  'src/services/tpv/table.tpv.service.ts#assignOrderWaiterInTransaction': { class: 'METADATA', why: 'servedById only' },
  'src/services/tpv/table.tpv.service.ts#assignTable': {
    class: 'PRIVATE_CREATION',
    why: 'new empty order; detaching zombie orders only clears tableId',
    markers: NEW_ORDER,
  },
  'src/services/kds/kitchenTicketAuthoring.service.ts#limpiarMarca': { class: 'METADATA', why: 'clears the kitchenPendingAt marker' },
  'src/services/mobile/areaTicket.mobile.service.ts#claimAreaTicket': { class: 'METADATA', why: 'claim fields under a CAS' },
  'src/services/tpv/payment.tpv.service.ts#recordOrderPayment': {
    class: 'METADATA',
    why: 'splitType/loyalty marks; its money write is settleStandalonePaymentInTx under its Order lock',
  },
  'src/services/shared/cuentaCancelada.ts#reabrirSiRecibeDinero': {
    class: 'METADATA',
    why: 'status PENDING al recibir dinero ya capturado; lo llaman payCashOrder, settleStandalonePaymentInTx y updateOrderTotalsForStandalonePayment bajo su candado',
    markers: ['ORDER_REOPENED_BY_CAPTURED_PAYMENT'],
  },
  'src/services/shared/loyaltyOnPaidOrder.ts#awardLoyaltyForPaidOrder': { class: 'METADATA', why: 'loyalty award marks' },
  'src/jobs/kitchen-tickets-reconciliation.job.ts#KitchenTicketsReconciliationJob.runNow': {
    class: 'METADATA',
    why: 'KDS stage 3 sweep: only the kitchenPendingAt marker',
  },
  'src/jobs/loyalty-reconciliation.job.ts#LoyaltyReconciliationJob.runNow': { class: 'METADATA', why: 'loyalty claim marks' },
  'src/jobs/playtelecomEventSimReassignment.job.ts#reassignEventSimSalesForRule': {
    class: 'METADATA',
    why: 'moves a sale between venues of one organization (PlayTelecom); capture rechecks the expected venue',
  },
  'src/jobs/delivery-line-action-reconciler.job.ts#DeliveryLineActionReconcilerJob.limpiarReservas': {
    class: 'METADATA',
    why: 'expired delivery reservation tokens',
  },
  'src/services/delivery-channels/core/deliveryOrderLock.ts#tomarReserva': { class: 'METADATA', why: 'delivery reservation token' },
  'src/services/delivery-channels/core/deliveryOrderLock.ts#soltarReserva': { class: 'METADATA', why: 'delivery reservation token' },
  'src/services/delivery-channels/core/deliveryReconciliation.service.ts#bloquear': { class: 'METADATA', why: 'reconcile-blocked flag' },
  'src/services/delivery-channels/core/deliveryReconciliation.service.ts#reconcileDeliveryOrderFromProvider': {
    class: 'METADATA',
    why: 'providerAcceptedAt; its money writes are applyLineRemoval/reprecio under advisory → Order lock (Plan 4 domain)',
  },
  'src/services/delivery-channels/core/respondToDeliveryOrder.service.ts#acceptDeliveryOrder': {
    class: 'METADATA',
    why: 'acceptance marks',
  },
  'src/services/delivery-channels/core/respondToDeliveryOrder.service.ts#markDeliveryOrderReady': { class: 'METADATA', why: 'ready marks' },
  'src/services/delivery-channels/core/respondToDeliveryOrder.service.ts#recuperarAceptacionDesdeProveedor': {
    class: 'METADATA',
    why: 'acceptance recovered from the provider',
  },
  'src/services/delivery-channels/providers/uber-eats/uber.eventProcessor.ts#processUberEvent': {
    class: 'METADATA',
    why: 'provider status marks',
  },
  'src/services/mobile/order.mobile.service.ts#cancelOrderInTransaction': CANCEL('assertOrderCancellableUnderLock'),
  'src/services/dashboard/order.dashboard.service.ts#deleteOrder': CANCEL('assertOrderCancellableUnderLock'),
  'src/services/mobile/areaTicketV7.mobile.service.ts#cancelAreaTicketCheckout': CANCEL('assertOrderCancellableUnderLock'),
  'src/services/delivery-channels/core/cancelDeliveryOrder.service.ts#cancelDeliveryOrder': CANCEL('lockExistingOrderForPayment('),
  'src/services/pos-sync/posSyncOrder.service.ts#processPosOrderDeleteEvent': CANCEL('lockExistingOrderForPayment('),
  'src/services/fiscal/confirmarContratoDePrecio.service.ts#confirmarContratoIvaIncluido': {
    class: 'EXCLUDED',
    why: 'contract confirmation: one CAS UPDATE of contratoDePrecio (orderContratoDePrecioWriters), no money or lines',
  },
  'src/services/tpv/order.tpv.service.ts#createOrder': { class: 'PRIVATE_CREATION', why: 'new empty order', markers: NEW_ORDER },
  'src/services/tpv/order.tpv.service.ts#sellSerializedItem': {
    class: 'PRIVATE_CREATION',
    why: 'new order with its nested serialized line; registration shares the transaction (T2)',
    markers: NEW_ORDER,
  },
  'src/services/tpv/payment.tpv.service.ts#recordFastPayment': { class: 'PRIVATE_CREATION', why: 'fast-payment order', markers: NEW_ORDER },
  'src/services/mobile/areaTicket.mobile.service.ts#openAreaTicket': {
    class: 'PRIVATE_CREATION',
    why: 'new ticket order with nested lines',
    markers: NEW_ORDER,
  },
  'src/services/mobile/estimate.mobile.service.ts#convertToOrder': {
    class: 'PRIVATE_CREATION',
    why: 'one nested create of order and lines',
    markers: NEW_ORDER,
  },
  'src/services/mobile/refund.mobile.service.ts#createRefund': {
    class: 'PRIVATE_CREATION',
    why: 'new refund shadow order',
    markers: NEW_ORDER,
  },
  'src/services/dashboard/venueCheckout.service.ts#finalizeVenueCheckout': {
    class: 'PRIVATE_CREATION',
    why: 'new checkout shadow order',
    markers: NEW_ORDER,
  },
  'src/services/b4bit/b4bit.service.ts#initiateCryptoPayment': { class: 'PRIVATE_CREATION', why: 'new crypto order', markers: NEW_ORDER },
  'src/services/dashboard/paymentLink.service.ts#completeCharge': {
    class: 'PRIVATE_CREATION',
    why: 'new paid-link order',
    markers: NEW_ORDER,
  },
  'src/services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout': {
    class: 'PRIVATE_CREATION',
    why: 'new paid-link order',
    markers: NEW_ORDER,
  },
  'src/services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout': {
    class: 'PRIVATE_CREATION',
    why: 'new paid-link order',
    markers: NEW_ORDER,
  },
}

const LOCKING = new Set(['LOCKED', 'CALLER_LOCKED', 'PRIVATE_CREATION'])
const moneyToken = new RegExp(`\\b(${MONEY_COLUMNS.join('|')})\\b`)

describe('Plan 3b final manifest of the writers the documentary capture depends on', () => {
  const { fiscal, orderWriters, code, calls } = scan()
  const codeOf = (key: string) => code.get(key) ?? ''

  it('finds the writers (a collapse to zero means the scanner broke, not the code)', () => {
    expect(fiscal.size).toBeGreaterThanOrEqual(50)
    expect(orderWriters.size).toBeGreaterThanOrEqual(70)
  })

  it('every fiscal writer is classified exactly once — no new writer without review, no stale entry', () => {
    expect([...fiscal].sort()).toEqual(Object.keys(WRITERS).sort())
  })

  it('every other Order writer is inventoried as non-fiscal — a new Order writer anywhere must be classified', () => {
    const nonFiscal = [...orderWriters].filter(key => !fiscal.has(key))
    expect(nonFiscal.sort()).toEqual(Object.keys(NON_FISCAL_ORDER_WRITERS).sort())
  })

  it.each(Object.entries(WRITERS))('%s satisfies its class', (key, writer) => {
    const body = codeOf(key)
    expect(body.length).toBeGreaterThan(0)
    if (writer.class === 'LOCKED')
      for (const marker of writer.lock) expect({ key, marker, present: body.includes(marker) }).toMatchObject({ present: true })
    if (writer.class === 'PRIVATE_CREATION')
      for (const marker of writer.creates) expect({ key, marker, present: body.includes(marker) }).toMatchObject({ present: true })
    if (writer.class === 'METADATA') expect({ key, moneyToken: body.match(moneyToken)?.[0] ?? null }).toEqual({ key, moneyToken: null })
    if (writer.class === 'EXCLUDED') expect(writer.reason.length).toBeGreaterThan(40)
  })

  it.each(Object.entries(WRITERS).filter(([, w]) => w.class === 'CALLER_LOCKED'))(
    '%s is only called from writers that already hold the Order lock',
    (key, writer) => {
      const callers = (writer as Extract<Writer, { class: 'CALLER_LOCKED' }>).callers
      const name = key.split('#')[1]
      const actual = [...new Set(calls.filter(c => c.callee === name && c.owner !== key).map(c => c.owner))].sort()
      expect(actual).toEqual([...callers].sort())
      for (const caller of callers) {
        const holder = LOCK_HOLDERS[caller]
        const cls = WRITERS[caller]?.class
        expect({ caller, holdsLock: (!!cls && LOCKING.has(cls)) || (!!holder && holder.every(m => codeOf(caller).includes(m))) }).toEqual({
          caller,
          holdsLock: true,
        })
      }
    },
  )

  it.each(OPTIONAL_TX)(
    '$callee receives a caller transaction only from writers that hold the Order',
    ({ callee, txIndex, lockedCallers }) => {
      const withTx = [
        ...new Set(calls.filter(c => c.callee === callee && hasCallerTransaction(c.argNodes[txIndex])).map(c => c.owner)),
      ].sort()
      expect(withTx).toEqual([...lockedCallers].sort())
      for (const caller of lockedCallers) {
        const holdsLock = LOCKING.has(WRITERS[caller]?.class ?? '') || codeOf(caller).includes('lockExistingOrderForPayment(')
        expect({ caller, holdsLock }).toEqual({ caller, holdsLock: true })
      }
    },
  )

  it.each(Object.entries(NON_FISCAL_ORDER_WRITERS))('%s (non-fiscal Order writer) keeps its markers', (key, writer) => {
    expect(codeOf(key).length).toBeGreaterThan(0)
    for (const marker of writer.markers ?? [])
      expect({ key, marker, present: codeOf(key).includes(marker) }).toMatchObject({ present: true })
  })

  it.each(Object.entries(WRITERS).flatMap(([key, w]) => ('proof' in w ? w.proof.map(p => [key, p] as const) : [])))(
    '%s names an existing proof',
    (_key, p) => {
      const file = path.join(ROOT, p.file)
      expect({ file: p.file, exists: fs.existsSync(file) }).toEqual({ file: p.file, exists: true })
      const text = fs.readFileSync(file, 'utf8')
      expect({ file: p.file, title: p.title, found: text.includes(p.title) }).toMatchObject({ found: true })
      expect({ file: p.file, mentions: p.mentions, found: text.includes(p.mentions) }).toMatchObject({ found: true })
    },
  )
})

describe('documentary capture dependencies (what the frozen entry reads, and what protects it)', () => {
  const { code } = scan()
  const loader = code.get('src/services/fiscal/cfdi.service.ts#loadOrderForCfdiFromDb') ?? ''
  const admission = code.get('src/services/fiscal/admisionIva.ts#bloquearOrdenParaFacturar') ?? ''

  it('the capture never reads the order customer: the receptor comes only from explicit request parameters', () => {
    expect(loader.length).toBeGreaterThan(0)
    expect(loader).not.toMatch(/\bcustomer(Id)?\b|orderCustomer|OrderCustomer/)
    expect(code.get('src/services/fiscal/entradaDocumental.ts#capturarEntrada')).toContain('receptor,')
  })

  it('admission locks the Order and its Products only: the SAT fallbacks of MenuCategory and Venue.type are read unlocked', () => {
    expect(admission).toContain('FOR UPDATE OF o')
    expect(admission).toContain('FOR SHARE OF p')
    expect(admission).not.toMatch(/"MenuCategory"/)
    // Each fallback is read ONCE per capture (one committed value, frozen in the entry): see writerCapture.test.ts.
    expect(loader).toContain('defaultSatProductKey')
    expect(loader).toMatch(/venue:\s*\{\s*select:\s*\{\s*slug: true,\s*type: true/)
  })
})

describe('locked-transaction helpers never receive the global client', () => {
  const { calls, globalClients } = scan()
  const GUARDED: Array<{ callee: string; txIndex: number; minimum: number }> = [
    { callee: 'recalculateOrderTotals', txIndex: 3, minimum: 16 },
    { callee: 'applyPromotionToOrder', txIndex: 1, minimum: 1 },
    // B2: 11 sitios medidos al cerrar B2 (T2 3, T3 2, T4 2, T5 2, T6 1 —cupón—, T7 1); B2c T2 +1 (`voidItems`), T4 +1 (`compItems`),
    // T5 +1 (`addAreaTicketItems`).
    { callee: 'sincronizarRepartos', txIndex: 0, minimum: 14 },
    // Codex r1 P1: los siete escritores que crean una fila sobre una orden existente; B2c T2 (R7-1) +2 (borrar y anular);
    // B2c T3 (R7-1) +2 (quitar promoción, quitar una fila desde el móvil); B2c T4 (R7-1) +3 (las tres cortesías).
    { callee: 'conservarDescuentoHistorico', txIndex: 0, minimum: 14 },
    // B2b T6b (R9): borrar y anular renglones.
    { callee: 'retirarImpuestoDeRenglones', txIndex: 0, minimum: 2 },
    // B2c: borrar y anular (T2), quitar promoción (T3), las tres cortesías (T4).
    { callee: 'recortarDescuentosDeRenglones', txIndex: 0, minimum: 6 },
    // B2c T5 (P5): abrir el vale y agregarle renglones.
    { callee: 'crearEspejosDelVale', txIndex: 0, minimum: 2 },
  ]

  it.each(GUARDED)('$callee gets a transaction client, never the autocommit prisma import', ({ callee, txIndex, minimum }) => {
    const sites = calls.filter(c => c.callee === callee && hasCallerTransaction(c.argNodes[txIndex]))
    expect(sites.length).toBeGreaterThanOrEqual(minimum)
    // ponytail: identifiers bound to the default `utils/prismaClient` import only; an alias (`const db = prisma`) would need symbol resolution.
    const global = sites
      .filter(c => {
        const arg = unwrap(c.argNodes[txIndex])
        return ts.isIdentifier(arg) && (globalClients.get(c.file)?.has(arg.text) ?? false)
      })
      .map(c => `${c.owner}(${c.args[txIndex]})`)
    expect(global).toEqual([])
  })
})

/**
 * Ruling T8-R2 (final review, Important 2): ONE lock-wait budget. A lock wait counts against the interactive-transaction
 * timeout, so a transaction on Prisma's default (5 s / 2 s) dies with P2028 behind a holder that is allowed 15 s (the
 * capture, the TPV writers): a 500 online, a RETRY in the sync reducer, a permanent DLQ for a POS header. Every
 * transaction whose callback takes the canonical Order lock — directly, through a helper that receives the tx, or through
 * an optional-tx entry point given the tx — opens with { timeout: 15_000, maxWait: 5_000 } (`ORDER_LOCK_WAIT_BUDGET`, or
 * the same literal values). Only the function that OPENS the transaction takes the options.
 */
const ORDER_LOCK_TRANSACTIONS: Record<string, number> = {
  'src/services/tpv/order.tpv.service.ts#createOrder': 1,
  'src/services/tpv/order.tpv.service.ts#createOrderWithItems': 1,
  // Mesas topology-lock and controller entry points, with the same budget contract.
  'src/controllers/tpv/order-table.tpv.controller.ts#mergeOrders': 1,
  'src/controllers/tpv/order-table.tpv.controller.ts#cancelOrder': 1,
  'src/services/tpv/table.tpv.service.ts#assignTable': 1,
  'src/services/tpv/table.tpv.service.ts#clearTable': 1,
  'src/services/tpv/table.tpv.service.ts#releaseTableIfSettled': 1,
  'src/services/tpv/table.tpv.service.ts#moveOrderToTable': 1,
  'src/services/tpv/table.tpv.service.ts#reconcileTableAfterOrderRemoved': 1,
  'src/services/tpv/table.tpv.service.ts#assignOrderWaiter': 1,
  'src/services/tpv/table.tpv.service.ts#deleteTable': 1,
  'src/mcp/tools/tables.ts#registerTableTools': 1,
  // Plan 3b writers (the final review's list)
  'src/services/dashboard/discountEngine.service.ts#applyDiscountToOrder': 1,
  'src/services/dashboard/discountEngine.service.ts#removeDiscountFromOrder': 1,
  'src/services/dashboard/discountEngine.service.ts#applyAutomaticDiscounts': 1,
  'src/services/dashboard/discountEngine.service.ts#applyManualDiscount': 1,
  'src/services/tpv/discount.tpv.service.ts#applyCouponCode': 1,
  'src/services/mobile/comp-item.mobile.service.ts#compOrderItem': 1,
  'src/services/mobile/comp-item.mobile.service.ts#compWholeOrder': 1,
  'src/services/mobile/service-charge.mobile.service.ts#applyServiceCharge': 1,
  'src/services/mobile/service-charge.mobile.service.ts#removeServiceCharge': 1,
  'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceCharges': 1,
  'src/services/mobile/order.mobile.service.ts#createOrderWithItems': 1,
  'src/services/mobile/order.mobile.service.ts#updateOrderDetails': 1,
  'src/services/mobile/order.mobile.service.ts#applyOrderDiscount': 1,
  'src/services/mobile/order.mobile.service.ts#removeOrderDiscount': 1,
  'src/services/mobile/order.mobile.service.ts#splitOrderItems': 1,
  'src/services/mobile/order.mobile.service.ts#splitOrderBySeat': 1,
  'src/services/promotions/promotion.service.ts#applyPromotionToOrder': 1,
  'src/services/promotions/promotion.service.ts#removePromotionFromOrder': 1,
  'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrder': 1,
  'src/services/wallet/redeemStampReward.service.ts#redeemStampReward': 1,
  'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems': 1,
  'src/services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent': 1,
  'src/services/tpv/payment.tpv.service.ts#updateOrderTotalsForStandalonePayment': 1,
  // KDS stage 3 × plan 3b (Codex, merge 30-sep): the author takes kitchen lock → Order lock → lines, like every writer
  'src/services/kds/kitchenTicketAuthoring.service.ts#authorKitchenTickets': 1,
  // develop f97a82b1: the abandoned-order cleanup rereads each order under the lock
  'src/jobs/abandoned-orders-cleanup.job.ts#AbandonedOrdersCleanupJob.runOnce': 1,
  // Already on the budget before the final wave
  'src/services/tpv/order.tpv.service.ts#addItemsToOrder': 1,
  'src/services/tpv/order.tpv.service.ts#removeOrderItem': 1,
  'src/services/tpv/order.tpv.service.ts#compItems': 1,
  'src/services/tpv/order.tpv.service.ts#voidItems': 1,
  'src/services/tpv/order.tpv.service.ts#applyDiscount': 1,
  'src/services/tpv/order.tpv.service.ts#addSerializedItemToOrder': 1,
  'src/services/mobile/order.mobile.service.ts#mergeOrders': 1,
  'src/services/mobile/order.mobile.service.ts#cancelOrder': 1,
  'src/services/dashboard/order.dashboard.service.ts#updateOrder': 1,
  'src/services/dashboard/order.dashboard.service.ts#deleteOrder': 1,
  'src/services/mobile/areaTicketV7.mobile.service.ts#cancelAreaTicketCheckout': 1,
  'src/services/pos-sync/posSyncOrder.service.ts#processPosOrderDeleteEvent': 1,
  'src/services/pos-sync/posSyncOrderItem.service.ts#applyPosOrderItemEvent': 1,
  // Payment, refund and delivery lanes that take the same lock (outside the review's list; same rule)
  'src/services/mobile/order.mobile.service.ts#payCashOrder': 1,
  'src/services/dashboard/order.dashboard.service.ts#settleOrder': 1,
  'src/services/dashboard/manualPayment.service.ts#createManualPayment': 1,
  'src/services/dashboard/customer.dashboard.service.ts#settleCustomerBalance': 1,
  'src/services/b4bit/b4bit.service.ts#settleOrderForConfirmedCryptoPayment': 2,
  'src/services/dashboard/refund.dashboard.service.ts#issueRefund': 1,
  'src/services/tpv/refund.tpv.service.ts#recordRefund': 1,
  'src/services/delivery-channels/core/cancelDeliveryOrder.service.ts#cancelDeliveryOrder': 1,
  'src/services/delivery-channels/core/applyDeliveryRefund.service.ts#applyDeliveryRefund': 1,
}

/** Lock-taking transactions whose wait is governed by their own protocol, pinned verbatim so a change is re-reviewed. */
const OWN_BUDGET: Record<string, { options: string; reason: string }> = {
  'src/services/tpv/payment.tpv.service.ts#recordOrderPayment': {
    options: 'OPCIONES_DE_TRANSACCION_DEL_INTENTO',
    reason:
      'attempt-lock protocol (Codex R6-2/R14-1): explicit READ COMMITTED and 10 s, with SET LOCAL lock_timeout (8 s) bounding every lock wait of the transaction, the Order included; owned by the cobro-remoto protocol',
  },
}

/** Functions that take the canonical Order lock on the transaction they RECEIVE; one that opens its own is an opener. */

/** The new helper is a seed only while its executable SQL still claims ordered Order rows FOR UPDATE. */
function hasOrderedOrderClaim(body: string): boolean {
  const sf = ts.createSourceFile('scope.ts', body, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag) && node.tag.name.text === '$queryRaw') {
      found ||= /FROM\s+"Order"[\s\S]*?ORDER BY id FOR UPDATE/.test(node.template.getText(sf))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Scope delegation retains the old unconditional awaited Venue fence before each ordered Order claim. */
function hasVenueFenceBeforeOrderedOrderClaim(body: string): boolean {
  const sf = ts.createSourceFile('scope.ts', body, ts.ScriptTarget.Latest, true)
  const scope = sf.statements.find(ts.isFunctionDeclaration)
  if (!scope?.body || scope.name?.text !== 'lockTableOrderScope') return false
  const client = scope.parameters[0]?.name
  if (!client || !ts.isIdentifier(client)) return false
  const fences: number[] = []
  const claims: number[] = []
  const visit = (node: ts.Node): void => {
    if (node !== scope && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isPropertyAccessExpression(node.tag) &&
      node.tag.name.text === '$queryRaw' &&
      ts.isIdentifier(node.tag.expression) &&
      node.tag.expression.text === client.text &&
      ts.isAwaitExpression(node.parent)
    ) {
      const sql = node.template.getText(sf)
      if (/FROM\s+"Order"[\s\S]*?ORDER BY id FOR UPDATE/.test(sql)) claims.push(node.getStart(sf))
      if (/FROM\s+"Venue"[\s\S]*?FOR KEY SHARE/.test(sql)) {
        const declaration = node.parent.parent
        // A nested/conditional/foreign-client fence does not prove the unconditional claim ordering.
        if (
          ts.isVariableDeclaration(declaration) &&
          ts.isVariableDeclarationList(declaration.parent) &&
          ts.isVariableStatement(declaration.parent.parent) &&
          declaration.parent.parent.parent === scope.body
        )
          fences.push(node.getStart(sf))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return fences.length === 1 && claims.length > 0 && claims.every(position => fences[0] < position)
}

function orderLockHelpers(code: Map<string, string>, calls: Call[]): Set<string> {
  const calleesByOwner = new Map<string, Set<string>>()
  for (const c of calls) calleesByOwner.set(c.owner, (calleesByOwner.get(c.owner) ?? new Set()).add(c.callee))
  const helpers = new Set(['lockExistingOrderForPayment'])
  if (hasOrderedOrderClaim(code.get('src/services/shared/tableOrderLock.ts#lockTableOrderScope') ?? '')) helpers.add('lockTableOrderScope')
  for (let grew = true; grew; ) {
    grew = false
    for (const [key, body] of code) {
      const name = key.split('#')[1]
      if (helpers.has(name) || /\$transaction\(|withDeliveryOrderLock\(/.test(body)) continue
      if ([...(calleesByOwner.get(key) ?? [])].some(callee => helpers.has(callee))) {
        helpers.add(name)
        grew = true
      }
    }
  }
  return helpers
}

const ONE_BUDGET = { timeout: '15000', maxWait: '5000' }

/**
 * `timeout` / `maxWait` of a `$transaction` options literal: a number's value (`15_000` ⇒ '15000') or the expression text.
 * The shared `ORDER_LOCK_WAIT_BUDGET` stands for its value, which its own test pins.
 */
function budgetOf(options: ts.Expression | undefined): { timeout?: string; maxWait?: string } {
  if (options?.getText() === 'ORDER_LOCK_WAIT_BUDGET') return ONE_BUDGET
  const value = (name: string) => {
    const e = property(options, name)
    return e && (ts.isNumericLiteral(e) ? e.text : e.getText())
  }
  return { timeout: value('timeout'), maxWait: value('maxWait') }
}

function transactionTakesOrderLock(t: Transaction, helpers: Set<string>): boolean {
  return t.callees.some(
    c => helpers.has(c.name) || OPTIONAL_TX.some(o => o.callee === c.name && hasCallerTransaction(c.argNodes?.[o.txIndex])),
  )
}

describe('every transaction that takes the canonical Order lock waits on ONE budget (Ruling T8-R2)', () => {
  const { code, calls, transactions } = scan()
  const helpers = orderLockHelpers(code, calls)
  // Named transaction callbacks resolve their nearest lexical binding; callbacks handed to a
  // wrapper that opens the transaction (withDeliveryOrderLock) are covered by its own pin below. Raw
  // `SELECT … FROM "Order" … FOR UPDATE` outside the canonical helper is outside this rule (listed in the final-wave report).
  const locking = transactions.filter(t => transactionTakesOrderLock(t, helpers))

  it('scope delegation preserves the Venue KEY SHARE fence before ordered Order FOR UPDATE', () => {
    expect(hasVenueFenceBeforeOrderedOrderClaim(code.get('src/services/shared/tableOrderLock.ts#lockTableOrderScope') ?? '')).toBe(true)
  })

  it('finds the lock-taking transactions (a collapse means the scanner broke, not the code)', () => {
    for (const helper of ['lockDiscountOrder', 'requireOpenOrder', 'applyPromotionInTransaction', 'assertOrderCancellableUnderLock'])
      expect({ helper, found: helpers.has(helper) }).toEqual({ helper, found: true })
    expect(locking.length).toBeGreaterThanOrEqual(45)
  })

  it('every lock-taking transaction is pinned: a new one is classified here before it ships', () => {
    const found = locking.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.owner]: (acc[t.owner] ?? 0) + 1 }), {})
    const pinned = { ...ORDER_LOCK_TRANSACTIONS, ...Object.fromEntries(Object.keys(OWN_BUDGET).map(owner => [owner, 1])) }
    expect(found).toEqual(pinned)
  })

  it.each(locking.map(t => [`${t.owner}:${t.line}`, t] as const))('%s opens with the one budget (or its pinned OWN_BUDGET)', (site, t) => {
    const own = OWN_BUDGET[t.owner]
    if (own) expect({ site, options: t.options?.getText() }).toEqual({ site, options: own.options })
    else expect({ site, ...budgetOf(t.options) }).toEqual({ site, ...ONE_BUDGET })
  })

  it('ORDER_LOCK_WAIT_BUDGET, next to the canonical lock helper, is { timeout: 15_000, maxWait: 5_000 }', () => {
    // The printer drops numeric separators: `15_000` is printed `15000`.
    expect(code.get('src/services/shared/paymentShiftClaim.ts#ORDER_LOCK_WAIT_BUDGET')).toMatch(
      /ORDER_LOCK_WAIT_BUDGET = \{ timeout: 15_?000, maxWait: 5_?000 \} as const/,
    )
  })

  it('withDeliveryOrderLock (delivery advisory → Order) opens its transaction on the same budget', () => {
    const [opener] = transactions.filter(t => t.owner === 'src/services/delivery-channels/core/deliveryOrderLock.ts#withDeliveryOrderLock')
    expect(budgetOf(opener?.options)).toEqual({ timeout: 'CANDADO_TX_TIMEOUT_MS', maxWait: '5000' })
    expect(code.get('src/services/delivery-channels/core/deliveryOrderLock.ts#CANDADO_TX_TIMEOUT_MS')).toMatch(
      /CANDADO_TX_TIMEOUT_MS = 15_?000\b/,
    )
  })
})

describe('R11 (Codex r5): quien rearma el dinero de una orden desde sus renglones rechaza las importadas', () => {
  const { calls, code } = scan()
  const MARCAS = ['rechazarSiEsImportada(', 'esOrdenImportada(']
  // Nacen en Avoqado en la misma transacción (nunca son importadas), o son el ayudante mismo, cuyos llamadores ya pasan la red.
  const EXENTOS = new Set([
    'src/services/tpv/order.tpv.service.ts#createOrderWithItems',
    'src/services/mobile/order.mobile.service.ts#createOrderWithItems',
    'src/services/mobile/comp-item.mobile.service.ts#recalculateOrderTotals',
    // B2c T5: el vale nace en Avoqado (`openAreaTicket`): nunca es importado.
    'src/services/mobile/areaTicket.mobile.service.ts#addAreaTicketItems',
  ])
  const rearman = [
    ...new Set(calls.filter(c => c.callee === 'sincronizarRepartos' || c.callee === 'recalculateOrderTotals').map(c => c.owner)),
  ].filter(o => !EXENTOS.has(o))
  it('la red encuentra a los escritores (contados el 4-oct tras B2c T5: 23; si colapsa, se rompió el escáner)', () => {
    expect(rearman.length).toBeGreaterThanOrEqual(23)
  })
  it.each([...rearman].sort())('%s rechaza (o, si es automático, salta) las órdenes importadas', key => {
    const cuerpo = code.get(key) ?? ''
    expect({ key, guarda: MARCAS.some(m => cuerpo.includes(m)) }).toEqual({ key, guarda: true })
  })
})

describe('Mesas lock/budget scanner regressions', () => {
  const source = (text: string) => ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true)
  const opener = (text: string): Transaction => {
    const sf = source(text)
    let result: Transaction | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node) === '$transaction') {
        result = {
          owner: ownerOf(node),
          line: 1,
          options: node.arguments[1],
          callees: calleesOf(transactionCallback(node.arguments[0], node)),
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (!result) throw new Error('fixture has no transaction')
    return result
  }

  it('seeds only the real ordered Order SQL and propagates through a tx-only helper', () => {
    const body = 'async function lockTableOrderScope(tx) { await tx.$queryRaw`SELECT id FROM "Order" ORDER BY id FOR UPDATE`; }'
    const key = 'src/services/shared/tableOrderLock.ts#lockTableOrderScope'
    const call: Call = {
      callee: 'lockTableOrderScope',
      owner: 'fixture.ts#mergeOrdersInTransaction',
      file: 'fixture.ts',
      args: ['tx'],
      argNodes: ts.factory.createNodeArray([ts.factory.createIdentifier('tx')]),
    }
    const code = new Map([
      [key, body],
      ['fixture.ts#mergeOrdersInTransaction', 'async function mergeOrdersInTransaction(tx) { await lockTableOrderScope(tx); }'],
    ])
    expect(orderLockHelpers(code, [call]).has('mergeOrdersInTransaction')).toBe(true)
    expect(orderLockHelpers(new Map([[key, body.replace('FOR UPDATE', 'FOR SHARE')]]), [call]).has('lockTableOrderScope')).toBe(false)
    expect(hasOrderedOrderClaim(body.replace('"Order"', '"Table"'))).toBe(false)
  })

  it('rejects a removed, reordered, conditional or foreign-client Venue fence', () => {
    const venue = 'const venues = await tx.$queryRaw`SELECT id FROM "Venue" FOR KEY SHARE`;'
    const order = 'const orders = await tx.$queryRaw`SELECT id FROM "Order" ORDER BY id FOR UPDATE`;'
    const scope = (parts: string) => `async function lockTableOrderScope(tx) { ${parts} }`
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(venue + order))).toBe(true)
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(order))).toBe(false)
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(order + venue))).toBe(false)
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(venue.replace('FOR KEY SHARE', 'FOR SHARE') + order))).toBe(false)
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(`if (condition) { ${venue} } ${order}`))).toBe(false)
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(venue.replace('tx.$queryRaw', 'foreign.$queryRaw') + order))).toBe(false)
    expect(hasVenueFenceBeforeOrderedOrderClaim(scope(`// ${venue}\n${order}`))).toBe(false)
  })

  it('finds a lexical local callback and rejects its missing/wrong budget', () => {
    const local =
      'async function updateOrder() { const update = async tx => lockTableOrderScope(tx); return prisma.$transaction(update, OPTIONS); }'
    const noBudget = opener(local.replace(', OPTIONS', ''))
    expect(noBudget.callees.some(c => c.name === 'lockTableOrderScope')).toBe(true)
    expect(budgetOf(noBudget.options)).not.toEqual(ONE_BUDGET)
    expect(budgetOf(opener(local.replace('OPTIONS', '{ timeout: 5000, maxWait: 2000 }')).options)).not.toEqual(ONE_BUDGET)
    expect(budgetOf(opener(local.replace('OPTIONS', 'ORDER_LOCK_WAIT_BUDGET')).options)).toEqual(ONE_BUDGET)
  })

  it('does not use a homonymous callback from another lexical scope', () => {
    const t = opener(
      'async function update(tx) { await lockTableOrderScope(tx); } async function other() { const update = async tx => writeMetadata(tx); return prisma.$transaction(update); }',
    )
    expect(t.callees.some(c => c.name === 'lockTableOrderScope')).toBe(false)
    expect(t.callees.some(c => c.name === 'writeMetadata')).toBe(true)
  })

  it('distinguishes undefined plus options from tx plus options, while global/import aliases remain caller arguments', () => {
    const call = (text: string) => {
      const st = source(text).statements[0]
      if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) throw new Error('invalid call fixture')
      return st.expression
    }
    const ownOptional = opener('prisma.$transaction(tx => applyPromotionToOrder(payload, undefined, options), ORDER_LOCK_WAIT_BUDGET)')
    const callerOptional = opener('prisma.$transaction(tx => applyPromotionToOrder(payload, tx, options), ORDER_LOCK_WAIT_BUDGET)')
    expect(transactionTakesOrderLock(ownOptional, new Set())).toBe(false)
    expect(transactionTakesOrderLock(callerOptional, new Set())).toBe(true)
    expect(hasCallerTransaction(call('applyPromotionToOrder(payload, undefined, options)').arguments[1])).toBe(false)
    expect(hasCallerTransaction(call('applyPromotionToOrder(payload, tx, options)').arguments[1])).toBe(true)
    for (const importedName of ['prisma', 'tenantPrisma']) {
      const arg = call(`applyPromotionToOrder(payload, ${importedName}, options)`).arguments[1]
      expect(hasCallerTransaction(arg)).toBe(true)
      expect(ts.isIdentifier(arg) && new Set([importedName]).has(arg.text)).toBe(true)
    }
  })
})
