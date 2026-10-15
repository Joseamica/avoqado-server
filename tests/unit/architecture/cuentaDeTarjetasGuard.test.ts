/**
 * Tarjetas de regalo (R11): toda función que rechaza (o salta) una cuenta IMPORTADA de SoftRestaurant porque reescribe
 * su dinero o sus líneas, rechaza (o salta) también una CUENTA DE TARJETAS. Es el mismo lugar y la misma intención
 * (hechos A § 4.1). Más: agregar un artículo serializado, la cocina y las tres cancelaciones de una cuenta sin cobrar.
 *
 * Qué garantiza (escáner con el compilador de TypeScript sobre el código VIVO de `src/`; recontado el 14-oct: 25 llamadas
 * en 24 funciones, la unión de cuentas con dos):
 *  1. Cada llamada a `rechazarSiEsImportada(…)` / `esOrdenImportada(…)` se atribuye a la función que la ENCIERRA más de
 *     cerca —declaración, expresión de función, flecha (también tipada), método de objeto o de clase, constructor,
 *     getter/setter, `export default function`— y esa MISMA función (no una anidada ni la de afuera) contiene una llamada a
 *     una guardia de tarjetas (`rechazarSiEsCuentaDeTarjetas`, `esCuentaDeTarjetasEnTx` o `tieneRenglonDeTarjeta`). Una
 *     llamada a nivel de módulo cuenta como el sitio `(módulo)` y exige su guardia también a nivel de módulo.
 *  2. Los 24 sitios medidos siguen apareciendo por su nombre (si una refactorización los saca del alcance, truena).
 *  3. Toda referencia a esas dos funciones es una llamada directa o su `import` sin alias: pasarlas como valor, renombrarlas
 *     al importar o desestructurarlas de un `import()` truena, porque el escáner ya no podría seguirlas.
 *  4. Una autoprueba con las cinco formas que se escapaban al escáner por líneas (flecha tipada, expresión de función,
 *     método de objeto, método de clase y `export default async function`).
 * Qué NO garantiza: que la guardia corra en el mismo camino (una guardia dentro de un `if` muerto pasaría), ni que el
 * nombre de la guardia no esté sombreado por otra función local. Eso lo prueban las pruebas de comportamiento.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC = path.join(__dirname, '../../../src')
const IMPORTADA = new Set(['rechazarSiEsImportada', 'esOrdenImportada'])
const GUARDIAS = new Set(['rechazarSiEsCuentaDeTarjetas', 'esCuentaDeTarjetasEnTx', 'tieneRenglonDeTarjeta'])
const EXCLUIDOS = new Set(['services/shared/ordenImportada.ts', 'services/giftCards/cuentaDeTarjetas.ts'])

/** Recontados contra el código vivo el 14-oct (Tarea A5). */
const SITIOS_MEDIDOS = [
  'services/tpv/discount.tpv.service.ts#applyCouponCode',
  'services/tpv/order.tpv.service.ts#addItemsToOrder',
  'services/tpv/order.tpv.service.ts#removeOrderItem',
  'services/tpv/order.tpv.service.ts#compItems',
  'services/tpv/order.tpv.service.ts#voidItems',
  'services/tpv/order.tpv.service.ts#applyDiscount',
  'services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount',
  'services/dashboard/discountEngine.service.ts#removeDiscountFromOrder',
  'services/dashboard/discountEngine.service.ts#applyAutomaticDiscounts',
  'services/dashboard/discountEngine.service.ts#applyManualDiscount',
  'services/promotions/promotion.service.ts#applyPromotionInTransaction',
  'services/promotions/promotion.service.ts#removePromotionFromOrder',
  'services/mobile/order.mobile.service.ts#applyOrderDiscountInTransaction',
  'services/mobile/order.mobile.service.ts#removeOrderDiscountInTransaction',
  'services/mobile/order.mobile.service.ts#splitOrderItemsInTransaction',
  'services/mobile/order.mobile.service.ts#splitOrderBySeatInTransaction',
  'services/mobile/order.mobile.service.ts#mergeOrdersInTransaction',
  'services/mobile/loyalty.mobile.service.ts#redeemPointsToOrderInTransaction',
  'services/wallet/redeemStampReward.service.ts#redeemStampReward',
  'services/mobile/service-charge.mobile.service.ts#applyServiceChargeInTransaction',
  'services/mobile/service-charge.mobile.service.ts#removeServiceChargeInTransaction',
  'services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceChargesInTransaction',
  'services/mobile/comp-item.mobile.service.ts#compOrderItemInTransaction',
  'services/mobile/comp-item.mobile.service.ts#compWholeOrderInTransaction',
]

type Funcion =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

function esFuncion(n: ts.Node): n is Funcion {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  )
}

function funcionQueEncierra(n: ts.Node): Funcion | undefined {
  for (let p = n.parent; p; p = p.parent) if (esFuncion(p)) return p
  return undefined
}

function textoDeNombre(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : name.getText()
}

/** Quién sostiene un objeto literal o una clase: `const servicio = {…}` → `servicio`. */
function nombreDelContenedor(n: ts.Node): string {
  if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
    if (n.name) return n.name.text
    return ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : '(clase)'
  }
  if (ts.isObjectLiteralExpression(n)) {
    const p = n.parent
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isPropertyAssignment(p)) return `${nombreDelContenedor(p.parent)}.${textoDeNombre(p.name)}`
    const fuera = funcionQueEncierra(n)
    return fuera ? nombreDe(fuera) : '(objeto)'
  }
  return '(?)'
}

/** El nombre del sitio. Un callback anónimo (el de `prisma.$transaction`, por ejemplo) es parte de la función que lo encierra. */
function nombreDe(f: Funcion): string {
  if (ts.isFunctionDeclaration(f)) return f.name?.text ?? 'default'
  if (ts.isMethodDeclaration(f) || ts.isGetAccessorDeclaration(f) || ts.isSetAccessorDeclaration(f))
    return `${nombreDelContenedor(f.parent)}.${textoDeNombre(f.name)}`
  if (ts.isConstructorDeclaration(f)) return `${nombreDelContenedor(f.parent)}.constructor`
  let p: ts.Node = f.parent
  while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return `${nombreDelContenedor(p.parent)}.${textoDeNombre(p.name)}`
  if (ts.isExportAssignment(p)) return 'default'
  if (ts.isFunctionExpression(f) && f.name) return f.name.text
  const fuera = funcionQueEncierra(f)
  return fuera ? nombreDe(fuera) : '(módulo)'
}

function nombreLlamado(c: ts.CallExpression): string | undefined {
  const e = c.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

function llamadasEn(raiz: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(n)
    ts.forEachChild(n, visitar)
  }
  visitar(raiz)
  return out
}

/** ¿Es este identificador el callee de una llamada (`f(…)` o `modulo.f(…)`)? */
function esLlamadaDirecta(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isCallExpression(p) && p.expression === id) return true
  return ts.isPropertyAccessExpression(p) && p.name === id && ts.isCallExpression(p.parent) && p.parent.expression === p
}

interface Sitio {
  sitio: string
  linea: number
  guarda: boolean
}

function analizar(rel: string, codigo: string): { sitios: Sitio[]; referenciasOpacas: string[] } {
  const sf = ts.createSourceFile(rel, codigo, ts.ScriptTarget.Latest, true)
  const llamadas = llamadasEn(sf)
  const porFuncion = new Map<Funcion | ts.SourceFile, ts.CallExpression[]>()
  const guardadas = new Set<Funcion | ts.SourceFile>()
  for (const c of llamadas) {
    const nombre = nombreLlamado(c)
    const duena = funcionQueEncierra(c) ?? sf
    if (nombre && IMPORTADA.has(nombre)) porFuncion.set(duena, [...(porFuncion.get(duena) ?? []), c])
    if (nombre && GUARDIAS.has(nombre)) guardadas.add(duena)
  }
  const sitios = [...porFuncion.entries()].map(([duena, cs]) => ({
    sitio: `${rel}#${ts.isSourceFile(duena) ? '(módulo)' : nombreDe(duena)}`,
    linea: sf.getLineAndCharacterOfPosition(cs[0].getStart(sf)).line + 1,
    guarda: guardadas.has(duena),
  }))

  const referenciasOpacas: string[] = []
  const visitar = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && IMPORTADA.has(n.text)) {
      const p = n.parent
      const importSinAlias = ts.isImportSpecifier(p) && !p.propertyName && p.name === n
      if (!importSinAlias && !esLlamadaDirecta(n))
        referenciasOpacas.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${p.getText(sf).slice(0, 80)}`)
    }
    ts.forEachChild(n, visitar)
  }
  visitar(sf)
  return { sitios, referenciasOpacas }
}

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivos(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

/** La función de primer nivel `nombre` (declaración o variable) de un archivo de `src/`. */
function funcionDe(rel: string, nombre: string): ts.Node | undefined {
  const sf = ts.createSourceFile(rel, fs.readFileSync(path.join(SRC, rel), 'utf8'), ts.ScriptTarget.Latest, true)
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === nombre) return st
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === nombre) return d
  }
  return undefined
}

const llamadasA = (raiz: ts.Node | undefined, nombre: string) => (raiz ? llamadasEn(raiz).filter(c => nombreLlamado(c) === nombre) : [])

describe('el escáner de las guardias (autoprueba)', () => {
  // Una función guardada y, DESPUÉS de ella, cinco sitios SIN guardia en las formas que el escáner por líneas le
  // acreditaba a la función anterior (la revisión de A5 r1 los coló todos).
  const FIXTURE = `
import { esOrdenImportada, rechazarSiEsImportada } from '../shared/ordenImportada'
import { rechazarSiEsCuentaDeTarjetas } from '../giftCards/cuentaDeTarjetas'

export async function protegida(tx: unknown, orderId: string, order: { originSystem: string }) {
  rechazarSiEsImportada(order)
  await rechazarSiEsCuentaDeTarjetas(tx as never, orderId, 'descuentos')
}

export const flechaTipada: (order: { originSystem: string }) => Promise<void> = async order => {
  rechazarSiEsImportada(order)
}

const expresion = async function (order: { originSystem: string }) {
  rechazarSiEsImportada(order)
}

export const servicio = {
  async metodo(order: { originSystem: string }) {
    rechazarSiEsImportada(order)
  },
}

class Escritor {
  async escribir(order: { originSystem: string }) {
    if (esOrdenImportada(order)) return
  }
}

export default async function (order: { originSystem: string }) {
  rechazarSiEsImportada(order)
}
`

  it('ve las cinco formas sin guardia y sólo la función guardada pasa', () => {
    expect(analizar('fixture.ts', FIXTURE).sitios.map(({ sitio, guarda }) => ({ sitio, guarda }))).toEqual([
      { sitio: 'fixture.ts#protegida', guarda: true },
      { sitio: 'fixture.ts#flechaTipada', guarda: false },
      { sitio: 'fixture.ts#expresion', guarda: false },
      { sitio: 'fixture.ts#servicio.metodo', guarda: false },
      { sitio: 'fixture.ts#Escritor.escribir', guarda: false },
      { sitio: 'fixture.ts#default', guarda: false },
    ])
  })

  it('la guardia cuenta sólo en la MISMA función: una flecha anidada sin guardia no hereda la de afuera', () => {
    const codigo = `
export async function afuera(tx: unknown, orderId: string, order: { originSystem: string }) {
  await rechazarSiEsCuentaDeTarjetas(tx as never, orderId, 'x')
  const adentro = async () => {
    rechazarSiEsImportada(order)
  }
  await adentro()
}
`
    expect(analizar('anidada.ts', codigo).sitios.map(({ sitio, guarda }) => ({ sitio, guarda }))).toEqual([
      { sitio: 'anidada.ts#adentro', guarda: false },
    ])
  })

  it('una referencia que no es llamada directa (alias, valor, desestructurada) se reporta como opaca', () => {
    const codigo = `
import { rechazarSiEsImportada as r } from '../shared/ordenImportada'
import { esOrdenImportada } from '../shared/ordenImportada'
const lista = [esOrdenImportada]
export async function f() {
  const { rechazarSiEsImportada } = await import('../shared/ordenImportada')
}
`
    expect(analizar('opaca.ts', codigo).referenciasOpacas).toHaveLength(3)
  })
})

describe('cuenta de tarjetas: las guardias acompañan a las de cuentas importadas', () => {
  const sitios: Sitio[] = []
  const referenciasOpacas: string[] = []
  for (const archivo of archivos(SRC)) {
    const rel = path.relative(SRC, archivo).split(path.sep).join('/')
    if (EXCLUIDOS.has(rel)) continue
    const codigo = fs.readFileSync(archivo, 'utf8')
    if (!/rechazarSiEsImportada|esOrdenImportada/.test(codigo)) continue
    const r = analizar(rel, codigo)
    sitios.push(...r.sitios)
    referenciasOpacas.push(...r.referenciasOpacas)
  }

  it(`encuentra por su nombre los ${SITIOS_MEDIDOS.length} sitios medidos el 14-oct (si falta uno, el escáner lo perdió)`, () => {
    expect(sitios.map(s => s.sitio).sort()).toEqual(expect.arrayContaining(SITIOS_MEDIDOS))
  })

  it('toda referencia a la guardia de importadas es una llamada directa o su import sin alias', () => {
    expect(referenciasOpacas).toEqual([])
  })

  it.each(sitios.map(s => [s.sitio, s.linea, s.guarda] as const))(
    '%s (línea %d) también rechaza o salta una cuenta de tarjetas',
    (sitio, linea, guarda) => {
      expect({ sitio, linea, guarda }).toEqual({ sitio, linea, guarda: true })
    },
  )

  it('agregar un artículo serializado rechaza una cuenta de tarjetas', () => {
    const guardias = llamadasA(funcionDe('services/tpv/order.tpv.service.ts', 'addSerializedItemToOrder'), 'rechazarSiEsCuentaDeTarjetas')
    expect(guardias.map(c => c.arguments.map(a => (ts.isStringLiteral(a) ? `'${a.text}'` : a.getText())))).toEqual([
      ['tx', 'orderId', "'artículos serializados'"],
    ])
  })

  it('la cocina no arma renglones de tarjeta (KDS)', () => {
    const funcion = funcionDe('services/kds/kitchenTicketAuthoring.service.ts', 'authorKitchenTickets')
    expect(funcion).toBeDefined()
    let pideElSobre = false
    let loExcluye = false
    const visitar = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && textoDeNombre(n.name) === 'giftCardId' && n.initializer.kind === ts.SyntaxKind.TrueKeyword)
        pideElSobre = true
      if (
        ts.isPrefixUnaryExpression(n) &&
        n.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isPropertyAccessExpression(n.operand) &&
        n.operand.name.text === 'giftCardId'
      )
        loExcluye = true
      ts.forEachChild(n, visitar)
    }
    if (funcion) visitar(funcion)
    expect({ pideElSobre, loExcluye }).toEqual({ pideElSobre: true, loExcluye: true })
  })

  it.each([
    ['services/mobile/order.mobile.service.ts', 'cancelOrderInTransaction'],
    ['services/dashboard/order.dashboard.service.ts', 'deleteOrder'],
    ['services/dashboard/order.dashboard.service.ts', 'updateOrder'],
  ])('%s#%s desactiva los sobres PENDING de una cuenta cancelada sin cobrar', (rel, funcion) => {
    expect(llamadasA(funcionDe(rel, funcion), 'desactivarSobresPendientesDeCuentaEnTx')).toHaveLength(1)
  })
})
