import fs from 'fs'
import path from 'path'
import ts from 'typescript'

type InventoryDecision =
  | { decision: 'include'; lane: string; auditFunction: string }
  | { decision: 'exclude'; lane: string; reason: string }

const INVENTORY: Record<string, InventoryDecision> = {
  'src/services/b4bit/b4bit.service.ts#initiateCryptoPayment#create': {
    decision: 'exclude',
    lane: 'b4bitInitiation',
    reason: 'PENDING is not confirmed money',
  },
  'src/services/b4bit/b4bit.service.ts#completeAndAttributeB4BitPaymentInTx#confirmation:update:1': {
    decision: 'exclude',
    lane: 'b4bitCompletedRedelivery',
    reason: 'already-COMPLETED metadata refresh; it cannot claim Shift or settle Order',
  },
  'src/services/b4bit/b4bit.service.ts#completeAndAttributeB4BitPaymentInTx#confirmation:updateMany:1': {
    decision: 'include',
    lane: 'b4bitWebhook',
    auditFunction: 'completeAndAttributeB4BitPaymentInTx',
  },
  'src/services/b4bit/b4bit.service.ts#completeAndAttributeB4BitPaymentInTx#confirmation:update:2': {
    decision: 'exclude',
    lane: 'b4bitCasLoserRedelivery',
    reason: 'CAS loser observed COMPLETED and refreshes metadata only; winner owns attribution',
  },
  'src/services/dashboard/customer.dashboard.service.ts#settleCustomerBalance#create': {
    decision: 'include',
    lane: 'settleCustomerBalance',
    auditFunction: 'settleCustomerBalance',
  },
  'src/services/dashboard/manualPayment.service.ts#createManualPayment#create': {
    decision: 'include',
    lane: 'manualPayment',
    auditFunction: 'createManualPayment',
  },
  'src/services/dashboard/manualSale.service.ts#createOneManualSale#create': {
    decision: 'exclude',
    lane: 'manualSale',
    reason: 'retroactive historical import',
  },
  'src/services/dashboard/order.dashboard.service.ts#settleOrder#create': {
    decision: 'include',
    lane: 'settleOrder',
    auditFunction: 'settleOrder',
  },
  'src/services/dashboard/payment.dashboard.service.ts#updatePayment#confirmation:update:1': {
    decision: 'exclude',
    lane: 'dashboardPaymentCorrection',
    reason: 'back-office correction only; runtime rejects every non-COMPLETED to COMPLETED transition',
  },
  'src/services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout#create': {
    decision: 'exclude',
    lane: 'stripePaymentLink',
    reason: 'online processor checkout without cashier',
  },
  'src/services/dashboard/paymentLink.service.ts#completeCharge#create': {
    decision: 'exclude',
    lane: 'blumonPaymentLink',
    reason: 'online processor checkout without cashier',
  },
  'src/services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout#create': {
    decision: 'exclude',
    lane: 'mercadoPagoPaymentLink',
    reason: 'online processor checkout without cashier',
  },
  'src/services/dashboard/refund.dashboard.service.ts#issueRefund#create': {
    decision: 'include',
    lane: 'issueRefund',
    auditFunction: 'issueRefund',
  },
  'src/services/dashboard/sale-verification.org.dashboard.service.ts#editOrgSaleVerification#confirmation:update:1': {
    decision: 'exclude',
    lane: 'organizationSaleVerificationCorrection',
    reason: 'edits amount/method on an already-ingested promoter Payment and never changes Payment status or captures tender',
  },
  'src/services/dashboard/venueCheckout.service.ts#finalizeVenueCheckout#create': {
    decision: 'exclude',
    lane: 'venueCheckout',
    reason: 'online checkout without cashier',
  },
  'src/services/delivery-channels/core/applyDeliveryRefund.service.ts#applyDeliveryRefund#create': {
    decision: 'exclude',
    lane: 'deliveryRefund',
    reason: 'delivery platform settles the money',
  },
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder#create': {
    decision: 'exclude',
    lane: 'deliveryIngestion',
    reason: 'delivery platform settles the money',
  },
  'src/services/mobile/order.mobile.service.ts#payCashOrder#create': {
    decision: 'include',
    lane: 'payCashOrder',
    auditFunction: 'payCashOrder',
  },
  'src/services/mobile/refund.mobile.service.ts#createRefund#create': {
    decision: 'include',
    lane: 'createRefund',
    auditFunction: 'createRefund',
  },
  'src/services/onboarding/demoSeed.service.ts#seedOrders#create': {
    decision: 'exclude',
    lane: 'demoSeed',
    reason: 'synthetic onboarding data',
  },
  'src/services/pos-sync/posSyncOrder.service.ts#processPaymentsForOrder#create': {
    decision: 'include',
    lane: 'posSyncOrder',
    auditFunction: 'processPaymentsForOrder',
  },
  'src/services/tpv/order.tpv.service.ts#runCreateOrderTransaction#create': {
    decision: 'exclude',
    lane: 'freeCart',
    reason: 'zero-value courtesy order',
  },
  'src/services/tpv/payment.tpv.service.ts#recordOrderPayment#create': {
    decision: 'include',
    lane: 'recordOrderPayment',
    auditFunction: 'recordOrderPayment',
  },
  'src/services/tpv/payment.tpv.service.ts#recordFastPayment#create': {
    decision: 'include',
    lane: 'recordFastPayment',
    auditFunction: 'recordFastPayment',
  },
  'src/services/tpv/refund.tpv.service.ts#ejecutarTransaccionDelReembolso#create': {
    decision: 'include',
    lane: 'recordRefund',
    auditFunction: 'ejecutarTransaccionDelReembolso',
  },
}

const INCLUDED_SOURCE_FILES = [
  ...new Set(
    Object.keys(INVENTORY)
      .filter(key => INVENTORY[key].decision === 'include')
      .map(key => key.split('#')[0]),
  ),
]

interface AstCall {
  file: string
  functionName: string
  expression: string
  position: number
  node: ts.CallExpression
  sourceFile: ts.SourceFile
}

const PAYMENT_WRITE_METHODS = new Set(['create', 'createMany', 'upsert', 'update', 'updateMany'])

function staticPropertyName(expression: ts.Expression): string | undefined {
  if (ts.isComputedPropertyName(expression)) return staticPropertyName(expression.expression)
  if (ts.isIdentifier(expression) || ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) return argument.text
  }
  return undefined
}

function receiverOf(expression: ts.Expression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return expression.expression
  return undefined
}

function directPaymentDelegateRoot(expression: ts.Expression): ts.Expression | undefined {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return undefined
  return staticPropertyName(unwrapped) === 'payment' ? receiverOf(unwrapped) : undefined
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isFunctionLike(cursor)) return cursor
  }
  return undefined
}

function priorIdentifierInitializer(identifier: ts.Identifier, call: AstCall): ts.Expression | undefined {
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return undefined
  let found: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text && node.initializer) {
      found = node.initializer
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === identifier.text
    ) {
      found = node.right
    }
    ts.forEachChild(node, visit)
  }
  visit(owner.body)
  return found
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function resolveAliasedExpression(expression: ts.Expression, call: AstCall, seen = new Set<string>()): ts.Expression {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) return unwrapped
  seen.add(unwrapped.text)
  const initializer = priorIdentifierInitializer(unwrapped, call)
  return initializer ? resolveAliasedExpression(initializer, call, seen) : unwrapped
}

function identifierAliasesPayment(identifier: ts.Identifier, call: AstCall, seen = new Set<string>()): boolean {
  if (seen.has(identifier.text)) return false
  seen.add(identifier.text)
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return false
  let aliased = false
  const visit = (node: ts.Node) => {
    if (aliased || node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name.text === identifier.text && node.initializer) {
        aliased = isPaymentDelegate(node.initializer, call, seen)
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const element = node.name.elements.find(item => {
          const sourceName = item.propertyName ?? item.name
          const sourceText =
            ts.isIdentifier(sourceName) || ts.isStringLiteral(sourceName) || ts.isNoSubstitutionTemplateLiteral(sourceName)
              ? sourceName.text
              : undefined
          return sourceText === 'payment' && ts.isIdentifier(item.name) && item.name.text === identifier.text
        })
        if (element) aliased = true
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === identifier.text
    ) {
      aliased = isPaymentDelegate(node.right, call, seen)
    }
    ts.forEachChild(node, visit)
  }
  visit(owner.body)
  return aliased
}

function isPaymentDelegate(expression: ts.Expression, call: AstCall, seen = new Set<string>()): boolean {
  const resolved = unwrapExpression(expression)
  if (directPaymentDelegateRoot(resolved)) return true
  if (ts.isIdentifier(resolved)) return identifierAliasesPayment(resolved, call, seen)
  return false
}

function paymentDelegateRoot(expression: ts.Expression, call: AstCall, seen = new Set<string>()): ts.Expression | undefined {
  const resolved = unwrapExpression(expression)
  const directRoot = directPaymentDelegateRoot(resolved)
  if (directRoot) return directRoot
  if (!ts.isIdentifier(resolved) || seen.has(resolved.text)) return undefined
  seen.add(resolved.text)
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return undefined
  let root: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name.text === resolved.text && node.initializer) {
        root = paymentDelegateRoot(node.initializer, call, seen)
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const element = node.name.elements.find(item => {
          const sourceName = item.propertyName ?? item.name
          return (
            staticPropertyName(sourceName as ts.Expression) === 'payment' && ts.isIdentifier(item.name) && item.name.text === resolved.text
          )
        })
        if (element) root = node.initializer
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === resolved.text
    ) {
      root = paymentDelegateRoot(node.right, call, seen)
    }
    ts.forEachChild(node, visit)
  }
  visit(owner.body)
  return root
}

interface PaymentWriteResolution {
  method: string
  delegateRoot: ts.Expression
}

function aliasedPaymentWrite(identifier: ts.Identifier, call: AstCall, seen = new Set<string>()): PaymentWriteResolution | undefined {
  if (seen.has(identifier.text)) return undefined
  seen.add(identifier.text)
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return undefined
  let resolution: PaymentWriteResolution | undefined
  const resolveSource = (source: ts.Expression): PaymentWriteResolution | undefined => {
    const expression = unwrapExpression(source)
    const method = staticPropertyName(expression)
    const receiver = receiverOf(expression)
    if (method && receiver && PAYMENT_WRITE_METHODS.has(method)) {
      const delegateRoot = paymentDelegateRoot(receiver, call)
      return delegateRoot ? { method, delegateRoot } : undefined
    }
    return ts.isIdentifier(expression) ? aliasedPaymentWrite(expression, call, seen) : undefined
  }
  const visit = (node: ts.Node) => {
    if (node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name.text === identifier.text && node.initializer) {
        resolution = resolveSource(node.initializer)
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const delegateRoot = paymentDelegateRoot(node.initializer, call)
        if (delegateRoot) {
          const element = node.name.elements.find(item => ts.isIdentifier(item.name) && item.name.text === identifier.text)
          if (element) {
            const sourceName = element.propertyName ?? element.name
            const method = staticPropertyName(sourceName as ts.Expression)
            if (method && PAYMENT_WRITE_METHODS.has(method)) resolution = { method, delegateRoot }
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === identifier.text
    ) {
      resolution = resolveSource(node.right)
    }
    ts.forEachChild(node, visit)
  }
  visit(owner.body)
  return resolution
}

function resolvePaymentWrite(call: AstCall): PaymentWriteResolution | undefined {
  const expression = unwrapExpression(call.node.expression)
  const method = staticPropertyName(expression)
  const receiver = receiverOf(expression)
  if (method && receiver && PAYMENT_WRITE_METHODS.has(method)) {
    const delegateRoot = paymentDelegateRoot(receiver, call)
    return delegateRoot ? { method, delegateRoot } : undefined
  }
  return ts.isIdentifier(expression) ? aliasedPaymentWrite(expression, call) : undefined
}

function paymentWriteMethod(call: AstCall): string | undefined {
  const resolution = resolvePaymentWrite(call)
  if (!resolution) return undefined
  const { method } = resolution
  if (method === 'update' || method === 'updateMany') {
    const status = paymentCompletionStatus(call)
    if (status === 'NON_COMPLETED') return undefined
  }
  return method
}

function enclosingFunctionName(node: ts.Node): string {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isFunctionDeclaration(cursor) && cursor.name) return cursor.name.text
    if (ts.isMethodDeclaration(cursor) && cursor.name) return cursor.name.getText()
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name)
    ) {
      return cursor.parent.name.text
    }
  }
  return '<module>'
}

function parseCalls(file: string, source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')): AstCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: AstCall[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      calls.push({
        file,
        functionName: enclosingFunctionName(node),
        expression: node.expression.getText(sourceFile),
        position: node.getStart(sourceFile),
        node,
        sourceFile,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function objectPropertyExpression(object: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | undefined {
  const property = object.properties.find(item => 'name' in item && item.name && staticPropertyName(item.name) === propertyName)
  if (property && ts.isPropertyAssignment(property)) return property.initializer
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name
  return undefined
}

function argumentObject(call: AstCall, argumentIndex: number): ts.ObjectLiteralExpression | undefined {
  const argument = call.node.arguments[argumentIndex]
  if (!argument) return undefined
  const resolved = resolveAliasedExpression(argument, call)
  return ts.isObjectLiteralExpression(resolved) ? resolved : undefined
}

function hasObjectProperty(call: AstCall, argumentIndex: number, propertyName: string): boolean {
  const argument = call.node.arguments[argumentIndex]
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false
  return argument.properties.some(item => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === propertyName)
}

type CompletionStatus = 'COMPLETED' | 'NON_COMPLETED' | 'UNKNOWN'

function paymentCompletionStatus(call: AstCall): CompletionStatus {
  const argument = argumentObject(call, 0)
  if (!argument || argument.properties.some(ts.isSpreadAssignment)) return 'UNKNOWN'
  const dataExpression = objectPropertyExpression(argument, 'data')
  if (!dataExpression) return 'NON_COMPLETED'
  const data = resolveAliasedExpression(dataExpression, call)
  if (!ts.isObjectLiteralExpression(data) || data.properties.some(ts.isSpreadAssignment)) return 'UNKNOWN'
  const statusExpression = objectPropertyExpression(data, 'status')
  if (!statusExpression) return 'NON_COMPLETED'
  const status = resolveAliasedExpression(statusExpression, call)
  const text = status.getText(call.sourceFile)
  if ((ts.isStringLiteral(status) && status.text === 'COMPLETED') || /(?:^|\.)COMPLETED$/.test(text)) return 'COMPLETED'
  if (ts.isStringLiteral(status) || /(?:^|\.)(?:FAILED|PENDING|PROCESSING|REFUNDED|CANCELLED)$/.test(text)) return 'NON_COMPLETED'
  return 'UNKNOWN'
}

function candidateEntries(calls: AstCall[]): Array<{ call: AstCall; key: string }> {
  const ordinals = new Map<string, number>()
  return calls.flatMap(call => {
    const method = paymentWriteMethod(call)
    if (!method) return []
    const suffix = method === 'update' || method === 'updateMany' ? 'confirmation' : method
    const base = `${call.file}#${call.functionName}#${suffix}`
    if (suffix !== 'confirmation') return [{ call, key: base }]
    const ordinalKey = `${base}:${method}`
    const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1
    ordinals.set(ordinalKey, ordinal)
    return [{ call, key: `${base}:${method}:${ordinal}` }]
  })
}

function discoverCandidates(calls: AstCall[]): string[] {
  return candidateEntries(calls).map(entry => entry.key)
}

function nearestBlock(node: ts.Node): ts.Block | ts.SourceFile | undefined {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isBlock(cursor) || ts.isSourceFile(cursor)) return cursor
  }
  return undefined
}

function containingStatement(node: ts.Node, block: ts.Block | ts.SourceFile): ts.Statement | undefined {
  let cursor: ts.Node = node
  while (cursor.parent && cursor.parent !== block) cursor = cursor.parent
  return ts.isStatement(cursor) ? cursor : undefined
}

function conditionalWithinBlock(node: ts.Node, block: ts.Block | ts.SourceFile): boolean {
  for (let cursor = node.parent; cursor && cursor !== block; cursor = cursor.parent) {
    if (ts.isIfStatement(cursor) || ts.isConditionalExpression(cursor) || ts.isSwitchStatement(cursor) || ts.isTryStatement(cursor)) {
      return true
    }
  }
  return false
}

/**
 * A lexical ordering check is insufficient for money: a nested/conditional
 * `return`, `throw`, `break` or `continue` can leave the relevant block after
 * the Payment write without ever reaching the anomaly recorder. Walk control
 * statements conservatively, while ignoring nested functions because their
 * exits belong to a different invocation.
 */
function containsAbruptFlowOutsideNestedFunction(node: ts.Node): boolean {
  let abrupt = false
  const visit = (current: ts.Node) => {
    if (abrupt) return
    if (current !== node && ts.isFunctionLike(current)) return
    if (ts.isReturnStatement(current) || ts.isThrowStatement(current) || ts.isBreakStatement(current) || ts.isContinueStatement(current)) {
      abrupt = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return abrupt
}

function sameBlockPositionallyOrdered(before: AstCall, after: AstCall): boolean {
  const block = nearestBlock(before.node)
  if (!block || nearestBlock(after.node) !== block) return false
  const beforeStatement = containingStatement(before.node, block)
  const afterStatement = containingStatement(after.node, block)
  if (!beforeStatement || !afterStatement) return false
  const beforeIndex = block.statements.indexOf(beforeStatement)
  const afterIndex = block.statements.indexOf(afterStatement)
  if (beforeIndex < 0 || afterIndex <= beforeIndex) return false
  return !block.statements
    .slice(beforeIndex, afterIndex)
    .some(statement => ts.isReturnStatement(statement) || ts.isThrowStatement(statement))
}

function sameBlockOrdered(before: AstCall, after: AstCall): boolean {
  const block = nearestBlock(before.node)
  return Boolean(
    block &&
      sameBlockPositionallyOrdered(before, after) &&
      !conditionalWithinBlock(before.node, block) &&
      !conditionalWithinBlock(after.node, block),
  )
}

function unconditionalBeforePossiblyConditional(before: AstCall, after: AstCall): boolean {
  const block = nearestBlock(before.node)
  return Boolean(block && sameBlockPositionallyOrdered(before, after) && !conditionalWithinBlock(before.node, block))
}

function isNonWinningUpdateManyExit(statement: ts.Statement, payment: AstCall): boolean {
  if (paymentWriteMethod(payment) !== 'updateMany' || !ts.isIfStatement(statement)) return false
  const resultName = ancestorVariableName(payment.node)
  if (!resultName || statement.elseStatement) return false
  let resultDeclaration: ts.VariableDeclaration | undefined
  for (let cursor = payment.node.parent; cursor; cursor = cursor.parent) {
    if (ts.isVariableDeclaration(cursor)) {
      resultDeclaration = cursor
      break
    }
    if (ts.isStatement(cursor)) break
  }
  if (!resultDeclaration || !ts.isIdentifier(resultDeclaration.name) || !isConstVariableDeclaration(resultDeclaration)) return false
  const initializer = resultDeclaration.initializer && unwrapExpression(resultDeclaration.initializer)
  const exactCall = initializer && ts.isAwaitExpression(initializer) ? unwrapExpression(initializer.expression) : initializer
  if (exactCall !== payment.node) return false
  const block = nearestBlock(payment.node)
  if (!block || statement.parent !== block) return false
  const paymentStatement = containingStatement(payment.node, block)
  if (!paymentStatement) return false
  const paymentIndex = block.statements.indexOf(paymentStatement)
  const branchIndex = block.statements.indexOf(statement)
  if (paymentIndex < 0 || branchIndex !== paymentIndex + 1) return false
  const condition = unwrapExpression(statement.expression)
  if (!ts.isBinaryExpression(condition)) return false
  if (
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
  ) {
    return false
  }
  const isCount = (expression: ts.Expression) => {
    const candidate = unwrapExpression(expression)
    if (!ts.isPropertyAccessExpression(candidate) || candidate.name.text !== 'count') return false
    const receiver = unwrapExpression(candidate.expression)
    return (
      ts.isIdentifier(receiver) &&
      receiver.text === resultName &&
      lexicalDeclaration(receiver, payment.sourceFile) === resultDeclaration!.name
    )
  }
  const isZero = (expression: ts.Expression) => {
    const candidate = unwrapExpression(expression)
    return ts.isNumericLiteral(candidate) && candidate.text === '0'
  }
  return (isCount(condition.left) && isZero(condition.right)) || (isZero(condition.left) && isCount(condition.right))
}

function auditDominatesInSameBlock(payment: AstCall, audit: AstCall): boolean {
  const block = nearestBlock(payment.node)
  if (!block || nearestBlock(audit.node) !== block) return false
  const paymentStatement = containingStatement(payment.node, block)
  const auditStatement = containingStatement(audit.node, block)
  if (!paymentStatement || !auditStatement) return false
  const paymentIndex = block.statements.indexOf(paymentStatement)
  const auditIndex = block.statements.indexOf(auditStatement)
  if (paymentIndex < 0 || auditIndex <= paymentIndex) return false
  if (conditionalWithinBlock(payment.node, block) || conditionalWithinBlock(audit.node, block)) return false
  return !block.statements.slice(paymentIndex, auditIndex).some(statement => {
    if (!containsAbruptFlowOutsideNestedFunction(statement)) return false
    // updateMany is only real money for count=1. Its exact count=0 loser branch
    // may return without an audit because it did not win the transition.
    return !isNonWinningUpdateManyExit(statement, payment)
  })
}

function reachableAuditorFor(payment: AstCall, auditors: AstCall[]): AstCall | undefined {
  return auditors.find(audit => {
    if (auditDominatesInSameBlock(payment, audit)) return true
    let noShiftIf: ts.IfStatement | undefined
    for (let cursor = audit.node.parent; cursor; cursor = cursor.parent) {
      if (ts.isIfStatement(cursor)) {
        noShiftIf = cursor
        break
      }
      if (ts.isFunctionLike(cursor)) break
    }
    if (!noShiftIf) return false
    const condition = noShiftIf.expression.getText(audit.sourceFile)
    const inPendingBranch =
      (condition === 'shiftClaim.pendingReason' || condition === 'shiftClaim') &&
      audit.position >= noShiftIf.thenStatement.getStart(audit.sourceFile) &&
      audit.position < noShiftIf.thenStatement.getEnd()
    const inNoShiftElse = Boolean(
      noShiftIf.elseStatement &&
        /\bshiftClaim\.shiftId\b/.test(condition) &&
        audit.position >= noShiftIf.elseStatement.getStart(audit.sourceFile) &&
        audit.position < noShiftIf.elseStatement.getEnd(),
    )
    if (!inPendingBranch && !inNoShiftElse) return false
    const paymentBlock = nearestBlock(payment.node)
    if (!paymentBlock || noShiftIf.parent !== paymentBlock) return false
    const paymentStatement = containingStatement(payment.node, paymentBlock)
    if (!paymentStatement) return false
    const paymentIndex = paymentBlock.statements.indexOf(paymentStatement)
    const branchIndex = paymentBlock.statements.indexOf(noShiftIf)
    if (paymentIndex < 0 || branchIndex <= paymentIndex) return false
    return !paymentBlock.statements.slice(paymentIndex, branchIndex).some(statement => {
      if (!containsAbruptFlowOutsideNestedFunction(statement)) return false
      return !isNonWinningUpdateManyExit(statement, payment)
    })
  })
}

function ancestorVariableName(node: ts.Node): string | undefined {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) return cursor.name.text
    if (ts.isStatement(cursor)) return undefined
  }
  return undefined
}

function expectedPaymentIdExpression(payment: AstCall): string | undefined {
  const method = paymentWriteMethod(payment)
  if (method === 'create' || method === 'upsert') {
    const resultName = ancestorVariableName(payment.node)
    return resultName ? `${resultName}.id` : undefined
  }
  if (method === 'update' || method === 'updateMany') {
    const argument = argumentObject(payment, 0)
    const whereExpression = argument && objectPropertyExpression(argument, 'where')
    const where = whereExpression && resolveAliasedExpression(whereExpression, payment)
    const idExpression = where && ts.isObjectLiteralExpression(where) ? objectPropertyExpression(where, 'id') : undefined
    return idExpression?.getText(payment.sourceFile)
  }
  return undefined
}

function declarationScope(node: ts.Node): ts.Node | undefined {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isParameter(cursor)) {
      const fn = cursor.parent
      return ts.isFunctionLike(fn) ? fn.body : undefined
    }
    if (ts.isBlock(cursor) || ts.isSourceFile(cursor)) return cursor
  }
  return undefined
}

/**
 * Resolve the declaration that owns an identifier in this parsed source tree.
 * Text equality is deliberately insufficient: two transaction callbacks may
 * both call their parameter `tx` while representing different DB sessions.
 */
function lexicalDeclaration(identifier: ts.Identifier, sourceFile: ts.SourceFile): ts.Identifier | undefined {
  const usePosition = identifier.getStart(sourceFile)
  const candidates: Array<{ name: ts.Identifier; scope: ts.Node }> = []
  const visit = (node: ts.Node) => {
    let declarationName: ts.Identifier | undefined
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      declarationName = node.name
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declarationName = node.name
    }
    const declarationIsHoistedFunction = ts.isFunctionDeclaration(node)
    if (
      declarationName?.text === identifier.text &&
      (declarationIsHoistedFunction || declarationName.getStart(sourceFile) <= usePosition)
    ) {
      const scope = declarationScope(declarationName)
      if (scope && usePosition >= scope.getStart(sourceFile) && usePosition < scope.getEnd()) {
        candidates.push({ name: declarationName, scope })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  candidates.sort((left, right) => {
    const leftSpan = left.scope.getEnd() - left.scope.getStart(sourceFile)
    const rightSpan = right.scope.getEnd() - right.scope.getStart(sourceFile)
    return leftSpan - rightSpan || right.name.getStart(sourceFile) - left.name.getStart(sourceFile)
  })
  return candidates[0]?.name
}

function isConstVariableDeclaration(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) && Boolean(declaration.parent.flags & ts.NodeFlags.Const)
}

function bindingHasWrites(declaration: ts.Identifier, sourceFile: ts.SourceFile): boolean {
  let written = false
  const visit = (node: ts.Node) => {
    if (written) return
    if (ts.isIdentifier(node) && node !== declaration && node.text === declaration.text) {
      const parent = node.parent
      const assigned =
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      const incremented =
        (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      if ((assigned || incremented) && lexicalDeclaration(node, sourceFile) === declaration) {
        written = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return written
}

function sameLexicalIdentifier(
  left: ts.Expression | undefined,
  leftCall: AstCall,
  right: ts.Expression | undefined,
  rightCall: AstCall,
): boolean {
  if (!left || !right || leftCall.sourceFile !== rightCall.sourceFile) return false
  const resolvedLeft = unwrapExpression(left)
  const resolvedRight = unwrapExpression(right)
  if (!ts.isIdentifier(resolvedLeft) || !ts.isIdentifier(resolvedRight)) return false
  const leftDeclaration = lexicalDeclaration(resolvedLeft, leftCall.sourceFile)
  const rightDeclaration = lexicalDeclaration(resolvedRight, rightCall.sourceFile)
  return Boolean(leftDeclaration && rightDeclaration && leftDeclaration === rightDeclaration)
}

function sameEnclosingFunction(...calls: AstCall[]): boolean {
  const owner = calls.length > 0 ? enclosingFunction(calls[0].node) : undefined
  return Boolean(owner && calls.every(call => enclosingFunction(call.node) === owner))
}

const PAYMENT_SHIFT_CLAIM_MODULE = 'src/services/shared/paymentShiftClaim'

interface CanonicalAwaitedCall {
  call: AstCall
  importedName: string
}

function astCallFromNode(node: ts.CallExpression, context: AstCall): AstCall {
  return {
    file: context.file,
    functionName: enclosingFunctionName(node),
    expression: node.expression.getText(context.sourceFile),
    position: node.getStart(context.sourceFile),
    node,
    sourceFile: context.sourceFile,
  }
}

function importsCanonicalPaymentShiftClaim(declaration: ts.ImportDeclaration, file: string): boolean {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return false
  const moduleName = declaration.moduleSpecifier.text
  if (moduleName === '@/services/shared/paymentShiftClaim') return true
  if (!moduleName.startsWith('.')) return false
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), moduleName)).replace(/\.ts$/, '')
  return resolved === PAYMENT_SHIFT_CLAIM_MODULE
}

/**
 * A provenance binding must be exactly `await <named import>(...)` from the
 * canonical helper module. Property-name matching would let
 * `fake.claimShiftForCapturedPayment(...)` certify money, and accepting an
 * un-awaited Promise would certify a value that was never a claim at runtime.
 */
function canonicalAwaitedCall(
  initializer: ts.Expression,
  context: AstCall,
  allowedImportedNames: Set<string>,
): CanonicalAwaitedCall | undefined {
  const outer = unwrapExpression(initializer)
  if (!ts.isAwaitExpression(outer)) return undefined
  const awaited = unwrapExpression(outer.expression)
  if (!ts.isCallExpression(awaited)) return undefined
  const callee = unwrapExpression(awaited.expression)
  if (!ts.isIdentifier(callee)) return undefined
  // A local parameter/variable with the import's spelling shadows it.
  if (lexicalDeclaration(callee, context.sourceFile)) return undefined

  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !importsCanonicalPaymentShiftClaim(statement, context.file)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    const imported = bindings.elements.find(element => element.name.text === callee.text)
    if (!imported) continue
    const importedName = (imported.propertyName ?? imported.name).text
    if (!imported.isTypeOnly && allowedImportedNames.has(importedName)) {
      return { call: astCallFromNode(awaited, context), importedName }
    }
  }
  return undefined
}

// POS-sync computes its claim in the parent transaction callback and threads it
// into the payment helper. That one reviewed exception is backed by a stateful
// suite plus the same-callback proof below. Gates no longer use an exception:
// even through parameters, they must trace to the awaited canonical import.
const PARAMETER_PROVENANCE_ALLOWLIST: Record<string, string> = {
  'src/services/pos-sync/posSyncOrder.service.ts#processPaymentsForOrder#shiftClaim':
    'tests/unit/services/pos-sync/posSyncOrder.shiftCloseRace.test.ts',
}

type BindingProvenance =
  | { kind: 'canonical-call'; origin: CanonicalAwaitedCall }
  | { kind: 'reviewed-parameter'; declaration: ts.ParameterDeclaration }

function bindingProvenance(audit: AstCall, binding: ts.Identifier, origins: Set<string>): BindingProvenance | undefined {
  const declaration = lexicalDeclaration(binding, audit.sourceFile)
  if (!declaration) return undefined
  if (ts.isParameter(declaration.parent)) {
    const tracedOrigin = canonicalOriginFromParameter(declaration.parent, audit, origins)
    if (tracedOrigin) return { kind: 'canonical-call', origin: tracedOrigin }
    const key = `${audit.file}#${audit.functionName}#${binding.text}`
    return PARAMETER_PROVENANCE_ALLOWLIST[key] ? { kind: 'reviewed-parameter', declaration: declaration.parent } : undefined
  }
  if (!ts.isVariableDeclaration(declaration.parent) || !declaration.parent.initializer) return undefined
  if (!isConstVariableDeclaration(declaration.parent)) return undefined
  const origin = canonicalAwaitedCall(declaration.parent.initializer, audit, origins)
  return origin ? { kind: 'canonical-call', origin } : undefined
}

function immutableStatusIdentity(expression: ts.Expression, context: AstCall): string | undefined {
  const resolved = unwrapExpression(expression)
  if (ts.isIdentifier(resolved)) {
    const declaration = lexicalDeclaration(resolved, context.sourceFile)
    if (!declaration || !ts.isVariableDeclaration(declaration.parent) || !isConstVariableDeclaration(declaration.parent)) return undefined
    if (bindingHasWrites(declaration, context.sourceFile)) return undefined
    return `const:${declaration.getStart(context.sourceFile)}`
  }
  if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) return `string:${resolved.text}`
  return undefined
}

function paymentPersistedStatus(payment: AstCall): ts.Expression | undefined {
  const input = argumentObject(payment, 0)
  const dataExpression = input && objectPropertyExpression(input, 'data')
  const data = dataExpression && resolveAliasedExpression(dataExpression, payment)
  return data && ts.isObjectLiteralExpression(data) ? objectPropertyExpression(data, 'status') : undefined
}

function completedWrapperMatchesPersistedStatus(payment: AstCall, origin: CanonicalAwaitedCall): boolean {
  if (origin.importedName !== 'claimShiftForCompletedPayment') return true
  const wrapperInput = argumentObject(origin.call, 1)
  const wrapperStatus = wrapperInput && objectPropertyExpression(wrapperInput, 'paymentStatus')
  const persistedStatus = paymentPersistedStatus(payment)
  if (!wrapperStatus || !persistedStatus) return false
  const wrapperIdentity = immutableStatusIdentity(wrapperStatus, origin.call)
  const persistedIdentity = immutableStatusIdentity(persistedStatus, payment)
  return Boolean(wrapperIdentity && persistedIdentity && wrapperIdentity === persistedIdentity)
}

function functionLocalName(owner: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(owner) && owner.name) return owner.name.text
  if (
    (ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) &&
    ts.isVariableDeclaration(owner.parent) &&
    ts.isIdentifier(owner.parent.name)
  ) {
    return owner.parent.name.text
  }
  return undefined
}

function canonicalOriginFromExpression(
  expression: ts.Expression,
  context: AstCall,
  origins: Set<string>,
  seenParameters: Set<string>,
): CanonicalAwaitedCall | undefined {
  const direct = canonicalAwaitedCall(expression, context, origins)
  if (direct) return direct
  const resolved = unwrapExpression(expression)
  if (!ts.isIdentifier(resolved)) return undefined
  const declaration = lexicalDeclaration(resolved, context.sourceFile)
  if (!declaration) return undefined
  if (ts.isVariableDeclaration(declaration.parent) && declaration.parent.initializer) {
    if (!isConstVariableDeclaration(declaration.parent)) return undefined
    return canonicalOriginFromExpression(declaration.parent.initializer, context, origins, seenParameters)
  }
  if (ts.isParameter(declaration.parent)) {
    return canonicalOriginFromParameter(declaration.parent, context, origins, seenParameters)
  }
  return undefined
}

function canonicalOriginFromParameter(
  parameter: ts.ParameterDeclaration,
  context: AstCall,
  origins: Set<string>,
  seenParameters = new Set<string>(),
): CanonicalAwaitedCall | undefined {
  const owner = parameter.parent
  if (!ts.isFunctionLike(owner)) return undefined
  const ownerName = functionLocalName(owner)
  const parameterIndex = owner.parameters.indexOf(parameter)
  if (!ownerName || parameterIndex < 0) return undefined
  const key = `${context.file}#${ownerName}#${parameterIndex}`
  if (seenParameters.has(key)) return undefined
  const nextSeen = new Set(seenParameters).add(key)
  const callsites = parseCalls(context.file, context.sourceFile.text).filter(call => {
    const callee = unwrapExpression(call.node.expression)
    return ts.isIdentifier(callee) && callee.text === ownerName
  })
  if (callsites.length === 0) return undefined
  const traced = callsites.map(callsite => {
    const argument = callsite.node.arguments[parameterIndex]
    return argument ? canonicalOriginFromExpression(argument, callsite, origins, nextSeen) : undefined
  })
  return traced.every(Boolean) ? traced[0] : undefined
}

/**
 * POS-sync intentionally computes a Shift claim before calling its payment
 * helper. Its parameter exception is safe only while every call threads both
 * `tx` and `shiftClaim` from the same enclosing transaction callback.
 */
function reviewedClaimParameterUsesSameTransaction(payment: AstCall, audit: AstCall, claimParameter: ts.ParameterDeclaration): boolean {
  const owner = enclosingFunction(audit.node)
  if (!owner || claimParameter.parent !== owner || !owner.parameters) return false
  const claimIndex = owner.parameters.indexOf(claimParameter)
  const resolution = resolvePaymentWrite(payment)
  const paymentTx = resolution && unwrapExpression(resolution.delegateRoot)
  if (claimIndex < 0 || !paymentTx || !ts.isIdentifier(paymentTx)) return false
  const paymentTxDeclaration = lexicalDeclaration(paymentTx, payment.sourceFile)
  if (!paymentTxDeclaration || !ts.isParameter(paymentTxDeclaration.parent) || paymentTxDeclaration.parent.parent !== owner) return false
  const txIndex = owner.parameters.indexOf(paymentTxDeclaration.parent)
  const ownerName = functionLocalName(owner)
  if (txIndex < 0 || !ownerName) return false

  const callsites = parseCalls(audit.file, audit.sourceFile.text).filter(call => {
    const callee = unwrapExpression(call.node.expression)
    return ts.isIdentifier(callee) && callee.text === ownerName && call.node !== audit.node
  })
  if (callsites.length === 0) return false
  return callsites.every(callsite => {
    const txArgument = callsite.node.arguments[txIndex]
    const claimArgument = callsite.node.arguments[claimIndex]
    if (!txArgument || !claimArgument) return false
    const tx = unwrapExpression(txArgument)
    const claim = unwrapExpression(claimArgument)
    if (!ts.isIdentifier(tx) || !ts.isIdentifier(claim)) return false
    const txDeclaration = lexicalDeclaration(tx, callsite.sourceFile)
    const claimDeclaration = lexicalDeclaration(claim, callsite.sourceFile)
    const callOwner = enclosingFunction(callsite.node)
    return Boolean(
      callOwner &&
        txDeclaration &&
        ts.isParameter(txDeclaration.parent) &&
        txDeclaration.parent.parent === callOwner &&
        claimDeclaration &&
        ts.isVariableDeclaration(claimDeclaration.parent) &&
        enclosingFunction(claimDeclaration.parent) === callOwner,
    )
  })
}

function auditorBindingsMatch(payment: AstCall, audit: AstCall): boolean {
  const resolution = resolvePaymentWrite(payment)
  if (
    !resolution ||
    !sameEnclosingFunction(payment, audit) ||
    !sameLexicalIdentifier(resolution.delegateRoot, payment, audit.node.arguments[0], audit)
  ) {
    return false
  }
  const input = argumentObject(audit, 1)
  if (!input) return false
  const paymentId = objectPropertyExpression(input, 'paymentId')
  const claim = objectPropertyExpression(input, 'claim')
  const gate = objectPropertyExpression(input, 'reconciliationEnabled')
  if (!paymentId || !claim || !gate) return false
  if (paymentId.getText(audit.sourceFile) !== expectedPaymentIdExpression(payment)) return false
  if (!ts.isIdentifier(claim) || claim.text !== 'shiftClaim') return false
  if (!ts.isIdentifier(gate) || gate.text !== 'reconciliationEnabled') return false
  const claimProvenance = bindingProvenance(
    audit,
    claim,
    new Set(['claimShiftForCapturedPayment', 'claimShiftForCompletedPayment', 'claimShiftForRefund']),
  )
  if (!claimProvenance) return false
  if (claimProvenance.kind === 'canonical-call') {
    if (
      !sameLexicalIdentifier(
        resolution.delegateRoot,
        payment,
        claimProvenance.origin.call.node.arguments[0],
        claimProvenance.origin.call,
      ) ||
      !completedWrapperMatchesPersistedStatus(payment, claimProvenance.origin)
    ) {
      return false
    }
  } else if (!reviewedClaimParameterUsesSameTransaction(payment, audit, claimProvenance.declaration)) {
    return false
  }
  const gateProvenance = bindingProvenance(audit, gate, new Set(['resolvePaymentShiftReconciliationEnabled']))
  return gateProvenance?.kind === 'canonical-call'
}

function safeAuditorFor(payment: AstCall, auditors: AstCall[]): AstCall | undefined {
  const reachable = reachableAuditorFor(payment, auditors)
  return reachable && auditorBindingsMatch(payment, reachable) ? reachable : undefined
}

function callsInside(node: ts.Node, calls: AstCall[]): AstCall[] {
  return calls.filter(call => call.position >= node.getStart(call.sourceFile) && call.position < node.getEnd())
}

function topLevelStatementInFunction(call: AstCall): ts.Statement | undefined {
  const fn = enclosingFunction(call.node)
  if (!fn?.body || !ts.isBlock(fn.body)) return undefined
  return containingStatement(call.node, fn.body)
}

function bulkOrderSetPrecedesShift(calls: AstCall[], functionName: string): boolean {
  const orderLock = callsForFunction(calls, functionName, 'lockExistingOrderForPayment')[0]
  const shiftLock = callsForFunction(calls, functionName, 'claimShiftForCapturedPayment')[0]
  if (!orderLock || !shiftLock) return false
  const orderLoop = topLevelStatementInFunction(orderLock)
  const shiftLoop = topLevelStatementInFunction(shiftLock)
  if (!orderLoop || !shiftLoop || orderLoop === shiftLoop || !ts.isForOfStatement(orderLoop) || !ts.isForOfStatement(shiftLoop))
    return false
  if (orderLoop.expression.getText(orderLock.sourceFile) !== 'targetOrderIds') return false
  if (shiftLoop.expression.getText(shiftLock.sourceFile) !== 'targetOrderIds') return false
  if (callsInside(orderLoop, calls).some(call => call.expression === 'claimShiftForCapturedPayment')) return false
  return orderLoop.getStart(orderLock.sourceFile) < shiftLoop.getStart(shiftLock.sourceFile)
}

function posNaturalKeyClassificationIsSafe(calls: AstCall[], functionName: string): boolean {
  const naturalLock = callsForFunction(calls, functionName, 'lockPosOrderNaturalKey')[0]
  const lookup = callsForFunction(calls, functionName, 'findExistingOrderWithSmartResolution')[0]
  const orderLock = callsForFunction(calls, functionName, 'lockExistingOrderForPayment')[0]
  const shiftLock = callsForFunction(calls, functionName, 'tx.shift.updateMany')[0]
  if (
    !naturalLock ||
    !lookup ||
    !orderLock ||
    !shiftLock ||
    !sameEnclosingFunction(naturalLock, lookup, orderLock, shiftLock) ||
    !sameBlockOrdered(naturalLock, lookup)
  ) {
    return false
  }
  const transactionBinding = naturalLock.node.arguments[0]
  const shiftDelegate = receiverOf(shiftLock.node.expression)
  const shiftBinding = shiftDelegate && receiverOf(shiftDelegate)
  if (
    !transactionBinding ||
    !sameLexicalIdentifier(transactionBinding, naturalLock, lookup.node.arguments[0], lookup) ||
    !sameLexicalIdentifier(transactionBinding, naturalLock, orderLock.node.arguments[0], orderLock) ||
    !sameLexicalIdentifier(transactionBinding, naturalLock, shiftBinding, shiftLock)
  ) {
    return false
  }

  let guardedByExistingOrder = false
  for (let cursor = orderLock.node.parent; cursor; cursor = cursor.parent) {
    if (ts.isIfStatement(cursor)) {
      guardedByExistingOrder = cursor.expression.getText(orderLock.sourceFile) === 'existingOrder'
      break
    }
    if (ts.isFunctionLike(cursor)) break
  }
  if (!guardedByExistingOrder) return false
  const orderStatement = topLevelStatementInFunction(orderLock)
  const shiftStatement = topLevelStatementInFunction(shiftLock)
  return Boolean(
    orderStatement && shiftStatement && orderStatement.getStart(orderLock.sourceFile) < shiftStatement.getStart(shiftLock.sourceFile),
  )
}

function guardedExistingOrderPathPrecedes(calls: AstCall[], functionName: string, guardText: string, nextExpression: string): boolean {
  const orderLock = callsForFunction(calls, functionName, 'lockExistingOrderForPayment')[0]
  const nextLock = callsForFunction(calls, functionName, nextExpression)[0]
  if (!orderLock || !nextLock) return false
  let guardMatches = false
  for (let cursor = orderLock.node.parent; cursor; cursor = cursor.parent) {
    if (ts.isIfStatement(cursor)) {
      guardMatches = cursor.expression.getText(orderLock.sourceFile) === guardText
      break
    }
    if (ts.isFunctionLike(cursor)) break
  }
  const orderStatement = topLevelStatementInFunction(orderLock)
  const nextStatement = topLevelStatementInFunction(nextLock)
  return Boolean(
    guardMatches &&
      orderStatement &&
      nextStatement &&
      orderStatement !== nextStatement &&
      orderStatement.getStart(orderLock.sourceFile) < nextStatement.getStart(nextLock.sourceFile),
  )
}

function callsForFunction(calls: AstCall[], functionName: string, expression: string): AstCall[] {
  return calls.filter(call => call.functionName === functionName && call.expression === expression)
}

describe('paymentShiftClaim — inventario AST de carriles de caja', () => {
  const allSourceFiles = (() => {
    const files: string[] = []
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(absolute)
        else if (entry.name.endsWith('.ts')) files.push(path.relative(process.cwd(), absolute))
      }
    }
    walk(path.join(process.cwd(), 'src'))
    return files
  })()

  it('cada Payment create/confirmation vivo aparece una vez en el manifest con decisión y razón', () => {
    const discovered = allSourceFiles.flatMap(file => discoverCandidates(parseCalls(file))).sort()
    expect(discovered).toEqual(Object.keys(INVENTORY).sort())
    for (const entry of Object.values(INVENTORY)) {
      expect(entry.lane).toBeTruthy()
      if (entry.decision === 'exclude') expect(entry.reason).toBeTruthy()
    }
  })

  it('cada INCLUDE enlaza cada write real con un auditor posterior en el mismo camino alcanzable', () => {
    for (const [candidate, entry] of Object.entries(INVENTORY)) {
      if (entry.decision !== 'include') continue
      const file = candidate.split('#')[0]
      const calls = parseCalls(file)
      const writes = candidateEntries(calls)
        .filter(item => item.key === candidate)
        .map(item => item.call)
      const auditors = callsForFunction(calls, entry.auditFunction, 'recordPendingPaymentShiftReconciliation')
      expect({
        candidate,
        writes: writes.length,
        everyWriteAudited: writes.every(write => Boolean(safeAuditorFor(write, auditors))),
      }).toEqual({
        candidate,
        writes: 1,
        everyWriteAudited: true,
      })
    }
  })

  it('comentarios o strings falsos no satisfacen el inventario ni el auditor', () => {
    const fixture = `
      // tx.payment.create({}); recordPendingPaymentShiftReconciliation(tx, fake)
      const text = 'tx.payment.create(); recordPendingPaymentShiftReconciliation(tx, fake)'
      function newCashWriter() { tx.payment.create({ data: { status: 'COMPLETED' } }) }
    `
    const calls = parseCalls('fixture.ts', fixture)
    expect(discoverCandidates(calls)).toEqual(['fixture.ts#newCashWriter#create'])
    expect(callsForFunction(calls, 'newCashWriter', 'recordPendingPaymentShiftReconciliation')).toHaveLength(0)
  })

  it('descubre aliases, propiedades computadas y variantes soportadas de escritura Payment', () => {
    const fixture = `
      function aliased() { const payments = tx.payment; payments.create({ data: row }) }
      function aliasNamedPayment() { const payment = tx.payment; payment.create({ data: row }) }
      function computed() { tx['payment']['create']({ data: row }) }
      function bulk() { tx.payment.createMany({ data: rows }) }
      function upserted() { tx.payment.upsert({ where: key, create: row, update: row }) }
      function destructured() { const { payment: payments } = tx; payments.create({ data: row }) }
      function assigned() { let payments; payments = tx.payment; payments.create({ data: row }) }
    `
    expect(discoverCandidates(parseCalls('fixture.ts', fixture))).toEqual([
      'fixture.ts#aliased#create',
      'fixture.ts#aliasNamedPayment#create',
      'fixture.ts#computed#create',
      'fixture.ts#bulk#createMany',
      'fixture.ts#upserted#upsert',
      'fixture.ts#destructured#create',
      'fixture.ts#assigned#create',
    ])
  })

  it('descubre aliases del método y datos/status indirectos; lo desconocido entra conservadoramente', () => {
    const fixture = `
      function destructuredMethod() { const { create } = tx.payment; create({ data: row }) }
      function aliasedMethod() { const write = tx.payment.create; write({ data: row }) }
      function assignedMethod() { let write; write = tx['payment']['create']; write({ data: row }) }
      function aliasedData() { const data = { status: 'COMPLETED' }; tx.payment.update({ where: { id }, data }) }
      function shorthandStatus() { const status = 'COMPLETED'; const data = { status }; tx.payment.update({ where: { id }, data }) }
      function assignedComputedData() { let data; data = { ['status']: 'COMPLETED' }; tx['payment']['update']({ ['where']: { id }, ['data']: data }) }
      function unknownData() { tx.payment.update({ where: { id }, data }) }
      function knownFailure() { tx.payment.update({ where: { id }, data: { status: 'FAILED' } }) }
    `
    expect(discoverCandidates(parseCalls('fixture.ts', fixture))).toEqual([
      'fixture.ts#destructuredMethod#create',
      'fixture.ts#aliasedMethod#create',
      'fixture.ts#assignedMethod#create',
      'fixture.ts#aliasedData#confirmation:update:1',
      'fixture.ts#shorthandStatus#confirmation:update:1',
      'fixture.ts#assignedComputedData#confirmation:update:1',
      'fixture.ts#unknownData#confirmation:update:1',
    ])
  })

  it('rechaza auditor muerto, condicional o separado del write por un retorno', () => {
    for (const fixture of [
      `function lane(){ tx.payment.create({ data: row }); return; recordPendingPaymentShiftReconciliation(tx, row) }`,
      `function lane(){ tx.payment.create({ data: row }); if (false) { recordPendingPaymentShiftReconciliation(tx, row) } }`,
      `function lane(){ if (enabled) tx.payment.create({ data: row }); recordPendingPaymentShiftReconciliation(tx, row) }`,
    ]) {
      const calls = parseCalls('fixture.ts', fixture)
      const payment = calls.find(call => paymentWriteMethod(call))!
      const auditors = callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation')
      expect(safeAuditorFor(payment, auditors)).toBeUndefined()
    }
  })

  it('rechaza auditor que no enlaza el mismo tx, Payment, claim capturado y gate resuelto', () => {
    const good = `
      import {
        claimShiftForCapturedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)
        const payment = await tx.payment.create({ data: row })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const mutations = [
      good.replace('recordPendingPaymentShiftReconciliation(tx,', 'recordPendingPaymentShiftReconciliation(otherTx,'),
      good.replace('paymentId: payment.id', 'paymentId: otherPayment.id'),
      good.replace('claim: shiftClaim', "claim: { shiftId: 'already-attributed' }"),
      good.replace('reconciliationEnabled,', 'reconciliationEnabled: false,'),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)',
        'const shiftClaim = false ? await claimShiftForCapturedPayment(tx, claimInput) : { shiftId: null }',
      ),
      good.replace(
        'const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)',
        'const reconciliationEnabled = false ? await resolvePaymentShiftReconciliationEnabled(prisma, venueId) : false',
      ),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)',
        'const shiftClaim = claimShiftForCapturedPayment(tx, claimInput)',
      ),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)',
        'const shiftClaim = await fake.claimShiftForCapturedPayment(tx, claimInput)',
      ),
      good.replace(
        'const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)',
        'const reconciliationEnabled = resolvePaymentShiftReconciliationEnabled(prisma, venueId)',
      ),
      good.replace(
        'const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)',
        'const reconciliationEnabled = await fake.resolvePaymentShiftReconciliationEnabled(prisma, venueId)',
      ),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)',
        'const shiftClaim = await claimShiftForCapturedPayment(otherTx, claimInput)',
      ),
    ]

    const goodCalls = parseCalls('fixture.ts', good)
    const goodPayment = goodCalls.find(call => paymentWriteMethod(call))!
    expect(safeAuditorFor(goodPayment, callsForFunction(goodCalls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeDefined()
    for (const fixture of mutations) {
      const calls = parseCalls('fixture.ts', fixture)
      const payment = calls.find(call => paymentWriteMethod(call))!
      expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
    }
  })

  it('no concede provenance al import si una function local hoisted con el mismo nombre lo sombrea', () => {
    const fixture = `
      import {
        claimShiftForCapturedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)
        const payment = await tx.payment.create({ data: row })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })

        function claimShiftForCapturedPayment() {
          return { shiftId: 'fabricated', pendingReason: null }
        }
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
  })

  it('liga paymentStatus del wrapper nullable al status que realmente persiste Payment, incluso con aliases/shorthand', () => {
    const fixture = `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const wrapperStatus = 'PENDING'
        const persistedStatus = 'COMPLETED'
        const data = { status: persistedStatus }
        const shiftClaim = await claimShiftForCompletedPayment(tx, {
          ...claimInput,
          paymentStatus: wrapperStatus,
        })
        const payment = await tx.payment.create({ data })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
  })

  it('rechaza dos lecturas textualmente iguales de status mutable separadas por una escritura', () => {
    const fixture = `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const shiftClaim = await claimShiftForCompletedPayment(tx, {
          ...claimInput,
          paymentStatus: paymentData.status,
        })
        paymentData.status = 'COMPLETED'
        const payment = await tx.payment.create({ data: { status: paymentData.status } })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
  })

  it('rechaza dos llamadas effectful aunque su texto de status sea idéntico', () => {
    const fixture = `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const shiftClaim = await claimShiftForCompletedPayment(tx, {
          ...claimInput,
          paymentStatus: nextStatus(),
        })
        const payment = await tx.payment.create({ data: { status: nextStatus() } })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
  })

  it('rechaza un binding de status escrito aunque esté declarado const en una fixture inválida', () => {
    const fixture = `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const statusSnapshot = 'PENDING'
        const shiftClaim = await claimShiftForCompletedPayment(tx, {
          ...claimInput,
          paymentStatus: statusSnapshot,
        })
        statusSnapshot = 'COMPLETED'
        const payment = await tx.payment.create({ data: { status: statusSnapshot } })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
  })

  it('no perdona un return de supuesto perdedor CAS si el resultado updateMany es let y fue reasignado', () => {
    const fixture = `
      import {
        claimShiftForCapturedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)
        let transition = await tx.payment.updateMany({
          where: { id: paymentId },
          data: { status: 'COMPLETED' },
        })
        transition = { count: 0 }
        if (transition.count === 0) return
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId,
          reconciliationEnabled,
        })
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
  })

  it('rechaza break/continue directos o condicionales entre Payment huérfano y su auditor', () => {
    const fixtureFor = (control: string) => `
      import {
        claimShiftForCapturedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const shiftClaim = await claimShiftForCapturedPayment(tx, claimInput)
        while (active) {
          const payment = await tx.payment.create({ data: row })
          ${control}
          await recordPendingPaymentShiftReconciliation(tx, {
            claim: shiftClaim,
            paymentId: payment.id,
            reconciliationEnabled,
          })
        }
      }
    `

    for (const control of ['break', 'continue', 'if (skip) break', 'if (skip) continue']) {
      const calls = parseCalls('fixture.ts', fixtureFor(control))
      const payment = calls.find(call => paymentWriteMethod(call))!
      expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()
    }
  })

  it('no concede provenance a parámetros fuera del allowlist estrecho y sus suites de comportamiento existen', () => {
    const fixture = `
      async function lane(tx: any, shiftClaim: any, reconciliationEnabled: boolean) {
        const payment = await tx.payment.create({ data: row })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!
    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeUndefined()

    expect(Object.keys(PARAMETER_PROVENANCE_ALLOWLIST)).toEqual([
      'src/services/pos-sync/posSyncOrder.service.ts#processPaymentsForOrder#shiftClaim',
    ])
    for (const behaviorSuite of Object.values(PARAMETER_PROVENANCE_ALLOWLIST)) {
      expect(fs.existsSync(path.join(process.cwd(), behaviorSuite))).toBe(true)
    }
  })

  it('cada captured claim decide totalOrders explícitamente', () => {
    const capturedCalls = INCLUDED_SOURCE_FILES.flatMap(file => parseCalls(file)).filter(
      call => call.expression === 'claimShiftForCapturedPayment' || call.expression === 'claimShiftForCompletedPayment',
    )
    // POS-sync no usa este helper: SoftRestaurant es autoridad de sus totales y
    // aquí sólo toma el lock OPEN con `updatedAt`. Sus Payment sí queda en el
    // manifest/auditor, pero no debe duplicar totalOrders localmente.
    expect(capturedCalls.length).toBe(7)
    for (const call of capturedCalls) {
      expect({
        file: call.file,
        functionName: call.functionName,
        incrementTotalOrders: hasObjectProperty(call, 1, 'incrementTotalOrders'),
      }).toEqual({
        file: call.file,
        functionName: call.functionName,
        incrementTotalOrders: true,
      })
    }

    const missingDecision = parseCalls(
      'fixture.ts',
      'function lane(){ claimShiftForCapturedPayment(tx, { venueId, amountPesos, tipPesos }) }',
    )[0]
    expect(hasObjectProperty(missingDecision, 1, 'incrementTotalOrders')).toBe(false)
  })

  it('las rutas con Order existente bloquean Order antes de Payment/Shift', () => {
    const lanes = [
      ['src/services/mobile/order.mobile.service.ts', 'payCashOrder', 'claimShiftForCapturedPayment'],
      ['src/services/tpv/payment.tpv.service.ts', 'recordOrderPayment', 'claimShiftForCompletedPayment'],
      ['src/services/dashboard/order.dashboard.service.ts', 'settleOrder', 'claimShiftForCapturedPayment'],
    ] as const

    for (const [file, functionName, nextLock] of lanes) {
      const calls = parseCalls(file)
      const orderLock = callsForFunction(calls, functionName, 'lockExistingOrderForPayment')[0]
      const followingLock = callsForFunction(calls, functionName, nextLock)[0]
      expect({
        file,
        functionName,
        hasOrderLock: Boolean(orderLock),
        beforeNextLock: Boolean(orderLock && followingLock && unconditionalBeforePossiblyConditional(orderLock, followingLock)),
      }).toEqual({
        file,
        functionName,
        hasOrderLock: true,
        beforeNextLock: true,
      })
    }

    const manualCalls = parseCalls('src/services/dashboard/manualPayment.service.ts')
    expect(guardedExistingOrderPathPrecedes(manualCalls, 'createManualPayment', 'input.orderId', 'claimShiftForCapturedPayment')).toBe(true)
    const b4bitCalls = parseCalls('src/services/b4bit/b4bit.service.ts')
    expect(
      guardedExistingOrderPathPrecedes(b4bitCalls, 'completeAndAttributeB4BitPaymentInTx', 'payment.orderId', 'lockB4BitPaymentRow'),
    ).toBe(true)
    const dashboardRefundCalls = parseCalls('src/services/dashboard/refund.dashboard.service.ts')
    expect(guardedExistingOrderPathPrecedes(dashboardRefundCalls, 'issueRefund', 'originalOrder?.orderId', 'tx.$queryRaw')).toBe(true)
    const tpvRefundCalls = parseCalls('src/services/tpv/refund.tpv.service.ts')
    expect(
      guardedExistingOrderPathPrecedes(tpvRefundCalls, 'ejecutarTransaccionDelReembolso', 'originalPayment.orderId', 'tx.$queryRaw'),
    ).toBe(true)
  })

  it('settleCustomerBalance adquiere el conjunto estable completo de Orders antes de cualquier Shift', () => {
    const calls = parseCalls('src/services/dashboard/customer.dashboard.service.ts')
    expect(bulkOrderSetPrecedesShift(calls, 'settleCustomerBalance')).toBe(true)
  })

  it('POS serializa llave natural, clasifica en tx y sólo en la rama existing hace Order→Shift', () => {
    const calls = parseCalls('src/services/pos-sync/posSyncOrder.service.ts')
    expect(posNaturalKeyClassificationIsSafe(calls, 'processPosOrderEvent')).toBe(true)
  })

  it('fixtures mutantes no certifican lock condicional, bulk Order-after-Shift ni clasificación POS exterior', () => {
    const conditional = parseCalls(
      'fixture.ts',
      `function lane(){ if (maybe) { lockExistingOrderForPayment(tx, row) } claimShiftForCapturedPayment(tx, claim) }`,
    )
    const conditionalOrder = callsForFunction(conditional, 'lane', 'lockExistingOrderForPayment')[0]
    const conditionalShift = callsForFunction(conditional, 'lane', 'claimShiftForCapturedPayment')[0]
    expect(sameBlockOrdered(conditionalOrder, conditionalShift)).toBe(false)

    const brokenBulk = parseCalls(
      'fixture.ts',
      `function settleCustomerBalance(){
        for (const orderId of targetOrderIds) { claimShiftForCapturedPayment(tx, claim); lockExistingOrderForPayment(tx, row) }
      }`,
    )
    expect(bulkOrderSetPrecedesShift(brokenBulk, 'settleCustomerBalance')).toBe(false)

    const brokenPos = parseCalls(
      'fixture.ts',
      `function processPosOrderEvent(){
        const existingOrder = findExistingOrderWithSmartResolution(prisma, externalId, venueId, folio)
        transaction(async tx => { if (existingOrder) lockExistingOrderForPayment(tx, row); tx.shift.updateMany(update) })
      }`,
    )
    expect(posNaturalKeyClassificationIsSafe(brokenPos, 'processPosOrderEvent')).toBe(false)

    const wrongPosBinding = parseCalls(
      'fixture.ts',
      `function processPosOrderEvent(){
        transaction(async tx => {
          lockPosOrderNaturalKey(tx, key)
          const existingOrder = findExistingOrderWithSmartResolution(prisma, externalId, venueId, folio)
          if (existingOrder) lockExistingOrderForPayment(tx, row)
          tx.shift.updateMany(update)
        })
      }`,
    )
    expect(posNaturalKeyClassificationIsSafe(wrongPosBinding, 'processPosOrderEvent')).toBe(false)

    const splitCallbacksWithSameSpelling = parseCalls(
      'fixture.ts',
      `function processPosOrderEvent(){
        transaction(async tx => {
          lockPosOrderNaturalKey(tx, key)
          const existingOrder = findExistingOrderWithSmartResolution(tx, externalId, venueId, folio)
        })
        transaction(async tx => {
          if (existingOrder) lockExistingOrderForPayment(tx, row)
          tx.shift.updateMany(update)
        })
      }`,
    )
    expect(posNaturalKeyClassificationIsSafe(splitCallbacksWithSameSpelling, 'processPosOrderEvent')).toBe(false)
  })

  it('mobile/TPV preservan session → tickets → Order → Shift para vales por área', () => {
    for (const [file, functionName] of [
      ['src/services/mobile/order.mobile.service.ts', 'payCashOrder'],
      ['src/services/tpv/payment.tpv.service.ts', 'recordOrderPayment'],
    ] as const) {
      const calls = parseCalls(file)
      const areaLock = callsForFunction(calls, functionName, 'areaTicketPayment.lockAreaTicketCheckoutForPayment')[0]
      const orderLock = callsForFunction(calls, functionName, 'lockExistingOrderForPayment')[0]
      const shiftLock = callsForFunction(
        calls,
        functionName,
        file.includes('/tpv/') ? 'claimShiftForCompletedPayment' : 'claimShiftForCapturedPayment',
      )[0]
      expect({
        file,
        areaBeforeOrder: Boolean(areaLock && orderLock && areaLock.position < orderLock.position),
        orderBeforeShift: Boolean(orderLock && shiftLock && orderLock.position < shiftLock.position),
      }).toEqual({ file, areaBeforeOrder: true, orderBeforeShift: true })
    }
  })
})
