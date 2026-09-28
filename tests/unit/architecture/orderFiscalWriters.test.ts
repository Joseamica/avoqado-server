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
const WRITE_METHODS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
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

let cached: ReturnType<typeof scanSources> | undefined
const scan = () => (cached ??= scanSources())

function scanSources() {
  const printer = ts.createPrinter({ removeComments: true })
  const fiscal = new Set<string>()
  const orderWriters = new Set<string>()
  const code = new Map<string, string>()
  const calls: Call[] = []
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
        const callee = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : ''
        if (callee) calls.push({ callee, owner: keyOf(n), file: rel, args: n.arguments.map(a => a.getText(sf)), argNodes: n.arguments })
        if (ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)) {
          const method = n.expression.name.text
          const model = n.expression.expression.name.text
          const arg = n.arguments[0]
          if (CHILD_MODELS.has(model) && WRITE_METHODS.has(method)) fiscal.add(keyOf(n))
          if (model === 'order' && WRITE_METHODS.has(method)) {
            orderWriters.add(keyOf(n))
            const orderFiscal =
              ((method === 'update' || method === 'updateMany') && fiscalPayload(property(arg, 'data'))) ||
              (method === 'upsert' && fiscalPayload(property(arg, 'update'))) ||
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
  return { fiscal, orderWriters, code, calls, globalClients }
}

type Proof = { file: string; title: string; mentions: string }
type Writer =
  | { class: 'LOCKED'; lock: string[]; proof: Proof[]; note?: string }
  | { class: 'CALLER_LOCKED'; callers: string[]; proof: Proof[] }
  | { class: 'PRIVATE_CREATION'; creates: string[]; note: string }
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
  'src/services/mobile/comp-item.mobile.service.ts#compOrderItem': { class: 'LOCKED', lock: LOCK, proof: T1('compOrderItem') },
  'src/services/mobile/comp-item.mobile.service.ts#compWholeOrder': { class: 'LOCKED', lock: LOCK, proof: T1('compWholeOrder') },
  'src/services/mobile/service-charge.mobile.service.ts#applyServiceCharge': {
    class: 'LOCKED',
    lock: ['requireOpenOrder('],
    proof: T1('applyServiceCharge'),
  },
  'src/services/mobile/service-charge.mobile.service.ts#removeServiceCharge': {
    class: 'LOCKED',
    lock: ['requireOpenOrder('],
    proof: T1('removeServiceCharge'),
  },
  'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceChargesInTransaction': {
    class: 'CALLER_LOCKED',
    callers: ['src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceCharges'],
    proof: T1('syncAutomaticServiceCharges'),
  },
  'src/services/mobile/order.mobile.service.ts#mergeOrders': {
    class: 'LOCKED',
    lock: ['ORDER BY id FOR UPDATE'],
    proof: proof(MOBILE_T1, 'mergeOrders', 'merge rereads source membership after waiting'),
  },
  'src/services/mobile/order.mobile.service.ts#updateOrderDetails': {
    class: 'METADATA',
    reason:
      'Opaque data map carries only customerName/specialRequests/covers/type/customerId. Only a covers change composes money, and it does so under lockExistingOrderForPayment through syncAutomaticServiceCharges with the same tx (T1).',
  },
  // ── Mobile discounts, splits, promotions and redemptions (T4) ───────────────────────────────
  'src/services/mobile/comp-item.mobile.service.ts#recalculateOrderTotals': {
    class: 'CALLER_LOCKED',
    callers: [
      'src/services/mobile/comp-item.mobile.service.ts#compOrderItem',
      'src/services/mobile/comp-item.mobile.service.ts#compWholeOrder',
      'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrder',
      'src/services/mobile/order.mobile.service.ts#applyOrderDiscount',
      'src/services/mobile/order.mobile.service.ts#mergeOrders',
      'src/services/mobile/order.mobile.service.ts#removeOrderDiscount',
      'src/services/mobile/order.mobile.service.ts#splitOrderBySeat',
      'src/services/mobile/order.mobile.service.ts#splitOrderItems',
      'src/services/mobile/service-charge.mobile.service.ts#applyServiceCharge',
      'src/services/mobile/service-charge.mobile.service.ts#removeServiceCharge',
      'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceChargesInTransaction',
      'src/services/promotions/promotion.service.ts#applyPromotionInTransaction',
      'src/services/promotions/promotion.service.ts#removePromotionFromOrder',
      'src/services/wallet/redeemStampReward.service.ts#redeemStampReward',
    ],
    proof: T4('applyOrderDiscount'),
  },
  'src/services/mobile/order.mobile.service.ts#applyOrderDiscount': { class: 'LOCKED', lock: LOCK, proof: T4('applyOrderDiscount') },
  'src/services/mobile/order.mobile.service.ts#removeOrderDiscount': { class: 'LOCKED', lock: LOCK, proof: T4('removeOrderDiscount') },
  'src/services/mobile/order.mobile.service.ts#splitOrderItems': {
    class: 'LOCKED',
    lock: VENUE_FENCE_THEN_LOCK,
    proof: [...T4('splitOrderItems'), ...proof(MOBILE_T4, 'splitOrderItems', 'split writers take the Venue before the source Order')],
  },
  'src/services/mobile/order.mobile.service.ts#splitOrderBySeat': {
    class: 'LOCKED',
    lock: VENUE_FENCE_THEN_LOCK,
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
  'src/services/mobile/loyalty.mobile.service.ts#redeemPointsToOrder': { class: 'LOCKED', lock: LOCK, proof: T4('redeemPointsToOrder') },
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
    note: 'Direct branch (paid-order sweep, reasignarCobro, recordOrderPayment without in-tx settlement): Order lock, reread of the inputs, one rerun on a change, then skip + warn (Ruling T7-R1).',
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
  'src/jobs/abandoned-orders-cleanup.job.ts#AbandonedOrdersCleanupJob.cleanupAbandonedOrders': {
    class: 'EXCLUDED',
    reason: 'deletes old TAKEOUT orders selected as PENDING with zero lines; nothing invoiceable at selection time',
    residual:
      'the deleteMany by ids does not re-check emptiness/paymentStatus in its WHERE: a line or payment landing in between is deleted with the order (Payment cascades). Pre-existing, outside the fiscal lock protocol.',
  },
}

/** Functions that are not fiscal writers themselves but hold the Order lock for a CALLER_LOCKED helper. */
const LOCK_HOLDERS: Record<string, string[]> = {
  'src/services/dashboard/discountEngine.service.ts#applyDiscountToOrder': ['lockDiscountOrder('],
  'src/services/dashboard/discountEngine.service.ts#applyAutomaticDiscounts': ['lockDiscountOrder('],
  'src/services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceCharges': LOCK,
  'src/services/delivery-channels/core/deliveryReconciliation.service.ts#reconcileDeliveryOrderFromProvider': [
    'withDeliveryOrderLock(',
    ...LOCK,
  ],
  'src/services/mobile/kdsOutOfStock.mobile.service.ts#enviarYAplicar': ['withDeliveryOrderLock(', ...LOCK],
  'src/services/tpv/payment.tpv.service.ts#recordOrderPayment': LOCK,
}

/** Optional-tx entry points: a call that passes the tx must come from a writer that already holds the Order lock. */
const OPTIONAL_TX: Array<{ callee: string; txIndex: number; lockedCallers: string[] }> = [
  {
    callee: 'syncAutomaticServiceCharges',
    txIndex: 2,
    lockedCallers: [
      'src/services/mobile/order.mobile.service.ts#mergeOrders',
      'src/services/mobile/order.mobile.service.ts#updateOrderDetails',
    ],
  },
  { callee: 'applyPromotionToOrder', txIndex: 1, lockedCallers: ['src/services/mobile/order.mobile.service.ts#createOrderWithItems'] },
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
  'src/services/tpv/table.tpv.service.ts#moveOrderToTable': {
    class: 'METADATA',
    why: 'tableId only (residual: Table FOR UPDATE → Order vs split Order → child insert KEY SHARE Table)',
  },
  'src/services/tpv/table.tpv.service.ts#assignOrderWaiter': { class: 'METADATA', why: 'servedById only' },
  'src/services/tpv/table.tpv.service.ts#assignTable': {
    class: 'PRIVATE_CREATION',
    why: 'new empty order; detaching zombie orders only clears tableId',
    markers: NEW_ORDER,
  },
  'src/services/mobile/areaTicket.mobile.service.ts#claimAreaTicket': { class: 'METADATA', why: 'claim fields under a CAS' },
  'src/services/tpv/payment.tpv.service.ts#recordOrderPayment': {
    class: 'METADATA',
    why: 'splitType/loyalty marks; its money write is settleStandalonePaymentInTx under its Order lock',
  },
  'src/services/shared/loyaltyOnPaidOrder.ts#awardLoyaltyForPaidOrder': { class: 'METADATA', why: 'loyalty award marks' },
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
  'src/services/mobile/order.mobile.service.ts#cancelOrder': CANCEL('assertOrderCancellableUnderLock'),
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
        expect({ caller, holdsLock: cls ? LOCKING.has(cls) : !!holder && holder.every(m => codeOf(caller).includes(m)) }).toEqual({
          caller,
          holdsLock: true,
        })
      }
    },
  )

  it.each(OPTIONAL_TX)(
    '$callee receives a caller transaction only from writers that hold the Order',
    ({ callee, txIndex, lockedCallers }) => {
      const withTx = [...new Set(calls.filter(c => c.callee === callee && c.args.length > txIndex).map(c => c.owner))].sort()
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
  ]

  it.each(GUARDED)('$callee gets a transaction client, never the autocommit prisma import', ({ callee, txIndex, minimum }) => {
    const sites = calls.filter(c => c.callee === callee && c.args.length > txIndex)
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
