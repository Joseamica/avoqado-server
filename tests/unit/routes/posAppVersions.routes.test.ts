import fs from 'fs'
import path from 'path'

/**
 * Actualizador del POS — montaje de rutas (estático, como platformCharges.routes.test.ts). La autorización real la prueba la
 * integración; aquí se fija que el montaje quede DESPUÉS del guardia de SUPERADMIN y que la pública lleve su límite por visitante.
 */
const leer = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8')

const PADRE = leer('src/routes/superadmin.routes.ts')
const PUBLICAS = leer('src/routes/public.routes.ts')
const NUEVOS = [
  'src/controllers/superadmin/posAppVersions.controller.ts',
  'src/routes/superadmin/posAppVersions.routes.ts',
  'src/controllers/public/posAppVersion.public.controller.ts',
]

describe('rutas del actualizador del POS', () => {
  it('superadmin.routes.ts monta /pos-app-versions después del guardia de SUPERADMIN', () => {
    const guardia = PADRE.indexOf('authorizeRole([StaffRole.SUPERADMIN])')
    const montaje = PADRE.indexOf("router.use('/pos-app-versions'")
    expect(guardia).toBeGreaterThan(-1)
    expect(montaje).toBeGreaterThan(guardia)
  })

  it('public.routes.ts declara posAppVersionLimit por visitante, 120 por minuto, y lo usa en /pos-app-version', () => {
    expect(PUBLICAS).toMatch(/const posAppVersionLimit = rateLimit\(\{[^}]*max: 120[^}]*keyGenerator: porVisitante/)
    expect(PUBLICAS).toMatch(/router\.get\(\s*'\/pos-app-version',\s*posAppVersionLimit,/)
    expect(PUBLICAS.indexOf('const posAppVersionLimit')).toBeGreaterThan(PUBLICAS.indexOf('const porVisitante'))
  })

  it.each(NUEVOS)('%s no importa AppUpdate, tpv-version-gate ni logAction', rel => {
    const src = leer(rel)
    expect(src).not.toMatch(/AppUpdate/)
    expect(src).not.toMatch(/tpv-version-gate/)
    expect(src).not.toMatch(/logAction/)
  })
})
