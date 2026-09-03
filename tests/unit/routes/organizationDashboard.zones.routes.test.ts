/**
 * Cableado de las rutas de zonas del dashboard de organización (estático, lee el archivo).
 *
 * 2026-09-01: `PUT/DELETE /:orgId/zones/:zoneId` iban sólo con checkOrgAccess y pasaban el
 * zoneId de la URL tal cual al servicio, que no recibía orgId: cualquier miembro de una org
 * renombraba o borraba zonas de OTRA org. El candado vive en el servicio (`assertZoneInOrg`)
 * y sólo sirve si la ruta le pasa el orgId — que es lo que fija esta prueba.
 */
import fs from 'fs'
import path from 'path'

const routesSource = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard/organizationDashboard.routes.ts'), 'utf8')

describe('rutas de zonas del dashboard de organización', () => {
  it('PUT /:orgId/zones/:zoneId le pasa el orgId al servicio', () => {
    expect(routesSource).toMatch(/organizationDashboardService\.updateZone\(orgId, zoneId,/)
    expect(routesSource).not.toMatch(/organizationDashboardService\.updateZone\(zoneId/)
  })

  it('DELETE /:orgId/zones/:zoneId le pasa el orgId al servicio', () => {
    expect(routesSource).toMatch(/organizationDashboardService\.deleteZone\(orgId, zoneId\)/)
    expect(routesSource).not.toMatch(/organizationDashboardService\.deleteZone\(zoneId\)/)
  })
})
