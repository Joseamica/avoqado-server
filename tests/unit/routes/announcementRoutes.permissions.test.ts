import fs from 'fs'
import path from 'path'

const RUTAS = path.join(__dirname, '../../../src/routes/superadmin/announcement.routes.ts')
const PADRE = path.join(__dirname, '../../../src/routes/superadmin.routes.ts')

/**
 * Guardia estática de autorización.
 *
 * Es estática a propósito: caza EXACTAMENTE la regresión que la auditoría de Codex
 * encontró (pasarle a `authorizeRole` un rol suelto en vez de un arreglo, con lo que
 * "SUPERADMIN".includes("ADMIN") dejaría pasar a un ADMIN). El padre ahora usa la
 * autoridad más fuerte: `requireActiveSuperadmin`, que relee Staff activo desde DB.
 * No sustituye a la integración con supertest que verifica el 403 real.
 */
describe('rutas de anuncios: autorizacion', () => {
  // ===== CASOS NUEVOS =====
  it('estan montadas bajo el router de superadmin', () => {
    const padre = fs.readFileSync(PADRE, 'utf8')
    expect(padre).toMatch(/announcementRoutes/)
    expect(padre).toMatch(/router\.use\('\/announcements', announcementRoutes\)/)
  })

  it('el padre exige una cuenta SUPERADMIN activa confirmada por DB', () => {
    const padre = fs.readFileSync(PADRE, 'utf8')
    expect(padre).toMatch(/router\.use\(requireActiveSuperadmin\)/)
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
