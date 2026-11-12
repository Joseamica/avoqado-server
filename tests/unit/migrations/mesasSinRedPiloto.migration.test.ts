/**
 * D5 · bloque P (11-nov-2026): la migración de DATOS que crea la Feature `MESAS_SIN_RED` (interruptor del piloto «cobrar mesas sin
 * internet»). Va en su propia publicación, DESPUÉS de que esté en producción el código que la excluye de demos, exención y Stripe
 * (Codex p-r1 #1: durante el despliegue, el servidor anterior concedería la fila nueva a cada demo creada en esa ventana).
 */
import fs from 'fs'
import path from 'path'

const CODIGO = 'MESAS_SIN_RED'

describe('la migración de datos', () => {
  const dir = path.join(__dirname, '../../../prisma/migrations')
  const carpeta = fs.readdirSync(dir).find(d => d.endsWith('_feature_mesas_sin_red_piloto'))
  const sql = carpeta ? fs.readFileSync(path.join(dir, carpeta, 'migration.sql'), 'utf8') : ''

  it('crea la Feature a $0, activa, con id cuid v1, y es idempotente sin pisar una fila existente', () => {
    expect(carpeta).toBeDefined()
    const valores = sql.match(/VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/)?.[1] ?? ''
    const [id, code, , , category, precio, activa] = valores
      .split(/,\s*\n/)
      .map(v => v.trim().replace(/^'|'$/g, ''))
    expect(id).toMatch(/^c[a-z0-9]{24}$/)
    expect([code, category, precio, activa]).toEqual([CODIGO, 'OPERATIONS', '0.00', 'true'])
    expect(sql).toMatch(/ON CONFLICT \("code"\) DO NOTHING;/)
    // Sólo datos: ni esquema ni concesiones.
    expect(sql).not.toMatch(/ALTER TABLE|CREATE TABLE|"VenueFeature"/i)
  })
})
