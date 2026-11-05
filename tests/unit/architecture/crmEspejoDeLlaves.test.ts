/**
 * CRM, llaves finas (plan 2026-11-04, L11): `campanas` y `admin` son sólo el ESPEJO para la pantalla vieja y viven en
 * `access.service.ts` (alias de `hasCrmKey` y `legacyFlags`). Ninguna ruta, servicio, controlador ni herramienta del MCP
 * puede decidir con ellos: ni leer `access.admin`/`access.campanas` ni pedir `'crm:admin'`/`'crm:campanas'`.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const DONDE = ['services/crm', 'controllers/crm', 'mcp/tools/crm.ts', 'routes/crm.routes.ts']
const EXCLUIDO = path.join(SRC, 'services/crm/access.service.ts')
const ESPEJO = /\.(admin|campanas)\b|'crm:(admin|campanas)'/

function archivos(p: string): string[] {
  const full = path.join(SRC, p)
  if (full.endsWith('.ts')) return [full]
  return fs.readdirSync(full, { withFileTypes: true }).flatMap(e => {
    const sub = path.join(p, e.name)
    return e.isDirectory() ? archivos(sub) : e.name.endsWith('.ts') ? [path.join(SRC, sub)] : []
  })
}

describe('CRM: nada decide con el espejo de llaves (campanas / admin)', () => {
  it('sólo access.service.ts nombra el espejo', () => {
    const todos = DONDE.flatMap(archivos).filter(f => f !== EXCLUIDO)
    expect(todos.length).toBeGreaterThan(5)
    const hallazgos = todos.flatMap(f =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((linea, i) => (ESPEJO.test(linea) ? [`${path.relative(SRC, f)}:${i + 1}: ${linea.trim()}`] : [])),
    )
    expect(hallazgos).toEqual([])
  })
})
