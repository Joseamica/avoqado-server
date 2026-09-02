import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'

const ROOTS = ['src', 'tests', 'scripts', 'prisma'] as const
const SUPPORTED_EXECUTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.sql'])
const EXPLICITLY_NON_EXECUTABLE_EXTENSIONS = new Set(['.csv', '.json', '.md', '.prisma', '.sh', '.toml', '.ttf', '.xlsx'])
const TARGET_MODELS = {
  commercialPublication: 'CommercialPublication',
  commercialCampaignVersion: 'CommercialCampaignVersion',
  commercialQuote: 'CommercialQuote',
} as const
const TARGET_TABLES = new Set(Object.values(TARGET_MODELS))
const TARGET_TABLE_ORDER = new Map<TargetTable, number>(Object.values(TARGET_MODELS).map((table, index) => [table, index]))

type TargetTable = (typeof TARGET_MODELS)[keyof typeof TARGET_MODELS]
type WriterOperation = 'create' | 'createMany' | 'createManyAndReturn' | 'upsert' | 'sqlInsert'
type VersionStrategy =
  | 'literal-v1'
  | 'literal-v2'
  | 'literal-v3'
  | 'copy-schema-version'
  | 'omitted'
  | 'spread-only'
  | 'dynamic'

function isPrismaWriterOperation(value: string): value is Exclude<WriterOperation, 'sqlInsert'> {
  return value === 'create' || value === 'createMany' || value === 'createManyAndReturn' || value === 'upsert'
}

interface WriterOccurrence {
  file: string
  table: TargetTable
  operation: WriterOperation
  occurrence: number
  versionStrategy: VersionStrategy
  line: number
}

type InventoryEntry = Omit<WriterOccurrence, 'line'>

const EXPECTED_WRITERS: InventoryEntry[] = [
  {
    file: 'src/services/commercial/offers/commercialOfferPublication.service.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'src/services/commercial/commercialCampaignPublication.service.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'src/services/commercial/commercialPublication.service.ts',
    table: 'CommercialPublication',
    operation: 'createMany',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'src/services/commercial/commercialQuotePersistence.service.ts',
    table: 'CommercialQuote',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'src/services/commercial/quotes-v3/commercialQuoteV3Persistence.service.ts',
    table: 'CommercialQuote',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-billing-core.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-billing-core.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-billing-core.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 3,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-billing-core.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 4,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 3,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 4,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 3,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 3,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 4,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 5,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 5,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 6,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 6,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 7,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 7,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 8,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-outbox.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-phase2-authority.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-phase2-authority.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'copy-schema-version',
  },
  {
    file: 'tests/integration/commercial/commercial-phase2-authority.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'copy-schema-version',
  },
  {
    file: 'tests/integration/commercial/commercial-offer-v3.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-offer-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 1,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'sqlInsert',
    occurrence: 2,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 3,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 4,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 5,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 6,
    versionStrategy: 'literal-v1',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 7,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 8,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'sqlInsert',
    occurrence: 9,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'omitted',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'create',
    occurrence: 2,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 2,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'create',
    occurrence: 2,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 3,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'create',
    occurrence: 3,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 4,
    versionStrategy: 'literal-v3',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-direct-acceptance.integration.test.ts',
    table: 'CommercialQuote',
    operation: 'create',
    occurrence: 3,
    versionStrategy: 'dynamic',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-acquisition.integration.test.ts',
    table: 'CommercialPublication',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v2',
  },
  {
    file: 'tests/integration/commercial/commercial-quote-v3-acquisition.integration.test.ts',
    table: 'CommercialCampaignVersion',
    operation: 'create',
    occurrence: 1,
    versionStrategy: 'literal-v3',
  },
]

function propertyName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return ts.isComputedPropertyName(node) ? null : node.getText(sourceFile).replace(/^['"]|['"]$/gu, '')
}

function orderedPropertyInitializer(object: ts.ObjectLiteralExpression, name: string, sourceFile: ts.SourceFile): ts.Expression | null {
  let initializer: ts.Expression | null = null
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name))) {
      initializer = null
    } else if (ts.isPropertyAssignment(property) && propertyName(property.name, sourceFile) === name) {
      initializer = property.initializer
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      initializer = null
    }
  }
  return initializer
}

function objectVersionStrategy(object: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): VersionStrategy {
  let strategy: VersionStrategy = 'omitted'
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) strategy = 'spread-only'
    else if (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name)) strategy = 'dynamic'
    else if (ts.isPropertyAssignment(property) && propertyName(property.name, sourceFile) === 'schemaVersion') {
      strategy =
        ts.isNumericLiteral(property.initializer) && property.initializer.text === '1'
          ? 'literal-v1'
          : ts.isNumericLiteral(property.initializer) && property.initializer.text === '2'
            ? 'literal-v2'
            : ts.isNumericLiteral(property.initializer) && property.initializer.text === '3'
              ? 'literal-v3'
            : 'dynamic'
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'schemaVersion') strategy = 'dynamic'
  }
  return strategy
}

function prismaVersionStrategy(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  operation: Exclude<WriterOperation, 'sqlInsert'>,
): VersionStrategy {
  const argument = call.arguments[0]
  if (!argument || !ts.isObjectLiteralExpression(argument)) return 'dynamic'
  const data = orderedPropertyInitializer(argument, operation === 'upsert' ? 'create' : 'data', sourceFile)
  if (!data) return argument.properties.some(ts.isSpreadAssignment) ? 'spread-only' : 'omitted'
  if (ts.isObjectLiteralExpression(data)) return objectVersionStrategy(data, sourceFile)
  if (ts.isArrayLiteralExpression(data)) {
    const strategies = data.elements.map(element =>
      ts.isObjectLiteralExpression(element) ? objectVersionStrategy(element, sourceFile) : ('dynamic' as const),
    )
    if (strategies.length === 0) return 'omitted'
    if (strategies.every(strategy => strategy === 'literal-v1')) return 'literal-v1'
    if (strategies.every(strategy => strategy === 'literal-v2')) return 'literal-v2'
    if (strategies.every(strategy => strategy === 'literal-v3')) return 'literal-v3'
    return 'dynamic'
  }
  return 'dynamic'
}

interface BindingInfo {
  declaration: ts.Declaration
  initializer: ts.Expression | null
  immutable: boolean
  reassigned: boolean
  writes: ts.Expression[]
  delegateHint: keyof typeof TARGET_MODELS | null
}

interface LexicalScope {
  parent: LexicalScope | null
  kind: 'source' | 'function' | 'block'
  bindings: Map<string, BindingInfo>
}

interface SourceAnalysis {
  sourceFile: ts.SourceFile
  nodeScopes: WeakMap<ts.Node, LexicalScope>
  checker: ts.TypeChecker | null
}

type StringDomain =
  | { kind: 'FINITE'; candidates: AccessKeyResolution[] }
  | { kind: 'PATTERN'; prefix: string; suffix: string }
  | { kind: 'AMBIGUOUS' }

interface SqlSlot {
  domain: StringDomain
  resolvedText: string | null
  provenance: 'TEMPLATE_SPAN' | 'EXPRESSION_FALLBACK'
}

interface SqlResolution {
  text: string | null
  slots: Map<string, SqlSlot>
  targets: Set<TargetTable>
  insertIntent: boolean
  carrierTrusted: boolean
  valueDomain: StringDomain
  ownershipNode: ts.Expression | null
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function newScope(parent: LexicalScope | null, kind: LexicalScope['kind']): LexicalScope {
  return { parent, kind, bindings: new Map() }
}

function bindingTargetName(
  node: ts.PropertyName | ts.BindingName | undefined,
  sourceFile: ts.SourceFile,
): keyof typeof TARGET_MODELS | null {
  if (!node) return null
  const name = propertyName(node, sourceFile)
  return name && Object.prototype.hasOwnProperty.call(TARGET_MODELS, name) ? (name as keyof typeof TARGET_MODELS) : null
}

function registerBindingName(
  name: ts.BindingName,
  declaration: ts.Declaration,
  initializer: ts.Expression | null,
  immutable: boolean,
  scope: LexicalScope,
  sourceFile: ts.SourceFile,
  delegateHint: keyof typeof TARGET_MODELS | null = null,
): void {
  if (ts.isIdentifier(name)) {
    scope.bindings.set(name.text, {
      declaration,
      initializer,
      immutable,
      reassigned: false,
      writes: [],
      delegateHint,
    })
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        registerBindingName(element.name, element, null, immutable, scope, sourceFile)
        continue
      }
      registerBindingName(
        element.name,
        element,
        initializer,
        immutable,
        scope,
        sourceFile,
        bindingTargetName(element.propertyName ?? element.name, sourceFile),
      )
    }
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) registerBindingName(element.name, element, null, immutable, scope, sourceFile)
  }
}

function nearestVarScope(scope: LexicalScope): LexicalScope {
  let current = scope
  while (current.kind === 'block' && current.parent) current = current.parent
  return current
}

function lookupBinding(identifier: ts.Identifier, analysis: SourceAnalysis): BindingInfo | null {
  let scope: LexicalScope | null = analysis.nodeScopes.get(identifier) ?? null
  while (scope) {
    const binding = scope.bindings.get(identifier.text)
    if (binding) return binding
    scope = scope.parent
  }
  return null
}

function assignedIdentifiers(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) return [node]
  if (ts.isParenthesizedExpression(node)) return assignedIdentifiers(node.expression)
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => assignedIdentifiers(element))
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap(property => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name]
      if (ts.isPropertyAssignment(property)) return assignedIdentifiers(property.initializer)
      if (ts.isSpreadAssignment(property)) return assignedIdentifiers(property.expression)
      return []
    })
  }
  return []
}

function analyzeSource(sourceFile: ts.SourceFile, checker: ts.TypeChecker | null = null): SourceAnalysis {
  const root = newScope(null, 'source')
  const nodeScopes = new WeakMap<ts.Node, LexicalScope>()
  const analysis: SourceAnalysis = { sourceFile, nodeScopes, checker }

  const collect = (node: ts.Node, inherited: LexicalScope): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      inherited.bindings.set(node.name.text, {
        declaration: node,
        initializer: null,
        immutable: true,
        reassigned: false,
        writes: [],
        delegateHint: null,
      })
    }
    let scope = inherited
    if (node !== sourceFile && ts.isFunctionLike(node)) scope = newScope(inherited, 'function')
    else if (node !== sourceFile && (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isModuleBlock(node))) {
      scope = newScope(inherited, 'block')
    }
    nodeScopes.set(node, scope)

    if (ts.isParameter(node)) registerBindingName(node.name, node, node.initializer ?? null, false, scope, sourceFile)
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent
      const immutable = ts.isVariableDeclarationList(declarationList) && Boolean(declarationList.flags & ts.NodeFlags.Const)
      const declarationScope =
        ts.isVariableDeclarationList(declarationList) && Boolean(declarationList.flags & ts.NodeFlags.BlockScoped)
          ? scope
          : nearestVarScope(scope)
      registerBindingName(node.name, node, node.initializer ?? null, immutable, declarationScope, sourceFile)
    }
    ts.forEachChild(node, child => collect(child, scope))
  }
  collect(sourceFile, root)

  const markWrites = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
      for (const identifier of assignedIdentifiers(node.left)) {
        const binding = lookupBinding(identifier, analysis)
        if (binding) {
          binding.reassigned = true
          binding.writes.push(node.right)
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    ) {
      for (const identifier of assignedIdentifiers(node.operand)) {
        const binding = lookupBinding(identifier, analysis)
        if (binding) binding.reassigned = true
      }
    }
    ts.forEachChild(node, markWrites)
  }
  markWrites(sourceFile)
  return analysis
}

interface AccessKeyResolution {
  value: string
  trusted: boolean
}

interface AccessKeyResult {
  candidates: AccessKeyResolution[]
  complete: boolean
}

function mergedKeyTrust(candidates: AccessKeyResolution[]): Map<string, boolean> {
  const byValue = new Map<string, boolean>()
  for (const candidate of candidates) {
    byValue.set(candidate.value, (byValue.get(candidate.value) ?? true) && candidate.trusted)
  }
  return byValue
}

function typeKeyResolutions(node: ts.TypeNode): AccessKeyResult {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return { candidates: [{ value: node.literal.text, trusted: true }], complete: true }
  }
  if (ts.isParenthesizedTypeNode(node)) return typeKeyResolutions(node.type)
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map(typeKeyResolutions)
    const complete = members.every(member => member.complete)
    const byValue = mergedKeyTrust(members.flatMap(member => member.candidates))
    const ambiguous = byValue.size > 1
    return {
      candidates: [...byValue].map(([value, trusted]) => ({ value, trusted: trusted && complete && !ambiguous })),
      complete,
    }
  }
  return { candidates: [], complete: false }
}

function bindingTypeResolutions(binding: BindingInfo): AccessKeyResult | null {
  const declaration = binding.declaration
  if ((ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) && declaration.type) {
    return typeKeyResolutions(declaration.type)
  }
  return null
}

function keyResolutions(node: ts.Expression, analysis: SourceAnalysis, visiting = new Set<BindingInfo>()): AccessKeyResult {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { candidates: [{ value: node.text, trusted: true }], complete: true }
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return keyResolutions(node.expression, analysis, visiting)
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = keyResolutions(node.whenTrue, analysis, visiting)
    const whenFalse = keyResolutions(node.whenFalse, analysis, visiting)
    const complete = whenTrue.complete && whenFalse.complete
    const byValue = mergedKeyTrust([...whenTrue.candidates, ...whenFalse.candidates])
    const ambiguous = byValue.size > 1
    return {
      candidates: [...byValue].map(([value, trusted]) => ({ value, trusted: trusted && !ambiguous && complete })),
      complete,
    }
  }
  if (!ts.isIdentifier(node)) return { candidates: [], complete: false }
  const binding = lookupBinding(node, analysis)
  if (!binding || visiting.has(binding)) return { candidates: [], complete: false }
  const expressions = [binding.initializer, ...binding.writes].filter((value): value is ts.Expression => value !== null)
  const next = new Set([...visiting, binding])
  const expressionResolutions = expressions.map(expression => keyResolutions(expression, analysis, next))
  const typeResolution = bindingTypeResolutions(binding)
  const resolutions = [...expressionResolutions, ...(typeResolution ? [typeResolution] : [])]
  const complete =
    resolutions.length > 0 &&
    resolutions.every(resolution => resolution.complete) &&
    (binding.initializer !== null || typeResolution?.complete === true)
  const nested = resolutions.flatMap(resolution => resolution.candidates)
  const bindingTrusted = binding.immutable && !binding.reassigned && expressions.length === 1 && complete
  const byValue = new Map<string, boolean>()
  for (const resolution of nested) {
    const candidateTrusted = bindingTrusted && resolution.trusted
    byValue.set(resolution.value, (byValue.get(resolution.value) ?? true) && candidateTrusted)
  }
  const ambiguous = byValue.size > 1
  return {
    candidates: [...byValue].map(([value, trusted]) => ({ value, trusted: trusted && !ambiguous && complete })),
    complete,
  }
}

function ambiguousStringDomain(): StringDomain {
  return { kind: 'AMBIGUOUS' }
}

function finiteStringDomain(candidates: AccessKeyResolution[]): StringDomain {
  const byValue = mergedKeyTrust(candidates)
  if (byValue.size === 0) return ambiguousStringDomain()
  return { kind: 'FINITE', candidates: [...byValue].map(([value, trusted]) => ({ value, trusted })) }
}

function finiteTypeDomain(type: ts.Type): StringDomain {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.Never)) {
    return ambiguousStringDomain()
  }
  if (type.isStringLiteral()) return finiteStringDomain([{ value: type.value, trusted: true }])
  if (type.isUnion()) {
    const members = type.types.map(finiteTypeDomain)
    if (members.some(member => member.kind !== 'FINITE')) return ambiguousStringDomain()
    return finiteStringDomain(members.flatMap(member => (member.kind === 'FINITE' ? member.candidates : [])))
  }
  return ambiguousStringDomain()
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function finiteRowsDomain(
  expression: ts.Expression,
  column: number | null,
  analysis: SourceAnalysis,
  visiting: Set<BindingInfo>,
): StringDomain {
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    const binding = lookupBinding(unwrapped, analysis)
    if (!binding || binding.reassigned || !binding.immutable || !binding.initializer || visiting.has(binding)) {
      return ambiguousStringDomain()
    }
    return finiteRowsDomain(binding.initializer, column, analysis, new Set([...visiting, binding]))
  }
  if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length === 0) return ambiguousStringDomain()
  const candidates: AccessKeyResolution[] = []
  for (const element of unwrapped.elements) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return ambiguousStringDomain()
    const row = unwrapExpression(element)
    const selected =
      column === null
        ? row
        : ts.isArrayLiteralExpression(row) && row.elements[column] && !ts.isOmittedExpression(row.elements[column])
          ? row.elements[column]
          : null
    if (!selected || ts.isSpreadElement(selected)) return ambiguousStringDomain()
    const domain = stringDomain(selected, analysis, visiting)
    if (domain.kind !== 'FINITE') return ambiguousStringDomain()
    candidates.push(...domain.candidates)
  }
  return finiteStringDomain(candidates)
}

function iterationBindingDomain(binding: BindingInfo, analysis: SourceAnalysis, visiting: Set<BindingInfo>): StringDomain | null {
  const declaration = binding.declaration
  let variable: ts.VariableDeclaration | null = null
  let column: number | null = null
  if (ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
    column = declaration.parent.elements.indexOf(declaration)
    variable = ts.isVariableDeclaration(declaration.parent.parent) ? declaration.parent.parent : null
  } else if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    variable = declaration
  }
  if (
    variable &&
    ts.isVariableDeclarationList(variable.parent) &&
    ts.isForOfStatement(variable.parent.parent) &&
    variable.parent.parent.initializer === variable.parent
  ) {
    return finiteRowsDomain(variable.parent.parent.expression, column, analysis, visiting)
  }
  return null
}

function contextualParameterDomain(binding: BindingInfo, analysis: SourceAnalysis, visiting: Set<BindingInfo>): StringDomain | null {
  const declaration = binding.declaration
  if (!ts.isParameter(declaration) || !ts.isFunctionLike(declaration.parent)) return null
  const callback = declaration.parent
  const invocation = callback.parent
  if (!ts.isCallExpression(invocation) || !invocation.arguments.includes(callback as ts.Expression)) return null
  const producer = invocation.expression
  if (!ts.isCallExpression(producer) || producer.arguments.length === 0) return null
  const column = callback.parameters.indexOf(declaration)
  return finiteRowsDomain(producer.arguments[0], column, analysis, visiting)
}

function templateStringDomain(node: ts.TemplateExpression, analysis: SourceAnalysis, visiting: Set<BindingInfo>): StringDomain {
  let values = [node.head.text]
  let complete = true
  for (const span of node.templateSpans) {
    const domain = stringDomain(span.expression, analysis, visiting)
    if (domain.kind !== 'FINITE' || values.length * domain.candidates.length > 256) {
      complete = false
      break
    }
    values = values.flatMap(prefix => domain.candidates.map(candidate => prefix + candidate.value + span.literal.text))
  }
  if (complete && values.length > 0) return finiteStringDomain(values.map(value => ({ value, trusted: true })))

  let prefix = node.head.text
  for (const span of node.templateSpans) {
    const domain = stringDomain(span.expression, analysis, visiting)
    if (domain.kind !== 'FINITE' || domain.candidates.length !== 1) break
    prefix += domain.candidates[0].value + span.literal.text
  }
  let suffix = ''
  for (let index = node.templateSpans.length - 1; index >= 0; index -= 1) {
    const span = node.templateSpans[index]
    const domain = stringDomain(span.expression, analysis, visiting)
    if (domain.kind !== 'FINITE' || domain.candidates.length !== 1) {
      suffix = span.literal.text + suffix
      break
    }
    suffix = domain.candidates[0].value + span.literal.text + suffix
  }
  return { kind: 'PATTERN', prefix, suffix }
}

function stringDomain(node: ts.Expression, analysis: SourceAnalysis, visiting = new Set<BindingInfo>()): StringDomain {
  const unwrapped = unwrapExpression(node)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return finiteStringDomain([{ value: unwrapped.text, trusted: true }])
  }
  if (ts.isTemplateExpression(unwrapped)) return templateStringDomain(unwrapped, analysis, visiting)
  if (ts.isConditionalExpression(unwrapped)) {
    const branches = [stringDomain(unwrapped.whenTrue, analysis, visiting), stringDomain(unwrapped.whenFalse, analysis, visiting)]
    if (branches.some(branch => branch.kind !== 'FINITE')) return ambiguousStringDomain()
    return finiteStringDomain(branches.flatMap(branch => (branch.kind === 'FINITE' ? branch.candidates : [])))
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringDomain(unwrapped.left, analysis, visiting)
    const right = stringDomain(unwrapped.right, analysis, visiting)
    if (left.kind !== 'FINITE' || right.kind !== 'FINITE' || left.candidates.length * right.candidates.length > 256) {
      return ambiguousStringDomain()
    }
    return finiteStringDomain(
      left.candidates.flatMap(leftCandidate =>
        right.candidates.map(rightCandidate => ({
          value: leftCandidate.value + rightCandidate.value,
          trusted: leftCandidate.trusted && rightCandidate.trusted,
        })),
      ),
    )
  }
  if (ts.isCallExpression(unwrapped)) {
    if (unwrapped.arguments.length === 0) return ambiguousStringDomain()
    const argumentsResolved = unwrapped.arguments.map(argument => stringDomain(argument, analysis, visiting))
    if (argumentsResolved.some(argument => argument.kind !== 'FINITE')) return ambiguousStringDomain()
    return finiteStringDomain(argumentsResolved.flatMap(argument => (argument.kind === 'FINITE' ? argument.candidates : [])))
  }
  if (ts.isTaggedTemplateExpression(unwrapped)) return stringDomain(unwrapped.template, analysis, visiting)
  if (!ts.isIdentifier(unwrapped)) return ambiguousStringDomain()
  const binding = lookupBinding(unwrapped, analysis)
  if (!binding) {
    return analysis.checker ? finiteTypeDomain(analysis.checker.getTypeAtLocation(unwrapped)) : ambiguousStringDomain()
  }
  if (visiting.has(binding) || binding.reassigned) return ambiguousStringDomain()
  if (ts.isVariableDeclaration(binding.declaration) && !binding.immutable) return ambiguousStringDomain()
  const next = new Set([...visiting, binding])
  const iteration = iterationBindingDomain(binding, analysis, next)
  if (iteration) return iteration
  const contextual = contextualParameterDomain(binding, analysis, next)
  if (contextual?.kind === 'FINITE') return contextual
  const declaration = binding.declaration
  if ((ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) && declaration.type) {
    const typed = typeKeyResolutions(declaration.type)
    if (typed.complete && typed.candidates.length > 0) return finiteStringDomain(typed.candidates)
    return ambiguousStringDomain()
  }
  if (analysis.checker) {
    const checked = finiteTypeDomain(analysis.checker.getTypeAtLocation(unwrapped))
    if (checked.kind === 'FINITE') return checked
  }
  if (!binding.initializer) return ambiguousStringDomain()
  return stringDomain(binding.initializer, analysis, next)
}

function accessKeyResolutions(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, analysis: SourceAnalysis): AccessKeyResult {
  if (ts.isPropertyAccessExpression(node)) return { candidates: [{ value: node.name.text, trusted: true }], complete: true }
  return node.argumentExpression ? keyResolutions(node.argumentExpression, analysis) : { candidates: [], complete: false }
}

function symbolOriginatesFromPrismaClient(symbol: ts.Symbol, checker: ts.TypeChecker, visiting = new Set<ts.Symbol>()): boolean {
  if (visiting.has(symbol)) return false
  const next = new Set([...visiting, symbol])
  for (const declaration of symbol.declarations ?? []) {
    let current: ts.Node | undefined = declaration
    while (current) {
      if (
        (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) &&
        current.moduleSpecifier &&
        ts.isStringLiteral(current.moduleSpecifier) &&
        current.moduleSpecifier.text === '@prisma/client'
      ) {
        return true
      }
      current = current.parent
    }
    const normalized = declaration.getSourceFile().fileName.replace(/\\/gu, '/')
    if (normalized.includes('/node_modules/@prisma/client/') || normalized.includes('/node_modules/.prisma/client/')) return true
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return false
  const aliased = checker.getAliasedSymbol(symbol)
  return aliased !== symbol && symbolOriginatesFromPrismaClient(aliased, checker, next)
}

function isAuthenticPrismaSqlBuilder(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, analysis: SourceAnalysis): boolean {
  if (!analysis.checker) return false
  const operation = accessKeyResolutions(node, analysis)
  if (
    !operation.complete ||
    operation.candidates.length !== 1 ||
    !operation.candidates[0].trusted ||
    !['raw', 'sql'].includes(operation.candidates[0].value)
  ) {
    return false
  }
  const symbol = analysis.checker.getSymbolAtLocation(node.expression)
  return symbol ? symbolOriginatesFromPrismaClient(symbol, analysis.checker) : false
}

function isAuthenticPrismaSqlExecutor(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, analysis: SourceAnalysis): boolean {
  if (!analysis.checker) return false
  const operation = accessKeyResolutions(node, analysis)
  if (
    !operation.complete ||
    operation.candidates.length !== 1 ||
    !operation.candidates[0].trusted ||
    !['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'].includes(operation.candidates[0].value)
  ) {
    return false
  }
  const symbol = analysis.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : (node.argumentExpression ?? node))
  return symbol ? symbolOriginatesFromPrismaClient(symbol, analysis.checker) : false
}

function hasAuthenticPrismaSqlCarrier(node: ts.Expression, analysis: SourceAnalysis, visiting = new Set<BindingInfo>()): boolean {
  const unwrapped = unwrapExpression(node)
  if (
    ts.isTaggedTemplateExpression(unwrapped) &&
    (ts.isPropertyAccessExpression(unwrapped.tag) || ts.isElementAccessExpression(unwrapped.tag))
  ) {
    return isAuthenticPrismaSqlBuilder(unwrapped.tag, analysis)
  }
  if (
    ts.isCallExpression(unwrapped) &&
    (ts.isPropertyAccessExpression(unwrapped.expression) || ts.isElementAccessExpression(unwrapped.expression))
  ) {
    return isAuthenticPrismaSqlBuilder(unwrapped.expression, analysis)
  }
  if (!ts.isIdentifier(unwrapped)) return false
  const binding = lookupBinding(unwrapped, analysis)
  if (!binding || visiting.has(binding) || !binding.immutable || binding.reassigned || !binding.initializer) return false
  return hasAuthenticPrismaSqlCarrier(binding.initializer, analysis, new Set([...visiting, binding]))
}

function recognizablePrismaRoot(node: ts.Expression, analysis: SourceAnalysis, visiting = new Set<BindingInfo>()): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return recognizablePrismaRoot(node.expression, analysis, visiting)
  }
  if (ts.isIdentifier(node)) {
    if (/prisma/iu.test(node.text)) return true
    const binding = lookupBinding(node, analysis)
    if (!binding || visiting.has(binding)) return false
    const next = new Set([...visiting, binding])
    return [binding.initializer, ...binding.writes].some(
      expression => expression !== null && recognizablePrismaRoot(expression, analysis, next),
    )
  }
  if (ts.isPropertyAccessExpression(node)) return /prisma/iu.test(node.name.text)
  return false
}

function delegateResolutions(
  node: ts.Expression,
  analysis: SourceAnalysis,
  visiting = new Set<BindingInfo>(),
): Array<{ table: TargetTable; trusted: boolean }> {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return delegateResolutions(node.expression, analysis, visiting)
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const access = accessKeyResolutions(node, analysis)
    if (ts.isElementAccessExpression(node) && !access.complete && recognizablePrismaRoot(node.expression, analysis)) {
      return [...TARGET_TABLES].map(table => ({ table, trusted: false }))
    }
    const direct = access.candidates
      .filter(resolution => Object.prototype.hasOwnProperty.call(TARGET_MODELS, resolution.value))
      .map(resolution => ({
        table: TARGET_MODELS[resolution.value as keyof typeof TARGET_MODELS],
        trusted: resolution.trusted && access.complete,
      }))
    if (direct.length > 0) return direct
  }
  if (!ts.isIdentifier(node)) return []
  const binding = lookupBinding(node, analysis)
  if (!binding || visiting.has(binding)) return []
  const trusted = binding.immutable && !binding.reassigned
  if (binding.delegateHint) return [{ table: TARGET_MODELS[binding.delegateHint], trusted }]
  const candidates = [binding.initializer, ...binding.writes].filter((value): value is ts.Expression => value !== null)
  const next = new Set([...visiting, binding])
  const nested = candidates.flatMap(candidate => delegateResolutions(candidate, analysis, next))
  const byTable = new Map<TargetTable, boolean>()
  for (const resolution of nested) {
    const candidateTrusted = trusted && candidates.length === 1 && resolution.trusted
    byTable.set(resolution.table, (byTable.get(resolution.table) ?? true) && candidateTrusted)
  }
  return [...byTable].map(([table, candidateTrusted]) => ({ table, trusted: candidateTrusted }))
}

function targetsInText(text: string): Set<TargetTable> {
  return new Set([...TARGET_TABLES].filter(table => new RegExp(`(?:^|[^A-Za-z0-9_])${table}(?:$|[^A-Za-z0-9_])`, 'u').test(text)))
}

function mergedTargets(...sets: ReadonlySet<TargetTable>[]): Set<TargetTable> {
  return new Set(sets.flatMap(set => [...set]))
}

function targetsFromDomain(domain: StringDomain): Set<TargetTable> {
  if (domain.kind !== 'FINITE') return new Set()
  return new Set(
    domain.candidates
      .map(candidate => candidate.value)
      .filter((candidate): candidate is TargetTable => TARGET_TABLES.has(candidate as TargetTable)),
  )
}

function mergedSlots(...maps: ReadonlyMap<string, SqlSlot>[]): Map<string, SqlSlot> {
  return new Map(maps.flatMap(map => [...map]))
}

function singletonDomainText(domain: StringDomain): string | null {
  return domain.kind === 'FINITE' && domain.candidates.length === 1 ? domain.candidates[0].value : null
}

function sqlSlotMarker(node: ts.Expression): string {
  return `P3BSQLSLOT${Math.max(0, node.pos)}X${Math.max(0, node.end)}`
}

function emptySqlResolution(): SqlResolution {
  return {
    text: null,
    slots: new Map(),
    targets: new Set(),
    insertIntent: false,
    carrierTrusted: false,
    valueDomain: ambiguousStringDomain(),
    ownershipNode: null,
  }
}

function sqlExpressionResolution(node: ts.Expression, analysis: SourceAnalysis, visiting = new Set<BindingInfo>()): SqlResolution {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      text: node.text,
      slots: new Map(),
      targets: targetsInText(node.text),
      insertIntent: /\bINSERT\b/iu.test(node.text),
      carrierTrusted: true,
      valueDomain: finiteStringDomain([{ value: node.text, trusted: true }]),
      ownershipNode: node,
    }
  }
  if (ts.isTemplateExpression(node)) {
    const expressions = node.templateSpans.map(span => sqlExpressionResolution(span.expression, analysis, visiting))
    const slots = mergedSlots(...expressions.map(expression => expression.slots))
    let text = node.head.text
    node.templateSpans.forEach((span, index) => {
      const expression = expressions[index]
      const marker = sqlSlotMarker(span.expression)
      const domain = stringDomain(span.expression, analysis)
      slots.set(marker, {
        domain,
        resolvedText: expression.text ?? singletonDomainText(domain),
        provenance: 'TEMPLATE_SPAN',
      })
      text += marker
      text += span.literal.text
    })
    return {
      text,
      targets: mergedTargets(targetsInText(text ?? ''), ...expressions.map(expression => expression.targets)),
      insertIntent: /\bINSERT\b/iu.test(text ?? '') || expressions.some(expression => expression.insertIntent),
      slots,
      carrierTrusted: true,
      valueDomain: templateStringDomain(node, analysis, visiting),
      ownershipNode: node,
    }
  }
  if (ts.isTaggedTemplateExpression(node)) {
    if (ts.isPropertyAccessExpression(node.tag) || ts.isElementAccessExpression(node.tag)) {
      const tagName = accessKeyResolutions(node.tag, analysis).candidates.map(candidate => candidate.value)
      if (tagName.includes('sql')) {
        const template = sqlExpressionResolution(node.template, analysis, visiting)
        return { ...template, carrierTrusted: template.carrierTrusted && isAuthenticPrismaSqlBuilder(node.tag, analysis) }
      }
    }
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return sqlExpressionResolution(node.expression, analysis, visiting)
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlExpressionResolution(node.left, analysis, visiting)
    const right = sqlExpressionResolution(node.right, analysis, visiting)
    const slots = mergedSlots(left.slots, right.slots)
    const render = (expression: ts.Expression, resolution: SqlResolution): string => {
      if (resolution.text !== null) return resolution.text
      const marker = sqlSlotMarker(expression)
      const domain = stringDomain(expression, analysis)
      slots.set(marker, {
        domain,
        resolvedText: singletonDomainText(domain),
        provenance: 'EXPRESSION_FALLBACK',
      })
      return marker
    }
    return {
      text: render(node.left, left) + render(node.right, right),
      slots,
      targets: mergedTargets(left.targets, right.targets),
      insertIntent: left.insertIntent || right.insertIntent,
      carrierTrusted: left.carrierTrusted && right.carrierTrusted,
      valueDomain: stringDomain(node, analysis),
      ownershipNode: node,
    }
  }
  if (ts.isCallExpression(node)) {
    const argumentsResolved = node.arguments.map(argument => sqlExpressionResolution(argument, analysis, visiting))
    const valueDomain = stringDomain(node, analysis)
    const knownTransparentSqlBuilder =
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
      isAuthenticPrismaSqlBuilder(node.expression, analysis)
    const soleSqlArgument = argumentsResolved.length === 1 && argumentsResolved[0].insertIntent ? argumentsResolved[0] : null
    return {
      text: soleSqlArgument?.text ?? null,
      slots: soleSqlArgument?.slots ?? new Map(),
      targets: mergedTargets(targetsFromDomain(valueDomain), ...argumentsResolved.map(argument => argument.targets)),
      insertIntent: argumentsResolved.some(argument => argument.insertIntent),
      carrierTrusted: knownTransparentSqlBuilder && soleSqlArgument !== null && soleSqlArgument.carrierTrusted,
      valueDomain,
      ownershipNode: soleSqlArgument?.ownershipNode ?? null,
    }
  }
  if (ts.isIdentifier(node)) {
    const binding = lookupBinding(node, analysis)
    if (!binding || visiting.has(binding)) {
      const domain = stringDomain(node, analysis)
      const exact = domain.kind === 'FINITE' && domain.candidates.length === 1 ? domain.candidates[0].value : null
      return {
        text: exact,
        slots: new Map(),
        targets: targetsFromDomain(domain),
        insertIntent: exact !== null && /\bINSERT\b/iu.test(exact),
        carrierTrusted: false,
        valueDomain: domain,
        ownershipNode: node,
      }
    }
    const next = new Set([...visiting, binding])
    const resolutions = [binding.initializer, ...binding.writes]
      .filter((value): value is ts.Expression => value !== null)
      .map(value => sqlExpressionResolution(value, analysis, next))
    const targets = mergedTargets(...resolutions.map(resolution => resolution.targets))
    const insertIntent = resolutions.some(resolution => resolution.insertIntent)
    const exactTexts = new Set(resolutions.map(resolution => resolution.text).filter((text): text is string => text !== null))
    const domain = stringDomain(node, analysis)
    for (const target of targetsFromDomain(domain)) targets.add(target)
    const typeText = domain.kind === 'FINITE' && domain.candidates.length === 1 ? domain.candidates[0].value : null
    const text =
      resolutions.length === 1
        ? resolutions[0].text
        : resolutions.length === 0
          ? typeText
          : exactTexts.size === 1
            ? [...exactTexts][0]
            : null
    return {
      text,
      slots: resolutions.length === 1 ? resolutions[0].slots : new Map(),
      targets,
      insertIntent: insertIntent || (text !== null && /\bINSERT\b/iu.test(text)),
      carrierTrusted: binding.immutable && !binding.reassigned && resolutions.length === 1 && resolutions[0].carrierTrusted,
      valueDomain: domain,
      ownershipNode: resolutions.length === 1 ? resolutions[0].ownershipNode : node,
    }
  }
  return emptySqlResolution()
}

function splitSqlList(source: string): string[] {
  const values: string[] = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote && source[index + 1] === quote) index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      values.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  values.push(source.slice(start).trim())
  return values
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote && source[index + 1] === quote) index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return index
  }
  return -1
}

function topLevelFrom(source: string): number {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote && source[index + 1] === quote) index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (depth === 0 && /^FROM\b/iu.test(source.slice(index))) return index
  }
  return source.length
}

function sqlInsertStrategies(sql: string): Array<{ table: TargetTable; versionStrategy: VersionStrategy }> {
  const results: Array<{ table: TargetTable; versionStrategy: VersionStrategy }> = []
  const insert =
    /\bINSERT\s+INTO\s+(?:(?:"[A-Za-z][A-Za-z0-9_]*"|[A-Za-z][A-Za-z0-9_]*)\s*\.\s*)?(?:"([A-Za-z][A-Za-z0-9_]*)"|([A-Za-z][A-Za-z0-9_]*))/giu
  for (const match of sql.matchAll(insert)) {
    const table = (match[1] ?? match[2]) as TargetTable
    if (!TARGET_TABLES.has(table)) continue
    const columnsOpen = sql.indexOf('(', match.index! + match[0].length)
    const columnsClose = columnsOpen >= 0 ? matchingParen(sql, columnsOpen) : -1
    if (columnsClose < 0) {
      results.push({ table, versionStrategy: 'omitted' })
      continue
    }
    const columns = splitSqlList(sql.slice(columnsOpen + 1, columnsClose)).map(column => column.replace(/^"|"$/gu, '').trim())
    const versionIndex = columns.indexOf('schemaVersion')
    if (versionIndex < 0) {
      results.push({ table, versionStrategy: 'omitted' })
      continue
    }
    const tail = sql.slice(columnsClose + 1).trimStart()
    if (/^VALUES\b/iu.test(tail)) {
      const values: string[] = []
      let cursor = tail.search(/\(/u)
      while (cursor >= 0 && tail[cursor] === '(') {
        const valuesClose = matchingParen(tail, cursor)
        if (valuesClose < 0) break
        const value = splitSqlList(tail.slice(cursor + 1, valuesClose))[versionIndex]
        if (value !== undefined) values.push(value.trim())
        cursor = valuesClose + 1
        while (/\s/u.test(tail[cursor] ?? '')) cursor += 1
        if (tail[cursor] !== ',') break
        cursor += 1
        while (/\s/u.test(tail[cursor] ?? '')) cursor += 1
      }
      results.push({
        table,
        versionStrategy:
          values.length > 0 && values.every(value => value === '1')
            ? 'literal-v1'
            : values.length > 0 && values.every(value => value === '2')
              ? 'literal-v2'
              : values.length > 0 && values.every(value => value === '3')
                ? 'literal-v3'
              : 'dynamic',
      })
      continue
    }
    if (/^SELECT\b/iu.test(tail)) {
      const selection = tail.replace(/^SELECT\b/iu, '')
      const value = splitSqlList(selection.slice(0, topLevelFrom(selection)))[versionIndex]?.trim()
      results.push({
        table,
        versionStrategy:
          value === '"schemaVersion"' || value === 'schemaVersion'
            ? 'copy-schema-version'
            : value === '1'
              ? 'literal-v1'
              : value === '2'
                ? 'literal-v2'
                : value === '3'
                  ? 'literal-v3'
                : 'dynamic',
      })
      continue
    }
    results.push({ table, versionStrategy: 'dynamic' })
  }
  return results
}

interface ResolvedSqlInsert {
  table: TargetTable
  versionStrategy: VersionStrategy
  statement: number
}

type SqlSlotRole = 'VERB' | 'INTO_BOUNDARY' | 'TARGET' | 'COLUMNS' | 'SCHEMA_CELL' | 'OTHER'

interface RenderedSqlSlot {
  slot: SqlSlot
  start: number
  end: number
}

interface SqlTextRange {
  start: number
  end: number
}

function renderSqlForDiscovery(resolution: SqlResolution): { text: string; slots: RenderedSqlSlot[] } {
  const source = resolution.text ?? ''
  const occurrences = [...resolution.slots].flatMap(([marker, slot]) => {
    const found: Array<{ marker: string; slot: SqlSlot; start: number }> = []
    let cursor = source.indexOf(marker)
    while (cursor >= 0) {
      found.push({ marker, slot, start: cursor })
      cursor = source.indexOf(marker, cursor + marker.length)
    }
    return found
  })
  occurrences.sort((left, right) => left.start - right.start || left.marker.localeCompare(right.marker))
  let sourceCursor = 0
  let text = ''
  const slots: RenderedSqlSlot[] = []
  for (const occurrence of occurrences) {
    if (occurrence.start < sourceCursor) continue
    text += source.slice(sourceCursor, occurrence.start)
    const replacement = occurrence.slot.resolvedText ?? occurrence.marker
    const start = text.length
    text += replacement
    slots.push({ slot: occurrence.slot, start, end: text.length })
    sourceCursor = occurrence.start + occurrence.marker.length
  }
  text += source.slice(sourceCursor)
  return { text, slots }
}

function rangesOverlap(left: SqlTextRange, right: SqlTextRange): boolean {
  return left.start < right.end && right.start < left.end
}

function sqlListRanges(source: string, start: number, end: number): SqlTextRange[] {
  const ranges: SqlTextRange[] = []
  let itemStart = start
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = start; index < end; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote && source[index + 1] === quote) index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      ranges.push({ start: itemStart, end: index })
      itemStart = index + 1
    }
  }
  ranges.push({ start: itemStart, end })
  return ranges
}

function statementSlotRoles(
  text: string,
  slots: RenderedSqlSlot[],
  match: RegExpMatchArray,
  statementEnd: number,
): Array<{ rendered: RenderedSqlSlot; role: SqlSlotRole }> {
  const matchStart = match.index!
  const targetToken = match[1] ?? match[2]
  const targetOffset = match[0].lastIndexOf(targetToken)
  const target = { start: matchStart + targetOffset, end: matchStart + targetOffset + targetToken.length }
  const insertEnd = matchStart + match[0].toUpperCase().indexOf('INSERT') + 'INSERT'.length
  const columnsOpen = text.indexOf('(', matchStart + match[0].length)
  const columnsClose = columnsOpen >= 0 ? matchingParen(text, columnsOpen) : -1
  const roles = slots
    .filter(slot => rangesOverlap(slot, { start: matchStart, end: statementEnd }))
    .map(rendered => ({ rendered, role: 'OTHER' as SqlSlotRole }))
  const assign = (range: SqlTextRange, role: SqlSlotRole): void => {
    for (const entry of roles) if (rangesOverlap(entry.rendered, range)) entry.role = role
  }
  assign({ start: matchStart, end: insertEnd }, 'VERB')
  assign({ start: insertEnd, end: target.start }, 'INTO_BOUNDARY')
  assign(target, 'TARGET')
  if (columnsClose < 0) return roles
  assign({ start: columnsOpen, end: columnsClose + 1 }, 'COLUMNS')
  const columns = sqlListRanges(text, columnsOpen + 1, columnsClose)
  const versionIndex = columns.findIndex(
    range =>
      text
        .slice(range.start, range.end)
        .replace(/^\s*"|"\s*$/gu, '')
        .trim() === 'schemaVersion',
  )
  const tailStart = columnsClose + 1
  const tail = text.slice(tailStart, statementEnd)
  const boundary = tail.match(/^\s*(VALUES|SELECT)\b/iu)
  if (!boundary) return roles
  const boundaryStart = tailStart + boundary[0].search(/\S/u)
  const boundaryEnd = boundaryStart + boundary[1].length
  assign({ start: tailStart, end: boundaryEnd }, 'INTO_BOUNDARY')
  if (versionIndex < 0) return roles
  if (boundary[1].toUpperCase() === 'VALUES') {
    let rowOpen = text.indexOf('(', boundaryEnd)
    while (rowOpen >= 0 && rowOpen < statementEnd) {
      const rowClose = matchingParen(text, rowOpen)
      if (rowClose < 0 || rowClose >= statementEnd) break
      const value = sqlListRanges(text, rowOpen + 1, rowClose)[versionIndex]
      if (value) assign(value, 'SCHEMA_CELL')
      let cursor = rowClose + 1
      while (/\s/u.test(text[cursor] ?? '')) cursor += 1
      if (text[cursor] !== ',') break
      rowOpen = text.indexOf('(', cursor + 1)
    }
  } else {
    const selectionStart = boundaryEnd
    const selection = text.slice(selectionStart, statementEnd)
    const selectionEnd = selectionStart + topLevelFrom(selection)
    const value = sqlListRanges(text, selectionStart, selectionEnd)[versionIndex]
    if (value) assign(value, 'SCHEMA_CELL')
  }
  return roles
}

function patternIsForeign(domain: Extract<StringDomain, { kind: 'PATTERN' }>): boolean {
  return [...TARGET_TABLES].every(
    table =>
      !table.startsWith(domain.prefix) || !table.endsWith(domain.suffix) || table.length < domain.prefix.length + domain.suffix.length,
  )
}

function resolvedDomainTargets(domain: StringDomain, file: string, callsiteLine: number): TargetTable[] {
  if (domain.kind === 'FINITE') return [...targetsFromDomain(domain)]
  if (domain.kind === 'PATTERN' && patternIsForeign(domain)) return []
  throw new Error(`P3_2B_UNRESOLVED_SQL_INSERT_TARGET:${file}:${callsiteLine}`)
}

type SqlStatementOutcome =
  | { kind: 'COMMERCIAL_MATCHES'; matches: ResolvedSqlInsert[] }
  | { kind: 'PROVEN_FOREIGN'; statement: number }
  | { kind: 'NO_INSERT'; statement: number }
  | { kind: 'UNRESOLVED_COMMERCIAL'; statement: number }

function sqlStatementRanges(source: string): SqlTextRange[] {
  const ranges: SqlTextRange[] = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote && source[index + 1] === quote) index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ';' && depth === 0) {
      if (source.slice(start, index).trim().length > 0) ranges.push({ start, end: index })
      start = index + 1
    }
  }
  if (source.slice(start).trim().length > 0) ranges.push({ start, end: source.length })
  return ranges
}

function patternCouldMatchExact(domain: Extract<StringDomain, { kind: 'PATTERN' }>, value: string): boolean {
  return value.startsWith(domain.prefix) && value.endsWith(domain.suffix) && value.length >= domain.prefix.length + domain.suffix.length
}

function domainCouldContain(domain: StringDomain, value: string): boolean {
  if (domain.kind === 'AMBIGUOUS') return true
  if (domain.kind === 'PATTERN') return patternCouldMatchExact(domain, value)
  return domain.candidates.some(candidate => candidate.value.toUpperCase() === value.toUpperCase())
}

function sqlTargetAt(source: string, offset: number): { range: SqlTextRange; token: string } | null {
  const tail = source.slice(offset)
  const match = tail.match(
    /^\s*(?:(?:"[A-Za-z][A-Za-z0-9_]*"|[A-Za-z][A-Za-z0-9_]*)\s*\.\s*)?(?:"([A-Za-z][A-Za-z0-9_]*)"|([A-Za-z][A-Za-z0-9_]*))/u,
  )
  if (!match) return null
  const token = match[1] ?? match[2]
  const tokenOffset = match[0].lastIndexOf(token)
  const start = offset + tokenOffset
  return { range: { start, end: start + token.length }, token }
}

function targetCommerciality(
  target: { range: SqlTextRange; token: string } | null,
  slots: RenderedSqlSlot[],
): 'COMMERCIAL' | 'FOREIGN' | 'UNRESOLVED' {
  if (!target) return 'UNRESOLVED'
  const targetSlots = slots.filter(slot => rangesOverlap(slot, target.range))
  if (targetSlots.length > 1) return 'UNRESOLVED'
  if (targetSlots.length === 0) return TARGET_TABLES.has(target.token as TargetTable) ? 'COMMERCIAL' : 'FOREIGN'
  const domain = targetSlots[0].slot.domain
  if (domain.kind === 'AMBIGUOUS') return 'UNRESOLVED'
  if (domain.kind === 'PATTERN') return patternIsForeign(domain) ? 'FOREIGN' : 'UNRESOLVED'
  return domain.candidates.some(candidate => TARGET_TABLES.has(candidate.value as TargetTable)) ? 'COMMERCIAL' : 'FOREIGN'
}

function unresolvedStructuralOutcome(
  text: string,
  slots: RenderedSqlSlot[],
  statement: number,
): Exclude<SqlStatementOutcome, { kind: 'COMMERCIAL_MATCHES' }> {
  const into = /\bINTO\b/iu.exec(text)
  if (into) {
    const beforeInto = { start: 0, end: into.index }
    const verbSlots = slots.filter(slot => rangesOverlap(slot, beforeInto))
    const literalInsert = /\bINSERT\s*$/iu.test(text.slice(0, into.index))
    const possibleInsert = literalInsert || verbSlots.some(slot => domainCouldContain(slot.slot.domain, 'INSERT'))
    if (!possibleInsert) return { kind: 'NO_INSERT', statement }
    const target = sqlTargetAt(text, into.index + into[0].length)
    const commerciality = targetCommerciality(target, slots)
    return commerciality === 'FOREIGN' ? { kind: 'PROVEN_FOREIGN', statement } : { kind: 'UNRESOLVED_COMMERCIAL', statement }
  }

  const insert = /\bINSERT\b/iu.exec(text)
  if (!insert) return { kind: 'NO_INSERT', statement }
  let cursor = insert.index + insert[0].length
  while (/\s/u.test(text[cursor] ?? '')) cursor += 1
  const boundary = slots.find(slot => slot.start <= cursor && slot.end >= cursor)
  if (!boundary || !domainCouldContain(boundary.slot.domain, 'INTO')) return { kind: 'NO_INSERT', statement }
  const target = sqlTargetAt(text, boundary.end)
  const commerciality = targetCommerciality(target, slots)
  return commerciality === 'FOREIGN' ? { kind: 'PROVEN_FOREIGN', statement } : { kind: 'UNRESOLVED_COMMERCIAL', statement }
}

function resolvedSqlStatements(resolution: SqlResolution): SqlStatementOutcome[] {
  if (resolution.text === null) return []
  const rendered = renderSqlForDiscovery(resolution)
  const insertTarget =
    /\bINSERT\s+INTO\s+(?:(?:"[A-Za-z][A-Za-z0-9_]*"|[A-Za-z][A-Za-z0-9_]*)\s*\.\s*)?(?:"([A-Za-z][A-Za-z0-9_]*)"|([A-Za-z][A-Za-z0-9_]*))/iu
  return sqlStatementRanges(rendered.text).map((range, statement) => {
    const statementSql = rendered.text.slice(range.start, range.end)
    const statementSlots = rendered.slots
      .filter(slot => rangesOverlap(slot, range))
      .map(slot => ({ slot: slot.slot, start: slot.start - range.start, end: slot.end - range.start }))
    const match = insertTarget.exec(statementSql)
    if (!match) return unresolvedStructuralOutcome(statementSql, statementSlots, statement)
    const targetToken = match[1] ?? match[2]
    const targetOffset = match[0].lastIndexOf(targetToken)
    const targetStart = match.index + targetOffset
    const targetRange = { start: targetStart, end: targetStart + targetToken.length }
    const roles = statementSlotRoles(statementSql, statementSlots, match, statementSql.length)
    const targetSlots = roles.filter(entry => entry.role === 'TARGET')
    if (targetSlots.length > 1) return { kind: 'UNRESOLVED_COMMERCIAL', statement }
    const structuralSlot = roles.some(entry => entry.role !== 'OTHER')
    const forceDynamic = !resolution.carrierTrusted || structuralSlot
    if (targetSlots.length === 0) {
      const matches = sqlInsertStrategies(statementSql).map(result => ({
        ...result,
        versionStrategy: forceDynamic ? 'dynamic' : result.versionStrategy,
        statement,
      }))
      return matches.length > 0 ? { kind: 'COMMERCIAL_MATCHES', matches } : { kind: 'PROVEN_FOREIGN', statement }
    }
    const domain = targetSlots[0].rendered.slot.domain
    if (domain.kind === 'AMBIGUOUS' || (domain.kind === 'PATTERN' && !patternIsForeign(domain))) {
      return { kind: 'UNRESOLVED_COMMERCIAL', statement }
    }
    const targetCandidates = domain.kind === 'FINITE' ? [...targetsFromDomain(domain)] : []
    if (targetCandidates.length === 0) return { kind: 'PROVEN_FOREIGN', statement }
    const matches = targetCandidates.flatMap(table => {
      const materialized = statementSql.slice(0, targetRange.start) + table + statementSql.slice(targetRange.end)
      return sqlInsertStrategies(materialized).some(result => result.table === table)
        ? [{ table, versionStrategy: 'dynamic' as const, statement }]
        : []
    })
    return matches.length > 0 ? { kind: 'COMMERCIAL_MATCHES', matches } : { kind: 'UNRESOLVED_COMMERCIAL', statement }
  })
}

interface SourceOccurrenceControls {
  injectDuplicateOwnership?: true
}

interface DiscoveredOccurrence extends Omit<WriterOccurrence, 'occurrence'> {
  directPosition: number
  statement: number
  ownerPosition: number
}

type DeclaredFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

function declaredFunction(binding: BindingInfo): DeclaredFunction | null {
  if (ts.isFunctionDeclaration(binding.declaration)) return binding.declaration
  const initializer = binding.initializer ? unwrapExpression(binding.initializer) : null
  return initializer && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) ? initializer : null
}

type ExecutorEffect = 'EXECUTOR' | 'NON_EXECUTOR' | 'UNKNOWN'
type ValueFlow = 'NONE' | 'SCALAR_DERIVED' | 'SQL_BEARING' | 'OPAQUE'

interface CallbackEffectFlow {
  parameter: number
  argumentMask: number[]
}

interface FunctionEffectSummary {
  effect: ExecutorEffect
  returnFlow: ValueFlow
  callbackFlows: CallbackEffectFlow[]
}

interface FunctionEffectState {
  memo: WeakMap<DeclaredFunction, Map<string, FunctionEffectSummary>>
  inProgress: WeakMap<DeclaredFunction, Set<string>>
}

const FUNCTION_EFFECT_STATES = new WeakMap<SourceAnalysis, FunctionEffectState>()

function functionEffectState(analysis: SourceAnalysis): FunctionEffectState {
  const existing = FUNCTION_EFFECT_STATES.get(analysis)
  if (existing) return existing
  const created: FunctionEffectState = { memo: new WeakMap(), inProgress: new WeakMap() }
  FUNCTION_EFFECT_STATES.set(analysis, created)
  return created
}

function combineExecutorEffect(left: ExecutorEffect, right: ExecutorEffect): ExecutorEffect {
  if (left === 'EXECUTOR' || right === 'EXECUTOR') return 'EXECUTOR'
  if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN'
  return 'NON_EXECUTOR'
}

function combineValueFlow(left: ValueFlow, right: ValueFlow): ValueFlow {
  const rank: Record<ValueFlow, number> = { NONE: 0, SCALAR_DERIVED: 1, SQL_BEARING: 2, OPAQUE: 3 }
  return rank[left] >= rank[right] ? left : right
}

function exactTypeScriptCreateSourceFile(call: ts.CallExpression, analysis: SourceAnalysis): boolean {
  if (!analysis.checker || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'createSourceFile') return false
  const symbol = analysis.checker.getSymbolAtLocation(call.expression.name)
  if (!symbol) return false
  return (symbol.declarations ?? []).some(declaration => {
    const source = declaration.getSourceFile().fileName.replace(/\\/gu, '/')
    const declarationName = ts.getNameOfDeclaration(declaration)
    const name = declarationName && ts.isIdentifier(declarationName) ? declarationName.text : null
    return name === 'createSourceFile' && /\/node_modules\/typescript\/lib\/typescript\.d\.ts$/u.test(source)
  })
}

function declarationContainerName(declaration: ts.Declaration): string | null {
  let current: ts.Node | undefined = declaration.parent
  while (current && !ts.isSourceFile(current)) {
    if ((ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current)) && current.name) return current.name.text
    current = current.parent
  }
  return null
}

function exactStandardLibraryCallFlow(call: ts.CallExpression, analysis: SourceAnalysis): ValueFlow | null {
  if (!analysis.checker || !ts.isPropertyAccessExpression(call.expression)) return null
  const symbol = analysis.checker.getSymbolAtLocation(call.expression.name)
  if (!symbol) return null
  const declarations = symbol.declarations ?? []
  const receiverType = analysis.checker.getTypeAtLocation(call.expression.expression)
  const operationName = call.expression.name.text
  const receiverMatches = (container: 'RegExp' | 'String'): boolean =>
    container === 'String'
      ? Boolean(receiverType.flags & ts.TypeFlags.StringLike)
      : receiverType.getSymbol()?.getName() === 'RegExp' || analysis.checker?.typeToString(receiverType) === 'RegExp'
  const exact = (container: 'RegExp' | 'String', operations: ReadonlySet<string>): boolean =>
    receiverMatches(container) &&
    operations.has(operationName) &&
    declarations.some(declaration => {
      const source = declaration.getSourceFile().fileName.replace(/\\/gu, '/')
      return /\/node_modules\/typescript\/lib\/lib\.es5\.d\.ts$/u.test(source) && declarationContainerName(declaration) === container
    })
  if (exact('RegExp', new Set(['test']))) return 'SCALAR_DERIVED'
  if (exact('String', new Set(['indexOf', 'search']))) return 'SCALAR_DERIVED'
  if (
    exact('String', new Set(['slice', 'substring', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'concat', 'split', 'match']))
  ) {
    return 'SQL_BEARING'
  }
  return null
}

function expressionIsSyntacticallyString(node: ts.Expression, analysis: SourceAnalysis, visiting = new Set<BindingInfo>()): boolean {
  const unwrapped = unwrapExpression(node)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped) || ts.isTemplateExpression(unwrapped)) return true
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      expressionIsSyntacticallyString(unwrapped.left, analysis, visiting) ||
      expressionIsSyntacticallyString(unwrapped.right, analysis, visiting)
    )
  }
  if (!ts.isIdentifier(unwrapped)) return false
  const binding = lookupBinding(unwrapped, analysis)
  if (!binding || visiting.has(binding)) return false
  const declaration = binding.declaration
  if ((ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) && declaration.type) {
    if (declaration.type.kind === ts.SyntaxKind.StringKeyword) return true
    const typed = typeKeyResolutions(declaration.type)
    if (typed.complete && typed.candidates.length > 0) return true
  }
  if (!binding.initializer) return false
  return expressionIsSyntacticallyString(binding.initializer, analysis, new Set([...visiting, binding]))
}

function syntacticallyProvenStringCallFlow(call: ts.CallExpression, analysis: SourceAnalysis): ValueFlow | null {
  if (!ts.isPropertyAccessExpression(call.expression) || !expressionIsSyntacticallyString(call.expression.expression, analysis)) return null
  if (call.expression.name.text === 'indexOf' || call.expression.name.text === 'search') return 'SCALAR_DERIVED'
  if (
    ['slice', 'substring', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'concat', 'split', 'match'].includes(
      call.expression.name.text,
    )
  ) {
    return 'SQL_BEARING'
  }
  return null
}

function exactBuiltInCallFlow(call: ts.CallExpression, analysis: SourceAnalysis): ValueFlow | null {
  if (exactTypeScriptCreateSourceFile(call, analysis)) return 'NONE'
  return exactStandardLibraryCallFlow(call, analysis) ?? syntacticallyProvenStringCallFlow(call, analysis)
}

function binaryValueFlow(operator: ts.SyntaxKind, left: ValueFlow, right: ValueFlow): ValueFlow {
  const combined = combineValueFlow(left, right)
  if (combined === 'NONE') return 'NONE'
  if (combined === 'OPAQUE') return 'OPAQUE'
  if (operator === ts.SyntaxKind.PlusToken && combined === 'SQL_BEARING') return 'SQL_BEARING'
  return 'SCALAR_DERIVED'
}

function expressionValueFlow(
  node: ts.Node,
  parameters: ReadonlySet<ts.ParameterDeclaration>,
  analysis: SourceAnalysis,
  state = functionEffectState(analysis),
  visiting = new Set<BindingInfo>(),
): ValueFlow {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return expressionValueFlow(node.expression, parameters, analysis, state, visiting)
  }
  if (ts.isIdentifier(node)) {
    const binding = lookupBinding(node, analysis)
    if (!binding) return 'NONE'
    if (ts.isParameter(binding.declaration) && parameters.has(binding.declaration)) return 'SQL_BEARING'
    if (visiting.has(binding)) return 'OPAQUE'
    const next = new Set([...visiting, binding])
    return [binding.initializer, ...binding.writes]
      .filter((expression): expression is ts.Expression => expression !== null)
      .reduce<ValueFlow>(
        (flow, expression) => combineValueFlow(flow, expressionValueFlow(expression, parameters, analysis, state, next)),
        'NONE',
      )
  }
  if (ts.isPropertyAccessExpression(node)) {
    const receiver = expressionValueFlow(node.expression, parameters, analysis, state, visiting)
    if (receiver === 'NONE') return 'NONE'
    if (node.name.text === 'length') return 'SCALAR_DERIVED'
    return receiver
  }
  if (ts.isElementAccessExpression(node)) {
    return combineValueFlow(
      expressionValueFlow(node.expression, parameters, analysis, state, visiting),
      node.argumentExpression ? expressionValueFlow(node.argumentExpression, parameters, analysis, state, visiting) : 'NONE',
    )
  }
  if (ts.isCallExpression(node)) {
    const argumentFlows = node.arguments.map(argument => expressionValueFlow(argument, parameters, analysis, state, visiting))
    const calleeFlow = expressionValueFlow(node.expression, parameters, analysis, state, visiting)
    const dependent = [calleeFlow, ...argumentFlows].reduce<ValueFlow>(combineValueFlow, 'NONE')
    if (dependent === 'NONE') return 'NONE'
    const builtIn = exactBuiltInCallFlow(node, analysis)
    if (builtIn !== null) return builtIn
    if (ts.isIdentifier(node.expression)) {
      const binding = lookupBinding(node.expression, analysis)
      const called = binding ? declaredFunction(binding) : null
      if (called) {
        const mask = new Set(
          argumentFlows.map((flow, index) => (flow === 'SQL_BEARING' || flow === 'OPAQUE' ? index : -1)).filter(index => index >= 0),
        )
        return mask.size > 0 ? declaredFunctionEffectSummary(called, mask, analysis, state).returnFlow : dependent
      }
    }
    return 'OPAQUE'
  }
  if (ts.isBinaryExpression(node)) {
    if (assignmentOperator(node.operatorToken.kind)) return expressionValueFlow(node.right, parameters, analysis, state, visiting)
    return binaryValueFlow(
      node.operatorToken.kind,
      expressionValueFlow(node.left, parameters, analysis, state, visiting),
      expressionValueFlow(node.right, parameters, analysis, state, visiting),
    )
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return expressionValueFlow(node.operand, parameters, analysis, state, visiting) === 'NONE' ? 'NONE' : 'SCALAR_DERIVED'
  }
  if (ts.isConditionalExpression(node)) {
    const condition = expressionValueFlow(node.condition, parameters, analysis, state, visiting)
    const branches = combineValueFlow(
      expressionValueFlow(node.whenTrue, parameters, analysis, state, visiting),
      expressionValueFlow(node.whenFalse, parameters, analysis, state, visiting),
    )
    return branches === 'NONE' && condition !== 'NONE' ? 'SCALAR_DERIVED' : branches
  }
  if (ts.isTemplateExpression(node)) {
    const flow = node.templateSpans.reduce<ValueFlow>(
      (combined, span) => combineValueFlow(combined, expressionValueFlow(span.expression, parameters, analysis, state, visiting)),
      'NONE',
    )
    return flow === 'NONE' ? 'NONE' : flow === 'OPAQUE' ? 'OPAQUE' : 'SQL_BEARING'
  }
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    let flow: ValueFlow = 'NONE'
    ts.forEachChild(node, child => {
      flow = combineValueFlow(flow, expressionValueFlow(child, parameters, analysis, state, visiting))
    })
    return flow
  }
  let flow: ValueFlow = 'NONE'
  ts.forEachChild(node, child => {
    flow = combineValueFlow(flow, expressionValueFlow(child, parameters, analysis, state, visiting))
  })
  return flow
}

function expressionCarriesParameter(
  node: ts.Node,
  parameters: ReadonlySet<ts.ParameterDeclaration>,
  analysis: SourceAnalysis,
  state = functionEffectState(analysis),
): boolean {
  const flow = expressionValueFlow(node, parameters, analysis, state)
  return flow === 'SQL_BEARING' || flow === 'OPAQUE'
}

function bindingDeclaredInsideFunction(binding: BindingInfo, fn: DeclaredFunction): boolean {
  return (
    binding.declaration.getSourceFile() === fn.getSourceFile() && binding.declaration.pos >= fn.pos && binding.declaration.end <= fn.end
  )
}

function rootBinding(node: ts.Expression, analysis: SourceAnalysis): BindingInfo | null {
  const unwrapped = unwrapExpression(node)
  if (ts.isIdentifier(unwrapped)) return lookupBinding(unwrapped, analysis)
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return rootBinding(unwrapped.expression, analysis)
  }
  return null
}

function callbackEffect(
  expression: ts.Expression,
  argumentMask: ReadonlySet<number>,
  analysis: SourceAnalysis,
  state: FunctionEffectState,
): ExecutorEffect {
  const unwrapped = unwrapExpression(expression)
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    const summary = declaredFunctionEffectSummary(unwrapped, argumentMask, analysis, state)
    return summary.callbackFlows.length === 0 ? summary.effect : combineExecutorEffect(summary.effect, 'UNKNOWN')
  }
  if (ts.isIdentifier(unwrapped)) {
    return boundIdentifierExecutor(unwrapped, analysis, argumentMask, undefined, state)
  }
  return 'UNKNOWN'
}

function mergeCalledFunctionSummary(
  summary: FunctionEffectSummary,
  call: ts.CallExpression,
  currentFunction: DeclaredFunction,
  analysis: SourceAnalysis,
  state: FunctionEffectState,
  mark: (effect: ExecutorEffect) => void,
  callbackFlows: CallbackEffectFlow[],
): void {
  mark(summary.effect)
  for (const flow of summary.callbackFlows) {
    const callback = call.arguments[flow.parameter]
    if (!callback) {
      mark('UNKNOWN')
      continue
    }
    const unwrapped = unwrapExpression(callback)
    if (ts.isIdentifier(unwrapped)) {
      const binding = lookupBinding(unwrapped, analysis)
      if (binding && ts.isParameter(binding.declaration) && binding.declaration.parent === currentFunction) {
        callbackFlows.push({ parameter: currentFunction.parameters.indexOf(binding.declaration), argumentMask: flow.argumentMask })
        continue
      }
    }
    mark(callbackEffect(callback, new Set(flow.argumentMask), analysis, state))
  }
}

function provenLiteralBoolean(node: ts.Expression): boolean | null {
  const unwrapped = unwrapExpression(node)
  if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true
  if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
    const nested = provenLiteralBoolean(unwrapped.operand)
    return nested === null ? null : !nested
  }
  return null
}

function declaredFunctionEffectSummary(
  fn: DeclaredFunction,
  argumentMask: ReadonlySet<number>,
  analysis: SourceAnalysis,
  state = functionEffectState(analysis),
): FunctionEffectSummary {
  const key = [...argumentMask].sort((left, right) => left - right).join(',')
  const memo = state.memo.get(fn)
  const cached = memo?.get(key)
  if (cached) return cached
  const inProgress = state.inProgress.get(fn) ?? new Set<string>()
  if (inProgress.has(key)) return { effect: 'UNKNOWN', returnFlow: 'OPAQUE', callbackFlows: [] }
  inProgress.add(key)
  state.inProgress.set(fn, inProgress)

  const parameters = new Set(
    [...argumentMask].map(index => fn.parameters[index]).filter((parameter): parameter is ts.ParameterDeclaration => Boolean(parameter)),
  )
  let effect: ExecutorEffect = 'NON_EXECUTOR'
  let returnFlow: ValueFlow = 'NONE'
  const callbackFlows: CallbackEffectFlow[] = []
  const mark = (next: ExecutorEffect): void => {
    effect = combineExecutorEffect(effect, next)
  }
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return
    if (ts.isIfStatement(node)) {
      visit(node.expression)
      const condition = provenLiteralBoolean(node.expression)
      if (condition !== false) visit(node.thenStatement)
      if (condition !== true && node.elseStatement) visit(node.elseStatement)
      return
    }
    if (ts.isCallExpression(node)) {
      const taintedArguments = node.arguments
        .map((argument, index) => (expressionCarriesParameter(argument, parameters, analysis, state) ? index : -1))
        .filter(index => index >= 0)
      const calleeIsTainted = expressionCarriesParameter(node.expression, parameters, analysis, state)
      if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
        if (taintedArguments.length > 0) {
          const operation = accessKeyResolutions(node.expression, analysis)
          const recognizedExecutor = operation.candidates.some(candidate =>
            ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', 'query', 'execute'].includes(candidate.value),
          )
          if (recognizedExecutor) mark('EXECUTOR')
          else if (exactBuiltInCallFlow(node, analysis) === null) {
            const receiver = rootBinding(node.expression.expression, analysis)
            const locallyOwned = receiver !== null && bindingDeclaredInsideFunction(receiver, fn)
            if (!locallyOwned) mark('UNKNOWN')
          }
        }
      } else if (ts.isIdentifier(node.expression)) {
        const called = lookupBinding(node.expression, analysis)
        const calledParameter = called && ts.isParameter(called.declaration) && called.declaration.parent === fn ? called.declaration : null
        if (calledParameter) {
          const callbackParameter = fn.parameters.indexOf(calledParameter)
          if (argumentMask.has(callbackParameter) && calleeIsTainted) mark('UNKNOWN')
          else if (taintedArguments.length > 0) callbackFlows.push({ parameter: callbackParameter, argumentMask: taintedArguments })
        } else if (taintedArguments.length > 0) {
          if (!called) mark('UNKNOWN')
          else {
            const calledFunction = declaredFunction(called)
            if (!calledFunction) mark('UNKNOWN')
            else {
              const summary = declaredFunctionEffectSummary(calledFunction, new Set(taintedArguments), analysis, state)
              mergeCalledFunctionSummary(summary, node, fn, analysis, state, mark, callbackFlows)
            }
          }
        }
      } else if (taintedArguments.length > 0 || calleeIsTainted) {
        mark('UNKNOWN')
      }
    } else if (ts.isReturnStatement(node) && node.expression) {
      returnFlow = combineValueFlow(returnFlow, expressionValueFlow(node.expression, parameters, analysis, state))
    } else if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
      if (expressionCarriesParameter(node.right, parameters, analysis, state)) {
        if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) mark('UNKNOWN')
        else {
          const assigned = assignedIdentifiers(node.left)
          if (
            assigned.some(identifier => {
              const binding = lookupBinding(identifier, analysis)
              return !binding || !bindingDeclaredInsideFunction(binding, fn)
            })
          ) {
            mark('UNKNOWN')
          }
        }
      }
    } else if (ts.isThrowStatement(node) && node.expression && expressionCarriesParameter(node.expression, parameters, analysis, state)) {
      mark('UNKNOWN')
    } else if (
      ts.isNewExpression(node) &&
      node.arguments?.some(argument => expressionCarriesParameter(argument, parameters, analysis, state))
    ) {
      mark('UNKNOWN')
    }
    ts.forEachChild(node, visit)
  }
  if (!fn.body) effect = 'UNKNOWN'
  else {
    visit(fn.body)
    if (!ts.isBlock(fn.body)) returnFlow = combineValueFlow(returnFlow, expressionValueFlow(fn.body, parameters, analysis, state))
  }
  const summary = { effect, returnFlow: fn.body ? returnFlow : ('OPAQUE' as const), callbackFlows }
  inProgress.delete(key)
  const entries = memo ?? new Map<string, FunctionEffectSummary>()
  entries.set(key, summary)
  state.memo.set(fn, entries)
  return summary
}

function declaredFunctionExecutor(
  fn: DeclaredFunction,
  analysis: SourceAnalysis,
  argumentMask: ReadonlySet<number>,
  callArguments: readonly ts.Expression[] | undefined,
  state = functionEffectState(analysis),
): ExecutorEffect {
  const summary = declaredFunctionEffectSummary(fn, argumentMask, analysis, state)
  let effect =
    summary.returnFlow === 'SQL_BEARING' || summary.returnFlow === 'OPAQUE'
      ? combineExecutorEffect(summary.effect, 'UNKNOWN')
      : summary.effect
  for (const flow of summary.callbackFlows) {
    const callback = callArguments?.[flow.parameter]
    effect = combineExecutorEffect(effect, callback ? callbackEffect(callback, new Set(flow.argumentMask), analysis, state) : 'UNKNOWN')
  }
  return effect
}

function boundIdentifierExecutor(
  identifier: ts.Identifier,
  analysis: SourceAnalysis,
  argumentMask: ReadonlySet<number>,
  callArguments: readonly ts.Expression[] | undefined,
  state = functionEffectState(analysis),
  visiting = new Set<BindingInfo>(),
): ExecutorEffect {
  const binding = lookupBinding(identifier, analysis)
  if (!binding) return 'UNKNOWN'
  if (visiting.has(binding)) return 'UNKNOWN'
  const initializer = binding.initializer ? unwrapExpression(binding.initializer) : null
  if (initializer && ts.isIdentifier(initializer)) {
    return boundIdentifierExecutor(initializer, analysis, argumentMask, callArguments, state, new Set([...visiting, binding]))
  }
  if (
    initializer &&
    ts.isCallExpression(initializer) &&
    (ts.isPropertyAccessExpression(initializer.expression) || ts.isElementAccessExpression(initializer.expression))
  ) {
    const bindOperation = accessKeyResolutions(initializer.expression, analysis)
    if (bindOperation.complete && bindOperation.candidates.some(candidate => candidate.value === 'bind')) {
      const boundTarget = initializer.expression.expression
      if (ts.isPropertyAccessExpression(boundTarget) || ts.isElementAccessExpression(boundTarget)) {
        const operation = accessKeyResolutions(boundTarget, analysis)
        if (
          operation.candidates.some(candidate =>
            ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', 'query', 'execute'].includes(candidate.value),
          )
        ) {
          return argumentMask.has(0) ? 'EXECUTOR' : 'NON_EXECUTOR'
        }
      }
    }
  }
  const fn = declaredFunction(binding)
  return fn ? declaredFunctionExecutor(fn, analysis, argumentMask, callArguments, state) : 'UNKNOWN'
}

function callbackContextRequiresDynamic(node: ts.Node, analysis: SourceAnalysis): boolean {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      let argument: ts.Expression = current
      let parent = current.parent
      while (
        parent &&
        (ts.isParenthesizedExpression(parent) ||
          ts.isAsExpression(parent) ||
          ts.isTypeAssertionExpression(parent) ||
          ts.isNonNullExpression(parent))
      ) {
        argument = parent
        parent = parent.parent
      }
      if (parent && ts.isCallExpression(parent)) {
        const argumentIndex = parent.arguments.indexOf(argument)
        if (argumentIndex >= 0) {
          if (!ts.isIdentifier(parent.expression)) return true
          return boundIdentifierExecutor(parent.expression, analysis, new Set([argumentIndex]), parent.arguments) !== 'NON_EXECUTOR'
        }
      }
      return false
    }
    current = current.parent
  }
  return false
}

function sourceOccurrencesFromAst(
  file: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | null,
  controls: SourceOccurrenceControls = {},
): Omit<WriterOccurrence, 'occurrence'>[] {
  const discovered: DiscoveredOccurrence[] = []
  const analysis = analyzeSource(sourceFile, checker)
  const ownedSql = new Map<string, { owner: ts.Node; direct: boolean }>()
  const callsites: Array<ts.CallExpression | ts.TaggedTemplateExpression> = []
  const collectCallsites = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) callsites.push(node)
    ts.forEachChild(node, collectCallsites)
  }
  collectCallsites(sourceFile)
  callsites.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
  const callsiteOrdinals = new Map(callsites.map((node, index) => [node, index + 1]))
  let duplicateInjected = false
  const claimOwnership = (
    key: string,
    owner: ts.Node,
    directArgument: ts.Expression,
    ownershipNode: ts.Expression,
    statement: number,
    table: TargetTable,
  ): boolean => {
    const callsite = callsiteOrdinals.get(owner as ts.CallExpression | ts.TaggedTemplateExpression) ?? 0
    const argument = ts.isCallExpression(owner) ? owner.arguments.indexOf(directArgument) : 0
    const diagnostic = `P3_2B_DUPLICATE_SQL_OWNERSHIP:${file}:${
      sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line + 1
    }:callsite${callsite}:arg${argument}:statement${statement + 1}:${table}`
    const direct = directArgument === ownershipNode
    const existing = ownedSql.get(key)
    if (existing) {
      const ownerContainsExisting = owner.pos <= existing.owner.pos && owner.end >= existing.owner.end
      if ((existing.direct && !direct) || ownerContainsExisting) return false
      throw new Error(diagnostic)
    }
    ownedSql.set(key, { owner, direct })
    if (controls.injectDuplicateOwnership && !duplicateInjected) {
      duplicateInjected = true
      if (ownedSql.has(key)) throw new Error(diagnostic)
    }
    return true
  }
  const recordSqlResolution = (
    resolution: SqlResolution,
    owner: ts.Node,
    directArgument: ts.Expression,
    forceDynamic = false,
    allowOpaque = false,
  ): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line + 1
    const outcomes = resolvedSqlStatements(resolution)
    if (outcomes.some(outcome => outcome.kind === 'UNRESOLVED_COMMERCIAL')) {
      throw new Error(`P3_2B_UNRESOLVED_SQL_INSERT_TARGET:${file}:${line}`)
    }
    const parsed = outcomes.flatMap(outcome => (outcome.kind === 'COMMERCIAL_MATCHES' ? outcome.matches : []))
    if (parsed.length > 0) {
      for (const result of parsed) {
        const ownershipNode = resolution.ownershipNode ?? directArgument
        const ownershipKey = `${ownershipNode.pos}:${ownershipNode.end}:${result.statement}:${result.table}`
        if (!claimOwnership(ownershipKey, owner, directArgument, ownershipNode, result.statement, result.table)) continue
        discovered.push({
          ...result,
          versionStrategy: forceDynamic ? 'dynamic' : result.versionStrategy,
          file,
          operation: 'sqlInsert',
          line,
          directPosition: directArgument.getStart(sourceFile),
          ownerPosition: owner.getStart(sourceFile),
        })
      }
      return
    }
    if (!allowOpaque) return
    if (resolution.text !== null) return
    const opaqueTargets =
      resolution.targets.size > 0
        ? [...resolution.targets]
        : resolution.valueDomain.kind === 'FINITE'
          ? resolvedDomainTargets(resolution.valueDomain, file, line)
          : []
    for (const table of opaqueTargets) {
      const ownershipNode = resolution.ownershipNode ?? directArgument
      const ownershipKey = `${ownershipNode.pos}:${ownershipNode.end}:0:${table}`
      if (!claimOwnership(ownershipKey, owner, directArgument, ownershipNode, 0, table)) continue
      discovered.push({
        table,
        versionStrategy: 'dynamic',
        file,
        operation: 'sqlInsert',
        line,
        directPosition: directArgument.getStart(sourceFile),
        statement: 0,
        ownerPosition: owner.getStart(sourceFile),
      })
    }
  }
  const processNode = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const receiver = node.expression.expression
      const operationResult = accessKeyResolutions(node.expression, analysis)
      const delegates = delegateResolutions(receiver, analysis)
      const writerOperations = new Map<Exclude<WriterOperation, 'sqlInsert'>, boolean>()
      for (const operation of operationResult.candidates) {
        if (isPrismaWriterOperation(operation.value)) {
          writerOperations.set(operation.value, operation.trusted && operationResult.complete)
        }
      }
      if (!operationResult.complete && delegates.length > 0) {
        writerOperations.set('create', false)
        writerOperations.set('createMany', false)
        writerOperations.set('createManyAndReturn', false)
        writerOperations.set('upsert', false)
      }
      for (const [operation, operationTrusted] of writerOperations) {
        for (const delegate of delegates) {
          discovered.push({
            file,
            table: delegate.table,
            operation,
            versionStrategy: operationTrusted && delegate.trusted ? prismaVersionStrategy(node, sourceFile, operation) : 'dynamic',
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            directPosition: node.getStart(sourceFile),
            statement: 0,
            ownerPosition: node.getStart(sourceFile),
          })
        }
      }

      const recognizedSqlExecutor = operationResult.candidates.some(operation =>
        ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', 'query'].includes(operation.value),
      )
      const authenticPrismaExecutor = isAuthenticPrismaSqlExecutor(node.expression, analysis)
      const knownSqlBuilder = isAuthenticPrismaSqlBuilder(node.expression, analysis)
      if (!knownSqlBuilder) {
        const directArguments = recognizedSqlExecutor ? node.arguments.slice(0, 1) : node.arguments
        for (const directArgument of directArguments) {
          const resolution = sqlExpressionResolution(directArgument, analysis)
          if (recognizedSqlExecutor || resolution.insertIntent) {
            recordSqlResolution(
              resolution,
              node,
              directArgument,
              !recognizedSqlExecutor ||
                !operationResult.complete ||
                operationResult.candidates.some(operation => !operation.trusted) ||
                (callbackContextRequiresDynamic(node, analysis) &&
                  !authenticPrismaExecutor &&
                  !hasAuthenticPrismaSqlCarrier(directArgument, analysis)),
              true,
            )
          }
        }
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      for (const [argumentIndex, directArgument] of node.arguments.entries()) {
        const resolution = sqlExpressionResolution(directArgument, analysis)
        if (!resolution.insertIntent) continue
        const executor = boundIdentifierExecutor(node.expression, analysis, new Set([argumentIndex]), node.arguments)
        if (executor !== 'NON_EXECUTOR') {
          recordSqlResolution(resolution, node, directArgument, true, executor === 'EXECUTOR')
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node) && (ts.isPropertyAccessExpression(node.tag) || ts.isElementAccessExpression(node.tag))) {
      const operationResult = accessKeyResolutions(node.tag, analysis)
      const sqlResolution = sqlExpressionResolution(node.template, analysis)
      const recognizedSqlExecutor = operationResult.candidates.some(operation => ['$queryRaw', '$executeRaw'].includes(operation.value))
      const authenticPrismaExecutor = isAuthenticPrismaSqlExecutor(node.tag, analysis)
      const knownSqlBuilder = isAuthenticPrismaSqlBuilder(node.tag, analysis)
      if (!knownSqlBuilder && (recognizedSqlExecutor || sqlResolution.insertIntent)) {
        recordSqlResolution(
          sqlResolution,
          node,
          node.template,
          !recognizedSqlExecutor ||
            !operationResult.complete ||
            operationResult.candidates.some(operation => !operation.trusted) ||
            (callbackContextRequiresDynamic(node, analysis) && !authenticPrismaExecutor),
        )
      }
    }
  }
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit)
    processNode(node)
  }
  visit(sourceFile)
  return discovered
    .sort(
      (left, right) =>
        left.directPosition - right.directPosition ||
        left.statement - right.statement ||
        (TARGET_TABLE_ORDER.get(left.table) ?? Number.MAX_SAFE_INTEGER) -
          (TARGET_TABLE_ORDER.get(right.table) ?? Number.MAX_SAFE_INTEGER) ||
        left.ownerPosition - right.ownerPosition,
    )
    .map(({ directPosition: _directPosition, statement: _statement, ownerPosition: _ownerPosition, ...occurrence }) => occurrence)
}

function sourceOccurrences(file: string, source: string, controls: SourceOccurrenceControls = {}): Omit<WriterOccurrence, 'occurrence'>[] {
  if (extname(file) === '.sql') {
    return sqlInsertStrategies(source).map(result => ({ ...result, file, operation: 'sqlInsert', line: 1 }))
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  return sourceOccurrencesFromAst(file, sourceFile, null, controls)
}

const PRISMA_CLIENT_MODULE_SPECIFIER = ['@prisma', 'client'].join('/')

const A_PRIME_SYNTHETIC_SOURCES = {
  a1SerializableForeign: {
    file: 'p3b-a-prime-a1-serializable-foreign.ts',
    source: `const tableName = \`serializable_retry_\${process.pid}_\${Date.now()}\`; client.query(\`INSERT INTO "\${tableName}" ("id") VALUES (1)\`)`,
  },
  a1PrefixPublication: {
    file: 'p3b-a-prime-a1-prefix-publication.ts',
    source: `async function insert(client: Client, prefix: string) { const table = \`\${prefix}\${'Public'}ation\`; await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
  },
  a1CommercialMiddle: {
    file: 'p3b-a-prime-a1-commercial-middle.ts',
    source: `async function insert(client: Client, middle: string) { const table = \`Commercial\${middle}\`; await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
  },
  a1MixedFinite: {
    file: 'p3b-a-prime-a1-mixed-finite.ts',
    source: `for (const table of ['CatalogBrand', 'CommercialPublication'] as const) { client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
  },
  a1MultiSpanSuffix: {
    file: 'p3b-a-prime-a1-multi-span-suffix.ts',
    source: `async function insert(client: Client, prefix: string) { const table = \`\${prefix}\${'Commercial'}Quote\`; await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
  },
  a2DynamicVerb: {
    file: 'p3b-a-prime-a2-dynamic-verb.ts',
    source: `async function insert(client: Client, verb: string) { await client.query(\`\${verb} INTO "CommercialPublication" ("schemaVersion") VALUES (1)\`) }`,
  },
  a2DynamicInto: {
    file: 'p3b-a-prime-a2-dynamic-into.ts',
    source: `async function insert(client: Client, into: string) { await client.query(\`INSERT \${into} "CommercialPublication" ("schemaVersion") VALUES (1)\`) }`,
  },
  a2NestedVerb: {
    file: 'p3b-a-prime-a2-nested-verb.ts',
    source: `async function insert(client: Client, verb: 'INSERT') { await client.query(\`\${identity(verb)} INTO "CommercialPublication" ("schemaVersion") VALUES (1)\`) }`,
  },
  a2NestedTarget: {
    file: 'p3b-a-prime-a2-nested-target.ts',
    source: `async function insert(client: Client, table: 'CommercialCampaignVersion') { await client.query(\`INSERT INTO "\${quoteIdentifier(identity(table))}" ("schemaVersion") VALUES (1)\`) }`,
  },
  a2SchemaSlot: {
    file: 'p3b-a-prime-a2-schema-slot.ts',
    source: `async function insert(client: Client, schemaVersion: number) { await client.query(\`INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (\${schemaVersion})\`) }`,
  },
  a2WhereCopy: {
    file: 'p3b-a-prime-a2-where-copy.ts',
    source: `async function copy(client: Client, id: string) { await client.query(\`INSERT INTO "CommercialQuote" ("id", "schemaVersion") SELECT "id", "schemaVersion" FROM "CommercialQuote" WHERE "id" = \${id}\`) }`,
  },
  a3DeclaredRun: {
    file: 'p3b-a-prime-a3-declared-run.ts',
    source: `function run(sql: string) { return client.query(sql) } run('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3ArrowAlias: {
    file: 'p3b-a-prime-a3-arrow-alias.ts',
    source: `const run = (sql: string) => client.query(sql); const execute = run; execute('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a3Noop: {
    file: 'p3b-a-prime-a3-noop.ts',
    source: `function discard(sql: string) { return sql.length } discard('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a3RecursiveOpaque: {
    file: 'p3b-a-prime-a3-recursive-opaque.ts',
    source: `function dispatch(sql: string): unknown { return flag ? dispatch(sql) : opaque(sql) } dispatch('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a3NoNameTrust: {
    file: 'p3b-a-prime-a3-no-name-trust.ts',
    source: `function sourceOccurrences(sql: string) { return client.query(sql) } sourceOccurrences('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3PureLocalParser: {
    file: 'p3b-a-prime-a3-pure-local-parser.ts',
    source: `function parse(sql: string) { return sql.trim().split(' ') } function inspect(sql: string) { return parse(sql).length } inspect('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3LocalShadowQuery: {
    file: 'p3b-a-prime-a3-local-shadow-query.ts',
    source: `const client = { query: (value: string) => value }; function run(sql: string) { return client.query(sql) } run('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a3ExternalPropertyStorage: {
    file: 'p3b-a-prime-a3-external-property-storage.ts',
    source: `const externalState = {} as { sql?: string }; function store(sql: string) { externalState.sql = sql } store('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3GlobalStorage: {
    file: 'p3b-a-prime-a3-global-storage.ts',
    source: `let stored = ''; function store(sql: string) { stored = sql } store('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a3ContainerStorage: {
    file: 'p3b-a-prime-a3-container-storage.ts',
    source: `const stored: string[] = []; function store(sql: string) { stored.push(sql) } store('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a3IdentityReturn: {
    file: 'p3b-a-prime-a3-identity-return.ts',
    source: `function identity(sql: string) { return sql } identity('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3OpaqueReturn: {
    file: 'p3b-a-prime-a3-opaque-return.ts',
    source: `function envelope(sql: string) { return { sql } } envelope('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a3ImmediateSqlCallback: {
    file: 'p3b-a-prime-a3-immediate-sql-callback.ts',
    source: `function immediately(callback: () => unknown) { return callback() } immediately(() => client.query('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)'))`,
  },
  a3EscapingSqlCallback: {
    file: 'p3b-a-prime-a3-escaping-sql-callback.ts',
    source: `const handlers: Array<() => unknown> = []; function register(callback: () => unknown) { handlers.push(callback) } register(() => client.query('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)'))`,
  },
  a3MutualCycle: {
    file: 'p3b-a-prime-a3-mutual-cycle.ts',
    source: `function first(sql: string): unknown { return second(sql) } function second(sql: string): unknown { return first(sql) } first('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a3ImmediatePureTransform: {
    file: 'p3b-a-prime-a3-immediate-pure-transform.ts',
    source: `function apply(sql: string, transform: (value: string) => string) { return transform(sql).length } apply('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)', value => value.trim())`,
  },
  a3CanonicalRegexpTest: {
    file: 'p3b-a-prime-a3-canonical-regexp-test.ts',
    source: `function matches(sql: string) { return /^INSERT\\b/u.test(sql) } matches('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3ScalarLength: {
    file: 'p3b-a-prime-a3-scalar-length.ts',
    source: `function length(sql: string): number { return sql.length } length('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3ScalarIndex: {
    file: 'p3b-a-prime-a3-scalar-index.ts',
    source: `function index(sql: string): number { const found: number = sql.indexOf('INSERT'); return found } index('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a3ScalarBoolean: {
    file: 'p3b-a-prime-a3-scalar-boolean.ts',
    source: `function present(sql: string): boolean { return sql.length > 0 } present('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a3TrimReturn: {
    file: 'p3b-a-prime-a3-trim-return.ts',
    source: `function normalize(sql: string): string { return sql.trim() } normalize('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3QueryTrim: {
    file: 'p3b-a-prime-a3-query-trim.ts',
    source: `function run(sql: string) { return client.query(sql.trim()) } run('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a3FakeTest: {
    file: 'p3b-a-prime-a3-fake-test.ts',
    source: `let stored = ''; const fake = { test(sql: string) { stored = sql; return true } }; function inspect(sql: string) { return fake.test(sql) } inspect('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a3ExternalWriteSql: {
    file: 'p3b-a-prime-a3-external-write-sql.ts',
    source: `declare function writeSql(sql: string): Promise<void>; function run(sql: string) { return writeSql(sql) } run('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3ScheduledAuthenticLiteral: {
    file: 'p3b-a-prime-a3-scheduled-authentic-literal.ts',
    source: `import { Prisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; schedule(() => prisma.$executeRaw(Prisma.sql\`INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)\`))`,
  },
  a3ScheduledAuthenticCopy: {
    file: 'p3b-a-prime-a3-scheduled-authentic-copy.ts',
    source: `import { Prisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; schedule(() => prisma.$queryRaw(Prisma.sql\`INSERT INTO "CommercialQuote" ("id", "schemaVersion") SELECT "id", "schemaVersion" FROM "CommercialQuote"\`))`,
  },
  a3ScheduledShadowExecutor: {
    file: 'p3b-a-prime-a3-scheduled-shadow-executor.ts',
    source: `const Prisma = { sql: (value: unknown) => value }; const prisma = { $executeRaw: (value: unknown) => value }; schedule(() => prisma.$executeRaw(Prisma.sql\`INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)\`))`,
  },
  a3SqlCallbackParameter: {
    file: 'p3b-a-prime-a3-sql-callback-parameter.ts',
    source: `function deliver(callback: (sql: string) => unknown, sql: string) { return callback(sql) } deliver(sql => client.query(sql), 'INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)')`,
  },
  a3ScheduledDynamicTarget: {
    file: 'p3b-a-prime-a3-scheduled-dynamic-target.ts',
    source: `import { Prisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; const table: 'CommercialCampaignVersion' = 'CommercialCampaignVersion'; schedule(() => prisma.$executeRaw(Prisma.sql\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`))`,
  },
  a3ScheduledUnresolvedTarget: {
    file: 'p3b-a-prime-a3-scheduled-unresolved-target.ts',
    source: `import { Prisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; function run(table: string) { schedule(() => prisma.$executeRaw(Prisma.sql\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`)) }`,
  },
  a3ScheduledSchemaSlot: {
    file: 'p3b-a-prime-a3-scheduled-schema-slot.ts',
    source: `import { Prisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; function run(schemaVersion: number) { schedule(() => prisma.$queryRaw(Prisma.sql\`INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (\${schemaVersion})\`)) }`,
  },
  a4QueryWrapper: {
    file: 'p3b-a-prime-a4-query-wrapper.ts',
    source: `observe(client.query('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)'))`,
  },
  a4ExecuteWrapper: {
    file: 'p3b-a-prime-a4-execute-wrapper.ts',
    source: `observe(client.execute('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)'))`,
  },
  a4DescendantAndDirect: {
    file: 'p3b-a-prime-a4-descendant-and-direct.ts',
    source: `observe(client.query('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)'), 'INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a4Siblings: {
    file: 'p3b-a-prime-a4-siblings.ts',
    source: `client.query('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)'); client.query('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)')`,
  },
  a4TwoStatements: {
    file: 'p3b-a-prime-a4-two-statements.ts',
    source: `client.query('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1); INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)')`,
  },
  a4NaturalDuplicate: {
    file: 'p3b-a-prime-a4-natural-duplicate.ts',
    source: `const insertion = client.query('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)'); observe(insertion, insertion)`,
  },
  a5DirectPrisma: {
    file: 'p3b-a-prime-a5-direct-prisma.ts',
    source: `import { Prisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; prisma.$executeRaw(Prisma.sql\`INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)\`); prisma.$executeRaw(Prisma.raw('INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)'))`,
  },
  a5AliasPrisma: {
    file: 'p3b-a-prime-a5-alias-prisma.ts',
    source: `import { Prisma as DbPrisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'; prisma.$executeRaw(DbPrisma.sql\`INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)\`)`,
  },
  a5ReexportModule: {
    file: 'p3b-a-prime-a5-reexport.ts',
    source: `export { Prisma as DbPrisma } from '${PRISMA_CLIENT_MODULE_SPECIFIER}'`,
  },
  a5ReexportPrisma: {
    file: 'p3b-a-prime-a5-reexport-prisma.ts',
    source: `import { DbPrisma } from './p3b-a-prime-a5-reexport'; prisma.$executeRaw(DbPrisma.sql\`INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)\`)`,
  },
  a5ShadowPrisma: {
    file: 'p3b-a-prime-a5-shadow-prisma.ts',
    source: `const Prisma = { sql: (value: unknown) => value, raw: (value: string) => value }; prisma.$executeRaw(Prisma.raw('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)'))`,
  },
} as const

type APrimeSyntheticSourceKey = keyof typeof A_PRIME_SYNTHETIC_SOURCES
type APrimeObserved = {
  diagnostic: string | null
  occurrences: Array<Pick<WriterOccurrence, 'table' | 'operation' | 'versionStrategy'>>
}

let aPrimeTypeScriptProgram:
  | { checker: ts.TypeChecker; program: ts.Program; absolutePaths: Map<APrimeSyntheticSourceKey, string> }
  | undefined

function cachedAPrimeTypeScriptProgram(): NonNullable<typeof aPrimeTypeScriptProgram> {
  if (aPrimeTypeScriptProgram) return aPrimeTypeScriptProgram
  const root = process.cwd()
  const absolutePaths = new Map<APrimeSyntheticSourceKey, string>()
  const virtualSources = new Map<string, string>()
  for (const [key, fixture] of Object.entries(A_PRIME_SYNTHETIC_SOURCES) as Array<
    [APrimeSyntheticSourceKey, (typeof A_PRIME_SYNTHETIC_SOURCES)[APrimeSyntheticSourceKey]]
  >) {
    const absolute = join(root, fixture.file)
    absolutePaths.set(key, absolute)
    virtualSources.set(absolute, fixture.source)
  }
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  }
  const host = ts.createCompilerHost(options, true)
  const hostFileExists = host.fileExists.bind(host)
  const hostReadFile = host.readFile.bind(host)
  const hostGetSourceFile = host.getSourceFile.bind(host)
  host.fileExists = fileName => virtualSources.has(fileName) || hostFileExists(fileName)
  host.readFile = fileName => virtualSources.get(fileName) ?? hostReadFile(fileName)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = virtualSources.get(fileName)
    return source === undefined
      ? hostGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
  }
  const program = ts.createProgram({ rootNames: [...virtualSources.keys()], options, host })
  aPrimeTypeScriptProgram = { checker: program.getTypeChecker(), program, absolutePaths }
  return aPrimeTypeScriptProgram
}

function observeAPrimeSource(key: APrimeSyntheticSourceKey, checkerMode: 'real' | 'null'): APrimeObserved {
  const fixture = A_PRIME_SYNTHETIC_SOURCES[key]
  try {
    const occurrences =
      checkerMode === 'real'
        ? (() => {
            const cached = cachedAPrimeTypeScriptProgram()
            const sourceFile = cached.program.getSourceFile(cached.absolutePaths.get(key)!)
            if (!sourceFile) throw new Error(`P3_2B_A_PRIME_TYPESCRIPT_SOURCE_MISSING:${fixture.file}`)
            return sourceOccurrencesFromAst(fixture.file, sourceFile, cached.checker)
          })()
        : sourceOccurrences(fixture.file, fixture.source)
    return {
      diagnostic: null,
      occurrences: occurrences.map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy })),
    }
  } catch (error) {
    return { diagnostic: error instanceof Error ? error.message : String(error), occurrences: [] }
  }
}

function observeAPrimeDual(key: APrimeSyntheticSourceKey): { real: APrimeObserved; null: APrimeObserved } {
  return { real: observeAPrimeSource(key, 'real'), null: observeAPrimeSource(key, 'null') }
}

function filesBelow(path: string): string[] {
  return readdirSync(path).flatMap(name => {
    const child = join(path, name)
    if (name === '.DS_Store') return []
    return statSync(child).isDirectory() ? filesBelow(child) : [child]
  })
}

function classifyExtension(file: string): 'supported' | 'ignored' {
  const extension = extname(file)
  if (SUPPORTED_EXECUTABLE_EXTENSIONS.has(extension)) return 'supported'
  if (EXPLICITLY_NON_EXECUTABLE_EXTENSIONS.has(extension)) return 'ignored'
  throw new Error(`P3-2B unsupported executable extension requires a parser decision: ${file}`)
}

function enumerate(files: Array<{ file: string; source: string }>): WriterOccurrence[] {
  const found: Array<Omit<WriterOccurrence, 'occurrence'>> = []
  for (const input of files.sort((left, right) => left.file.localeCompare(right.file))) {
    if (classifyExtension(input.file) === 'ignored') continue
    found.push(...sourceOccurrences(input.file, input.source))
  }
  return assignOrdinals(found)
}

function assignOrdinals(found: Array<Omit<WriterOccurrence, 'occurrence'>>): WriterOccurrence[] {
  const ordinal = new Map<string, number>()
  const occurrences: WriterOccurrence[] = []
  for (const occurrenceFound of found) {
    const key = `${occurrenceFound.file}\u0000${occurrenceFound.table}\u0000${occurrenceFound.operation}`
    const occurrence = (ordinal.get(key) ?? 0) + 1
    ordinal.set(key, occurrence)
    occurrences.push({ ...occurrenceFound, occurrence })
  }
  return occurrences
}

function compareInventory(actual: WriterOccurrence[], expected: InventoryEntry[]): string[] {
  const expectedByKey = new Map(
    expected.map(entry => [`${entry.file}\u0000${entry.table}\u0000${entry.operation}\u0000${entry.occurrence}`, entry]),
  )
  const diagnostics: string[] = []
  for (const occurrence of actual) {
    const key = `${occurrence.file}\u0000${occurrence.table}\u0000${occurrence.operation}\u0000${occurrence.occurrence}`
    const listed = expectedByKey.get(key)
    const location = `${occurrence.file}:${occurrence.line} ${occurrence.table} ${occurrence.operation} occurrence ${occurrence.occurrence}`
    if (!listed) diagnostics.push(`${location}: unrecognized writer (${occurrence.versionStrategy})`)
    else if (listed.versionStrategy !== occurrence.versionStrategy) {
      diagnostics.push(`${location}: expected ${listed.versionStrategy}, observed ${occurrence.versionStrategy}`)
    }
    expectedByKey.delete(key)
  }
  for (const missing of expectedByKey.values()) {
    diagnostics.push(`${missing.file} ${missing.table} ${missing.operation} occurrence ${missing.occurrence}: listed writer not found`)
  }
  return diagnostics
}

function repositoryOccurrences(): WriterOccurrence[] {
  const root = process.cwd()
  const files = ROOTS.flatMap(directory => filesBelow(join(root, directory)))
    .map(absolute => ({ absolute, file: relative(root, absolute) }))
    .sort((left, right) => left.file.localeCompare(right.file))
  for (const input of files) classifyExtension(input.file)
  const programRoots = files
    .filter(input => classifyExtension(input.file) === 'supported' && extname(input.file) !== '.sql')
    .map(input => input.absolute)
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  if (config.error) throw new Error(`P3_2B_TYPESCRIPT_PROGRAM_CONFIG:${config.error.code}`)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram({
    rootNames: programRoots,
    options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true },
  })
  const checker = program.getTypeChecker()
  const found: Array<Omit<WriterOccurrence, 'occurrence'>> = []
  for (const input of files) {
    if (classifyExtension(input.file) === 'ignored') continue
    if (extname(input.file) === '.sql') {
      found.push(...sourceOccurrences(input.file, readFileSync(input.absolute, 'utf8')))
      continue
    }
    const sourceFile = program.getSourceFile(input.absolute)
    if (!sourceFile) throw new Error(`P3_2B_TYPESCRIPT_PROGRAM_SOURCE_MISSING:${input.file}`)
    found.push(...sourceOccurrencesFromAst(input.file, sourceFile, checker))
  }
  return assignOrdinals(found)
}

describe('P3-2B immutable commercial writer inventory', () => {
  it('[P3-2B-U6] [C6] freezes exactly 57 known writers while keeping five production writers isolated', () => {
    const actual = repositoryOccurrences()

    expect(EXPECTED_WRITERS).toHaveLength(57)
    expect(compareInventory(actual, EXPECTED_WRITERS)).toEqual([])
    expect(
      actual.filter(
        writer =>
          writer.file.startsWith('src/') &&
          ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialQuote'].includes(writer.table),
      ),
    ).toEqual([
      expect.objectContaining({
        file: 'src/services/commercial/commercialCampaignPublication.service.ts',
        table: 'CommercialCampaignVersion',
        versionStrategy: 'literal-v2',
      }),
      expect.objectContaining({
        file: 'src/services/commercial/commercialPublication.service.ts',
        table: 'CommercialPublication',
        versionStrategy: 'literal-v2',
      }),
      expect.objectContaining({
        file: 'src/services/commercial/commercialQuotePersistence.service.ts',
        table: 'CommercialQuote',
        versionStrategy: 'literal-v2',
      }),
      expect.objectContaining({
        file: 'src/services/commercial/offers/commercialOfferPublication.service.ts',
        table: 'CommercialCampaignVersion',
        versionStrategy: 'literal-v3',
      }),
      expect.objectContaining({
        file: 'src/services/commercial/quotes-v3/commercialQuoteV3Persistence.service.ts',
        table: 'CommercialQuote',
        versionStrategy: 'literal-v3',
      }),
    ])
  })

  it('[P3-2B-A1] classifies finite and pattern targets without excluding a possible commercial table', () => {
    const actual = {
      serializableForeign: observeAPrimeDual('a1SerializableForeign'),
      prefixPublication: observeAPrimeDual('a1PrefixPublication'),
      commercialMiddle: observeAPrimeDual('a1CommercialMiddle'),
      mixedFinite: observeAPrimeDual('a1MixedFinite'),
      multiSpanSuffix: observeAPrimeDual('a1MultiSpanSuffix'),
    }

    expect(actual).toEqual({
      serializableForeign: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      prefixPublication: {
        real: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a1-prefix-publication.ts:1',
          occurrences: [],
        },
        null: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a1-prefix-publication.ts:1',
          occurrences: [],
        },
      },
      commercialMiddle: {
        real: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a1-commercial-middle.ts:1',
          occurrences: [],
        },
        null: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a1-commercial-middle.ts:1',
          occurrences: [],
        },
      },
      mixedFinite: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      multiSpanSuffix: {
        real: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a1-multi-span-suffix.ts:1',
          occurrences: [],
        },
        null: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a1-multi-span-suffix.ts:1',
          occurrences: [],
        },
      },
    })
  })

  it('[P3-2B-A2] fails closed on unresolved SQL structure while preserving statement-local slot strategy', () => {
    const actual = {
      dynamicVerb: observeAPrimeDual('a2DynamicVerb'),
      dynamicInto: observeAPrimeDual('a2DynamicInto'),
      nestedVerb: observeAPrimeDual('a2NestedVerb'),
      nestedTarget: observeAPrimeDual('a2NestedTarget'),
      schemaSlot: observeAPrimeDual('a2SchemaSlot'),
      whereCopy: observeAPrimeDual('a2WhereCopy'),
    }

    expect(actual).toEqual({
      dynamicVerb: {
        real: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a2-dynamic-verb.ts:1',
          occurrences: [],
        },
        null: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a2-dynamic-verb.ts:1',
          occurrences: [],
        },
      },
      dynamicInto: {
        real: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a2-dynamic-into.ts:1',
          occurrences: [],
        },
        null: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a2-dynamic-into.ts:1',
          occurrences: [],
        },
      },
      nestedVerb: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      nestedTarget: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      schemaSlot: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      whereCopy: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'copy-schema-version' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'copy-schema-version' }],
        },
      },
    })
  })

  it('[P3-2B-A3] follows declared function flow without trusting or excluding a helper by name', () => {
    const actual = {
      declaredRun: observeAPrimeDual('a3DeclaredRun'),
      arrowAlias: observeAPrimeDual('a3ArrowAlias'),
      noop: observeAPrimeDual('a3Noop'),
      recursiveOpaque: observeAPrimeDual('a3RecursiveOpaque'),
      noNameTrust: observeAPrimeDual('a3NoNameTrust'),
      pureLocalParser: observeAPrimeDual('a3PureLocalParser'),
      localShadowQuery: observeAPrimeDual('a3LocalShadowQuery'),
      externalPropertyStorage: observeAPrimeDual('a3ExternalPropertyStorage'),
      globalStorage: observeAPrimeDual('a3GlobalStorage'),
      containerStorage: observeAPrimeDual('a3ContainerStorage'),
      identityReturn: observeAPrimeDual('a3IdentityReturn'),
      opaqueReturn: observeAPrimeDual('a3OpaqueReturn'),
      immediateSqlCallback: observeAPrimeDual('a3ImmediateSqlCallback'),
      escapingSqlCallback: observeAPrimeDual('a3EscapingSqlCallback'),
      mutualCycle: observeAPrimeDual('a3MutualCycle'),
      immediatePureTransform: observeAPrimeDual('a3ImmediatePureTransform'),
      canonicalRegexpTest: observeAPrimeDual('a3CanonicalRegexpTest'),
      scalarLength: observeAPrimeDual('a3ScalarLength'),
      scalarIndex: observeAPrimeDual('a3ScalarIndex'),
      scalarBoolean: observeAPrimeDual('a3ScalarBoolean'),
      trimReturn: observeAPrimeDual('a3TrimReturn'),
      queryTrim: observeAPrimeDual('a3QueryTrim'),
      fakeTest: observeAPrimeDual('a3FakeTest'),
      externalWriteSql: observeAPrimeDual('a3ExternalWriteSql'),
      scheduledAuthenticLiteral: observeAPrimeDual('a3ScheduledAuthenticLiteral'),
      scheduledAuthenticCopy: observeAPrimeDual('a3ScheduledAuthenticCopy'),
      scheduledShadowExecutor: observeAPrimeDual('a3ScheduledShadowExecutor'),
      sqlCallbackParameter: observeAPrimeDual('a3SqlCallbackParameter'),
      scheduledDynamicTarget: observeAPrimeDual('a3ScheduledDynamicTarget'),
      scheduledUnresolvedTarget: observeAPrimeDual('a3ScheduledUnresolvedTarget'),
      scheduledSchemaSlot: observeAPrimeDual('a3ScheduledSchemaSlot'),
    }

    expect(actual).toEqual({
      declaredRun: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      arrowAlias: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      noop: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      recursiveOpaque: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      noNameTrust: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      pureLocalParser: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      localShadowQuery: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      externalPropertyStorage: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      globalStorage: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      containerStorage: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      identityReturn: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      opaqueReturn: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      immediateSqlCallback: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      escapingSqlCallback: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      mutualCycle: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      immediatePureTransform: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      canonicalRegexpTest: {
        real: { diagnostic: null, occurrences: [] },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      scalarLength: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      scalarIndex: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      scalarBoolean: {
        real: { diagnostic: null, occurrences: [] },
        null: { diagnostic: null, occurrences: [] },
      },
      trimReturn: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      queryTrim: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      fakeTest: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      externalWriteSql: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      scheduledAuthenticLiteral: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      scheduledAuthenticCopy: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'copy-schema-version' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      scheduledShadowExecutor: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      sqlCallbackParameter: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      scheduledDynamicTarget: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      scheduledUnresolvedTarget: {
        real: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a3-scheduled-unresolved-target.ts:1',
          occurrences: [],
        },
        null: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:p3b-a-prime-a3-scheduled-unresolved-target.ts:1',
          occurrences: [],
        },
      },
      scheduledSchemaSlot: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
    })
  })

  it('[P3-2B-A4] assigns each SQL-bearing AST expression to one canonical owner in lexical order', () => {
    const summarize = (key: APrimeSyntheticSourceKey) => {
      const observed = observeAPrimeDual(key)
      return {
        real: {
          diagnostic: observed.real.diagnostic,
          tables: observed.real.occurrences.map(occurrence => occurrence.table),
        },
        null: {
          diagnostic: observed.null.diagnostic,
          tables: observed.null.occurrences.map(occurrence => occurrence.table),
        },
      }
    }
    const actual = {
      queryWrapper: summarize('a4QueryWrapper'),
      executeWrapper: summarize('a4ExecuteWrapper'),
      descendantAndDirect: summarize('a4DescendantAndDirect'),
      siblings: summarize('a4Siblings'),
      twoStatements: summarize('a4TwoStatements'),
      naturalDuplicate: summarize('a4NaturalDuplicate'),
    }

    expect(actual).toEqual({
      queryWrapper: {
        real: { diagnostic: null, tables: ['CommercialPublication'] },
        null: { diagnostic: null, tables: ['CommercialPublication'] },
      },
      executeWrapper: {
        real: { diagnostic: null, tables: ['CommercialQuote'] },
        null: { diagnostic: null, tables: ['CommercialQuote'] },
      },
      descendantAndDirect: {
        real: { diagnostic: null, tables: ['CommercialPublication', 'CommercialCampaignVersion'] },
        null: { diagnostic: null, tables: ['CommercialPublication', 'CommercialCampaignVersion'] },
      },
      siblings: {
        real: { diagnostic: null, tables: ['CommercialPublication', 'CommercialQuote'] },
        null: { diagnostic: null, tables: ['CommercialPublication', 'CommercialQuote'] },
      },
      twoStatements: {
        real: { diagnostic: null, tables: ['CommercialPublication', 'CommercialCampaignVersion'] },
        null: { diagnostic: null, tables: ['CommercialPublication', 'CommercialCampaignVersion'] },
      },
      naturalDuplicate: {
        real: { diagnostic: null, tables: ['CommercialQuote'] },
        null: { diagnostic: null, tables: ['CommercialQuote'] },
      },
    })
  })

  it('[P3-2B-A5] trusts Prisma SQL carriers only through the authentic TypeChecker symbol', () => {
    const actual = {
      direct: observeAPrimeDual('a5DirectPrisma'),
      alias: observeAPrimeDual('a5AliasPrisma'),
      reexport: observeAPrimeDual('a5ReexportPrisma'),
      shadow: observeAPrimeDual('a5ShadowPrisma'),
    }

    expect(actual).toEqual({
      direct: {
        real: {
          diagnostic: null,
          occurrences: [
            { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'literal-v1' },
            { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'literal-v1' },
          ],
        },
        null: {
          diagnostic: null,
          occurrences: [
            { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
            { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
          ],
        },
      },
      alias: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      reexport: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
      shadow: {
        real: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
        null: {
          diagnostic: null,
          occurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
        },
      },
    })
  })

  it('enumerates every literal-union target for a dynamic SQL identifier instead of dropping possible tables', () => {
    const unionHelper = sourceOccurrences(
      'synthetic-union-helper.ts',
      `async function insertVersionCase(
        client: Client,
        table: 'CommercialPublication' | 'CommercialCampaignVersion' | 'CommercialQuote',
      ) {
        const columns = '"id", "schemaVersion"'
        await client.query(\`INSERT INTO \${quoteIdentifier(table)} (\${columns}) VALUES ('fixture', 1)\`)
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const conditionalHelper = sourceOccurrences(
      'synthetic-conditional-helper.ts',
      `async function missingRootFailure(
        client: Client,
        table: 'CommercialPublication' | 'CommercialCampaignVersion',
      ) {
        const columns = table === 'CommercialPublication'
          ? '"id", "schemaVersion"'
          : '"id", "campaignCode", "schemaVersion"'
        await client.query(\`INSERT INTO \${quoteIdentifier(table)} (\${columns}) VALUES ('fixture', 1)\`)
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const aliasUnion = sourceOccurrences(
      'synthetic-alias-union-helper.ts',
      `async function insertWithAlias(
        client: Client,
        table: 'CommercialPublication' | 'CommercialCampaignVersion' | 'CommercialQuote',
      ) {
        await client.query(\`INSERT INTO \${escapeIdentifier(table)} ("id", "schemaVersion") VALUES ('fixture', 1)\`)
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const unresolvedQuoteIdentifier = (() => {
      try {
        return {
          diagnostic: null,
          occurrences: sourceOccurrences(
            'synthetic-unresolved-quote-identifier.ts',
            `async function insert(client: Client) {
              await client.query(\`INSERT INTO \${quoteIdentifier(chooseTable())} ("schemaVersion") VALUES (1)\`)
            }`,
          ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy })),
        }
      } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : String(error), occurrences: [] }
      }
    })()
    const unresolvedAlias = (() => {
      try {
        return {
          diagnostic: null,
          occurrences: sourceOccurrences(
            'synthetic-unresolved-alias.ts',
            `async function insert(client: Client) {
              await client.query(\`INSERT INTO \${escapeIdentifier(chooseTable())} ("schemaVersion") VALUES (1)\`)
            }`,
          ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy })),
        }
      } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : String(error), occurrences: [] }
      }
    })()
    const foreignValueOnly = sourceOccurrences(
      'synthetic-foreign-value.ts',
      `async function insert(client: Client) {
        await client.query('INSERT INTO "ForeignAudit" ("model", "schemaVersion") VALUES (\'CommercialQuote\', 1)')
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const schemaQualifiedQuoted = sourceOccurrences(
      'synthetic-schema-qualified.ts',
      `async function insert(client: Client) {
        await client.query('INSERT INTO public."CommercialPublication" ("schemaVersion") VALUES (1)')
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const templateTarget = sourceOccurrences(
      'synthetic-template-target.ts',
      `async function insert(client: Client, table: 'CommercialCampaignVersion') {
        await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`)
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const concatenatedTarget = sourceOccurrences(
      'synthetic-concatenated-target.ts',
      `async function insert(client: Client) {
        const table = '"CommercialQuote"'
        await client.query('INSERT INTO ' + table + ' ("schemaVersion") VALUES (1)')
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const classify = (file: string, source: string) => {
      try {
        return {
          diagnostic: null,
          occurrences: sourceOccurrences(file, source).map(({ table, operation, versionStrategy }) => ({
            table,
            operation,
            versionStrategy,
          })),
        }
      } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : String(error), occurrences: [] }
      }
    }
    const foreignFinite = [
      {
        fixture: 'h1-concurrency-complete-item',
        classification: classify(
          'synthetic-h1-concurrency-complete-item.ts',
          `for (const [table, id, label] of [['CatalogBrand', 'brand', 'BRAND'], ['CatalogManufacturer', 'manufacturer', 'MANUFACTURER'], ['CatalogFamily', 'family', 'FAMILY']] as const) { client.query(\`INSERT INTO "\${table}" ("id") VALUES ('fixture')\`) }`,
        ),
      },
      {
        fixture: 'h1-concurrency-bulk-item',
        classification: classify(
          'synthetic-h1-concurrency-bulk-item.ts',
          `for (const [table, suffix, label] of [['CatalogBrand', 'brand', 'BULK-BRAND'], ['CatalogManufacturer', 'manufacturer', 'BULK-MANUFACTURER'], ['CatalogFamily', 'family', 'BULK-FAMILY']] as const) { client.query(\`INSERT INTO "\${table}" ("id") VALUES ('fixture')\`) }`,
        ),
      },
      {
        fixture: 'h1-lifecycle-complete-item',
        classification: classify(
          'synthetic-h1-lifecycle-complete-item.ts',
          `for (const [table, id, label] of [['CatalogBrand', 'brand', 'Lifecycle brand'], ['CatalogManufacturer', 'manufacturer', 'Lifecycle manufacturer'], ['CatalogFamily', 'family', 'Lifecycle family']] as const) { client.query(\`INSERT INTO "\${table}" ("id") VALUES ('fixture')\`) }`,
        ),
      },
      {
        fixture: 'h1-lifecycle-service-principal',
        classification: classify(
          'synthetic-h1-lifecycle-service-principal.ts',
          `it.each([['CatalogImportBatch', '', ''], ['CatalogBindingBatch', '', ''], ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"]] as const)('case', async (table, extraColumns, extraValues) => { await client.query(\`INSERT INTO "\${table}" ("id"\${extraColumns}) VALUES ('fixture'\${extraValues})\`) })`,
        ),
      },
      {
        fixture: 'h1-lifecycle-null-dependencies',
        classification: classify(
          'synthetic-h1-lifecycle-null-dependencies.ts',
          `it.each([['CatalogImportBatch', '', ''], ['CatalogBindingBatch', '', ''], ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"]] as const)('case', async (table, extraColumns, extraValues) => { await client.query(\`INSERT INTO "\${table}" ("id"\${extraColumns}) VALUES ('fixture'\${extraValues})\`) })`,
        ),
      },
      {
        fixture: 'h1-lifecycle-terminal-evidence',
        classification: classify(
          'synthetic-h1-lifecycle-terminal-evidence.ts',
          `it.each([['CatalogImportBatch', '', ''], ['CatalogBindingBatch', '', ''], ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"]] as const)('case', async (table, extraColumns, extraValues) => { for (const state of ['PREVIEWED', 'APPLIED', 'FAILED'] as const) await client.query(\`INSERT INTO "\${table}" ("id"\${extraColumns}) VALUES ('fixture'\${extraValues})\`) })`,
        ),
      },
      {
        fixture: 'h1-lifecycle-blank-attempt',
        classification: classify(
          'synthetic-h1-lifecycle-blank-attempt.ts',
          `for (const [table, extraColumns, extraValues] of [['CatalogImportBatch', '', ''], ['CatalogBindingBatch', '', ''], ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"]] as const) { client.query(\`INSERT INTO "\${table}" ("id"\${extraColumns}) VALUES ('fixture'\${extraValues})\`) }`,
        ),
      },
      {
        fixture: 'h1-tenant-cross-organization',
        classification: classify(
          'synthetic-h1-tenant-cross-organization.ts',
          `for (const [table, id] of [['CatalogImportBatch', 'import'], ['CatalogBindingBatch', 'binding']] as const) { client.query(\`INSERT INTO "\${table}" ("id") VALUES ('fixture')\`) }`,
        ),
      },
    ]
    const generatedForeignPrefix = classify(
      'synthetic-serializable-retry.ts',
      `const tableName = \`serializable_retry_\${process.pid}_\${Date.now()}\`; client.query(\`INSERT INTO "\${tableName}" ("id") VALUES (1)\`)`,
    )
    const mixedFinite = classify(
      'synthetic-mixed-finite.ts',
      `for (const table of ['CatalogBrand', 'CommercialPublication', 'CatalogFamily'] as const) { client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
    )
    const ambiguousTargets = {
      any: classify(
        'synthetic-any-target.ts',
        `async function insert(client: Client, table: any) { await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
      ),
      string: classify(
        'synthetic-string-target.ts',
        `async function insert(client: Client, table: string) { await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
      ),
      unresolvedHelper: classify(
        'synthetic-unresolvable-helper.ts',
        `async function insert(client: Client) { await client.query(\`INSERT INTO "\${escapeIdentifier(chooseTable())}" ("schemaVersion") VALUES (1)\`) }`,
      ),
      never: classify(
        'synthetic-never-target.ts',
        `async function insert(client: Client, table: never) { await client.query(\`INSERT INTO "\${table}" ("schemaVersion") VALUES (1)\`) }`,
      ),
    }
    const deceptiveWrapper = sourceOccurrences(
      'synthetic-deceptive-wrapper.ts',
      `async function insert(client: Client) { const expect = client.execute.bind(client); await expect('INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)') }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const shadowedSourceOccurrences = sourceOccurrences(
      'synthetic-shadowed-source-occurrences.ts',
      `async function insert(client: Client) { const sourceOccurrences = client.execute.bind(client); await sourceOccurrences('INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)') }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    expect({
      unionHelper,
      conditionalHelper,
      aliasUnion,
      unresolvedQuoteIdentifier,
      unresolvedAlias,
      foreignValueOnly,
      schemaQualifiedQuoted,
      templateTarget,
      concatenatedTarget,
      foreignFinite,
      generatedForeignPrefix,
      mixedFinite,
      ambiguousTargets,
      deceptiveWrapper,
      shadowedSourceOccurrences,
    }).toEqual({
      unionHelper: [
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      conditionalHelper: [
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      aliasUnion: [
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      unresolvedQuoteIdentifier: {
        diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:synthetic-unresolved-quote-identifier.ts:2',
        occurrences: [],
      },
      unresolvedAlias: {
        diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:synthetic-unresolved-alias.ts:2',
        occurrences: [],
      },
      foreignValueOnly: [],
      schemaQualifiedQuoted: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
      templateTarget: [{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      concatenatedTarget: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
      foreignFinite: [
        { fixture: 'h1-concurrency-complete-item', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-concurrency-bulk-item', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-lifecycle-complete-item', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-lifecycle-service-principal', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-lifecycle-null-dependencies', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-lifecycle-terminal-evidence', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-lifecycle-blank-attempt', classification: { diagnostic: null, occurrences: [] } },
        { fixture: 'h1-tenant-cross-organization', classification: { diagnostic: null, occurrences: [] } },
      ],
      generatedForeignPrefix: { diagnostic: null, occurrences: [] },
      mixedFinite: {
        diagnostic: null,
        occurrences: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      },
      ambiguousTargets: {
        any: { diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:synthetic-any-target.ts:1', occurrences: [] },
        string: { diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:synthetic-string-target.ts:1', occurrences: [] },
        unresolvedHelper: {
          diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:synthetic-unresolvable-helper.ts:1',
          occurrences: [],
        },
        never: { diagnostic: 'P3_2B_UNRESOLVED_SQL_INSERT_TARGET:synthetic-never-target.ts:1', occurrences: [] },
      },
      deceptiveWrapper: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      shadowedSourceOccurrences: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
    })
  })

  it('counts a recognized nested query executor once instead of counting its wrapper', () => {
    const queryWrapper = sourceOccurrences(
      'synthetic-nested-executor.ts',
      `async function quoteAttempt(client: Client) {
        return errorReceipt(() =>
          client.query(\`INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES ('quote', 2)\`),
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const executeWrapper = sourceOccurrences(
      'synthetic-nested-execute.ts',
      `async function quoteAttempt(client: Client) {
        return observe(() =>
          client.execute(\`INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES ('quote', 2)\`),
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const partialOperationWrapper = sourceOccurrences(
      'synthetic-partial-operation.ts',
      `async function quoteAttempt(client: Client, flag: boolean) {
        return observe(() =>
          client[flag ? 'query' : chooseExecutor()](
            \`INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES ('quote', 2)\`,
          ),
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const identicalSiblingExecutors = sourceOccurrences(
      'synthetic-identical-siblings.ts',
      `async function insertTwice(client: Client) {
        await client.execute(\`INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES ('quote', 2)\`)
        await client.execute(\`INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES ('quote', 2)\`)
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const twoStatementsOneCallsite = sourceOccurrences(
      'synthetic-two-statements.ts',
      `async function insertTwice(client: Client) {
        await client.execute(
          'INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES (\'quote\', 1); INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES (\'quote\', 1)',
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const descendantAndDirect = sourceOccurrences(
      'synthetic-descendant-and-direct.ts',
      `async function insertBoth(client: Client) {
        return observe(
          () => client.execute(\`INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES ('publication', 2)\`),
          \`INSERT INTO "CommercialCampaignVersion" ("id", "schemaVersion") VALUES ('campaign', 2)\`,
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const directAndDescendant = sourceOccurrences(
      'synthetic-direct-and-descendant.ts',
      `async function insertBoth(client: Client) {
        return observe(
          \`INSERT INTO "CommercialCampaignVersion" ("id", "schemaVersion") VALUES ('campaign', 2)\`,
          () => client.execute(\`INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES ('publication', 2)\`),
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const twoDirectArguments = sourceOccurrences(
      'synthetic-two-direct-arguments.ts',
      `async function insertBoth() {
        return observe(
          \`INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES ('publication', 2)\`,
          \`INSERT INTO "CommercialCampaignVersion" ("id", "schemaVersion") VALUES ('campaign', 2)\`,
        )
      }`,
    ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy }))
    const duplicateOwnership = (() => {
      try {
        const injectDuplicate = sourceOccurrences as unknown as (
          file: string,
          source: string,
          controls: { injectDuplicateOwnership: true },
        ) => Omit<WriterOccurrence, 'occurrence'>[]
        return {
          diagnostic: null,
          occurrences: injectDuplicate(
            'synthetic-duplicate-ownership.ts',
            `async function insert(client: Client) { await client.query(\`INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)\`) }`,
            { injectDuplicateOwnership: true },
          ).map(({ table, operation, versionStrategy }) => ({ table, operation, versionStrategy })),
        }
      } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : String(error), occurrences: [] }
      }
    })()
    expect({
      queryWrapper,
      executeWrapper,
      partialOperationWrapper,
      identicalSiblingExecutors,
      twoStatementsOneCallsite,
      descendantAndDirect,
      directAndDescendant,
      twoDirectArguments,
      duplicateOwnership,
    }).toEqual({
      queryWrapper: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      executeWrapper: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      partialOperationWrapper: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      identicalSiblingExecutors: [
        { table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      twoStatementsOneCallsite: [
        { table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      descendantAndDirect: [
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      directAndDescendant: [
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      twoDirectArguments: [
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' },
      ],
      duplicateOwnership: {
        diagnostic: 'P3_2B_DUPLICATE_SQL_OWNERSHIP:synthetic-duplicate-ownership.ts:1:callsite1:arg0:statement1:CommercialQuote',
        occurrences: [],
      },
    })
  })

  it('fails closed for spreads, indirect delegates and mutable delegate aliases', () => {
    const actual = enumerate([
      {
        file: 'src/synthetic-spread.ts',
        source: 'prisma.commercialPublication.create({ data: { ...input } })',
      },
    ])
    expect(actual[0].versionStrategy).toBe('spread-only')
    expect(compareInventory(actual, [{ ...actual[0], versionStrategy: 'literal-v1' }])).toEqual([
      'src/synthetic-spread.ts:1 CommercialPublication create occurrence 1: expected literal-v1, observed spread-only',
    ])
    expect(
      sourceOccurrences('safe.ts', 'prisma.commercialPublication.create({ data: { ...input, schemaVersion: 1 } })')[0].versionStrategy,
    ).toBe('literal-v1')
    expect(
      sourceOccurrences('override.ts', 'prisma.commercialPublication.create({ data: { schemaVersion: 1, ...input } })')[0].versionStrategy,
    ).toBe('spread-only')
    expect(
      sourceOccurrences('mixed.ts', 'prisma.commercialPublication.createMany({ data: [{ schemaVersion: 1 }, { id: "missing" }] })')[0]
        .versionStrategy,
    ).toBe('dynamic')
    expect(
      sourceOccurrences('element-access.ts', "prisma['commercialPublication']['create']({ data: { schemaVersion: 1 } })"),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences(
        'computed-model-key.ts',
        "const model = 'commercialPublication'; prisma[model].create({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences(
        'computed-operation-key.ts',
        "const operation = 'create'; prisma.commercialPublication[operation]({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences(
        'duplicate-model-untrusted-first.ts',
        "let model = 'commercialPublication'; prisma[flag ? model : 'commercialPublication'].create({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'duplicate-model-untrusted-last.ts',
        "let model = 'commercialPublication'; prisma[flag ? 'commercialPublication' : model].create({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'duplicate-operation-untrusted-first.ts',
        "let operation = 'create'; prisma.commercialPublication[flag ? operation : 'create']({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'duplicate-operation-untrusted-last.ts',
        "let operation = 'create'; prisma.commercialPublication[flag ? 'create' : operation]({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'delegate-alias.ts',
        'const publication = prisma.commercialPublication; publication.create({ data: { schemaVersion: 1 } })',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'create', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences(
        'delegate-destructure.ts',
        'const { commercialPublication: publication } = prisma; publication.createMany({ data: [{ schemaVersion: 1 }] })',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'createMany', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences(
        'delegate-shorthand.ts',
        'const { commercialQuote } = prisma; commercialQuote.create({ data: { schemaVersion: 1 } })',
      ),
    ).toMatchObject([{ table: 'CommercialQuote', operation: 'create', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences(
        'mutable-delegate.ts',
        'let publication = prisma.commercialPublication; publication.create({ data: { schemaVersion: 1 } })',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'assignment-acquired-delegate.ts',
        'let publication; publication = prisma.commercialPublication; publication.create({ data: { schemaVersion: 1 } })',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'reassigned-delegate.ts',
        'const publication = prisma.commercialPublication; publication = replacement; publication.create({ data: { schemaVersion: 1 } })',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'multi-target-delegate.ts',
        'let delegate = prisma.commercialPublication; delegate = prisma.commercialQuote; delegate.create({ data: { schemaVersion: 1 } })',
      ),
    ).toMatchObject([
      { table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialQuote', operation: 'create', versionStrategy: 'dynamic' },
    ])
    expect(
      sourceOccurrences(
        'ambiguous-computed-keys.ts',
        "let model = 'commercialPublication'; model = 'commercialQuote'; let operation = 'create'; operation = 'createMany'; prisma[model][operation]({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([
      { table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialPublication', operation: 'createMany', versionStrategy: 'dynamic' },
      { table: 'CommercialQuote', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialQuote', operation: 'createMany', versionStrategy: 'dynamic' },
    ])
    expect(
      sourceOccurrences(
        'conditional-computed-key.ts',
        "prisma[flag ? 'commercialPublication' : 'commercialQuote'].create({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([
      { table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialQuote', operation: 'create', versionStrategy: 'dynamic' },
    ])
    expect(
      sourceOccurrences(
        'partially-unresolved-model-key.ts',
        "prisma[flag ? 'commercialPublication' : chooseModel()].create({ data: { schemaVersion: 1 } })",
      ),
    ).toMatchObject([
      { table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialCampaignVersion', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialQuote', operation: 'create', versionStrategy: 'dynamic' },
    ])
    expect(
      sourceOccurrences('unresolved-operation-key.ts', 'prisma.commercialPublication[chooseOperation()]({ data: { schemaVersion: 1 } })'),
    ).toMatchObject([
      { table: 'CommercialPublication', operation: 'create', versionStrategy: 'dynamic' },
      { table: 'CommercialPublication', operation: 'createMany', versionStrategy: 'dynamic' },
      { table: 'CommercialPublication', operation: 'createManyAndReturn', versionStrategy: 'dynamic' },
      { table: 'CommercialPublication', operation: 'upsert', versionStrategy: 'dynamic' },
    ])
    expect(
      sourceOccurrences(
        'create-capable-operations.ts',
        'prisma.commercialCampaignVersion.upsert({ create: { schemaVersion: 1 }, update: {} }); prisma.commercialQuote.createManyAndReturn({ data: [{ schemaVersion: 1 }] })',
      ),
    ).toMatchObject([
      { table: 'CommercialCampaignVersion', operation: 'upsert', versionStrategy: 'literal-v1' },
      { table: 'CommercialQuote', operation: 'createManyAndReturn', versionStrategy: 'literal-v1' },
    ])
    expect(
      sourceOccurrences(
        'shadowed-delegate.ts',
        'const publication = prisma.commercialPublication; { const publication = replacement; publication.create({ data: { schemaVersion: 1 } }) }',
      ),
    ).toEqual([])
  })

  it('[P3-2C-C1-W1] classifies literal schema v2/v3 only when every object, createMany row or SQL cell is exact', () => {
    const objectV2 = sourceOccurrences('object-v2.ts', 'prisma.commercialPublication.create({ data: { id: "pub", schemaVersion: 2 } })')
    const createManyV2 = sourceOccurrences(
      'create-many-v2.ts',
      'prisma.commercialPublication.createMany({ data: [{ schemaVersion: 2 }, { schemaVersion: 2 }] })',
    )
    const createManyMixed = sourceOccurrences(
      'create-many-mixed.ts',
      'prisma.commercialPublication.createMany({ data: [{ schemaVersion: 2 }, { schemaVersion: 1 }] })',
    )
    const objectExpression = sourceOccurrences(
      'object-expression.ts',
      'prisma.commercialPublication.create({ data: { schemaVersion: 1 + 1 } })',
    )
    const sqlValuesV2 = sourceOccurrences(
      'values-v2.sql',
      'INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (\'a\', 2), (\'b\', 2)',
    )
    const sqlValuesMixed = sourceOccurrences(
      'values-mixed.sql',
      'INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (\'a\', 2), (\'b\', 1)',
    )
    const sqlSelectV2 = sourceOccurrences(
      'select-v2.sql',
      'INSERT INTO "CommercialPublication" ("id", "schemaVersion") SELECT "id", 2 FROM "CommercialPublication"',
    )
    const sqlSelectExpression = sourceOccurrences(
      'select-expression.sql',
      'INSERT INTO "CommercialPublication" ("id", "schemaVersion") SELECT "id", 1 + 1 FROM "CommercialPublication"',
    )
    const objectV3 = sourceOccurrences('object-v3.ts', 'prisma.commercialCampaignVersion.create({ data: { schemaVersion: 3 } })')
    const createManyV3 = sourceOccurrences(
      'create-many-v3.ts',
      'prisma.commercialCampaignVersion.createMany({ data: [{ schemaVersion: 3 }, { schemaVersion: 3 }] })',
    )
    const sqlValuesV3 = sourceOccurrences(
      'values-v3.sql',
      'INSERT INTO "CommercialCampaignVersion" ("id", "schemaVersion") VALUES (\'a\', 3), (\'b\', 3)',
    )
    const sqlSelectV3 = sourceOccurrences(
      'select-v3.sql',
      'INSERT INTO "CommercialCampaignVersion" ("id", "schemaVersion") SELECT "id", 3 FROM "CommercialCampaignVersion"',
    )

    expect(objectV2).toMatchObject([{ versionStrategy: 'literal-v2' }])
    expect(createManyV2).toMatchObject([{ versionStrategy: 'literal-v2' }])
    expect(createManyMixed).toMatchObject([{ versionStrategy: 'dynamic' }])
    expect(objectExpression).toMatchObject([{ versionStrategy: 'dynamic' }])
    expect(sqlValuesV2).toMatchObject([{ versionStrategy: 'literal-v2' }])
    expect(sqlValuesMixed).toMatchObject([{ versionStrategy: 'dynamic' }])
    expect(sqlSelectV2).toMatchObject([{ versionStrategy: 'literal-v2' }])
    expect(sqlSelectExpression).toMatchObject([{ versionStrategy: 'dynamic' }])
    expect(objectV3).toMatchObject([{ versionStrategy: 'literal-v3' }])
    expect(createManyV3).toMatchObject([{ versionStrategy: 'literal-v3' }])
    expect(sqlValuesV3).toMatchObject([{ versionStrategy: 'literal-v3' }])
    expect(sqlSelectV3).toMatchObject([{ versionStrategy: 'literal-v3' }])

    const actualV2 = assignOrdinals(objectV2)
    const expectedV2AsV1 = actualV2.map(({ line: _line, ...entry }) => ({ ...entry, versionStrategy: 'literal-v1' as const }))
    const expectedV2AsDynamic = actualV2.map(({ line: _line, ...entry }) => ({ ...entry, versionStrategy: 'dynamic' as const }))
    expect(compareInventory(actualV2, expectedV2AsV1)).toEqual([
      'object-v2.ts:1 CommercialPublication create occurrence 1: expected literal-v1, observed literal-v2',
    ])
    expect(compareInventory(actualV2, expectedV2AsDynamic)).toEqual([
      'object-v2.ts:1 CommercialPublication create occurrence 1: expected dynamic, observed literal-v2',
    ])
    const actualV1 = assignOrdinals(
      sourceOccurrences('object-v1.ts', 'prisma.commercialPublication.create({ data: { schemaVersion: 1 } })'),
    )
    const expectedV1AsV2 = actualV1.map(({ line: _line, ...entry }) => ({ ...entry, versionStrategy: 'literal-v2' as const }))
    expect(compareInventory(actualV1, expectedV1AsV2)).toEqual([
      'object-v1.ts:1 CommercialPublication create occurrence 1: expected literal-v2, observed literal-v1',
    ])
  })

  it('classifies INSERT VALUES and INSERT SELECT schema-version strategies structurally', () => {
    const values = sourceOccurrences(
      'fixture.sql',
      'INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (\'publication-1\', 1)',
    )
    const copy = sourceOccurrences(
      'fixture.sql',
      'INSERT INTO "CommercialQuote" ("id", "schemaVersion") SELECT "id", "schemaVersion" FROM "CommercialQuote"',
    )
    const unrelatedValueSlot = sourceOccurrences(
      'unrelated-value-slot.ts',
      'async function insert(client: Client, id: string) { await client.query(`INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (${id}, 1)`) }',
    )
    const schemaVersionValueSlot = sourceOccurrences(
      'schema-version-value-slot.ts',
      'async function insert(client: Client, schemaVersion: number) { await client.query(`INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (\'publication-1\', ${schemaVersion})`) }',
    )
    const unrelatedSelectSlot = sourceOccurrences(
      'unrelated-select-slot.ts',
      'async function copy(client: Client, id: string) { await client.query(`INSERT INTO "CommercialQuote" ("id", "schemaVersion") SELECT ${id}, "schemaVersion" FROM "CommercialQuote"`) }',
    )
    const verbSingletonSlot = sourceOccurrences(
      'verb-singleton-slot.ts',
      'const verb = \'INSERT\'; client.query(`${verb} INTO "CommercialPublication" ("id", "schemaVersion") VALUES (\'publication-1\', 1)`)',
    )
    const columnsSlot = sourceOccurrences(
      'columns-slot.ts',
      'const columns = \'"id", "schemaVersion"\'; client.query(`INSERT INTO "CommercialPublication" (${columns}) VALUES (\'publication-1\', 1)`)',
    )
    const intoBoundarySlot = sourceOccurrences(
      'into-boundary-slot.ts',
      'const into = \'INTO\'; client.query(`INSERT ${into} "CommercialPublication" ("id", "schemaVersion") VALUES (\'publication-1\', 1)`)',
    )
    const unrelatedWhereSlot = sourceOccurrences(
      'unrelated-where-slot.ts',
      'async function copy(client: Client, id: string) { await client.query(`INSERT INTO "CommercialQuote" ("id", "schemaVersion") SELECT "id", "schemaVersion" FROM "CommercialQuote" WHERE "id" = ${id}`) }',
    )
    const independentStatements = sourceOccurrences(
      'independent-statements.ts',
      'async function insert(client: Client, table: \'CommercialPublication\') { await client.query(`INSERT INTO "${table}" ("schemaVersion") VALUES (1); INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)`) }',
    )
    const immutableTemplateAlias = sourceOccurrences(
      'immutable-template-alias.ts',
      'async function insert(client: Client, id: string) { const statement = `INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (${id}, 1)`; await client.query(statement) }',
    )
    const mutableTemplateAlias = sourceOccurrences(
      'mutable-template-alias.ts',
      'async function insert(client: Client, id: string) { let statement = `INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (${id}, 1)`; await client.query(statement) }',
    )
    const reassignedTemplateAlias = sourceOccurrences(
      'reassigned-template-alias.ts',
      'async function insert(client: Client, id: string) { let statement = `INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES (${id}, 1)`; statement = replacement; await client.query(statement) }',
    )
    expect(values).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'literal-v1' }])
    expect(copy).toMatchObject([{ table: 'CommercialQuote', versionStrategy: 'copy-schema-version' }])
    expect({ unrelatedValueSlot, schemaVersionValueSlot, unrelatedSelectSlot }).toMatchObject({
      unrelatedValueSlot: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
      schemaVersionValueSlot: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      unrelatedSelectSlot: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'copy-schema-version' }],
    })
    expect({
      verbSingletonSlot,
      columnsSlot,
      intoBoundarySlot,
      unrelatedWhereSlot,
      independentStatements,
      immutableTemplateAlias,
      mutableTemplateAlias,
      reassignedTemplateAlias,
    }).toMatchObject({
      verbSingletonSlot: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      columnsSlot: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      intoBoundarySlot: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      unrelatedWhereSlot: [{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'copy-schema-version' }],
      independentStatements: [
        { table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' },
        { table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'literal-v1' },
      ],
      immutableTemplateAlias: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'literal-v1' }],
      mutableTemplateAlias: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
      reassignedTemplateAlias: [{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }],
    })
    expect(
      sourceOccurrences(
        'multiple.sql',
        'INSERT INTO public."CommercialPublication" ("id", "schemaVersion") VALUES (\'one\', 1), (\'two\', 2)',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'indirect.ts',
        'const sqlVariable = \'INSERT INTO "public"."CommercialQuote" ("id", "schemaVersion") VALUES ("q", 1)\'; client.query(sqlVariable)',
      ),
    ).toMatchObject([{ table: 'CommercialQuote', versionStrategy: 'literal-v1' }])
    expect(
      sourceOccurrences('dynamic.ts', 'const sqlVariable = makeInsert("CommercialCampaignVersion"); client.query(sqlVariable)'),
    ).toMatchObject([{ table: 'CommercialCampaignVersion', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences('dependency-graph.ts', "const table = 'CommercialPublication'; const sql = buildInsert(table); client.query(sql)"),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'mutable-sql.ts',
        'let sql = \'INSERT INTO "CommercialQuote" ("id", "schemaVersion") VALUES ("q", 1)\'; client.query(sql)',
      ),
    ).toMatchObject([{ table: 'CommercialQuote', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'var-sql.ts',
        'var sql = \'INSERT INTO "CommercialCampaignVersion" ("id", "schemaVersion") VALUES ("v", 1)\'; client.query(sql)',
      ),
    ).toMatchObject([{ table: 'CommercialCampaignVersion', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'reassigned-sql.ts',
        'const sql = \'INSERT INTO "CommercialPublication" ("id", "schemaVersion") VALUES ("p", 1)\'; sql = replacement; client.query(sql)',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'separate-template-dependencies.ts',
        'const verb = \'INSERT\'; const table = \'CommercialQuote\'; const sql = `${verb} INTO "${table}" ("schemaVersion") VALUES (1)`; client.query(sql)',
      ),
    ).toMatchObject([{ table: 'CommercialQuote', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'neutral-builder.ts',
        "const verb = 'INSERT'; const table = 'CommercialCampaignVersion'; const sql = assemble(verb, table); client.query(sql)",
      ),
    ).toMatchObject([{ table: 'CommercialCampaignVersion', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'dynamic-tagged-template.ts',
        'const verb = \'INSERT\'; const table = \'CommercialPublication\'; prisma.$queryRaw`${verb} INTO "${table}" ("schemaVersion") VALUES (1)`',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'unresolved-query-operation.ts',
        'client[chooseQueryOperation()](\'INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)\')',
      ),
    ).toMatchObject([{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'prisma-sql-call.ts',
        'prisma.$executeRaw(Prisma.sql`INSERT INTO "CommercialPublication" ("schemaVersion") VALUES (1)`)',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'prisma-sql-variable.ts',
        'const statement = Prisma.sql`INSERT INTO "CommercialCampaignVersion" ("schemaVersion") VALUES (1)`; prisma.$queryRaw(statement)',
      ),
    ).toMatchObject([{ table: 'CommercialCampaignVersion', operation: 'sqlInsert', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'prisma-raw-variable.ts',
        'const statement = Prisma.raw(\'INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)\'); prisma.$executeRaw(statement)',
      ),
    ).toMatchObject([{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'prisma-unknown-call.ts',
        'const table = "CommercialPublication"; const statement = Prisma.sql`INSERT INTO ${Prisma.raw(table)} ("schemaVersion") VALUES (1)`; prisma.$executeRaw(statement)',
      ),
    ).toMatchObject([{ table: 'CommercialPublication', operation: 'sqlInsert', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences('unknown-executor.ts', 'client.execute(\'INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)\')'),
    ).toMatchObject([{ table: 'CommercialQuote', operation: 'sqlInsert', versionStrategy: 'dynamic' }])
    expect(
      sourceOccurrences(
        'non-executing-helper.ts',
        'function sourceOccurrences(_file: string, _source: string) { return [] }; sourceOccurrences("fixture.sql", \'INSERT INTO "CommercialQuote" ("schemaVersion") VALUES (1)\')',
      ),
    ).toEqual([])
  })

  it('reports an unlisted writer instead of allowing a known folder or table broadly', () => {
    const actual = enumerate([
      {
        file: 'scripts/synthetic-unlisted.cjs',
        source: 'prisma.commercialCampaignVersion.create({ data: { schemaVersion: 1 } })',
      },
    ])
    expect(compareInventory(actual, [])).toEqual([
      'scripts/synthetic-unlisted.cjs:1 CommercialCampaignVersion create occurrence 1: unrecognized writer (literal-v1)',
    ])
  })

  it('requires an explicit parser decision for a new executable extension', () => {
    expect(() => enumerate([{ file: 'scripts/synthetic-writer.coffee', source: 'writer()' }])).toThrow(
      'P3-2B unsupported executable extension requires a parser decision: scripts/synthetic-writer.coffee',
    )
  })
})
