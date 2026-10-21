// tests/unit/schemas/cfdiEmail.schema.test.ts
// 🔴 H24 (auditoría 2026-09-30): «Reenviar por correo». Sin correo va al registrado; con uno, ése (el cliente escribió mal el suyo).
import { sendCfdiEmailSchema } from '../../../src/schemas/dashboard/cfdi.schema'

const parse = (body: unknown) => sendCfdiEmailSchema.safeParse({ body })

describe('sendCfdiEmailSchema', () => {
  it('sin correo pasa (va al registrado)', () => {
    const r = parse({})
    expect(r.success && r.data.body.email).toBeUndefined()
  })

  it('con correo, sin espacios de más', () => {
    const r = parse({ email: '  nuevo@correo.mx ' })
    expect(r.success && r.data.body.email).toBe('nuevo@correo.mx')
  })

  it('un correo inválido ⇒ 400 en español', () => {
    const r = parse({ email: 'no-es-correo' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('El correo no es válido')
  })
})
