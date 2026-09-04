import fs from 'fs'
import path from 'path'
import ts from 'typescript'

type InventoryDecision =
  | { decision: 'include'; lane: string; auditFunction: string; transactionPath: readonly string[] }
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
    transactionPath: ['completeAndAttributeB4BitPaymentInTx'],
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
    transactionPath: [],
  },
  'src/services/dashboard/manualPayment.service.ts#createManualPayment#create': {
    decision: 'include',
    lane: 'manualPayment',
    auditFunction: 'createManualPayment',
    transactionPath: [],
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
    transactionPath: [],
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
    transactionPath: [],
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
    transactionPath: [],
  },
  'src/services/mobile/refund.mobile.service.ts#createRefund#create': {
    decision: 'include',
    lane: 'createRefund',
    auditFunction: 'createRefund',
    transactionPath: [],
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
    transactionPath: ['processPaymentsForOrder'],
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
    transactionPath: [],
  },
  'src/services/tpv/payment.tpv.service.ts#recordFastPayment#create': {
    decision: 'include',
    lane: 'recordFastPayment',
    auditFunction: 'recordFastPayment',
    transactionPath: [],
  },
  'src/services/tpv/refund.tpv.service.ts#ejecutarTransaccionDelReembolso#create': {
    decision: 'include',
    lane: 'recordRefund',
    auditFunction: 'ejecutarTransaccionDelReembolso',
    transactionPath: [],
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
  checker: ts.TypeChecker
}

const SOURCE_CHECKERS = new WeakMap<ts.SourceFile, ts.TypeChecker>()
const SOURCE_CALLS = new WeakMap<ts.SourceFile, AstCall[]>()
const PARSED_CONTEXTS = new WeakMap<AstCall[], { file: string; sourceFile: ts.SourceFile; checker: ts.TypeChecker }>()

const PAYMENT_WRITE_METHODS = new Set(['create', 'createMany', 'upsert', 'update', 'updateMany'])

function staticPropertyName(expression: ts.Expression | ts.PropertyName): string | undefined {
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
    if (
      ts.isFunctionDeclaration(cursor) ||
      ts.isFunctionExpression(cursor) ||
      ts.isArrowFunction(cursor) ||
      ts.isMethodDeclaration(cursor) ||
      ts.isGetAccessorDeclaration(cursor) ||
      ts.isSetAccessorDeclaration(cursor) ||
      ts.isConstructorDeclaration(cursor)
    )
      return cursor
  }
  return undefined
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function identifierAliasesPayment(identifier: ts.Identifier, call: AstCall, seen = new Set<string>()): boolean {
  const declaration = lexicalDeclaration(identifier, call.sourceFile)
  const declarationKey = declaration ? `${declaration.getStart(call.sourceFile)}` : identifier.text
  if (!declaration || seen.has(declarationKey)) return false
  seen.add(declarationKey)
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return false
  let aliased = false
  const visit = (node: ts.Node) => {
    if (aliased || node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name === declaration && node.initializer) {
        aliased = isPaymentDelegate(node.initializer, call, seen)
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const element = node.name.elements.find(item => {
          const sourceName = item.propertyName ?? item.name
          const sourceText =
            ts.isIdentifier(sourceName) || ts.isStringLiteral(sourceName) || ts.isNoSubstitutionTemplateLiteral(sourceName)
              ? sourceName.text
              : undefined
          return sourceText === 'payment' && item.name === declaration
        })
        if (element) aliased = true
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      lexicalDeclaration(node.left, call.sourceFile) === declaration
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
  if (!ts.isIdentifier(resolved)) return undefined
  const declaration = lexicalDeclaration(resolved, call.sourceFile)
  const declarationKey = declaration ? `${declaration.getStart(call.sourceFile)}` : resolved.text
  if (!declaration || seen.has(declarationKey)) return undefined
  seen.add(declarationKey)
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return undefined
  let root: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name === declaration && node.initializer) {
        root = paymentDelegateRoot(node.initializer, call, seen)
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const element = node.name.elements.find(item => {
          const sourceName = item.propertyName ?? item.name
          return staticPropertyName(sourceName as ts.Expression) === 'payment' && item.name === declaration
        })
        if (element) root = node.initializer
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      lexicalDeclaration(node.left, call.sourceFile) === declaration
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
  directReceiver: boolean
}

function aliasedPaymentWrite(identifier: ts.Identifier, call: AstCall, seen = new Set<string>()): PaymentWriteResolution | undefined {
  const declaration = lexicalDeclaration(identifier, call.sourceFile)
  const declarationKey = declaration ? `${declaration.getStart(call.sourceFile)}` : identifier.text
  if (!declaration || seen.has(declarationKey)) return undefined
  seen.add(declarationKey)
  const owner = enclosingFunction(call.node)
  if (!owner?.body) return undefined
  let resolution: PaymentWriteResolution | undefined
  const resolveSource = (source: ts.Expression): PaymentWriteResolution | undefined => {
    const expression = unwrapExpression(source)
    const method = staticPropertyName(expression)
    const receiver = receiverOf(expression)
    if (method && receiver && PAYMENT_WRITE_METHODS.has(method)) {
      const delegateRoot = paymentDelegateRoot(receiver, call)
      return delegateRoot ? { method, delegateRoot, directReceiver: false } : undefined
    }
    return ts.isIdentifier(expression) ? aliasedPaymentWrite(expression, call, seen) : undefined
  }
  const visit = (node: ts.Node) => {
    if (node.getStart(call.sourceFile) >= call.position) return
    if (ts.isFunctionLike(node) && node !== owner) return
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.name === declaration && node.initializer) {
        resolution = resolveSource(node.initializer)
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const delegateRoot = paymentDelegateRoot(node.initializer, call)
        if (delegateRoot) {
          const element = node.name.elements.find(item => item.name === declaration)
          if (element) {
            const sourceName = element.propertyName ?? element.name
            const method = staticPropertyName(sourceName as ts.Expression)
            if (method && PAYMENT_WRITE_METHODS.has(method)) resolution = { method, delegateRoot, directReceiver: false }
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      lexicalDeclaration(node.left, call.sourceFile) === declaration
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
    const directRoot = directPaymentDelegateRoot(receiver)
    if (directRoot) return { method, delegateRoot: directRoot, directReceiver: true }
    const delegateRoot = paymentDelegateRoot(receiver, call)
    return delegateRoot ? { method, delegateRoot, directReceiver: false } : undefined
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
  // `createSourceFile` alone does not bind identifiers. A tiny one-file Program
  // gives the guard TypeScript's own symbol/scope model without resolving the
  // repository dependency graph. The closed grammar needs declaration identity,
  // not text matching, to distinguish aliases from shadowed names.
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const options: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  }
  const host: ts.CompilerHost = {
    fileExists: candidate => candidate === file,
    getCanonicalFileName: candidate => candidate,
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: () => 'lib.d.ts',
    getNewLine: () => '\n',
    getSourceFile: candidate => (candidate === file ? sourceFile : undefined),
    readFile: candidate => (candidate === file ? source : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  }
  const program = ts.createProgram([file], options, host)
  const checker = program.getTypeChecker()
  SOURCE_CHECKERS.set(sourceFile, checker)
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
        checker,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  SOURCE_CALLS.set(sourceFile, calls)
  PARSED_CONTEXTS.set(calls, { file, sourceFile, checker })
  return calls
}

function objectPropertyExpression(object: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | undefined {
  const property = object.properties.find(item => 'name' in item && item.name && staticPropertyName(item.name) === propertyName)
  if (property && ts.isPropertyAssignment(property)) return property.initializer
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name
  return undefined
}

function closedPropertyName(name: ts.PropertyName): string | undefined {
  // Computed names are outside the grammar even when their current expression
  // happens to be a string literal. This keeps future edits from turning a
  // currently-known key into an override without changing the AST shape.
  if (ts.isComputedPropertyName(name)) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return undefined
}

/**
 * Closed object grammar for release-gating Payment writes:
 *
 * - the object is inline (except the one deliberately supported final `data`
 *   const handled below);
 * - every direct member is a static property or shorthand assignment;
 * - spreads, computed names, methods/accessors and duplicate names are invalid.
 *
 * Property initializers may contain ordinary application expressions. Only
 * direct members can replace `data`, `status`, `paymentStatus`, auditor claim,
 * payment id or gate, so nested payload objects do not need interpretation.
 */
function closedInlineObject(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  if (!expression) return undefined
  const candidate = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(candidate)) return undefined
  const names = new Set<string>()
  for (const property of candidate.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined
    const name = closedPropertyName(property.name)
    if (name === undefined || names.has(name)) return undefined
    names.add(name)
  }
  return candidate
}

function argumentObject(call: AstCall, argumentIndex: number): ts.ObjectLiteralExpression | undefined {
  return closedInlineObject(call.node.arguments[argumentIndex])
}

function hasObjectProperty(call: AstCall, argumentIndex: number, propertyName: string): boolean {
  const argument = call.node.arguments[argumentIndex]
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false
  return argument.properties.some(item => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === propertyName)
}

type CompletionStatus = 'COMPLETED' | 'NON_COMPLETED' | 'UNKNOWN'

function immutableStatusLiteralValue(expression: ts.Expression, context: AstCall, seen = new Set<ts.Identifier>()): string | undefined {
  const resolved = unwrapExpression(expression)
  if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) return resolved.text
  if (!ts.isIdentifier(resolved)) return undefined
  const declaration = lexicalDeclaration(resolved, context.sourceFile)
  if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration.parent)) return undefined
  const variable = declaration.parent
  if (!isConstVariableDeclaration(variable) || !variable.initializer || bindingHasWrites(declaration, context.sourceFile)) return undefined
  seen.add(declaration)
  return immutableStatusLiteralValue(variable.initializer, context, seen)
}

function paymentCompletionStatus(call: AstCall): CompletionStatus {
  const resolution = resolvePaymentWrite(call)
  if (!resolution?.directReceiver) return 'UNKNOWN'
  const argument = argumentObject(call, 0)
  if (!argument) return 'UNKNOWN'
  const dataExpression = objectPropertyExpression(argument, 'data')
  if (!dataExpression) return 'UNKNOWN'
  const data = stableObjectLiteral(dataExpression, call)
  if (!data) return 'UNKNOWN'
  const statusExpression = objectPropertyExpression(data, 'status')
  if (!statusExpression) return 'NON_COMPLETED'
  if (!immutableStatusIdentity(statusExpression, call)) return 'UNKNOWN'
  const literal = immutableStatusLiteralValue(statusExpression, call)
  if (literal === 'COMPLETED') return 'COMPLETED'
  if (literal && ['FAILED', 'PENDING', 'PROCESSING', 'REFUNDED', 'CANCELLED'].includes(literal)) return 'NON_COMPLETED'
  return 'UNKNOWN'
}

interface UnresolvedPaymentReference {
  file: string
  functionName: string
  position: number
  reason: string
}

function expressionMayYieldPaymentDelegate(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  const resolved = unwrapExpression(expression)
  if (directPaymentDelegateRoot(resolved)) return true
  if (ts.isConditionalExpression(resolved)) {
    return (
      expressionMayYieldPaymentDelegate(resolved.whenTrue, sourceFile, seenSymbols) ||
      expressionMayYieldPaymentDelegate(resolved.whenFalse, sourceFile, seenSymbols)
    )
  }
  if (ts.isBinaryExpression(resolved)) {
    return (
      expressionMayYieldPaymentDelegate(resolved.left, sourceFile, seenSymbols) ||
      expressionMayYieldPaymentDelegate(resolved.right, sourceFile, seenSymbols)
    )
  }
  if (!ts.isIdentifier(resolved)) return false
  const symbol = identifierSymbol(resolved, sourceFile)
  if (!symbol || seenSymbols.has(symbol)) return false
  const nextSeen = new Set(seenSymbols).add(symbol)
  let originatedAtPayment = false
  const visit = (node: ts.Node) => {
    if (originatedAtPayment) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && identifierSymbol(node.name, sourceFile) === symbol) {
      if (node.initializer) {
        originatedAtPayment = expressionMayYieldPaymentDelegate(node.initializer, sourceFile, nextSeen)
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      identifierSymbol(node.name, sourceFile) === symbol &&
      node.propertyName &&
      staticPropertyName(node.propertyName as ts.Expression) === 'payment'
    ) {
      originatedAtPayment = true
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapExpression(node.left)) &&
      identifierSymbol(unwrapExpression(node.left) as ts.Identifier, sourceFile) === symbol
    ) {
      originatedAtPayment = expressionMayYieldPaymentDelegate(node.right, sourceFile, nextSeen)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return originatedAtPayment
}

function exactDirectPaymentInvocation(member: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const receiver = receiverOf(member)
  if (!receiver || !directPaymentDelegateRoot(receiver)) return false
  if (member.questionDotToken) return false
  const delegate = unwrapExpression(receiver)
  if ((ts.isPropertyAccessExpression(delegate) || ts.isElementAccessExpression(delegate)) && delegate.questionDotToken) {
    return false
  }
  return ts.isCallExpression(member.parent) && member.parent.expression === member && !member.parent.questionDotToken
}

function paymentReferenceIssues(calls: AstCall[]): UnresolvedPaymentReference[] {
  const context = PARSED_CONTEXTS.get(calls)
  if (!context) return []
  const { file, sourceFile } = context
  const issues: UnresolvedPaymentReference[] = []
  const addIssue = (node: ts.Node, reason: string) => {
    issues.push({
      file,
      functionName: enclosingFunctionName(node),
      position: node.getStart(sourceFile),
      reason,
    })
  }
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = node
      const receiver = receiverOf(member)
      const method = staticPropertyName(member)
      if (receiver && method && PAYMENT_WRITE_METHODS.has(method) && expressionMayYieldPaymentDelegate(receiver, sourceFile)) {
        if (!exactDirectPaymentInvocation(member)) addIssue(member, `indirect-${method}`)
      } else if (
        receiver &&
        ts.isElementAccessExpression(member) &&
        method === undefined &&
        expressionMayYieldPaymentDelegate(receiver, sourceFile)
      ) {
        addIssue(member, 'computed-method')
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const delegateRoot = directPaymentDelegateRoot(node)
      const parent = node.parent
      const consumedAsMember = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node
      const proofContext = calls.find(call => enclosingFunction(call.node) === enclosingFunction(node)) ?? calls[0]
      if (delegateRoot && !consumedAsMember && proofContext && paymentDelegateRootIsProven(delegateRoot, proofContext)) {
        addIssue(node, 'delegate-escape')
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const bindsSupportedWrite = (pattern: ts.ObjectBindingPattern): boolean =>
        pattern.elements.some(element => {
          const sourceName = element.propertyName ?? element.name
          const name = staticPropertyName(sourceName as ts.Expression)
          return Boolean(
            (name && PAYMENT_WRITE_METHODS.has(name)) || (ts.isObjectBindingPattern(element.name) && bindsSupportedWrite(element.name)),
          )
        })
      if (
        (expressionMayYieldPaymentDelegate(node.initializer, sourceFile) && bindsSupportedWrite(node.name)) ||
        node.name.elements.some(element => {
          const sourceName = element.propertyName ?? element.name
          return (
            staticPropertyName(sourceName as ts.Expression) === 'payment' &&
            ts.isObjectBindingPattern(element.name) &&
            bindsSupportedWrite(element.name)
          )
        })
      ) {
        addIssue(node.name, 'destructured-write')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return issues.sort((left, right) => left.position - right.position)
}

function candidateEntries(calls: AstCall[]): Array<{ call: AstCall; key: string }> {
  const ordinals = new Map<string, number>()
  return calls.flatMap(call => {
    const callee = call.node.expression
    if ((!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) || !exactDirectPaymentInvocation(callee)) {
      return []
    }
    if (!resolvePaymentWrite(call)?.directReceiver) return []
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
  const candidates = candidateEntries(calls).map(entry => entry.key)
  const ordinals = new Map<string, number>()
  const unresolved = paymentReferenceIssues(calls).map(issue => {
    const base = `${issue.file}#${issue.functionName}#unknownPaymentWrite:${issue.reason}`
    const ordinal = (ordinals.get(base) ?? 0) + 1
    ordinals.set(base, ordinal)
    return `${base}:${ordinal}`
  })
  return [...candidates, ...unresolved]
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

function containsConditionalControlOutsideNestedFunction(node: ts.Node): boolean {
  let conditional = false
  const visit = (current: ts.Node) => {
    if (conditional) return
    if (current !== node && ts.isFunctionLike(current)) return
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      (ts.isBinaryExpression(current) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
          current.operatorToken.kind,
        ))
    ) {
      conditional = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return conditional
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

function canonicalAuditorStatement(audit: AstCall): ts.ExpressionStatement | undefined {
  const callee = unwrapExpression(audit.node.expression)
  if (!ts.isIdentifier(callee) || !canonicalNamedImport(callee, audit, new Set(['recordPendingPaymentShiftReconciliation']))) {
    return undefined
  }
  const awaited = audit.node.parent
  if (!ts.isAwaitExpression(awaited) || awaited.expression !== audit.node) return undefined
  return ts.isExpressionStatement(awaited.parent) && awaited.parent.expression === awaited ? awaited.parent : undefined
}

function exactClaimBranch(branch: ts.IfStatement, audit: AstCall): { block: ts.Block; kind: 'pending' | 'no-shift' } | undefined {
  const auditInput = argumentObject(audit, 1)
  const auditClaim = auditInput && objectPropertyExpression(auditInput, 'claim')
  if (!auditClaim || !ts.isIdentifier(auditClaim)) return undefined
  const isAuditClaim = (expression: ts.Expression) => {
    const resolved = unwrapExpression(expression)
    return ts.isIdentifier(resolved) && sameSymbol(auditClaim, resolved, audit.sourceFile)
  }
  const condition = unwrapExpression(branch.expression)
  const inBlock = (statement: ts.Statement | undefined) =>
    statement && ts.isBlock(statement) && audit.position >= statement.getStart(audit.sourceFile) && audit.position < statement.getEnd()
      ? statement
      : undefined
  const thenBlock = inBlock(branch.thenStatement)
  if (thenBlock) {
    if (isAuditClaim(condition)) return { block: thenBlock, kind: 'pending' }
    if (
      (ts.isPropertyAccessExpression(condition) || ts.isElementAccessExpression(condition)) &&
      staticPropertyName(condition) === 'pendingReason' &&
      receiverOf(condition) &&
      isAuditClaim(receiverOf(condition)!)
    ) {
      return { block: thenBlock, kind: 'pending' }
    }
  }
  const elseBlock = inBlock(branch.elseStatement)
  if (
    elseBlock &&
    (ts.isPropertyAccessExpression(condition) || ts.isElementAccessExpression(condition)) &&
    staticPropertyName(condition) === 'shiftId' &&
    receiverOf(condition) &&
    isAuditClaim(receiverOf(condition)!)
  ) {
    return { block: elseBlock, kind: 'no-shift' }
  }
  return undefined
}

function reachableAuditorFor(payment: AstCall, auditors: AstCall[]): AstCall | undefined {
  return auditors.find(audit => {
    const auditStatement = canonicalAuditorStatement(audit)
    if (!auditStatement) return false
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
    const approvedBranch = exactClaimBranch(noShiftIf, audit)
    if (!approvedBranch || auditStatement.parent !== approvedBranch.block) return false
    const auditIndexInBranch = approvedBranch.block.statements.indexOf(auditStatement)
    if (auditIndexInBranch < 0) return false
    if (
      approvedBranch.block.statements
        .slice(0, auditIndexInBranch)
        .some(statement => containsAbruptFlowOutsideNestedFunction(statement) || containsConditionalControlOutsideNestedFunction(statement))
    ) {
      return false
    }
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

function ancestorVariableDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isVariableDeclaration(cursor)) return cursor
    if (ts.isStatement(cursor)) return undefined
  }
  return undefined
}

function auditorPaymentIdMatches(payment: AstCall, audit: AstCall, paymentId: ts.Expression): boolean {
  const method = paymentWriteMethod(payment)
  if (method === 'create' || method === 'upsert') {
    const result = ancestorVariableDeclaration(payment.node)
    if (
      !result ||
      !ts.isIdentifier(result.name) ||
      !isConstVariableDeclaration(result) ||
      bindingHasWrites(result.name, payment.sourceFile)
    ) {
      return false
    }
    const initializer = result.initializer && unwrapExpression(result.initializer)
    const exactCall = initializer && ts.isAwaitExpression(initializer) ? unwrapExpression(initializer.expression) : initializer
    const id = unwrapExpression(paymentId)
    if (
      exactCall !== payment.node ||
      (!ts.isPropertyAccessExpression(id) && !ts.isElementAccessExpression(id)) ||
      staticPropertyName(id) !== 'id'
    ) {
      return false
    }
    const receiver = receiverOf(id)
    return Boolean(
      receiver &&
        ts.isIdentifier(unwrapExpression(receiver)) &&
        sameLexicalIdentifier(result.name, payment, receiver, audit) &&
        paymentResultStableUntilAudit(payment, audit),
    )
  }
  if (method === 'update' || method === 'updateMany') {
    const argument = argumentObject(payment, 0)
    const whereExpression = argument && objectPropertyExpression(argument, 'where')
    const where = closedInlineObject(whereExpression)
    const idExpression = where && objectPropertyExpression(where, 'id')
    if (!idExpression) return false
    const whereIdentity = immutableStatusIdentity(idExpression, payment)
    const auditIdentity = immutableStatusIdentity(paymentId, audit)
    return Boolean(whereIdentity && auditIdentity && sameStatusIdentity(whereIdentity, auditIdentity))
  }
  return false
}

function identifierSymbol(identifier: ts.Identifier, sourceFile: ts.SourceFile): ts.Symbol | undefined {
  const checker = SOURCE_CHECKERS.get(sourceFile)
  if (!checker) return undefined
  if (ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier) {
    return checker.getShorthandAssignmentValueSymbol(identifier.parent) ?? undefined
  }
  return checker.getSymbolAtLocation(identifier)
}

/**
 * Resolve the declaration that owns an identifier using TypeScript's binder.
 * Imports deliberately return undefined: callers use that distinction to
 * prove the canonical named import was not shadowed by a local declaration.
 */
function lexicalDeclaration(identifier: ts.Identifier, sourceFile: ts.SourceFile): ts.Identifier | undefined {
  const symbol = identifierSymbol(identifier, sourceFile)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (!declaration || ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
    return undefined
  }
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isBindingElement(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration)) &&
    declaration.name &&
    ts.isIdentifier(declaration.name)
  ) {
    return declaration.name
  }
  return undefined
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

function sameSymbol(left: ts.Identifier, right: ts.Identifier, sourceFile: ts.SourceFile): boolean {
  const leftSymbol = identifierSymbol(left, sourceFile)
  const rightSymbol = identifierSymbol(right, sourceFile)
  return Boolean(leftSymbol && rightSymbol && leftSymbol === rightSymbol)
}

/**
 * The only non-inline `data` form admitted by the grammar is a direct, local,
 * final `const data = { ... }` consumed by the write. Any additional reference
 * before that use is an alias, escape, capture, mutation, or otherwise a shape
 * that needs JavaScript effect interpretation; all of those fail closed.
 */
function constObjectIsFinalSingleUse(declaration: ts.Identifier, use: ts.Identifier, context: AstCall): boolean {
  if (!sameSymbol(declaration, use, context.sourceFile)) return false
  const usePosition = use.getStart(context.sourceFile)
  let safe = true
  const visit = (node: ts.Node) => {
    if (!safe || node.getStart(context.sourceFile) >= usePosition) return
    if (ts.isIdentifier(node) && node !== declaration && node !== use && sameSymbol(declaration, node, context.sourceFile)) {
      safe = false
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(context.sourceFile)
  return safe
}

function stableObjectLiteral(expression: ts.Expression, context: AstCall): ts.ObjectLiteralExpression | undefined {
  const inline = closedInlineObject(expression)
  if (inline) return inline
  const use = unwrapExpression(expression)
  if (!ts.isIdentifier(use)) return undefined
  const declaration = lexicalDeclaration(use, context.sourceFile)
  if (!declaration || !ts.isVariableDeclaration(declaration.parent)) return undefined
  const variable = declaration.parent
  if (!isConstVariableDeclaration(variable) || !variable.initializer) return undefined
  if (enclosingFunction(variable) !== enclosingFunction(context.node)) return undefined
  const object = closedInlineObject(variable.initializer)
  if (!object || bindingHasWrites(declaration, context.sourceFile)) return undefined
  return constObjectIsFinalSingleUse(declaration, use, context) ? object : undefined
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
const PRISMA_CLIENT_MODULE = 'src/utils/prismaClient'

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
    checker: context.checker,
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

function importsCanonicalPrismaClient(declaration: ts.ImportDeclaration, file: string): boolean {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return false
  const moduleName = declaration.moduleSpecifier.text
  if (moduleName === '@/utils/prismaClient') return true
  if (!moduleName.startsWith('.')) return false
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), moduleName)).replace(/\.ts$/, '')
  return resolved === PRISMA_CLIENT_MODULE
}

function isCanonicalPrismaDefaultImport(identifier: ts.Identifier, context: AstCall): boolean {
  const symbol = identifierSymbol(identifier, context.sourceFile)
  const declarations = symbol?.declarations ?? []
  if (declarations.length !== 1 || !ts.isImportClause(declarations[0])) return false
  const importClause = declarations[0]
  return Boolean(
    importClause.name &&
      !importClause.isTypeOnly &&
      ts.isImportDeclaration(importClause.parent) &&
      importsCanonicalPrismaClient(importClause.parent, context.file),
  )
}

function canonicalNamedImport(identifier: ts.Identifier, context: AstCall, expectedImportedNames: Set<string>): string | undefined {
  const symbol = identifierSymbol(identifier, context.sourceFile)
  const declarations = symbol?.declarations ?? []
  // A merged symbol means that a local declaration shares the import's name.
  // Even if TypeScript reports the import first, that ambiguity is outside the
  // release grammar and must not certify money.
  if (declarations.length !== 1 || !ts.isImportSpecifier(declarations[0])) return undefined
  const specifier = declarations[0]
  const importDeclaration = specifier.parent.parent.parent
  if (!ts.isImportDeclaration(importDeclaration) || !importsCanonicalPaymentShiftClaim(importDeclaration, context.file)) {
    return undefined
  }
  const importedName = (specifier.propertyName ?? specifier.name).text
  return !specifier.isTypeOnly && expectedImportedNames.has(importedName) ? importedName : undefined
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
  const importedName = canonicalNamedImport(callee, context, allowedImportedNames)
  return importedName ? { call: astCallFromNode(awaited, context), importedName } : undefined
}

// POS-sync is the one lane whose upstream POS owns totals and whose Shift claim
// is assembled without the shared claim helper. The mutable object never
// crosses the payment-helper boundary: four const primitive snapshots do. This
// reviewed semantic exception is still syntax-closed and backed by its stateful
// close-race suite; transaction provenance is proved independently below.
const INLINE_CLAIM_SNAPSHOT_ALLOWLIST: Record<string, string> = {
  'src/services/pos-sync/posSyncOrder.service.ts#processPaymentsForOrder#inlineClaimSnapshot':
    'tests/unit/services/pos-sync/posSyncOrder.shiftCloseRace.test.ts',
}

type BindingProvenance = { kind: 'canonical-call'; origin: CanonicalAwaitedCall }

function bindingProvenance(audit: AstCall, binding: ts.Identifier, origins: Set<string>): BindingProvenance | undefined {
  const declaration = lexicalDeclaration(binding, audit.sourceFile)
  if (!declaration) return undefined
  if (ts.isParameter(declaration.parent)) {
    if (!ts.isIdentifier(declaration.parent.name) || bindingHasWrites(declaration.parent.name, audit.sourceFile)) {
      return undefined
    }
    const tracedOrigin = canonicalOriginFromParameter(declaration.parent, audit, origins)
    return tracedOrigin ? { kind: 'canonical-call', origin: tracedOrigin } : undefined
  }
  if (!ts.isVariableDeclaration(declaration.parent) || !declaration.parent.initializer) return undefined
  if (!isConstVariableDeclaration(declaration.parent)) return undefined
  if (bindingHasWrites(declaration, audit.sourceFile)) return undefined
  const origin = canonicalAwaitedCall(declaration.parent.initializer, audit, origins)
  return origin ? { kind: 'canonical-call', origin } : undefined
}

type ImmutableStatusIdentity = { kind: 'literal'; value: string } | { kind: 'symbol'; symbol: ts.Symbol }

function primitiveType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(primitiveType)
  const primitiveFlags =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined
  return Boolean(type.flags & primitiveFlags)
}

function immutableStatusIdentity(expression: ts.Expression, context: AstCall): ImmutableStatusIdentity | undefined {
  const resolved = unwrapExpression(expression)
  if (ts.isIdentifier(resolved)) {
    const declaration = lexicalDeclaration(resolved, context.sourceFile)
    if (!declaration || !ts.isVariableDeclaration(declaration.parent) || !isConstVariableDeclaration(declaration.parent)) return undefined
    if (bindingHasWrites(declaration, context.sourceFile)) return undefined
    const symbol = identifierSymbol(resolved, context.sourceFile)
    const initializer = declaration.parent.initializer
    if (!symbol || !initializer || !primitiveType(context.checker.getTypeAtLocation(initializer))) return undefined
    return { kind: 'symbol', symbol }
  }
  if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) return { kind: 'literal', value: resolved.text }
  return undefined
}

function sameStatusIdentity(left: ImmutableStatusIdentity, right: ImmutableStatusIdentity): boolean {
  return left.kind === 'literal' && right.kind === 'literal'
    ? left.value === right.value
    : left.kind === 'symbol' && right.kind === 'symbol' && left.symbol === right.symbol
}

function paymentPersistedStatus(payment: AstCall): ts.Expression | undefined {
  const input = argumentObject(payment, 0)
  const dataExpression = input && objectPropertyExpression(input, 'data')
  const data = dataExpression && stableObjectLiteral(dataExpression, payment)
  return data ? objectPropertyExpression(data, 'status') : undefined
}

function paymentClosedGrammarViolation(payment: AstCall): string | undefined {
  const resolution = resolvePaymentWrite(payment)
  if (!resolution?.directReceiver) return 'Payment receiver must be a direct static transaction.payment write'
  const input = argumentObject(payment, 0)
  if (!input) return 'Prisma arguments must be one closed inline object with one static data property'
  const dataExpression = input && objectPropertyExpression(input, 'data')
  if (!dataExpression) return 'Prisma arguments must be one closed inline object with one static data property'
  const data = stableObjectLiteral(dataExpression, payment)
  if (!data) return 'Payment data must be inline or one final single-use const object without dynamic properties'
  const status = data && objectPropertyExpression(data, 'status')
  if (!status) return 'Payment data must contain one static status property'
  if (!immutableStatusIdentity(status, payment)) return 'Payment status must be a literal or one immutable primitive const symbol'
  return undefined
}

function paymentUsesClosedGrammar(payment: AstCall): boolean {
  return paymentClosedGrammarViolation(payment) === undefined
}

function closedGrammarDiagnostic(payment: AstCall, lane: string): string {
  const prefix = `${payment.file}#${payment.functionName}#${lane}`
  return `${prefix}: ${paymentClosedGrammarViolation(payment) ?? 'closed grammar accepted'}`
}

function completedWrapperMatchesPersistedStatus(payment: AstCall, origin: CanonicalAwaitedCall): boolean {
  if (origin.importedName !== 'claimShiftForCompletedPayment') return true
  const wrapperInput = argumentObject(origin.call, 1)
  const wrapperStatus = wrapperInput && objectPropertyExpression(wrapperInput, 'paymentStatus')
  const persistedStatus = paymentPersistedStatus(payment)
  if (!wrapperStatus || !persistedStatus) return false
  const wrapperIdentity = immutableStatusIdentity(wrapperStatus, origin.call)
  const persistedIdentity = immutableStatusIdentity(persistedStatus, payment)
  return Boolean(wrapperIdentity && persistedIdentity && sameStatusIdentity(wrapperIdentity, persistedIdentity))
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
  if (!ts.isFunctionDeclaration(owner)) return undefined
  const ownerName = functionLocalName(owner)
  const parameterIndex = owner.parameters.indexOf(parameter)
  if (!ownerName || parameterIndex < 0) return undefined
  const key = `${context.file}#${ownerName}#${parameterIndex}`
  if (seenParameters.has(key)) return undefined
  const nextSeen = new Set(seenParameters).add(key)
  const ownerDeclaration = ts.isFunctionDeclaration(owner) && owner.name ? owner.name : undefined
  const ownerSymbol = ownerDeclaration && identifierSymbol(ownerDeclaration, context.sourceFile)
  if (!ownerDeclaration || !ownerSymbol) return undefined
  const callsites = (SOURCE_CALLS.get(context.sourceFile) ?? []).filter(call => {
    const callee = call.node.expression
    return ts.isIdentifier(callee) && identifierSymbol(callee, context.sourceFile) === ownerSymbol
  })
  if (callsites.length === 0) return undefined
  const directCallees = new Set(callsites.map(callsite => callsite.node.expression as ts.Identifier))
  if (
    symbolReferences(ownerDeclaration, context.sourceFile).some(
      reference => reference !== ownerDeclaration && !directCallees.has(reference),
    )
  ) {
    return undefined
  }
  const traced = callsites.map(callsite => {
    const argument = callsite.node.arguments[parameterIndex]
    return argument ? canonicalOriginFromExpression(argument, callsite, origins, nextSeen) : undefined
  })
  return traced.every(Boolean) ? traced[0] : undefined
}

function symbolReferences(declaration: ts.Identifier, sourceFile: ts.SourceFile): ts.Identifier[] {
  const references: ts.Identifier[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && sameSymbol(declaration, node, sourceFile)) references.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

function propertyReadFromReference(reference: ts.Identifier): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  const parent = reference.parent
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    unwrapExpression(parent.expression) === reference
  ) {
    return parent
  }
  return undefined
}

function propertyAccessIsWritten(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const parent = access.parent
  return Boolean(
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isDeleteExpression(parent) && parent.expression === access),
  )
}

function exactAuditorClaimReference(reference: ts.Identifier, audit: AstCall): boolean {
  const property = reference.parent
  const input = argumentObject(audit, 1)
  return Boolean(
    input &&
      ts.isPropertyAssignment(property) &&
      property.parent === input &&
      property.initializer === reference &&
      closedPropertyName(property.name) === 'claim',
  )
}

function exactApprovedClaimConditionReference(reference: ts.Identifier, audit: AstCall): boolean {
  const branch = reference.parent
  if (!ts.isIfStatement(branch) || branch.expression !== reference) return false
  return Boolean(exactClaimBranch(branch, audit))
}

function objectBindingStableUntilAudit(
  declaration: ts.Identifier,
  audit: AstCall,
  allowedProperties: ReadonlySet<string>,
  allowAuditorClaimReference: boolean,
): boolean {
  const owner = enclosingFunction(declaration)
  if (!owner) return false
  const start = declaration.getEnd()
  const end = audit.node.getEnd()
  return symbolReferences(declaration, audit.sourceFile)
    .filter(reference => reference !== declaration)
    .filter(reference => {
      const position = reference.getStart(audit.sourceFile)
      return position >= start && position <= end
    })
    .every(reference => {
      if (enclosingFunction(reference) !== owner) return false
      if (allowAuditorClaimReference && exactAuditorClaimReference(reference, audit)) return true
      if (allowAuditorClaimReference && exactApprovedClaimConditionReference(reference, audit)) return true
      const property = propertyReadFromReference(reference)
      const name = property && staticPropertyName(property)
      return Boolean(property && name && allowedProperties.has(name) && !propertyAccessIsWritten(property))
    })
}

function claimBindingStableUntilAudit(claim: ts.Identifier, audit: AstCall): boolean {
  const declaration = lexicalDeclaration(claim, audit.sourceFile)
  return Boolean(
    declaration &&
      !ts.isParameter(declaration.parent) &&
      objectBindingStableUntilAudit(declaration, audit, new Set(['shiftId', 'pendingReason', 'candidateShiftId', 'observedStatus']), true),
  )
}

function paymentResultStableUntilAudit(payment: AstCall, audit: AstCall): boolean {
  const result = ancestorVariableDeclaration(payment.node)
  return Boolean(result && ts.isIdentifier(result.name) && objectBindingStableUntilAudit(result.name, audit, new Set(['id']), false))
}

function canonicalTransactionCallbackOwns(parameter: ts.ParameterDeclaration, context: AstCall): boolean {
  const callback = parameter.parent
  if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.parameters[0] !== parameter) return false
  const invocation = callback.parent
  if (!ts.isCallExpression(invocation) || invocation.arguments[0] !== callback || invocation.questionDotToken) return false
  const callee = invocation.expression
  if ((!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) || callee.questionDotToken) return false
  if (staticPropertyName(callee) !== '$transaction') return false
  const receiver = receiverOf(callee)
  const prismaIdentifier = receiver && unwrapExpression(receiver)
  return Boolean(prismaIdentifier && ts.isIdentifier(prismaIdentifier) && isCanonicalPrismaDefaultImport(prismaIdentifier, context))
}

function transactionPathFromParameter(
  parameter: ts.ParameterDeclaration,
  context: AstCall,
  seen = new Set<ts.Symbol>(),
): readonly string[] | undefined {
  if (!ts.isIdentifier(parameter.name) || bindingHasWrites(parameter.name, context.sourceFile)) return undefined
  if (canonicalTransactionCallbackOwns(parameter, context)) return []
  const owner = parameter.parent
  if (!ts.isFunctionDeclaration(owner) || !owner.name) return undefined
  const parameterIndex = owner.parameters.indexOf(parameter)
  const parameterSymbol = ts.isIdentifier(parameter.name) ? identifierSymbol(parameter.name, context.sourceFile) : undefined
  if (parameterIndex < 0 || !parameterSymbol || seen.has(parameterSymbol)) return undefined
  const helperSymbol = identifierSymbol(owner.name, context.sourceFile)
  if (!helperSymbol) return undefined
  const nextSeen = new Set(seen).add(parameterSymbol)
  const allCalls = SOURCE_CALLS.get(context.sourceFile) ?? []
  const callsites = allCalls.filter(call => {
    const callee = call.node.expression
    return ts.isIdentifier(callee) && identifierSymbol(callee, context.sourceFile) === helperSymbol
  })
  if (callsites.length === 0) return undefined
  const callsiteCallees = new Set(callsites.map(call => call.node.expression as ts.Identifier))
  if (symbolReferences(owner.name, context.sourceFile).some(reference => reference !== owner.name && !callsiteCallees.has(reference))) {
    return undefined
  }
  const parentPaths = callsites.map(callsite => {
    const awaited = callsite.node.parent
    if (!ts.isAwaitExpression(awaited) || awaited.expression !== callsite.node) return undefined
    const txArgument = callsite.node.arguments[parameterIndex]
    const resolvedArgument = txArgument && unwrapExpression(txArgument)
    if (!resolvedArgument || !ts.isIdentifier(resolvedArgument)) return undefined
    const argumentDeclaration = lexicalDeclaration(resolvedArgument, context.sourceFile)
    if (!argumentDeclaration || !ts.isParameter(argumentDeclaration.parent)) return undefined
    return transactionPathFromParameter(argumentDeclaration.parent, callsite, nextSeen)
  })
  if (parentPaths.some(pathEntry => pathEntry === undefined)) return undefined
  const first = parentPaths[0]!
  if (parentPaths.some(pathEntry => JSON.stringify(pathEntry) !== JSON.stringify(first))) return undefined
  return [owner.name.text, ...first]
}

function transactionPathForPayment(payment: AstCall): readonly string[] | undefined {
  const resolution = resolvePaymentWrite(payment)
  const root = resolution && unwrapExpression(resolution.delegateRoot)
  if (!root || !ts.isIdentifier(root)) return undefined
  const declaration = lexicalDeclaration(root, payment.sourceFile)
  if (!declaration || !ts.isParameter(declaration.parent)) return undefined
  return transactionPathFromParameter(declaration.parent, payment)
}

function paymentDelegateRootIsProven(rootExpression: ts.Expression, context: AstCall): boolean {
  const root = unwrapExpression(rootExpression)
  if (!ts.isIdentifier(root)) return false
  if (isCanonicalPrismaDefaultImport(root, context)) return true
  const declaration = lexicalDeclaration(root, context.sourceFile)
  return Boolean(declaration && ts.isParameter(declaration.parent) && transactionPathFromParameter(declaration.parent, context))
}

const CLAIM_SNAPSHOT_PROPERTIES = ['shiftId', 'candidateShiftId', 'observedStatus', 'pendingReason'] as const

function exactInlineClaimState(expression: ts.Expression | undefined): boolean {
  const object = closedInlineObject(expression)
  return Boolean(
    object &&
      object.properties.length === CLAIM_SNAPSHOT_PROPERTIES.length &&
      CLAIM_SNAPSHOT_PROPERTIES.every(propertyName => objectPropertyExpression(object, propertyName)),
  )
}

function reviewedInlineClaimSnapshot(payment: AstCall, audit: AstCall, claim: ts.Expression): boolean {
  const allowlistKey = `${audit.file}#${audit.functionName}#inlineClaimSnapshot`
  if (!INLINE_CLAIM_SNAPSHOT_ALLOWLIST[allowlistKey]) return false
  const snapshot = closedInlineObject(claim)
  if (!snapshot || snapshot.properties.length !== CLAIM_SNAPSHOT_PROPERTIES.length) return false
  const owner = enclosingFunction(audit.node)
  if (!owner || !ts.isFunctionDeclaration(owner) || !owner.name) return false
  const pathToTransaction = transactionPathForPayment(payment)
  if (!pathToTransaction || pathToTransaction[0] !== owner.name.text) return false

  const parameterByProperty = new Map<string, { declaration: ts.ParameterDeclaration; index: number }>()
  for (const propertyName of CLAIM_SNAPSHOT_PROPERTIES) {
    const value = objectPropertyExpression(snapshot, propertyName)
    if (!value || !ts.isIdentifier(value)) return false
    const declaration = lexicalDeclaration(value, audit.sourceFile)
    if (!declaration || !ts.isParameter(declaration.parent) || declaration.parent.parent !== owner) return false
    if (bindingHasWrites(declaration, audit.sourceFile)) return false
    const index = owner.parameters.indexOf(declaration.parent)
    if (index < 0) return false
    parameterByProperty.set(propertyName, { declaration: declaration.parent, index })
  }

  const helperSymbol = identifierSymbol(owner.name, audit.sourceFile)
  if (!helperSymbol) return false
  const callsites = (SOURCE_CALLS.get(audit.sourceFile) ?? []).filter(callsite => {
    const callee = callsite.node.expression
    return ts.isIdentifier(callee) && identifierSymbol(callee, audit.sourceFile) === helperSymbol
  })
  if (callsites.length === 0) return false

  return callsites.every(callsite => {
    let sourceClaim: ts.Identifier | undefined
    const snapshotReceivers: ts.Identifier[] = []
    const snapshotStatements: ts.VariableStatement[] = []
    for (const propertyName of CLAIM_SNAPSHOT_PROPERTIES) {
      const parameter = parameterByProperty.get(propertyName)
      const argument = parameter && callsite.node.arguments[parameter.index]
      if (!argument || !ts.isIdentifier(argument)) return false
      const snapshotDeclaration = lexicalDeclaration(argument, callsite.sourceFile)
      if (
        !snapshotDeclaration ||
        !ts.isVariableDeclaration(snapshotDeclaration.parent) ||
        !isConstVariableDeclaration(snapshotDeclaration.parent) ||
        !snapshotDeclaration.parent.initializer ||
        snapshotDeclaration.parent.getEnd() >= callsite.position ||
        bindingHasWrites(snapshotDeclaration, callsite.sourceFile)
      ) {
        return false
      }
      const declarationList = snapshotDeclaration.parent.parent
      const statement = declarationList.parent
      if (
        !ts.isVariableDeclarationList(declarationList) ||
        declarationList.declarations.length !== 1 ||
        !ts.isVariableStatement(statement)
      ) {
        return false
      }
      const initializer = unwrapExpression(snapshotDeclaration.parent.initializer)
      if (
        (!ts.isPropertyAccessExpression(initializer) && !ts.isElementAccessExpression(initializer)) ||
        staticPropertyName(initializer) !== propertyName
      ) {
        return false
      }
      const receiver = unwrapExpression(initializer.expression)
      if (!ts.isIdentifier(receiver)) return false
      if (sourceClaim && !sameSymbol(sourceClaim, receiver, callsite.sourceFile)) return false
      sourceClaim = receiver
      snapshotReceivers.push(receiver)
      snapshotStatements.push(statement)
    }
    if (!sourceClaim || new Set(snapshotStatements).size !== CLAIM_SNAPSHOT_PROPERTIES.length) return false

    // The four reads are one indivisible snapshot operation in the grammar:
    // separate, ordered, adjacent const statements in the same block. That
    // excludes a mutation/branch/call between fields without interpreting its
    // effects.
    const snapshotBlock = snapshotStatements[0].parent
    if (!ts.isBlock(snapshotBlock) || snapshotStatements.some(statement => statement.parent !== snapshotBlock)) return false
    const firstIndex = snapshotBlock.statements.indexOf(snapshotStatements[0])
    if (firstIndex < 0 || snapshotStatements.some((statement, index) => snapshotBlock.statements[firstIndex + index] !== statement)) {
      return false
    }

    const sourceDeclaration = lexicalDeclaration(sourceClaim, callsite.sourceFile)
    if (
      !sourceDeclaration ||
      !ts.isVariableDeclaration(sourceDeclaration.parent) ||
      !sourceDeclaration.parent.initializer ||
      !exactInlineClaimState(sourceDeclaration.parent.initializer) ||
      enclosingFunction(sourceDeclaration) !== enclosingFunction(callsite.node)
    ) {
      return false
    }

    const allowedSnapshotReceivers = new Set(snapshotReceivers)
    const firstSnapshotPosition = snapshotStatements[0].getStart(callsite.sourceFile)
    return symbolReferences(sourceDeclaration, callsite.sourceFile).every(reference => {
      if (reference === sourceDeclaration) return true
      if (allowedSnapshotReceivers.has(reference)) return true
      const assignment = reference.parent
      return Boolean(
        ts.isBinaryExpression(assignment) &&
          assignment.left === reference &&
          assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          assignment.getStart(callsite.sourceFile) < firstSnapshotPosition &&
          enclosingFunction(reference) === enclosingFunction(callsite.node) &&
          exactInlineClaimState(assignment.right),
      )
    })
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
  if (!auditorPaymentIdMatches(payment, audit, paymentId)) return false
  if (!ts.isIdentifier(gate)) return false
  if (!ts.isIdentifier(claim)) {
    if (!reviewedInlineClaimSnapshot(payment, audit, claim)) return false
    const gateProvenance = bindingProvenance(audit, gate, new Set(['resolvePaymentShiftReconciliationEnabled']))
    return gateProvenance?.kind === 'canonical-call'
  }
  const claimProvenance = bindingProvenance(
    audit,
    claim,
    new Set(['claimShiftForCapturedPayment', 'claimShiftForCompletedPayment', 'claimShiftForRefund']),
  )
  if (!claimProvenance) return false
  if (!claimBindingStableUntilAudit(claim, audit)) return false
  if (claimProvenance.kind === 'canonical-call') {
    if (
      !argumentObject(claimProvenance.origin.call, 1) ||
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
  }
  const gateProvenance = bindingProvenance(audit, gate, new Set(['resolvePaymentShiftReconciliationEnabled']))
  return gateProvenance?.kind === 'canonical-call'
}

function safeAuditorFor(payment: AstCall, auditors: AstCall[]): AstCall | undefined {
  if (!paymentUsesClosedGrammar(payment)) return undefined
  if (!transactionPathForPayment(payment)) return undefined
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
    const failures: Array<{
      candidate: string
      writes: number
      closedGrammarDiagnostics: string[]
      auditorMatched: boolean
      transactionPath: readonly string[] | undefined
      declaredTransactionPath: readonly string[]
    }> = []
    for (const [candidate, entry] of Object.entries(INVENTORY)) {
      if (entry.decision !== 'include') continue
      const file = candidate.split('#')[0]
      const calls = parseCalls(file)
      const writes = candidateEntries(calls)
        .filter(item => item.key === candidate)
        .map(item => item.call)
      const auditors = callsForFunction(calls, entry.auditFunction, 'recordPendingPaymentShiftReconciliation')
      const closedGrammarDiagnostics = writes
        .filter(write => !paymentUsesClosedGrammar(write))
        .map(write => closedGrammarDiagnostic(write, entry.lane))
      const auditorMatched = writes.length === 1 && writes.every(write => Boolean(safeAuditorFor(write, auditors)))
      const transactionPath = writes.length === 1 ? transactionPathForPayment(writes[0]) : undefined
      if (
        writes.length !== 1 ||
        closedGrammarDiagnostics.length > 0 ||
        !auditorMatched ||
        JSON.stringify(transactionPath) !== JSON.stringify(entry.transactionPath)
      ) {
        failures.push({
          candidate,
          writes: writes.length,
          closedGrammarDiagnostics,
          auditorMatched,
          transactionPath,
          declaredTransactionPath: entry.transactionPath,
        })
      }
    }
    expect(failures).toEqual([])
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

  it('sólo acepta receiver directo; aliases de delegate quedan UNKNOWN e inventariados', () => {
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
      'fixture.ts#computed#create',
      'fixture.ts#bulk#createMany',
      'fixture.ts#upserted#upsert',
      'fixture.ts#aliased#unknownPaymentWrite:indirect-create:1',
      'fixture.ts#aliasNamedPayment#unknownPaymentWrite:indirect-create:1',
      'fixture.ts#destructured#unknownPaymentWrite:indirect-create:1',
      'fixture.ts#assigned#unknownPaymentWrite:indirect-create:1',
    ])
  })

  it('mantiene aliases del método UNKNOWN; data/status sólo se interpretan bajo receiver directo', () => {
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
      'fixture.ts#aliasedData#confirmation:update:1',
      'fixture.ts#shorthandStatus#confirmation:update:1',
      'fixture.ts#assignedComputedData#confirmation:update:1',
      'fixture.ts#unknownData#confirmation:update:1',
      'fixture.ts#destructuredMethod#unknownPaymentWrite:destructured-write:1',
      'fixture.ts#aliasedMethod#unknownPaymentWrite:indirect-create:1',
      'fixture.ts#assignedMethod#unknownPaymentWrite:indirect-create:1',
    ])
  })

  it('clasifica como UNKNOWN los update/updateMany cuyo data o alias pudo mutar antes del write', () => {
    const fixture = `
      function propertyMutation() {
        const data = { status: 'PENDING' }
        data.status = 'COMPLETED'
        tx.payment.update({ where: { id }, data })
      }
      function elementMutation() {
        const data = { status: 'FAILED' }
        data['status'] = 'COMPLETED'
        tx.payment.updateMany({ where: { id }, data })
      }
      function aliasMutation() {
        const data = { status: 'PENDING' }
        const alias = data
        alias.status = 'COMPLETED'
        tx.payment.update({ where: { id }, data })
      }
      function objectAssignMutation() {
        const data = { status: 'PENDING' }
        Object.assign(data, { status: 'COMPLETED' })
        tx.payment.updateMany({ where: { id }, data })
      }
      function definePropertyMutation() {
        const data = { status: 'PENDING' }
        Object.defineProperty(data, 'status', { value: 'COMPLETED' })
        tx.payment.update({ where: { id }, data })
      }
      function unknownCallMutation() {
        const data = { status: 'PENDING' }
        mutatePaymentData(data)
        tx.payment.updateMany({ where: { id }, data })
      }
      function conditionalMutation() {
        const data = { status: 'PENDING' }
        if (shouldComplete) data.status = 'COMPLETED'
        tx.payment.update({ where: { id }, data })
      }
      function spreadReassignment() {
        let data = { status: 'PENDING' }
        data = { ...data, status: 'COMPLETED' }
        tx.payment.updateMany({ where: { id }, data })
      }
      function conditionalAliasMutation() {
        const data = { status: 'PENDING' }
        const alias = shouldUseData ? data : { status: 'FAILED' }
        alias.status = 'COMPLETED'
        tx.payment.update({ where: { id }, data })
      }
      function containerEscapeMutation() {
        const data = { status: 'PENDING' }
        const holder = { data }
        holder.data.status = 'COMPLETED'
        tx.payment.updateMany({ where: { id }, data })
      }
      function destructuredAliasMutation() {
        const data = { status: 'PENDING' }
        let alias
        ;[alias] = [data]
        alias.status = 'COMPLETED'
        tx.payment.update({ where: { id }, data })
      }
      function constructorEscapeMutation() {
        const data = { status: 'PENDING' }
        new Mutator(data)
        tx.payment.updateMany({ where: { id }, data })
      }
      function invokedFunctionAliasMutation() {
        const data = { status: 'PENDING' }
        const mutate = () => { data.status = 'COMPLETED' }
        const invoke = mutate
        invoke()
        tx.payment.update({ where: { id }, data })
      }
      function predeclaredClosureMutation() {
        function mutate() { data.status = 'COMPLETED' }
        const data = { status: 'PENDING' }
        mutate()
        tx.payment.updateMany({ where: { id }, data })
      }
    `
    const writes = parseCalls('fixture.ts', fixture).filter(call => resolvePaymentWrite(call))

    expect(
      writes.map(call => ({
        functionName: call.functionName,
        status: paymentCompletionStatus(call),
      })),
    ).toEqual([
      { functionName: 'propertyMutation', status: 'UNKNOWN' },
      { functionName: 'elementMutation', status: 'UNKNOWN' },
      { functionName: 'aliasMutation', status: 'UNKNOWN' },
      { functionName: 'objectAssignMutation', status: 'UNKNOWN' },
      { functionName: 'definePropertyMutation', status: 'UNKNOWN' },
      { functionName: 'unknownCallMutation', status: 'UNKNOWN' },
      { functionName: 'conditionalMutation', status: 'UNKNOWN' },
      { functionName: 'spreadReassignment', status: 'UNKNOWN' },
      { functionName: 'conditionalAliasMutation', status: 'UNKNOWN' },
      { functionName: 'containerEscapeMutation', status: 'UNKNOWN' },
      { functionName: 'destructuredAliasMutation', status: 'UNKNOWN' },
      { functionName: 'constructorEscapeMutation', status: 'UNKNOWN' },
      { functionName: 'invokedFunctionAliasMutation', status: 'UNKNOWN' },
      { functionName: 'predeclaredClosureMutation', status: 'UNKNOWN' },
    ])
    expect(discoverCandidates(parseCalls('fixture.ts', fixture))).toEqual([
      'fixture.ts#propertyMutation#confirmation:update:1',
      'fixture.ts#elementMutation#confirmation:updateMany:1',
      'fixture.ts#aliasMutation#confirmation:update:1',
      'fixture.ts#objectAssignMutation#confirmation:updateMany:1',
      'fixture.ts#definePropertyMutation#confirmation:update:1',
      'fixture.ts#unknownCallMutation#confirmation:updateMany:1',
      'fixture.ts#conditionalMutation#confirmation:update:1',
      'fixture.ts#spreadReassignment#confirmation:updateMany:1',
      'fixture.ts#conditionalAliasMutation#confirmation:update:1',
      'fixture.ts#containerEscapeMutation#confirmation:updateMany:1',
      'fixture.ts#destructuredAliasMutation#confirmation:update:1',
      'fixture.ts#constructorEscapeMutation#confirmation:updateMany:1',
      'fixture.ts#invokedFunctionAliasMutation#confirmation:update:1',
      'fixture.ts#predeclaredClosureMutation#confirmation:updateMany:1',
    ])
  })

  it('rechaza reemplazos por spread, computed y duplicados en Payment, wrapper y auditor', () => {
    const valid = `
      import prisma from '@/utils/prismaClient'
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function unsafeLane() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => {
          const paymentStatus = 'COMPLETED'
          const data = { status: paymentStatus }
          const shiftClaim = await claimShiftForCompletedPayment(tx, { paymentStatus })
          const payment = await tx.payment.create({ data })
          await recordPendingPaymentShiftReconciliation(tx, {
            claim: shiftClaim,
            paymentId: payment.id,
            reconciliationEnabled,
          })
        })
      }
    `
    const mutations = [
      valid.replace('tx.payment.create({ data })', 'tx.payment.create({ data, ...alternate })'),
      valid.replace('tx.payment.create({ data })', 'tx.payment.create({ data, data: alternateData })'),
      valid.replace(
        'const data = { status: paymentStatus }',
        "const propertyName = 'status'; const data = { status: paymentStatus, [propertyName]: 'PENDING' }",
      ),
      valid.replace('const data = { status: paymentStatus }', "const data = { status: paymentStatus, status: 'PENDING' }"),
      valid.replace('{ paymentStatus })', '{ paymentStatus, ...alternateClaim })'),
      valid.replace('{ paymentStatus })', "{ paymentStatus, paymentStatus: 'PENDING' })"),
      valid.replace('reconciliationEnabled,\n          })', 'reconciliationEnabled,\n            ...alternateAudit,\n          })'),
      valid.replace('claim: shiftClaim,', 'claim: shiftClaim,\n          claim: otherClaim,'),
      valid.replace('paymentId: payment.id,', 'paymentId: payment.id,\n          paymentId: otherPayment.id,'),
      valid.replace(
        'reconciliationEnabled,\n          })',
        'reconciliationEnabled,\n            reconciliationEnabled: false,\n          })',
      ),
    ]

    const validCalls = parseCalls('src/services/fixture.ts', valid)
    const validPayment = validCalls.find(call => paymentWriteMethod(call))!
    expect(
      safeAuditorFor(validPayment, callsForFunction(validCalls, 'unsafeLane', 'recordPendingPaymentShiftReconciliation')),
    ).toBeDefined()

    for (const [index, fixture] of mutations.entries()) {
      const calls = parseCalls('src/services/fixture.ts', fixture)
      const payment = calls.find(call => paymentWriteMethod(call))!
      expect({
        mutation: index,
        auditorMatched: Boolean(safeAuditorFor(payment, callsForFunction(calls, 'unsafeLane', 'recordPendingPaymentShiftReconciliation'))),
      }).toEqual({ mutation: index, auditorMatched: false })
    }
  })

  it('rechaza aliases por for-of/var/destructuring y closures condicionales, métodos o callbacks', () => {
    const fixtureFor = (mutation: string) => `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function unsafeLane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const paymentStatus = 'PENDING'
        const data = { status: paymentStatus }
        const shiftClaim = await claimShiftForCompletedPayment(tx, { paymentStatus })
        ${mutation}
        const payment = await tx.payment.create({ data })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const mutations = [
      "for (const alias of [data]) alias.status = 'COMPLETED'",
      "var alias = chooseData ? data : fallback; alias.status = 'COMPLETED'",
      "const { target: alias = data } = holder; alias.status = 'COMPLETED'",
      "const mutate = shouldMutate ? () => { data.status = 'COMPLETED' } : () => {}; mutate()",
      "const holder = { mutate() { data.status = 'COMPLETED' } }; holder.mutate()",
      "const mutate = () => { data.status = 'COMPLETED' }; Promise.resolve().then(mutate)",
    ]

    for (const mutation of mutations) {
      const calls = parseCalls('src/services/fixture.ts', fixtureFor(mutation))
      const payment = calls.find(call => paymentWriteMethod(call))!
      expect({
        mutation,
        auditor: safeAuditorFor(payment, callsForFunction(calls, 'unsafeLane', 'recordPendingPaymentShiftReconciliation')),
      }).toEqual({ mutation, auditor: undefined })
    }
  })

  it('usa símbolos TypeScript y no confunde un binding data sombreado con el const final', () => {
    const fixture = `
      import prisma from '@/utils/prismaClient'
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => {
          const paymentStatus = 'COMPLETED'
          const data = { status: paymentStatus }
          {
            const data = { status: 'FAILED' }
            data.status = 'COMPLETED'
          }
          const shiftClaim = await claimShiftForCompletedPayment(tx, { paymentStatus })
          const payment = await tx.payment.create({ data })
          await recordPendingPaymentShiftReconciliation(tx, {
            claim: shiftClaim,
            paymentId: payment.id,
            reconciliationEnabled,
          })
        })
      }
    `
    const calls = parseCalls('src/services/fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(paymentPersistedStatus(payment)?.getText(payment.sourceFile)).toBe('paymentStatus')
    expect(safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation'))).toBeDefined()
  })

  it('mantiene update y updateMany fuera de gramática como UNKNOWN e inventariados', () => {
    const fixture = `
      function unsafeUpdate() {
        const data = { status: 'FAILED' }
        for (const alias of [data]) alias.status = 'COMPLETED'
        tx.payment.update({ where: { id }, data })
      }
      function unsafeUpdateMany() {
        const data = { status: 'FAILED' }
        const holder = { mutate() { data.status = 'COMPLETED' } }
        holder.mutate()
        tx.payment.updateMany({ where: { id }, data })
      }
    `
    const calls = parseCalls('src/services/unsafe-writer.ts', fixture)
    const writes = calls.filter(call => resolvePaymentWrite(call))

    expect(writes.map(call => paymentCompletionStatus(call))).toEqual(['UNKNOWN', 'UNKNOWN'])
    expect(discoverCandidates(calls)).toEqual([
      'src/services/unsafe-writer.ts#unsafeUpdate#confirmation:update:1',
      'src/services/unsafe-writer.ts#unsafeUpdateMany#confirmation:updateMany:1',
    ])
  })

  it('diagnostica un writer fuera de gramática con file, function y lane', () => {
    const calls = parseCalls(
      'src/services/unsafe-writer.ts',
      `function writeCashPayment(){ tx.payment.create({ data: row, ...alternate }) }`,
    )
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(closedGrammarDiagnostic(payment, 'cashCheckout')).toBe(
      'src/services/unsafe-writer.ts#writeCashPayment#cashCheckout: Prisma arguments must be one closed inline object with one static data property',
    )
  })

  it('inventa UNKNOWN para toda referencia indirecta a Payment delegate/write en vez de dejarla desaparecer', () => {
    const variants: Array<{ name: string; body: string }> = [
      {
        name: 'methodCall',
        body: "tx.payment.create.call(tx.payment, { data: { status: 'COMPLETED' } })",
      },
      {
        name: 'methodApply',
        body: "tx.payment.create.apply(tx.payment, [{ data: { status: 'COMPLETED' } }])",
      },
      {
        name: 'methodBind',
        body: "const bound = tx.payment.create.bind(tx.payment); bound({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'dynamicConstMethod',
        body: "const method = 'create' as const; tx.payment[method]({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'delegateAlias',
        body: "const delegate = tx.payment; delegate.create({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'conditionalDelegate',
        body: "const delegate = choosePayment ? tx.payment : fallback; delegate.create({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'reassignedDelegate',
        body: "let delegate = tx.payment; delegate = fallback; delegate.create({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'methodAlias',
        body: "const write = tx.payment.create; write({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'conditionalMethod',
        body: "const write = chooseCreate ? tx.payment.create : fallback; write({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'reassignedMethod',
        body: "let write = tx.payment.create; write = fallback; write({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'nestedDestructure',
        body: "const { payment: { create: write } } = tx; write({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'optionalInvocation',
        body: "tx.payment?.create({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'parenthesizedInvocation',
        body: "(tx.payment.create)({ data: { status: 'COMPLETED' } })",
      },
      {
        name: 'uninvokedMethod',
        body: 'const write = tx.payment.create; void write',
      },
    ]

    const file = 'src/services/indirect-payment-writer.ts'
    const calls = parseCalls(
      file,
      `${variants.map(variant => `function ${variant.name}(tx: any) { ${variant.body} }`).join('\n')}
       function direct(tx: any) { tx.payment.create({ data: { status: 'COMPLETED' } }) }`,
    )

    for (const variant of variants) {
      const candidates = discoverCandidates(calls).filter(candidate => candidate.includes(`#${variant.name}#`))
      expect({ variant: variant.name, candidates }).toEqual({
        variant: variant.name,
        candidates: [expect.stringContaining(`${file}#${variant.name}#unknownPaymentWrite:`)],
      })
    }

    expect(discoverCandidates(calls).filter(candidate => candidate.includes('#direct#'))).toEqual([`${file}#direct#create`])

    const escapedDelegate = parseCalls(
      'src/services/escaped-payment-delegate.ts',
      `import prisma from '@/utils/prismaClient'
       async function escaped() {
         await prisma.$transaction(async database => { unknownConsumer(database.payment) })
       }`,
    )
    expect(discoverCandidates(escapedDelegate)).toEqual([
      'src/services/escaped-payment-delegate.ts#escaped#unknownPaymentWrite:delegate-escape:1',
    ])
  })

  it('sólo certifica el auditor canónico awaited como statement dominante o branch pendiente directo', () => {
    const auditCall = `recordPendingPaymentShiftReconciliation(tx, {
      claim: shiftClaim,
      venueId,
      paymentId: payment.id,
      orderId: null,
      staffId: null,
      channel: 'manualPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled,
    })`
    const laneFor = (name: string, auditStatement: string, beforeClaim = '') => `
      async function ${name}() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => {
          ${beforeClaim}
          const shiftClaim = await claimShiftForCapturedPayment(tx, {
            venueId, amountPesos, tipPesos, incrementTotalOrders: true,
          })
          const payment = await tx.payment.create({ data: { status: 'COMPLETED' } })
          ${auditStatement}
        })
      }
    `

    const invalidLanes: Array<[string, string]> = [
      ['invalidShadow', laneFor('invalidShadow', `await ${auditCall}`, 'function recordPendingPaymentShiftReconciliation() {}')],
      ['invalidVoid', laneFor('invalidVoid', `void ${auditCall}`)],
      ['invalidAnd', laneFor('invalidAnd', `ready && (await ${auditCall})`)],
      ['invalidOr', laneFor('invalidOr', `ready || (await ${auditCall})`)],
      ['invalidNullish', laneFor('invalidNullish', `ready ?? (await ${auditCall})`)],
      ['invalidLoopBody', laneFor('invalidLoopBody', `for (; ready; ) { await ${auditCall} }`)],
      ['invalidLoopClause', laneFor('invalidLoopClause', `for (let ignored = await ${auditCall}; false; ) { void ignored }`)],
      ['invalidReturn', laneFor('invalidReturn', `if (shiftClaim.pendingReason) { if (stop) return; await ${auditCall} }`)],
      ['invalidThrow', laneFor('invalidThrow', `if (shiftClaim.pendingReason) { if (stop) throw new Error('stop'); await ${auditCall} }`)],
      [
        'invalidBreak',
        `async function invalidBreak() {
          const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
          await prisma.$transaction(async tx => {
            for (const item of items) {
              const shiftClaim = await claimShiftForCapturedPayment(tx, {
                venueId, amountPesos, tipPesos, incrementTotalOrders: true,
              })
              const payment = await tx.payment.create({ data: { status: 'COMPLETED' } })
              if (shiftClaim.pendingReason) { if (item.stop) break; await ${auditCall} }
            }
          })
        }`,
      ],
      [
        'invalidContinue',
        `async function invalidContinue() {
          const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
          await prisma.$transaction(async tx => {
            for (const item of items) {
              const shiftClaim = await claimShiftForCapturedPayment(tx, {
                venueId, amountPesos, tipPesos, incrementTotalOrders: true,
              })
              const payment = await tx.payment.create({ data: { status: 'COMPLETED' } })
              if (shiftClaim.pendingReason) { if (item.stop) continue; await ${auditCall} }
            }
          })
        }`,
      ],
    ]

    const calls = parseCalls(
      'src/services/auditor-fixture.ts',
      `import prisma from '@/utils/prismaClient'
       import {
         claimShiftForCapturedPayment,
         recordPendingPaymentShiftReconciliation,
         resolvePaymentShiftReconciliationEnabled,
       } from '@/services/shared/paymentShiftClaim'
       ${laneFor('validUnconditional', `await ${auditCall}`)}
       ${laneFor('validPending', `if (shiftClaim.pendingReason) { await ${auditCall} }`)}
       ${invalidLanes.map(([, source]) => source).join('\n')}`,
    )
    const certifiedAuditor = (functionName: string) => {
      const payment = calls.find(call => call.functionName === functionName && paymentWriteMethod(call) === 'create')!
      return safeAuditorFor(payment, callsForFunction(calls, functionName, 'recordPendingPaymentShiftReconciliation'))
    }

    expect(certifiedAuditor('validUnconditional')).toBeDefined()
    expect(certifiedAuditor('validPending')).toBeDefined()
    for (const [functionName] of invalidLanes) {
      expect({ functionName, auditorMatched: Boolean(certifiedAuditor(functionName)) }).toEqual({
        functionName,
        auditorMatched: false,
      })
    }
  })

  it('rechaza mutación, alias, capture o escape de claim/Payment hasta evaluar por completo el auditor', () => {
    const laneFor = (name: string, between: string, extraAuditField = '') => `
      async function ${name}() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => {
          const shiftClaim = await claimShiftForCapturedPayment(tx, {
            venueId, amountPesos, tipPesos, incrementTotalOrders: true,
          })
          const payment = await tx.payment.create({ data: { status: 'COMPLETED', shiftId: shiftClaim.shiftId } })
          ${between}
          await recordPendingPaymentShiftReconciliation(tx, {
            ${extraAuditField}
            claim: shiftClaim,
            venueId,
            paymentId: payment.id,
            orderId: null,
            staffId: null,
            channel: 'manualPayment',
            amountPesos,
            tipPesos,
            reconciliationEnabled,
          })
        })
      }
    `

    const mutations: Array<[string, string, string]> = [
      ['mutateShiftId', "shiftClaim.shiftId = 'forged'", ''],
      ['mutatePendingReason', "shiftClaim.pendingReason = 'CLAIM_LOST'", ''],
      ['mutatePaymentId', "payment.id = 'forged'", ''],
      ['assignClaim', "Object.assign(shiftClaim, { pendingReason: 'CLAIM_LOST' })", ''],
      ['containerClaim', 'const holder = { shiftClaim }', ''],
      ['aliasClaim', 'const alias = shiftClaim', ''],
      ['captureClaim', 'const mutate = () => { shiftClaim.pendingReason = null }', ''],
      ['escapeClaim', 'unknownConsumer(shiftClaim)', ''],
      ['assignPayment', "Object.assign(payment, { id: 'forged' })", ''],
      ['aliasPayment', 'const paymentAlias = payment', ''],
      ['containerPayment', 'const holder = { payment }', ''],
      ['capturePayment', 'const inspect = () => payment.id', ''],
      ['escapePayment', 'unknownConsumer(payment)', ''],
      ['initializerClaimMutation', '', "evidence: (shiftClaim.pendingReason = 'CLAIM_LOST'),"],
      ['initializerPaymentMutation', '', "evidence: (payment.id = 'forged'),"],
      ['initializerClaimEscape', '', 'evidence: unknownConsumer(shiftClaim),'],
    ]

    const calls = parseCalls(
      'src/services/object-stability-fixture.ts',
      `import prisma from '@/utils/prismaClient'
       import {
         claimShiftForCapturedPayment,
         recordPendingPaymentShiftReconciliation,
         resolvePaymentShiftReconciliationEnabled,
       } from '@/services/shared/paymentShiftClaim'
       ${laneFor('stableObjects', '')}
       ${mutations.map(([name, between, field]) => laneFor(name, between, field)).join('\n')}`,
    )
    const certifiedAuditor = (functionName: string) => {
      const payment = calls.find(call => call.functionName === functionName && paymentWriteMethod(call) === 'create')!
      return safeAuditorFor(payment, callsForFunction(calls, functionName, 'recordPendingPaymentShiftReconciliation'))
    }

    expect(certifiedAuditor('stableObjects')).toBeDefined()
    for (const [functionName] of mutations) {
      expect({ functionName, auditorMatched: Boolean(certifiedAuditor(functionName)) }).toEqual({
        functionName,
        auditorMatched: false,
      })
    }

    const updateCalls = parseCalls(
      'src/services/update-object-stability-fixture.ts',
      `import prisma from '@/utils/prismaClient'
       import {
         claimShiftForCapturedPayment,
         recordPendingPaymentShiftReconciliation,
         resolvePaymentShiftReconciliationEnabled,
       } from '@/services/shared/paymentShiftClaim'
       async function primitiveId() {
         const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
         await prisma.$transaction(async tx => {
           const paymentId = 'payment-id'
           const shiftClaim = await claimShiftForCapturedPayment(tx, {
             venueId, amountPesos, tipPesos, incrementTotalOrders: true,
           })
           await tx.payment.updateMany({ where: { id: paymentId }, data: { status: 'COMPLETED' } })
           await recordPendingPaymentShiftReconciliation(tx, {
             claim: shiftClaim, paymentId, reconciliationEnabled,
           })
         })
       }
       async function objectId() {
         const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
         await prisma.$transaction(async tx => {
           const sourcePayment = { id: 'payment-id' }
           const shiftClaim = await claimShiftForCapturedPayment(tx, {
             venueId, amountPesos, tipPesos, incrementTotalOrders: true,
           })
           await tx.payment.updateMany({ where: { id: sourcePayment.id }, data: { status: 'COMPLETED' } })
           await recordPendingPaymentShiftReconciliation(tx, {
             claim: shiftClaim, paymentId: sourcePayment.id, reconciliationEnabled,
           })
         })
       }`,
    )
    const updateCertified = (functionName: string) => {
      const payment = updateCalls.find(call => call.functionName === functionName && paymentWriteMethod(call) === 'updateMany')!
      return Boolean(safeAuditorFor(payment, callsForFunction(updateCalls, functionName, 'recordPendingPaymentShiftReconciliation')))
    }
    expect(updateCertified('primitiveId')).toBe(true)
    expect(updateCertified('objectId')).toBe(false)
  })

  it('exige procedencia real de callback $transaction y declara cualquier helper intermedio en el manifest', () => {
    const imports = `
      import prisma from '@/utils/prismaClient'
      import {
        claimShiftForCapturedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
    `
    const writer = `
      const shiftClaim = await claimShiftForCapturedPayment(tx, {
        venueId, amountPesos, tipPesos, incrementTotalOrders: true,
      })
      const payment = await tx.payment.create({ data: { status: 'COMPLETED' } })
      await recordPendingPaymentShiftReconciliation(tx, {
        claim: shiftClaim,
        venueId,
        paymentId: payment.id,
        orderId: null,
        staffId: null,
        channel: 'manualPayment',
        amountPesos,
        tipPesos,
        reconciliationEnabled,
      })
    `
    const certifiedAuditor = (calls: AstCall[], functionName: string) => {
      const payment = calls.find(call => call.functionName === functionName && paymentWriteMethod(call) === 'create')!
      return safeAuditorFor(payment, callsForFunction(calls, functionName, 'recordPendingPaymentShiftReconciliation'))
    }

    const inline = `async function lane() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => { ${writer} })
      }
    `
    const fullClient = `async function fullClientLane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(tx, venueId)
        ${writer}
      }
    `
    const fakeTransaction = `async function fakeTransactionLane() {
        const fake = { $transaction: async (callback: any) => callback(prisma) }
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await fake.$transaction(async tx => { ${writer} })
      }
    `
    const directCalls = parseCalls('src/services/transaction-fixture.ts', `${imports}${inline}${fullClient}${fakeTransaction}`)
    expect(certifiedAuditor(directCalls, 'lane')).toBeDefined()
    expect(Boolean(certifiedAuditor(directCalls, 'fullClientLane'))).toBe(false)
    expect(Boolean(certifiedAuditor(directCalls, 'fakeTransactionLane'))).toBe(false)

    const helper = `${imports}
      async function writeInHelper(tx: any, reconciliationEnabled: boolean) { ${writer} }
      async function lane() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => { await writeInHelper(tx, reconciliationEnabled) })
      }
    `
    expect(certifiedAuditor(parseCalls('src/services/helper-transaction-fixture.ts', helper), 'writeInHelper')).toBeDefined()

    const helperWithUnprovenCaller = `${helper}
      async function bypass() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await writeInHelper(prisma, reconciliationEnabled)
      }
    `
    expect(
      Boolean(certifiedAuditor(parseCalls('src/services/helper-unproven-fixture.ts', helperWithUnprovenCaller), 'writeInHelper')),
    ).toBe(false)

    const escapedClaimHelper = `${imports}
      async function writeEscapedClaim(tx: any, claimFromCaller: any, reconciliationEnabled: boolean) {
        const payment = await tx.payment.create({ data: { status: 'COMPLETED' } })
        await recordPendingPaymentShiftReconciliation(tx, {
          claim: claimFromCaller,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
      async function escapedClaimLane() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => {
          const shiftClaim = await claimShiftForCapturedPayment(tx, {
            venueId, amountPesos, tipPesos, incrementTotalOrders: true,
          })
          await writeEscapedClaim(tx, shiftClaim, reconciliationEnabled)
        })
      }
    `
    const escapedCalls = parseCalls('src/services/escaped-claim-helper-fixture.ts', escapedClaimHelper)
    expect(Boolean(certifiedAuditor(escapedCalls, 'writeEscapedClaim'))).toBe(false)

    for (const [candidate, entry] of Object.entries(INVENTORY)) {
      if (entry.decision === 'include') {
        expect({ candidate, transactionPathDeclared: 'transactionPath' in entry }).toEqual({
          candidate,
          transactionPathDeclared: true,
        })
      }
    }
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
      import prisma from '@/utils/prismaClient'
      import {
        claimShiftForCapturedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane() {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        await prisma.$transaction(async tx => {
          const shiftClaim = await claimShiftForCapturedPayment(tx, { venueId })
          const payment = await tx.payment.create({ data: { status: 'COMPLETED' } })
          await recordPendingPaymentShiftReconciliation(tx, {
            claim: shiftClaim,
            paymentId: payment.id,
            reconciliationEnabled,
          })
        })
      }
    `
    const mutations = [
      good.replace('recordPendingPaymentShiftReconciliation(tx,', 'recordPendingPaymentShiftReconciliation(otherTx,'),
      good.replace('paymentId: payment.id', 'paymentId: otherPayment.id'),
      good.replace('claim: shiftClaim', "claim: { shiftId: 'already-attributed' }"),
      good.replace('reconciliationEnabled,', 'reconciliationEnabled: false,'),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, { venueId })',
        'const shiftClaim = false ? await claimShiftForCapturedPayment(tx, { venueId }) : { shiftId: null }',
      ),
      good.replace(
        'const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)',
        'const reconciliationEnabled = false ? await resolvePaymentShiftReconciliationEnabled(prisma, venueId) : false',
      ),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, { venueId })',
        'const shiftClaim = claimShiftForCapturedPayment(tx, { venueId })',
      ),
      good.replace(
        'const shiftClaim = await claimShiftForCapturedPayment(tx, { venueId })',
        'const shiftClaim = await fake.claimShiftForCapturedPayment(tx, { venueId })',
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
        'const shiftClaim = await claimShiftForCapturedPayment(tx, { venueId })',
        'const shiftClaim = await claimShiftForCapturedPayment(otherTx, { venueId })',
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

  it('rechaza identidad de status si el contenedor data o cualquiera de sus aliases muta antes de Payment', () => {
    const fixtureFor = (mutation: string, declaration = 'const data = { status: statusSnapshot }') => `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const statusSnapshot = 'PENDING'
        ${declaration}
        const shiftClaim = await claimShiftForCompletedPayment(tx, { paymentStatus: statusSnapshot })
        ${mutation}
        const payment = await tx.payment.create({ data })
        if (shiftClaim) await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
      }
    `
    const mutations: Array<[string, string?]> = [
      ["data.status = 'COMPLETED'"],
      ["data['status'] = 'COMPLETED'"],
      ["const alias = data; alias.status = 'COMPLETED'"],
      ["const alias = data; Object.assign(alias, { status: 'COMPLETED' })"],
      ["Object.defineProperty(data, 'status', { value: 'COMPLETED' })"],
      ['mutatePaymentData(data)'],
      ["if (shouldComplete) data.status = 'COMPLETED'"],
      ["(() => { data.status = 'COMPLETED' })()"],
      ["data = { ...data, status: 'COMPLETED' }", 'let data = { status: statusSnapshot }'],
      ["const alias = shouldUseData ? data : { status: 'FAILED' }; alias.status = 'COMPLETED'"],
      ["const holder = { data }; holder.data.status = 'COMPLETED'"],
      ["let alias; [alias] = [data]; alias.status = 'COMPLETED'"],
      ['new Mutator(data)'],
      ["const mutate = () => { data.status = 'COMPLETED' }; const invoke = mutate; invoke()"],
    ]

    for (const [mutation, declaration] of mutations) {
      const calls = parseCalls('fixture.ts', fixtureFor(mutation, declaration))
      const payment = calls.find(call => paymentWriteMethod(call))!
      expect({
        mutation,
        auditor: safeAuditorFor(payment, callsForFunction(calls, 'lane', 'recordPendingPaymentShiftReconciliation')),
      }).toEqual({ mutation, auditor: undefined })
    }
  })

  it('rechaza aliases y captures aunque parezcan inmutables o nunca invocados', () => {
    const fixture = `
      import {
        claimShiftForCompletedPayment,
        recordPendingPaymentShiftReconciliation,
        resolvePaymentShiftReconciliationEnabled,
      } from '@/services/shared/paymentShiftClaim'
      async function lane(tx: any) {
        const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)
        const statusSnapshot = 'PENDING'
        const data = { status: statusSnapshot }
        const alias = data
        const observedStatus = data.status
        const copiedStatus = { status: data.status }
        const neverInvokedArrow = () => { alias.status = 'COMPLETED' }
        const neverInvokedAlias = neverInvokedArrow
        {
          const data = { status: 'FAILED' }
          data.status = 'COMPLETED'
        }
        function neverInvoked() { alias.status = 'COMPLETED' }
        const shiftClaim = await claimShiftForCompletedPayment(tx, { paymentStatus: statusSnapshot })
        const payment = await tx.payment.create({ data: alias })
        if (shiftClaim) await recordPendingPaymentShiftReconciliation(tx, {
          claim: shiftClaim,
          paymentId: payment.id,
          reconciliationEnabled,
        })
        void observedStatus
        void copiedStatus
        void neverInvokedAlias
      }
    `
    const calls = parseCalls('fixture.ts', fixture)
    const payment = calls.find(call => paymentWriteMethod(call))!

    expect(paymentPersistedStatus(payment)).toBeUndefined()
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

  it('no concede claim-object parameters y el único snapshot inline revisado conserva su suite', () => {
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

    expect(Object.keys(INLINE_CLAIM_SNAPSHOT_ALLOWLIST)).toEqual([
      'src/services/pos-sync/posSyncOrder.service.ts#processPaymentsForOrder#inlineClaimSnapshot',
    ])
    for (const behaviorSuite of Object.values(INLINE_CLAIM_SNAPSHOT_ALLOWLIST)) {
      expect(fs.existsSync(path.join(process.cwd(), behaviorSuite))).toBe(true)
    }
  })

  it('rechaza mutación o escape del claim POS alrededor de sus snapshots primitivos', () => {
    const file = 'src/services/pos-sync/posSyncOrder.service.ts'
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    const mutations = [
      source.replace(
        'const writableShiftId = shiftClaim.shiftId',
        "const writableShiftId = shiftClaim.shiftId\n    shiftClaim.pendingReason = 'CLAIM_LOST'",
      ),
      source.replace(
        'const writableShiftId = shiftClaim.shiftId',
        'const escapedShiftClaim = shiftClaim\n    const writableShiftId = shiftClaim.shiftId',
      ),
    ]

    for (const mutation of mutations) {
      const calls = parseCalls(file, mutation)
      const payments = calls.filter(call => call.functionName === 'processPaymentsForOrder' && paymentWriteMethod(call))
      const auditors = callsForFunction(calls, 'processPaymentsForOrder', 'recordPendingPaymentShiftReconciliation')
      expect({
        paymentCount: payments.length,
        anyCertified: payments.some(payment => Boolean(safeAuditorFor(payment, auditors))),
      }).toEqual({ paymentCount: 1, anyCertified: false })
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
      guardedExistingOrderPathPrecedes(b4bitCalls, 'completeAndAttributeB4BitPaymentInTx', 'paymentOrderId', 'lockB4BitPaymentRow'),
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
