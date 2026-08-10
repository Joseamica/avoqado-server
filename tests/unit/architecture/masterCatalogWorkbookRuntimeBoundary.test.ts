import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

function runtimeWorkbookFiles(): string[] {
  const workers = join(process.cwd(), 'src/workers')
  const services = join(process.cwd(), 'src/services/master-catalog')
  return [
    ...readdirSync(services)
      .filter(name => /^(?:catalogWorkbook|catalogExport).*\.service\.ts$/u.test(name))
      .map(name => join(services, name)),
    ...readdirSync(workers)
      .filter(name => /^masterCatalog.*\.ts$/u.test(name))
      .map(name => join(workers, name)),
  ]
}

function importedModules(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const modules: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) modules.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      modules.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return modules
}

describe('master-catalog untrusted workbook runtime boundary', () => {
  it('keeps SheetJS outside every production workbook worker/service module', () => {
    // WHY: SheetJS may write trusted fixtures, but its parser cannot regain an
    // untrusted-upload path after the bounded OOXML subset replaces XLSX.read.
    const offenders = runtimeWorkbookFiles().flatMap(path =>
      importedModules(path)
        .filter(moduleName => moduleName === 'xlsx')
        .map(() => path.replace(`${process.cwd()}/`, '')),
    )

    expect(offenders).toEqual([])
  })
})
