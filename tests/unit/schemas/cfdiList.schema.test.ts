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

  // /full-testing 24-sep: `from=2026-13-45` llegaba al servicio y tumbaba la lista con 500.
  it('fecha válida AAAA-MM-DD pasa', () => {
    const r = parse({ from: '2026-09-01', to: '2026-09-24' })
    expect(r.success && r.data.query).toMatchObject({ from: '2026-09-01', to: '2026-09-24' })
  })

  it('fecha inexistente o con otro formato ⇒ 400 en español, nunca 500', () => {
    for (const malo of ['2026-13-45', '2026-02-30', 'abc', '24/09/2026', '2026-9-1']) {
      const r = parse({ from: malo })
      expect([malo, r.success]).toEqual([malo, false])
      if (!r.success) expect(r.error.issues[0].message).toBe('La fecha debe ser un día real con formato AAAA-MM-DD')
    }
    expect(parse({ to: '2026-02-29' }).success).toBe(false) // 2026 no es bisiesto
    expect(parse({ to: '2028-02-29' }).success).toBe(true)
  })

  it('un valor inexistente se rechaza con mensaje en español', () => {
    const r = parse({ status: ['STAMPED', 'PENDING'] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('El estado del CFDI no es válido')
  })
})
