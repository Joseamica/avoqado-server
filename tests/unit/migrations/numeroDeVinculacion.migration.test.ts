import * as fs from 'fs'
import * as path from 'path'

// Número de vinculación (PlayTelecom): la migración debe conservar lo que los roles tienen hoy.
const dir = path.join(__dirname, '../../../prisma/migrations')
const folder = fs.readdirSync(dir).find(d => d.endsWith('_numero_de_vinculacion'))
const APPROVE = "'sale-verifications:approve'"
const REVIEW = "'sale-verifications:review'"

const targets: Array<[string, string]> = [
  ['VenueRolePermission', 'permissions'],
  ['VenueRolePermission', 'deniedPermissions'],
  ['PermissionSet', 'permissions'],
]

describe('migración numero_de_vinculacion', () => {
  const sql = folder ? fs.readFileSync(path.join(dir, folder, 'migration.sql'), 'utf8') : ''
  // Sin comentarios, una sentencia por `;`
  const statements = sql
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)

  it('existe', () => {
    expect(folder).toBeDefined()
  })

  it.each(targets)('%s.%s: exactamente un UPDATE que agrega approve a quien tiene review, idempotente', (table, col) => {
    const q = `"${col}"`
    const matches = statements.filter(s => s.startsWith(`UPDATE "${table}"`) && s.includes(`array_append(${q}, ${APPROVE})`) && s.includes(`SET ${q} =`))
    expect(matches).toHaveLength(1)
    expect(matches[0]).toContain(`WHERE ${REVIEW} = ANY(${q})`)
    expect(matches[0]).toContain(`AND NOT (${APPROVE} = ANY(${q}))`)
  })

  it('sólo agrega: ni array_remove, ni DROP, ni DELETE FROM', () => {
    expect(statements.filter(s => s.startsWith('UPDATE'))).toHaveLength(3)
    expect(sql).not.toMatch(/array_remove/)
    // "ON DELETE CASCADE" del FK es normal
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM/)
  })
})
