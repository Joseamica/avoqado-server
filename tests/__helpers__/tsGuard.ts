/** Lo que comparten las guardias de arquitectura que leen el código con el compilador de TypeScript. */
import * as fs from 'fs'
import * as path from 'path'
import type ts from 'typescript'

/** La raíz del repo. */
export const ROOT = path.resolve(__dirname, '../..')

/** Los `.ts` bajo `dir`, sin las pruebas, en rutas absolutas. */
export const listTs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listTs(full)
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [full] : []
  })

/** La ruta relativa a la raíz, con `/`. */
export const fromRoot = (file: string): string => path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join('/')

/** `archivo:renglón` de un nodo, con la ruta del repo. */
export const lineOf = (sf: ts.SourceFile, node: ts.Node): string =>
  `${fromRoot(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
