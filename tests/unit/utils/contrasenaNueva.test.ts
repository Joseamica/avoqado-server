import {
  CONTRASENA_MAX,
  CONTRASENA_MIN,
  CONTRASENAS_COMUNES,
  contrasenaNuevaSchema,
  motivoContrasenaInvalida,
} from '../../../src/utils/contrasenaNueva'
import { resetPasswordSchema, updateAccountSchema } from '../../../src/schemas/dashboard/auth.schema'

describe('contrasenaNueva — contraseña de 8+ caracteres sin reglas de mayúsculas ni símbolos', () => {
  it('los límites son 8 y 128', () => {
    expect(CONTRASENA_MIN).toBe(8)
    expect(CONTRASENA_MAX).toBe(128)
  })

  it('acepta una contraseña sin mayúsculas ni números', () => {
    expect(motivoContrasenaInvalida('abcdefgh')).toBeNull()
  })

  it('acepta exactamente 8 y exactamente 128 caracteres', () => {
    expect(motivoContrasenaInvalida('zorro-ok')).toBeNull()
    expect(motivoContrasenaInvalida('x7'.repeat(64))).toBeNull()
  })

  it('rechaza menos de 8 caracteres', () => {
    expect(motivoContrasenaInvalida('corta')).toBe('La contraseña debe tener al menos 8 caracteres.')
    expect(motivoContrasenaInvalida('')).toBe('La contraseña debe tener al menos 8 caracteres.')
  })

  it('rechaza más de 128 caracteres', () => {
    expect(motivoContrasenaInvalida('a'.repeat(129))).toBe('La contraseña no puede tener más de 128 caracteres.')
  })

  it('rechaza las contraseñas comunes', () => {
    expect(motivoContrasenaInvalida('12345678')).toBe('Esa contraseña es muy común. Elige otra.')
    expect(motivoContrasenaInvalida('password')).toBe('Esa contraseña es muy común. Elige otra.')
  })

  it('compara las comunes sin importar mayúsculas', () => {
    expect(motivoContrasenaInvalida('Password')).toBe('Esa contraseña es muy común. Elige otra.')
    expect(motivoContrasenaInvalida('AVOQADO123')).toBe('Esa contraseña es muy común. Elige otra.')
  })

  it('la lista de comunes: minúsculas, sin repetidos y todas alcanzables (8+ caracteres)', () => {
    expect(CONTRASENAS_COMUNES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(CONTRASENAS_COMUNES).size).toBe(CONTRASENAS_COMUNES.length)
    for (const c of CONTRASENAS_COMUNES) {
      expect(c).toBe(c.toLowerCase())
      expect(c.length).toBeGreaterThanOrEqual(CONTRASENA_MIN)
    }
  })

  it('contrasenaNuevaSchema aplica la misma regla, con el mensaje en español', () => {
    expect(contrasenaNuevaSchema.safeParse('abcdefgh').success).toBe(true)

    const corta = contrasenaNuevaSchema.safeParse('corta')
    expect(corta.success).toBe(false)
    if (!corta.success) expect(corta.error.issues[0].message).toBe('La contraseña debe tener al menos 8 caracteres.')

    const comun = contrasenaNuevaSchema.safeParse('12345678')
    expect(comun.success).toBe(false)
    if (!comun.success) expect(comun.error.issues[0].message).toBe('Esa contraseña es muy común. Elige otra.')

    const noEsTexto = contrasenaNuevaSchema.safeParse(undefined)
    expect(noEsTexto.success).toBe(false)
    if (!noEsTexto.success) expect(noEsTexto.error.issues[0].message).toBe('La contraseña es requerida.')
  })
})

describe('regresión: los esquemas que usan strongPasswordSchema ya no piden mayúscula ni número', () => {
  it('updateAccountSchema acepta «abcdefgh» como contraseña nueva', () => {
    const r = updateAccountSchema.safeParse({ body: { old_password: 'lo-que-sea', password: 'abcdefgh' } })
    expect(r.success).toBe(true)
  })

  it('updateAccountSchema rechaza una común', () => {
    const r = updateAccountSchema.safeParse({ body: { old_password: 'lo-que-sea', password: '12345678' } })
    expect(r.success).toBe(false)
  })

  it('resetPasswordSchema acepta «abcdefgh» como contraseña nueva', () => {
    const r = resetPasswordSchema.safeParse({ body: { token: 't'.repeat(32), newPassword: 'abcdefgh' } })
    expect(r.success).toBe(true)
  })

  it('resetPasswordSchema rechaza una común', () => {
    const r = resetPasswordSchema.safeParse({ body: { token: 't'.repeat(32), newPassword: 'password' } })
    expect(r.success).toBe(false)
  })
})
