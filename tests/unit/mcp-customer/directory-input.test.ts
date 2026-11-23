import { z } from 'zod'
import { directoryInputSchema } from '@/mcp/directory/input'

// En el directorio, crear un descuento sólo crea descuentos MANUALES: uno automático lo aplica la caja a cuentas que ya
// estaban abiertas, y esta tanda no cambia el total de una cuenta abierta (auditoría 3-oct).
describe('parámetros del catálogo de directorio', () => {
  const schema = { venueId: z.string(), name: z.string(), automatic: z.boolean().optional(), confirm: z.boolean().optional() }

  it('create_discount pierde el parámetro «automatic» y conserva los demás', () => {
    const out = directoryInputSchema('create_discount', schema)
    expect(Object.keys(out ?? {}).sort()).toEqual(['confirm', 'name', 'venueId'])
  })

  it('un «automatic» enviado de todos modos se descarta al validar', () => {
    const parsed = z.object(directoryInputSchema('create_discount', schema)!).parse({ venueId: 'v', name: 'X', automatic: true })
    expect(parsed).toEqual({ venueId: 'v', name: 'X' })
  })

  // D13.2: `reportType` es nuevo en el MCP manual; el catálogo certificado no cambia lo que ya se revisó.
  it('export_sales_summary pierde «reportType» en el directorio', () => {
    const esquema = { venueId: z.string(), sections: z.string().optional(), reportType: z.string().optional() }
    expect(Object.keys(directoryInputSchema('export_sales_summary', esquema) ?? {}).sort()).toEqual(['sections', 'venueId'])
  })

  it('las demás herramientas conservan su esquema tal cual', () => {
    expect(directoryInputSchema('create_coupon', schema)).toBe(schema)
    expect(directoryInputSchema('daily_sales', undefined)).toBeUndefined()
  })
})
