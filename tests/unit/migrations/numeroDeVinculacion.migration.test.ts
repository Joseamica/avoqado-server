import * as fs from 'fs'
import * as path from 'path'

// Número de vinculación (PlayTelecom): la migración debe conservar lo que los roles tienen hoy.
const dir = path.join(__dirname, '../../../prisma/migrations')
const folder = fs.readdirSync(dir).find(d => d.endsWith('_numero_de_vinculacion'))

describe('migración numero_de_vinculacion', () => {
  it('existe y conserva los permisos de hoy', () => {
    expect(folder).toBeDefined()
    const sql = fs.readFileSync(path.join(dir, folder as string, 'migration.sql'), 'utf8')
    expect(sql).toMatch(/UPDATE "VenueRolePermission"[\s\S]*permissions[\s\S]*'sale-verifications:approve'[\s\S]*'sale-verifications:review' = ANY/)
    expect(sql).toMatch(/UPDATE "VenueRolePermission"[\s\S]*"deniedPermissions"[\s\S]*'sale-verifications:approve'/)
    expect(sql).toMatch(/UPDATE "PermissionSet"[\s\S]*'sale-verifications:approve'/)
    // "ON DELETE CASCADE" del FK es normal: sólo se prohíbe borrar objetos o filas
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM/)
  })
})
