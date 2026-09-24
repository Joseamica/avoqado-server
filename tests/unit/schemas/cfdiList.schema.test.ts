// tests/unit/schemas/cfdiList.schema.test.ts
// La lista de facturas acepta uno o VARIOS estatus/flujos (Testarudo 24-sep-2026: marcar dos en la pantalla
// no filtraba nada). Un solo valor sigue funcionando como antes.
import { listCfdisSchema } from '../../../src/schemas/dashboard/cfdi.schema'

const parse = (query: Record<string, unknown>) => listCfdisSchema.safeParse({ query })

describe('listCfdisSchema — status/flow uno o varios', () => {
  it('un valor (como antes) sale como arreglo de uno', () => {
    const r = parse({ status: 'STAMPED', flow: 'STAFF_B' })
    expect(r.success && r.data.query).toMatchObject({ status: ['STAMPED'], flow: ['STAFF_B'] })
  })

  it('varios valores repetidos (?status=A&status=B, o status[] de axios) llegan como arreglo', () => {
    const r = parse({ status: ['STAMPED', 'CANCELLED'] })
    expect(r.success && r.data.query.status).toEqual(['STAMPED', 'CANCELLED'])
  })

  it('separados por coma también', () => {
    const r = parse({ flow: 'STAFF_B,AUTOFACTURA_A' })
    expect(r.success && r.data.query.flow).toEqual(['STAFF_B', 'AUTOFACTURA_A'])
  })

  it('sin valor ⇒ sin filtro', () => {
    const r = parse({})
    expect(r.success && r.data.query.status).toBeUndefined()
  })

  it('un valor inexistente se rechaza con mensaje en español', () => {
    const r = parse({ status: ['STAMPED', 'PENDING'] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('El estado del CFDI no es válido')
  })
})
