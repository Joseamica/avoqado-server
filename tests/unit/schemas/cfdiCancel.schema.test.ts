// tests/unit/schemas/cfdiCancel.schema.test.ts
// C2 · T10 ronda 1 (I-1): «Consultar estado» manda `{ soloConsultar: true }` sin motivo; cancelar de verdad sigue exigiendo el motivo.
import { cancelCfdiSchema } from '../../../src/schemas/dashboard/cfdi.schema'

const parse = (body: unknown) => cancelCfdiSchema.safeParse({ body })

describe('cancelCfdiSchema', () => {
  it('🔴 `{ soloConsultar: true }` sin motivo pasa (sólo consulta)', () => {
    const r = parse({ soloConsultar: true })
    expect(r.success).toBe(true)
    expect(r.success && (r.data.body as any).soloConsultar).toBe(true)
  })

  it('control — cancelar sin motivo ⇒ el mensaje de siempre, en español', () => {
    const r = parse({})
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.map(i => i.message)).toContain('El motivo de cancelación es requerido')
  })

  it('control — `soloConsultar: false` no es una consulta: sigue exigiendo el motivo', () => {
    expect(parse({ soloConsultar: false }).success).toBe(false)
  })

  it('control — con motivo, igual que antes; un motivo fuera del catálogo se rechaza', () => {
    expect(parse({ motivo: '02' }).success).toBe(true)
    expect(parse({ motivo: '09' }).success).toBe(false)
    expect(parse({ motivo: '09', soloConsultar: true }).success).toBe(false)
  })
})
