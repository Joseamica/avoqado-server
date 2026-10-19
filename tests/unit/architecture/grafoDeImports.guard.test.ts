/**
 * Guardias del grafo de imports ESTÁTICOS de tiempo de ejecución (no los `import type`, no los `import()` dinámicos).
 *
 * N1 (Codex r2 del cierre de tarjetas 1a): `scripts/reasignar-cobro-a-su-orden.ts` elige la base (`elegirBase()`: local o Render) y
 * DESPUÉS carga Prisma con `import()` dinámico, porque el cliente lee `DATABASE_URL` al construirse. Si algún import ESTÁTICO del
 * script alcanza `src/utils/prismaClient`, el singleton nace con la URL local del `.env` ANTES de elegir: la pantalla confirma Render
 * y el script escribe en la local (el `import()` de después devuelve el módulo ya cacheado). Pasó con `isGiftCardTenderKind`
 * (giftCardTender → tenderType.dashboard.service → prismaClient) y `tieneRenglonDeTarjeta` (cuentaDeTarjetas → giftCardLedger).
 *
 * Ciclo (re-revisión del cierre r1): `shift.tpv.service` importa `shift.dashboard.service`; el detalle del panel no puede importar de
 * vuelta a la TPV (la marca y las ventas sin tarjetas viven en `giftCardMarks` y `shared/ventasDelTurno`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const RAIZ = join(__dirname, '../../..')
const PRISMA = join(RAIZ, 'src/utils/prismaClient.ts')

/** Los módulos que este archivo carga al cargarse (imports y re-exports con valor), sin los de sólo tipos ni los dinámicos. */
function importsEstaticos(archivo: string): string[] {
  const fuente = ts.createSourceFile(archivo, readFileSync(archivo, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  for (const nodo of fuente.statements) {
    if (ts.isImportDeclaration(nodo) && ts.isStringLiteral(nodo.moduleSpecifier)) {
      const c = nodo.importClause
      const soloTipos =
        c?.isTypeOnly === true ||
        (c !== undefined &&
          !c.name &&
          c.namedBindings !== undefined &&
          ts.isNamedImports(c.namedBindings) &&
          c.namedBindings.elements.length > 0 &&
          c.namedBindings.elements.every(e => e.isTypeOnly))
      if (!soloTipos) out.push(nodo.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(nodo) && nodo.moduleSpecifier && ts.isStringLiteral(nodo.moduleSpecifier) && !nodo.isTypeOnly) {
      out.push(nodo.moduleSpecifier.text)
    }
  }
  return out
}

/** `@/x` → `src/x`; relativo al archivo. Sólo código del repo (los paquetes no cargan el singleton). */
function resolver(desde: string, especificador: string): string | null {
  const base = especificador.startsWith('@/')
    ? join(RAIZ, 'src', especificador.slice(2))
    : especificador.startsWith('.')
      ? resolve(dirname(desde), especificador)
      : null
  if (!base) return null
  for (const candidato of [`${base}.ts`, join(base, 'index.ts'), base])
    if (existsSync(candidato) && candidato.endsWith('.ts')) return candidato
  return null
}

/** El camino de imports estáticos de `inicio` a `destino`, o `null` si no lo alcanza. */
function caminoHasta(inicio: string, destino: string): string[] | null {
  const previo = new Map<string, string | null>([[inicio, null]])
  const cola = [inicio]
  while (cola.length > 0) {
    const actual = cola.shift()!
    if (actual === destino) {
      const camino: string[] = []
      for (let p: string | null = actual; p; p = previo.get(p) ?? null) camino.unshift(relative(RAIZ, p))
      return camino
    }
    for (const esp of importsEstaticos(actual)) {
      const siguiente = resolver(actual, esp)
      if (siguiente && !previo.has(siguiente)) {
        previo.set(siguiente, actual)
        cola.push(siguiente)
      }
    }
  }
  return null
}

describe('N1: el script de reasignación no carga Prisma antes de elegir la base', () => {
  it('🔴 ningún import ESTÁTICO de scripts/reasignar-cobro-a-su-orden.ts alcanza src/utils/prismaClient', () => {
    expect(caminoHasta(join(RAIZ, 'scripts/reasignar-cobro-a-su-orden.ts'), PRISMA)).toBeNull()
  })

  it('control: el recorrido sí encuentra a Prisma cuando está (el servicio de tarjetas lo importa)', () => {
    expect(caminoHasta(join(RAIZ, 'src/services/giftCards/giftCardTender.ts'), PRISMA)).not.toBeNull()
  })
})

describe('cierre r1: sin ciclo entre los servicios de turnos', () => {
  it('🔴 shift.dashboard.service no alcanza shift.tpv.service (que ya lo importa)', () => {
    expect(
      caminoHasta(join(RAIZ, 'src/services/dashboard/shift.dashboard.service.ts'), join(RAIZ, 'src/services/tpv/shift.tpv.service.ts')),
    ).toBeNull()
  })
})
