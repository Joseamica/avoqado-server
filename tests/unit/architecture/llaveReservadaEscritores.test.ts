/**
 * SDK propio (ronda 2 · R2-1): todo escritor del JSON de ajustes de `Terminal` (`config` / `configOverrides`) pasa por
 * `src/lib/llaveReservadaSdkPropio.ts`, que quita la llave reservada `inHouseSdkEnabled`. Recuento TEXTUAL: cada llamada
 * `.terminal.(create|createMany|update|updateMany|upsert)(…)` cuyo argumento nombra `config` o `configOverrides`, más cada
 * `data.config… =`. Un sitio nuevo cambia el recuento y esta prueba truena: pásalo por `sinLlaveReservada` /
 * `configSinLlaveReservada` y súmalo aquí. Límite conocido: no ve SQL crudo ni `prisma['terminal']` (hoy no hay ninguno).
 */
import fs from 'fs'
import path from 'path'

const INVENTARIO: Record<string, number> = {
  'src/controllers/tpv/terminal.tpv.controller.ts': 1, // PUT del aparato
  'src/services/dashboard/tpv.dashboard.service.ts': 4, // alta, updateScopedTerminal (guardar y restablecer), cascada, `data.config =`
  'src/services/organization-dashboard/organizationDashboard.service.ts': 1, // reparto de los ajustes de la organización
}

function escritores(): Record<string, number> {
  const raiz = path.join(__dirname, '../../..')
  const archivos: string[] = []
  const recorrer = (d: string) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .forEach(e => (e.isDirectory() ? recorrer(path.join(d, e.name)) : e.name.endsWith('.ts') && archivos.push(path.join(d, e.name))))
  recorrer(path.join(raiz, 'src'))
  const cuenta: Record<string, number> = {}
  for (const archivo of archivos) {
    const s = fs.readFileSync(archivo, 'utf8')
    const llamadas = [...s.matchAll(/\.terminal\.(?:create|createMany|update|updateMany|upsert)\(/g)].filter(m => {
      let i = m.index! + m[0].length
      for (let nivel = 1; nivel && i < s.length; i++) nivel += s[i] === '(' ? 1 : s[i] === ')' ? -1 : 0
      return /\bconfig(?:Overrides)?\b\s*[:,}]/.test(s.slice(m.index, i))
    }).length
    const asignaciones = llamadas || /\.terminal\./.test(s) ? (s.match(/\bdata\.config(?:Overrides)?\s*=/g) ?? []).length : 0
    if (llamadas + asignaciones) cuenta[path.relative(raiz, archivo)] = llamadas + asignaciones
  }
  return cuenta
}

describe('escritores del JSON de ajustes de Terminal', () => {
  it('son exactamente los del inventario, y cada archivo usa el filtro de la llave reservada', () => {
    const cuenta = escritores()
    expect(cuenta).toEqual(INVENTARIO)
    for (const archivo of Object.keys(INVENTARIO)) {
      expect(fs.readFileSync(path.join(__dirname, '../../..', archivo), 'utf8')).toMatch(/llaveReservadaSdkPropio'/)
    }
  })
})
