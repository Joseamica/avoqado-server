/**
 * 6b · pulido (QA 14-oct): el bloque `@openapi` de GET /venues/:venueId/iva-por-producto traía un `description:` sin comillas
 * con «revisado: false» ⇒ YAMLSemanticError en cada arranque y la ruta no salía en /api-docs.
 * Se arma el spec con la MISMA librería que `src/config/swagger.ts` (swagger-jsdoc), sólo sobre el archivo de rutas del dashboard.
 */
import swaggerJsdoc from 'swagger-jsdoc'
import path from 'path'

const RUTA = '/api/v1/dashboard/venues/{venueId}/iva-por-producto'

describe('OpenAPI de la ruta iva-por-producto', () => {
  it('el YAML de dashboard.routes.ts se parsea sin errores y la ruta aparece en el spec', () => {
    const spec = swaggerJsdoc({
      definition: { openapi: '3.0.0', info: { title: 'test', version: '1.0.0' } },
      apis: [path.join(__dirname, '../../../src/routes/dashboard.routes.ts')],
      failOnErrors: true, // YAMLSemanticError en CUALQUIER bloque ⇒ lanza
    }) as { paths: Record<string, { get?: { summary?: string; description?: string } }> }

    expect(spec.paths[RUTA]?.get?.summary).toBe('Estado del IVA por producto del negocio')
    expect(spec.paths[RUTA]?.get?.description).toContain('revisado: false')
  })
})
