import fs from 'fs'
import path from 'path'

const RUTAS = path.join(__dirname, '../../../src/routes/superadmin/announcement.routes.ts')
const PADRE = path.join(__dirname, '../../../src/routes/superadmin.routes.ts')

/**
 * Guardia estática de autorización.
 *
 * Es estática a propósito: caza EXACTAMENTE la regresión que la auditoría de Codex
 * encontró (pasarle a `authorizeRole` un rol suelto en vez de un arreglo, con lo que
 * "SUPERADMIN".includes("ADMIN") dejaría pasar a un ADMIN). No sustituye a una prueba
 * de integración con supertest, que verificaría un 403 real.
 */
describe('rutas de anuncios: autorizacion', () => {
  // ===== CASOS NUEVOS =====
  it('estan montadas bajo el router de superadmin', () => {
    const padre = fs.readFileSync(PADRE, 'utf8')
    expect(padre).toMatch(/announcementRoutes/)
    expect(padre).toMatch(/router\.use\('\/announcements', announcementRoutes\)/)
  })

  it('el padre exige SUPERADMIN con un ARREGLO', () => {
    const padre = fs.readFileSync(PADRE, 'utf8')
    expect(padre).toMatch(/authorizeRole\(\[StaffRole\.SUPERADMIN\]\)/)
  })

  // ===== REGRESION: el P1 de la auditoria no puede volver =====
  it('la subruta NO pasa un rol suelto a authorizeRole', () => {
    const rutas = fs.readFileSync(RUTAS, 'utf8')
    expect(rutas).not.toMatch(/authorizeRole\(\s*StaffRole\./)
  })

  it('la subruta no se abre a ADMIN por su cuenta', () => {
    const rutas = fs.readFileSync(RUTAS, 'utf8')
    expect(rutas).not.toMatch(/StaffRole\.ADMIN/)
  })
})
