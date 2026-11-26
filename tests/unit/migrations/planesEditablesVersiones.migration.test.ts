import { readFileSync } from 'fs'
import { join } from 'path'

const sql = readFileSync(
  join(__dirname, '../../../prisma/migrations/20261125000000_planes_editables_versiones/migration.sql'),
  'utf8',
)

describe('migración planes editables · versiones de la oferta', () => {
  it('sólo agrega: ni DROP, ni RENAME, ni SET NOT NULL sobre tablas existentes', () => {
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|SET NOT NULL/i)
  })
  it('el puntero es un solo renglón y una versión publicada siempre tiene número', () => {
    expect(sql).toContain(`CHECK ("id" = 'vigente')`)
    expect(sql).toContain(`CHECK ("status" IN ('PREPARING', 'DISCARDED') OR "number" IS NOT NULL)`)
  })
  it('las columnas nuevas de tablas que ya existen son opcionales o con default', () => {
    expect(sql).toMatch(/ALTER TABLE "LaunchCampaignRedemption" ADD COLUMN "stripePriceId" TEXT;/)
    expect(sql).toMatch(
      /ALTER TABLE "PlatformSettings" ADD COLUMN "avisosDelAltaCorreos" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\];/,
    )
  })
})
