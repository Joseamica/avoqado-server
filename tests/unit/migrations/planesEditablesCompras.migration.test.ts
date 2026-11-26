import { readFileSync } from 'fs'
import { join } from 'path'

const sql = readFileSync(join(__dirname, '../../../prisma/migrations/20261126000000_planes_editables_compras/migration.sql'), 'utf8')

describe('migración planes editables · compras', () => {
  it('sólo agrega: ni DROP, ni RENAME, ni SET NOT NULL', () => {
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|SET NOT NULL/i)
  })
  it('la columna nueva de una tabla que ya existe es opcional', () => {
    expect(sql).toContain('ALTER TABLE "OnboardingProgress" ADD COLUMN "planOfferVersionNumber" INTEGER;')
  })
  it('ninguna columna nueva en VenueFeature', () => {
    expect(sql).not.toMatch(/ALTER TABLE "VenueFeature"/)
  })
  it('una versión no se borra con aceptaciones encima y la aceptación va acotada', () => {
    expect(sql).toMatch(/FOREIGN KEY \("offerVersionId"\) REFERENCES "PlanOfferVersion"\("id"\) ON DELETE RESTRICT/)
    expect(sql).toContain(`CHECK ("tier" IN ('PRO', 'PREMIUM') AND "interval" IN ('monthly', 'annual'))`)
  })
})
