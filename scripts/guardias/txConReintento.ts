/**
 * Guardia de la marca `TxConReintento` (S5b, r6 #2, R74; Rulings 22 y 29). Con el VERIFICADOR DE TIPOS (no con texto) comprueba
 * que la marca sólo viaja como parámetro. Una propiedad «lleva la marca» si es la del `unique symbol` declarado en
 * `src/utils/serializableRetry.ts` (por identidad: ningún alias la esconde). Falla con:
 *  (9)  una expresión donde el compilador espera la marca (argumento, inicializador, asignación, retorno, propiedad) que no es un
 *       identificador que resuelve a un parámetro (o a un elemento desestructurado de un parámetro) cuyo tipo declarado la lleva; y
 *       una variable que la lleva;
 *  (10) una aserción (`as`, `<T>`) cuyo destino la lleva, salvo las de `castsPermitidos` del JSON (un solo lugar, Ruling 29);
 *  (11) un escritor (función con un parámetro que lleva la marca, también por la restricción de un genérico `<T extends
 *       TxConReintento>`) usado como valor y no en posición de llamada: como argumento, en una variable, propiedad, índice
 *       (`s['f']`) o arreglo, `Reflect.apply`, `.call`, `.apply`, `.bind`. Salvo el cuerpo de `withDeadlockRetry`, de
 *       `withSerializableRetry` con `reintentarInterbloqueo`, o de un opener genérico del JSON, y los import/export que sólo la
 *       nombran (`const { f } = await import('…')` cuenta como un import, Ruling 22). Y un método de objeto con la marca donde el
 *       tipo esperado de esa propiedad no es un escritor (`const h: Record<string, Function> = { async a(tx) {…} }`), y un objeto
 *       con escritores ensanchado a `any`/`unknown` (`(servicio as any).f(prisma)`, `const s: any = servicio`);
 *  (12) las sobrecargas de un escritor que no llevan la marca en la misma posición, y un parámetro que la mezcla con un cliente
 *       sin marca (`TxConReintento | Prisma.TransactionClient`).
 * Techo (R74): protege contra el olvido y el código ordinario; la elusión deliberada (`eval`, `require` dinámico, generar código,
 * o ensanchar con `as any` algo que no es el escritor ni su objeto, p. ej. un módulo entero o `globalThis`) queda para la revisión
 * de código.
 *
 * Uso: `npm run guard:tx-con-reintento` (por avq-verify, con la memoria del typecheck). Hasta el paso 8 la marca está apagada y
 * `corridaSobreSrc` es false: corre, informa y sale con 0. Desde el paso 8 sale con 1 si falta la marca o hay hallazgos.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

export type OpcionesDeLaGuardia = {
  /** Raíz del proyecto: sólo se revisa `<raiz>/src/` y las llaves son `src/…#función`. */
  raiz: string
  castsPermitidos: Record<string, { cantidad: number }>
  openersGenericos: Record<string, { cuerpo: number }>
}

const SERIALIZABLE_RETRY = 'src/utils/serializableRetry.ts'

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
const sinParentesis = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? sinParentesis(e.expression) : e)
const esFuncionLiteral = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(n) || ts.isFunctionExpression(n)

export function revisarPrograma(programa: ts.Program, opciones: OpcionesDeLaGuardia): { marca: boolean; hallazgos: string[] } {
  const checker = programa.getTypeChecker()
  const relativo = (archivo: string) => path.relative(opciones.raiz, archivo).split(path.sep).join('/')
  const llave = (n: ts.Node) => `${relativo(n.getSourceFile().fileName)}#${ownerOf(n)}`
  const donde = (n: ts.Node) => {
    const sf = n.getSourceFile()
    return `${relativo(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().replace(/\s+/g, ' ').slice(0, 60)}`
  }
  const fuentes = programa.getSourceFiles().filter(sf => !sf.isDeclarationFile && relativo(sf.fileName).startsWith('src/'))

  // La marca: la propiedad del `unique symbol` de serializableRetry.ts (su nombre interno incluye la identidad del símbolo).
  const sr = fuentes.find(sf => relativo(sf.fileName) === SERIALIZABLE_RETRY)
  let nombreMarca: ts.__String | undefined
  const buscarMarca = (n: ts.Node) => {
    if (ts.isPropertySignature(n) && ts.isComputedPropertyName(n.name)) {
      const s = checker.getSymbolAtLocation(n.name.expression)
      const decl = s?.valueDeclaration
      const unica =
        decl &&
        ts.isVariableDeclaration(decl) &&
        decl.type &&
        ts.isTypeOperatorNode(decl.type) &&
        decl.type.operator === ts.SyntaxKind.UniqueKeyword
      const prop = unica
        ? checker
            .getTypeAtLocation(n.parent)
            .getProperties()
            .find(p => p.declarations?.includes(n))
        : undefined
      if (prop) nombreMarca = prop.escapedName
    }
    ts.forEachChild(n, buscarMarca)
  }
  if (sr) buscarMarca(sr)
  if (!nombreMarca) return { marca: false, hallazgos: [] }

  const cache = new Map<ts.Type, boolean>()
  const lleva = (t: ts.Type): boolean => {
    let r = cache.get(t)
    if (r !== undefined) return r
    cache.set(t, false)
    const restriccion = t.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(t) : undefined
    r = t.isUnion()
      ? t.types.some(lleva)
      : restriccion
        ? restriccion !== t && lleva(restriccion)
        : !!(t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) &&
          checker.getPropertiesOfType(t).some(p => p.escapedName === nombreMarca)
    cache.set(t, r)
    return r
  }
  const partes = (t: ts.Type) =>
    (t.isUnion() ? t.types : [t]).filter(p => !(p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)))
  const marcado = (t: ts.Type) => partes(t).some(lleva)
  const mezclado = (t: ts.Type) => marcado(t) && partes(t).some(p => !lleva(p))
  const esEscritor = (t: ts.Type) =>
    t
      .getCallSignatures()
      .some(s => s.getParameters().some(p => p.valueDeclaration && marcado(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration))))
  /** Un escritor, o un objeto que tiene uno como propiedad (un servicio). */
  const llevaEscritor = (t: ts.Type) =>
    esEscritor(t) || (!!(t.flags & ts.TypeFlags.Object) && checker.getPropertiesOfType(t).some(p => esEscritor(checker.getTypeOfSymbol(p))))
  const abierto = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))

  /** ¿Esta llamada abre la red? Índice del argumento que es el cuerpo, o -1. */
  const cuerpoDeApertura = (c: ts.CallExpression): number => {
    const decl = checker.getResolvedSignature(c)?.declaration
    const nombre = decl && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) && decl.name ? decl.name.getText() : undefined
    if (!decl || !nombre) return -1
    const k = `${relativo(decl.getSourceFile().fileName)}#${nombre}`
    if (k === `${SERIALIZABLE_RETRY}#withDeadlockRetry`) return 0
    if (k === `${SERIALIZABLE_RETRY}#withSerializableRetry`) {
      const o = c.arguments[1]
      const reintenta =
        o &&
        ts.isObjectLiteralExpression(o) &&
        o.properties.some(
          p =>
            ts.isPropertyAssignment(p) && p.name.getText() === 'reintentarInterbloqueo' && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
        )
      return reintenta ? 0 : -1
    }
    return opciones.openersGenericos[k]?.cuerpo ?? -1
  }
  const esCuerpoDeApertura = (n: ts.Node) => {
    const c = n.parent
    return !!c && ts.isCallExpression(c) && c.arguments.indexOf(n as ts.Expression) === cuerpoDeApertura(c)
  }
  /** Un parámetro (o un elemento desestructurado de un parámetro) cuyo tipo declarado lleva la marca. */
  const esParametroMarcado = (id: ts.Identifier, simbolo = checker.getSymbolAtLocation(id)) => {
    let decl: ts.Node | undefined = simbolo?.valueDeclaration
    if (!simbolo || !decl) return false
    while (decl && (ts.isBindingElement(decl) || ts.isObjectBindingPattern(decl) || ts.isArrayBindingPattern(decl))) decl = decl.parent
    return !!decl && ts.isParameter(decl) && marcado(checker.getTypeOfSymbol(simbolo))
  }

  const hallazgos: string[] = []
  const castsPorLlave = new Map<string, number>()

  // Los nombres de los escritores (y sus alias por import, desestructuración o `await import`): el filtro barato antes del tipo.
  const nombres = new Set<string>()
  const conParametroMarcado = (f: ts.SignatureDeclaration) => f.parameters.some(p => marcado(checker.getTypeAtLocation(p)))
  for (const sf of fuentes)
    ts.forEachChild(sf, function visitar(n: ts.Node) {
      // Un import por defecto de un escritor (`import otroNombre from './escritor'`) también lo nombra.
      if (ts.isImportClause(n) && n.name && esEscritor(checker.getTypeAtLocation(n.name))) nombres.add(n.name.text)
      if ((ts.isFunctionLike(n) || ts.isFunctionTypeNode(n)) && conParametroMarcado(n as ts.SignatureDeclaration)) {
        const nombre = (n as ts.SignatureDeclaration).name ?? ((n.parent as ts.NamedDeclaration | undefined)?.name as ts.Node | undefined)
        if (nombre && (ts.isIdentifier(nombre) || ts.isPrivateIdentifier(nombre))) nombres.add(nombre.text)
      }
      ts.forEachChild(n, visitar)
    })
  for (let cambio = true; cambio; ) {
    cambio = false
    for (const sf of fuentes)
      ts.forEachChild(sf, function visitar(n: ts.Node) {
        if ((ts.isBindingElement(n) || ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && ts.isIdentifier(n.name)) {
          const original = n.propertyName?.getText()
          if (original && nombres.has(original) && !nombres.has(n.name.text)) {
            nombres.add(n.name.text)
            cambio = true
          }
        }
        ts.forEachChild(n, visitar)
      })
  }

  for (const sf of fuentes) {
    const visitar = (n: ts.Node) => {
      // (12) Sobrecargas: todas llevan la marca en la misma posición; y nada de mezclarla con un cliente sin marca.
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.body) {
        const simbolo = n.name && checker.getSymbolAtLocation(n.name)
        const firmas = (simbolo?.declarations ?? []).filter((d): d is ts.SignatureDeclaration => ts.isFunctionLike(d) && d !== n)
        const posiciones = new Set<number>()
        for (const d of [n, ...firmas]) d.parameters.forEach((p, i) => marcado(checker.getTypeAtLocation(p)) && posiciones.add(i))
        for (const d of firmas)
          for (const i of posiciones)
            if (!d.parameters[i] || !marcado(checker.getTypeAtLocation(d.parameters[i])))
              hallazgos.push(`(12) ${donde(d)}: una sobrecarga sin la marca en el parámetro ${i + 1} deja pasar un cliente sin reintento`)
      }
      if (ts.isParameter(n) && mezclado(checker.getTypeAtLocation(n)))
        hallazgos.push(`(12) ${donde(n)}: el parámetro mezcla TxConReintento con un cliente sin marca; pide sólo TxConReintento`)

      // (10) Aserciones hacia la marca.
      if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && marcado(checker.getTypeFromTypeNode(n.type))) {
        const k = llave(n)
        const vistos = (castsPorLlave.get(k) ?? 0) + 1
        castsPorLlave.set(k, vistos)
        if (vistos > (opciones.castsPermitidos[k]?.cantidad ?? 0))
          hallazgos.push(
            `(10) ${donde(n)}: aserción a TxConReintento fuera de castsPermitidos (${k}); la marca sólo la entrega withDeadlockRetry`,
          )
      }

      // (9) Donde se espera la marca, sólo un parámetro que ya la lleva. Y ninguna variable la lleva.
      if (ts.isVariableDeclaration(n) && marcado(checker.getTypeAtLocation(n.name)))
        hallazgos.push(`(9) ${donde(n)}: una variable no puede llevar TxConReintento; pásalo como parámetro`)
      if (ts.isExpression(n) && !ts.isSpreadElement(n) && enRanura(n)) {
        const esperado = checker.getContextualType(n)
        const e = sinParentesis(n)
        const permitido =
          (ts.isIdentifier(e) && esParametroMarcado(e)) ||
          // Sólo la aserción A LA MARCA de una función listada (la que (10) ya limita a su cantidad); `tx as any` no.
          ((ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) &&
            marcado(checker.getTypeFromTypeNode(e.type)) &&
            (opciones.castsPermitidos[llave(e)]?.cantidad ?? 0) > 0)
        // En una llamada genérica (`<T extends TxConReintento>(tx: T)`) el tipo esperado ya viene instanciado (con `as any`, T = any):
        // se mira también el parámetro DECLARADO de la firma.
        const declarado = () => {
          const c = n.parent
          if (!ts.isCallExpression(c) && !ts.isNewExpression(c)) return false
          const params = checker.getResolvedSignature(c)?.declaration?.parameters
          const p = params?.[Math.min(c.arguments?.indexOf(n) ?? 0, params.length - 1)]
          return !!p && marcado(checker.getTypeAtLocation(p))
        }
        if (((esperado && marcado(esperado)) || declarado()) && !permitido)
          hallazgos.push(
            `(9) ${donde(n)}: donde se espera TxConReintento sólo va un parámetro que ya lo es (nada de any, aserciones, variables ni resultados)`,
          )
        const valor =
          ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || e.kind === ts.SyntaxKind.ThisKeyword
        if (esperado && abierto(esperado) && valor) {
          const tipo = checker.getTypeAtLocation(e)
          if (!esEscritor(tipo) && llevaEscritor(tipo))
            hallazgos.push(`(11) ${donde(n)}: un objeto con escritores ensanchado a any/unknown deja llamarlos con cualquier cliente`)
        }
      }
      // (9) Un argumento esparcido (`escribir(...args)`) en la posición de un parámetro con la marca.
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.some(ts.isSpreadElement)) {
        const firma = checker.getResolvedSignature(n)
        const i = n.arguments.findIndex(ts.isSpreadElement)
        if (
          firma
            ?.getParameters()
            .slice(i)
            .some(p => marcado(checker.getTypeOfSymbolAtLocation(p, n)))
        )
          hallazgos.push(`(9) ${donde(n.arguments[i])}: un argumento esparcido no puede llenar un parámetro TxConReintento`)
      }
      // (11) Una aserción a any/unknown que esconde un escritor o un objeto con escritores.
      if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && abierto(checker.getTypeFromTypeNode(n.type))) {
        const tipo = checker.getTypeAtLocation(n.expression)
        if (!esEscritor(tipo) && llevaEscritor(tipo))
          hallazgos.push(`(11) ${donde(n)}: «as any» sobre un objeto con escritores deja llamarlos con cualquier cliente`)
      }
      if (ts.isShorthandPropertyAssignment(n)) {
        const esperado = checker.getContextualType(n.parent)?.getProperty(n.name.text)
        const valor = checker.getShorthandAssignmentValueSymbol(n)
        if (esperado && marcado(checker.getTypeOfSymbol(esperado)) && !esParametroMarcado(n.name, valor))
          hallazgos.push(`(9) ${donde(n)}: donde se espera TxConReintento sólo va un parámetro que ya lo es`)
      }

      // (11) Un escritor sólo se llama.
      const referencia =
        (ts.isIdentifier(n) && nombres.has(n.text) && !esNombreDeDeclaracion(n)) ||
        (ts.isPropertyAccessExpression(n) && nombres.has(n.name.text)) ||
        (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && nombres.has(n.argumentExpression.text)) ||
        (ts.isShorthandPropertyAssignment(n) && nombres.has(n.name.text))
      if (referencia) {
        const tipo = ts.isShorthandPropertyAssignment(n)
          ? checker.getTypeOfSymbol(checker.getShorthandAssignmentValueSymbol(n)!)
          : checker.getTypeAtLocation(n)
        if (esEscritor(tipo) && !seLlama(n))
          hallazgos.push(`(11) ${donde(n)}: un escritor sólo se llama (escribir(tx)); nunca se pasa, guarda ni enlaza`)
      }
      // Un método de objeto con la marca: si el objeto tiene un tipo esperado, esa propiedad tiene que ser un escritor (una tabla
      // `Record<string, Function>` o `any` lo convierte en algo que se llama con cualquier cliente). Sin tipo esperado (`servicio =
      // { … }`), pasa: su tipo es el del método.
      if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) && conParametroMarcado(n)) {
        const contextual = checker.getContextualType(n.parent)
        // `Manejador | undefined` (y `T | null`): se mira el tipo sin lo nulo, o una unión legítima caería como falso positivo.
        const esperado = contextual && checker.getNonNullableType(contextual)
        if (esperado) {
          const nombre = nombreDePropiedad(n.name) // resuelve también `'a'(tx)` y `['a'](tx)`
          const propiedad = nombre === undefined ? undefined : esperado.getProperty(nombre)
          const tipo = propiedad ? checker.getTypeOfSymbol(propiedad) : (esperado.getStringIndexType() ?? esperado.getNumberIndexType())
          if (!tipo || !esEscritor(tipo))
            hallazgos.push(
              `(11) ${donde(n)}: un método con TxConReintento en un objeto cuyo tipo no lo pide como escritor (tabla de despacho)`,
            )
        }
      }
      if (esFuncionLiteral(n) && conParametroMarcado(n) && !esDeclaracion(n) && !esCuerpoDeApertura(n))
        hallazgos.push(
          `(11) ${donde(n)}: una función con TxConReintento como valor; decláralo con nombre y llámalo, o pásalo a withDeadlockRetry`,
        )

      ts.forEachChild(n, visitar)
    }
    visitar(sf)
  }
  return { marca: true, hallazgos }

  function seLlama(n: ts.Node): boolean {
    const p = n.parent
    if (ts.isCallExpression(p) && p.expression === n) return true
    if (ts.isIdentifier(n) && ts.isPropertyAccessExpression(p) && p.name === n) return true // lo decide el `a.escribir` completo
    if (ts.isExportAssignment(p) || ts.isTypeQueryNode(p)) return true
    return esCuerpoDeApertura(n)
  }
}

/** El texto de un nombre de propiedad escrito como identificador, comillas, número o `['literal']`; si no es literal, undefined. */
function nombreDePropiedad(nombre: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(nombre) || ts.isStringLiteralLike(nombre) || ts.isNumericLiteral(nombre)) return nombre.text
  if (ts.isComputedPropertyName(nombre) && ts.isStringLiteralLike(nombre.expression)) return nombre.expression.text
  return undefined
}

function esNombreDeDeclaracion(n: ts.Identifier): boolean {
  const p = n.parent
  return (
    ((ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionExpression(p)) &&
      p.name === n) ||
    (ts.isBindingElement(p) && p.propertyName === n) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isShorthandPropertyAssignment(p) ||
    ts.isQualifiedName(p)
  )
}
/** Una función literal que ES la declaración de un nombre: `const f = (tx) => …` o una propiedad de clase. */
function esDeclaracion(f: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const p = f.parent
  return (
    (ts.isVariableDeclaration(p) && p.initializer === f && ts.isIdentifier(p.name)) || (ts.isPropertyDeclaration(p) && p.initializer === f)
  )
}
/** Las ranuras donde el compilador tiene un tipo esperado: argumento, inicializador, asignación, retorno, propiedad, arreglo. */
function enRanura(n: ts.Expression): boolean {
  const p = n.parent
  if (!p) return false
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n)) return true
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) && p.initializer === n)
    return true
  if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true
  if (ts.isPropertyAssignment(p) && p.initializer === n) return true
  if (ts.isArrowFunction(p) && p.body === n) return true
  return ts.isReturnStatement(p) || ts.isArrayLiteralExpression(p)
}

if (require.main === module) {
  const raiz = path.resolve(__dirname, '../..')
  const revisado = JSON.parse(fs.readFileSync(path.join(raiz, 'tests/unit/architecture/ordenDeCandadosParte2.reviewed.json'), 'utf8'))
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(raiz, 'tsconfig.typecheck.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      },
    },
  )
  if (!config) throw new Error('No se pudo leer tsconfig.typecheck.json')
  const inicio = Date.now()
  const programa = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, incremental: false, noEmit: true } })
  const r = revisarPrograma(programa, { raiz, castsPermitidos: revisado.castsPermitidos, openersGenericos: revisado.openersGenericos })
  const exigir = revisado.corridaSobreSrc === true
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1)
  const memoria = (process.memoryUsage().rss / 1024 ** 3).toFixed(2)
  if (!r.marca) console.log('🟡 guardia TxConReintento: la marca está apagada (TxConReintento es un alias); se prende en el paso 8.')
  for (const h of r.hallazgos) console.log(h)
  console.log(
    `guardia TxConReintento: ${r.hallazgos.length} hallazgos · ${programa.getSourceFiles().length} archivos · ${segundos} s · ${memoria} GB` +
      (exigir ? '' : ' · no se exige todavía (corridaSobreSrc: false, paso 8)'),
  )
  process.exitCode = exigir && (!r.marca || r.hallazgos.length > 0) ? 1 : 0
}
