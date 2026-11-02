/**
 * Negocios demo (Codex r5): en un demo sólo se escribe en las secciones PERMITIDAS; lo demás queda cerrado por defecto.
 * Esta prueba obliga a decidir: toda sección de negocio que exista en las rutas del panel y de la app está clasificada
 * (permitida o bloqueada con su razón). Una sección nueva sin clasificar truena aquí, y mientras tanto queda cerrada en el
 * demo (nunca abierta). Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md.
 */
import fs from 'fs'
import path from 'path'
import { APP_BLOQUEADAS, APP_PERMITIDAS, PANEL_BLOQUEADAS, PANEL_PERMITIDAS } from '@/services/demo/candadoDemo'

const RUTAS = path.join(__dirname, '../../../src/routes')

/** Secciones `/venues/:venueId/<sección>` con alguna escritura (o un router montado) en un archivo de rutas. */
function secciones(archivo: string): string[] {
  const codigo = fs.readFileSync(path.join(RUTAS, archivo), 'utf8')
  const encontradas = [...codigo.matchAll(/router\.(?:post|put|patch|delete|use)\(\s*'\/venues\/:venueId\/([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase())
  return [...new Set(encontradas)].sort()
}

describe('candado demo: cada sección de negocio está clasificada', () => {
  it('panel: toda sección es permitida o bloqueada (con razón), y ninguna es las dos cosas', () => {
    const sinClasificar = secciones('dashboard.routes.ts').filter(s => !PANEL_PERMITIDAS.has(s) && !(s in PANEL_BLOQUEADAS))
    expect(sinClasificar).toEqual([])
    expect(Object.keys(PANEL_BLOQUEADAS).filter(s => PANEL_PERMITIDAS.has(s))).toEqual([])
  })

  it('app del POS: toda sección es permitida o bloqueada (con razón), y ninguna es las dos cosas', () => {
    const sinClasificar = secciones('mobile.routes.ts').filter(s => !APP_PERMITIDAS.has(s) && !(s in APP_BLOQUEADAS))
    expect(sinClasificar).toEqual([])
    expect(Object.keys(APP_BLOQUEADAS).filter(s => APP_PERMITIDAS.has(s))).toEqual([])
  })

  it('encuentra las secciones (si esto baja mucho, la búsqueda se rompió)', () => {
    expect(secciones('dashboard.routes.ts').length).toBeGreaterThan(80)
    expect(secciones('mobile.routes.ts').length).toBeGreaterThan(30)
  })
})
