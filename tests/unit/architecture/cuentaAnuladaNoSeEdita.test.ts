/**
 * P2-5b + R-P2-S2-1/3: inventario de escritores y cadenas de ayudantes, no prueba de concurrencia.
 * Adapta archivosTs/funcionQueContiene de orderCancelWriters a nodos TS para no confundir callbacks con su entrada.
 * Techo explícito: modelos Prisma accedidos por propiedad literal y UPDATE "Order" literal; no interpreta SQL dinámico,
 * nombres calculados de modelo ni llamadas ocultas por una referencia de función. Payment tiene UNA lista: cobroSobreCancelada.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import revisados from './cuentaAnuladaNoSeEdita.reviewed.json'

const SRC = path.join(__dirname, '../../../src')
type Entrada = { clase: string; motivo?: string; categoria?: string; candado?: string }
const inventario: Record<string, Entrada> = revisados
const modelos = new Set([
  'orderItem',
  'orderItemModifier',
  'orderItemSelloIva',
  'orderDiscount',
  'orderPromotion',
  'orderCustomer',
  'orderServiceCharge',
  'couponRedemption',
])
const metodos = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
// R-P2-S2-6: sólo se excluye un payload demostrado literal sin campos ni relaciones objetivo.
const camposDeCuenta = new Set([
  'subtotal',
  'discountAmount',
  'taxAmount',
  'tipAmount',
  'total',
  'paidAmount',
  'remainingBalance',
  'serviceChargeAmount',
  'customerId',
  'items',
  'orderDiscounts',
  'promotions',
  'orderCustomers',
  'serviceCharges',
  'couponRedemption',
  'payments',
])
function nombreEstatico(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression) ? name.expression.text : undefined
}
function payloadPuedeEditar(n: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n))
    return payloadPuedeEditar(n.expression)
  if (ts.isConditionalExpression(n)) return payloadPuedeEditar(n.whenTrue) || payloadPuedeEditar(n.whenFalse)
  if (ts.isArrayLiteralExpression(n)) return n.elements.some(e => ts.isSpreadElement(e) || payloadPuedeEditar(e))
  if (!ts.isObjectLiteralExpression(n)) return true
  return n.properties.some(p => {
    if (ts.isSpreadAssignment(p)) return payloadPuedeEditar(p.expression)
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return true
    const key = nombreEstatico(p.name)
    return key === undefined || camposDeCuenta.has(key)
  })
}
function escrituraDeOrden(n: ts.CallExpression, metodo: string): boolean {
  if (metodo === 'delete' || metodo === 'deleteMany') return true
  const args = n.arguments[0]
  if (!args || !ts.isObjectLiteralExpression(args)) return true
  if (args.properties.some(p => ts.isSpreadAssignment(p) || !('name' in p) || !p.name || nombreEstatico(p.name) === undefined)) return true
  return (metodo === 'upsert' ? ['create', 'update'] : ['data']).some(key => {
    const property = args.properties.find(p => 'name' in p && p.name && nombreEstatico(p.name) === key)
    return !property || !ts.isPropertyAssignment(property) || payloadPuedeEditar(property.initializer)
  })
}

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? (e.name === '__tests__' ? [] : archivosTs(p)) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}
function funcionQueContiene(node: ts.Node): ts.Node {
  let result: ts.Node = node.getSourceFile()
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && ts.isSourceFile(n.parent)) result = n
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent.parent.parent)) result = n
    if (ts.isMethodDeclaration(n) && ts.isClassDeclaration(n.parent)) result = n
  }
  return result
}
function nombre(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) return node.name?.getText() ?? '(módulo)'
  if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)) return `${node.parent.name?.text}.${node.name.getText()}`
  return '(módulo)'
}
function destino(file: string, module: string, symbol: string): string {
  const target = module.startsWith('@/') ? path.join(SRC, module.slice(2)) : path.resolve(path.dirname(path.join(SRC, file)), module)
  return `${path.relative(SRC, target)}.ts#${symbol}`
}
function scan(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const funciones = new Map<string, string>(),
    escritores = new Set<string>(),
    llamadas = new Map<string, Set<string>>()
  const imports = new Map<string, string>(),
    namespaces = new Map<string, string>()
  function visit(n: ts.Node) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = n.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          imports.set(item.name.text, destino(file, n.moduleSpecifier.text, item.propertyName?.text ?? item.name.text))
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, n.moduleSpecifier.text)
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      let init = n.initializer
      if (ts.isAwaitExpression(init)) init = init.expression
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(init.arguments[0])) {
        const module = init.arguments[0].text
        for (const item of n.name.elements)
          imports.set(item.name.getText(sf), destino(file, module, item.propertyName?.getText(sf) ?? item.name.getText(sf)))
      }
    }
    const owner = funcionQueContiene(n),
      key = `${file}#${nombre(owner)}`
    if (owner === n && !ts.isSourceFile(n)) funciones.set(key, n.getText(sf))
    if (ts.isCallExpression(n)) {
      const expr = n.expression
      if (ts.isPropertyAccessExpression(expr) && metodos.has(expr.name.text) && ts.isPropertyAccessExpression(expr.expression)) {
        const model = expr.expression.name.text
        if (modelos.has(model) || (model === 'order' && escrituraDeOrden(n, expr.name.text))) escritores.add(key)
      }
      let target: string | undefined
      if (ts.isIdentifier(expr)) target = imports.get(expr.text) ?? `${file}#${expr.text}`
      else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && namespaces.has(expr.expression.text))
        target = destino(file, namespaces.get(expr.expression.text)!, expr.name.text)
      if (target) llamadas.set(target, new Set([...(llamadas.get(target) ?? []), key]))
    }
    if (
      (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) &&
      /UPDATE\s+"Order"(?:\s|$)/.test(n.getText(sf))
    )
      escritores.add(key)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { funciones, escritores, llamadas }
}
const todos = archivosTs(SRC).map(file => scan(path.relative(SRC, file), fs.readFileSync(file, 'utf8')))
const funciones = new Map(todos.flatMap(s => [...s.funciones]))
const escritores = new Set(todos.flatMap(s => [...s.escritores]))
const callers = new Map<string, Set<string>>()
for (const result of todos) for (const [key, values] of result.llamadas) callers.set(key, new Set([...(callers.get(key) ?? []), ...values]))

function protegida(key: string): boolean {
  const item = inventario[key],
    body = funciones.get(key) ?? ''
  if (!item) return false
  if (item.clase === 'EXCEPCION') return !!item.categoria && !!item.motivo
  if (item.clase === 'EDITOR_TOPOLOGICO') return body.includes('lockTableOrderScope(') && body.includes('rechazarSiCuentaAnuladaEnTx(')
  if (item.clase === 'EDITOR')
    return (
      body.includes('bloquearCuentaParaEditar(') ||
      (!!item.candado && body.includes(`${item.candado}(`) && protegida(`${key.split('#')[0]}#${item.candado}`))
    )
  return false
}
function revisarCallers(key: string, chain: string[] = []): string[] {
  if (chain.includes(key)) return [`ciclo sin raíz: ${[...chain, key].join(' → ')}`]
  const entradas = [...(callers.get(key) ?? [])]
  if (!entradas.length) return [`${key}: ayudante sin llamador en src`]
  return entradas.flatMap(caller => {
    const item = inventario[caller]
    if (!item) return [`${key} ← ${caller}: llamador sin clasificar`]
    if (protegida(caller)) return []
    if (['AYUDANTE', 'AYUDANTE_HISTORICO', 'PUENTE'].includes(item.clase)) return revisarCallers(caller, [...chain, key])
    return [`${key} ← ${caller}: raíz sin candado y rechazo`]
  })
}

function errorDeClasificacion(item: Entrada): string | null {
  if (!['EDITOR', 'EDITOR_TOPOLOGICO', 'AYUDANTE', 'AYUDANTE_HISTORICO', 'PUENTE', 'EXCEPCION'].includes(item.clase))
    return 'clase desconocida'
  if (item.clase === 'EXCEPCION') {
    if (
      !['DINERO_TARDIO', 'REEMBOLSO', 'ANULACION', 'CREA_CUENTA', 'PLATAFORMA', 'ADMIN', 'COCINA'].includes(item.categoria ?? '') ||
      (item.motivo?.trim().length ?? 0) < 30
    )
      return 'excepción sin categoría/motivo'
  }
  return null
}

describe('Cuenta anulada no se edita: inventario P2-5b', () => {
  it('detecta escrituras Prisma, SQL crudo y función contenedora, incluyendo callbacks', () => {
    const result = scan(
      'new.ts',
      'export async function editar(tx){await tx.$transaction(async db=>{ await db.orderItem.update({data:{total:1}}); await db.$executeRaw`UPDATE "Order" SET total=1`; });} const otro=async tx=>tx.order.update({data:{customerId:"x"}}); async function soloSql(tx){await tx.$executeRaw`UPDATE "Order" SET total=1`}',
    )
    expect([...result.escritores].sort()).toEqual(['new.ts#editar', 'new.ts#otro', 'new.ts#soloSql'])
  })
  it.each([
    ['alias', 'tx.order.update({data: patch})', true],
    ['shorthand', 'tx.order.update({data})', true],
    ['llamada', 'tx.order.update({data: make()})', true],
    ['argumento variable', 'tx.order.update(args)', true],
    ['spread', 'tx.order.update({data: {...patch}})', true],
    ['computed campo', 'tx.order.update({data: {[field]: 1}})', true],
    ['computed total conocido', 'tx.order.update({data: {["total"]: 1}})', true],
    ['nombre total entre comillas', 'tx.order.update({data: {"total": 1}})', true],
    ['computed argumento', 'tx.order.update({[field]: payload})', true],
    ['upsert rama alias', 'tx.order.upsert({create: {status: "PENDING"}, update: patch})', true],
    ['upsert rama llamada', 'tx.order.upsert({create: make(), update: {status: "PENDING"}})', true],
    ['createMany array con alias', 'tx.order.createMany({data: [{status: "PENDING"}, row]})', true],
    ['createMany array con spread', 'tx.order.createMany({data: [...rows]})', true],
    ['createMany array dinero', 'tx.order.createMany({data: [{total: 1}]})', true],
    ['delete', 'tx.order.delete({where: {id: "x"}})', true],
    ['deleteMany', 'tx.order.deleteMany({where: {id: "x"}})', true],
    ['hijos anidados', 'tx.order.update({data: {items: {deleteMany: {}}}})', true],
    ['condicional con dinero', 'tx.order.update({data: flag ? {status: "PENDING"} : {total: 1}})', true],
    ['literal sólo estado', 'tx.order.update({data: {status: "PENDING"}})', false],
    ['shorthand sólo estado', 'tx.order.update({data: {status}})', false],
    ['spread literal sólo estado', 'tx.order.update({data: {...{status: "PENDING"}}})', false],
    ['aserción literal sólo estado', 'tx.order.update({data: ({status: "PENDING"} as const)})', false],
    ['upsert sin objetivos', 'tx.order.upsert({create: {status: "PENDING"}, update: {status: "PENDING"}})', false],
    ['createMany sin objetivos', 'tx.order.createMany({data: [{status: "PENDING"}]})', false],
  ])('payload %s: un escritor ordinario nunca queda invisible', (_caso, call, detectado) => {
    const result = scan('new.ts', `async function editar(tx){${call}}`)
    expect([...result.escritores]).toEqual(detectado ? ['new.ts#editar'] : [])
  })
  it.each([
    { clase: 'EDTIOR' },
    { clase: 'EDITOR ' },
    { clase: 'EXCEPCION', categoria: 'OTRA', motivo: 'Una justificación suficientemente larga para que el motivo sea válido.' },
    { clase: 'EXCEPCION', motivo: 'Una justificación suficientemente larga para que el motivo sea válido.' },
    { clase: 'EXCEPCION', categoria: 'ANULACION', motivo: '' },
    { clase: 'EXCEPCION', categoria: 'ANULACION', motivo: ' '.repeat(60) },
    { clase: 'EXCEPCION', categoria: 'ANULACION' },
  ])('el validador real rechaza una clasificación inválida: %j', item => {
    expect(errorDeClasificacion(item)).not.toBeNull()
  })
  it.each(['EDITOR', 'EDITOR_TOPOLOGICO', 'AYUDANTE', 'AYUDANTE_HISTORICO', 'PUENTE'])('conserva la clase prevista %s', clase => {
    expect(errorDeClasificacion({ clase })).toBeNull()
  })
  it.each(['DINERO_TARDIO', 'REEMBOLSO', 'ANULACION', 'CREA_CUENTA', 'PLATAFORMA', 'ADMIN', 'COCINA'])(
    'conserva la categoría prevista %s con motivo real',
    categoria => {
      expect(
        errorDeClasificacion({
          clase: 'EXCEPCION',
          categoria,
          motivo: 'Esta excepción conserva una operación permitida por el diseño aprobado.',
        }),
      ).toBeNull()
    },
  )

  it('cada escritor está clasificado, sin ocultar escritores nuevos detrás del conteo histórico', () => {
    expect([...escritores].filter(key => !inventario[key]).sort()).toEqual([])
  })
  it('ninguna entrada está muerta y cada editor tiene el candado y rechazo de su clase', () => {
    const problemas: string[] = []
    for (const [key, item] of Object.entries(inventario)) {
      if (!funciones.has(key)) problemas.push(`${key}: función inexistente`)
      if (['EDITOR', 'EDITOR_TOPOLOGICO'].includes(item.clase) && !protegida(key)) problemas.push(`${key}: editor sin protección`)
      const clasificacion = errorDeClasificacion(item)
      if (clasificacion) problemas.push(`${key}: ${clasificacion}`)
      if (item.clase === 'AYUDANTE' && !funciones.get(key)?.includes('rechazarSiCuentaAnuladaEnTx('))
        problemas.push(`${key}: falta relectura`)
      if (['AYUDANTE', 'AYUDANTE_HISTORICO', 'PUENTE'].includes(item.clase)) problemas.push(...revisarCallers(key))
    }
    expect(problemas).toEqual([])
  })
  it('los caminos de atribución y el canje público R13 conservan FOR NO KEY UPDATE a través de su helper', () => {
    for (const key of Object.keys(inventario).filter(key =>
      /#(attachCustomerToOrder|linkCustomerToExistingOrder|updateGuestInfo|leerVentaBajoCandado|recordCouponRedemption)$/.test(key),
    )) {
      const body = funciones.get(key)!
      expect(body).toMatch(/bloquearCuentaParaEditar\(tx,\s*\{ venueId, orderId \},\s*'ATRIBUCION'\)/)
      expect(body).not.toContain('lockExistingOrderForPayment(')
    }
    for (const name of ['ligarClienteBajoCandado', 'removeCustomerFromOrder']) {
      const body = funciones.get(`services/tpv/order.tpv.service.ts#${name}`)!
      expect(body).not.toContain('lockExistingOrderForPayment(')
    }
  })
  it('sólo orderCancelGuard pide el bypass de anulación', () => {
    const piden = [...funciones].filter(([, body]) => /porAnulacion\s*:\s*true/.test(body)).map(([key]) => key)
    expect(piden).toEqual(['services/shared/orderCancelGuard.ts#devolverCanjesDeVentaAnuladaEnTx'])
  })
  it('Payment se vigila en su único inventario canónico, incluidos sus siete métodos', () => {
    const canonical = fs.readFileSync(path.join(__dirname, 'cobroSobreCancelada.test.ts'), 'utf8')
    expect(canonical).toContain('createMany|update|updateMany|upsert|delete|deleteMany')
  })
})
