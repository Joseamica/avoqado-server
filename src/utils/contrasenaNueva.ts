import { z } from 'zod'

/**
 * Regla de contraseña para CUENTAS NUEVAS (alta desde la landing, invitación, restablecer, cambiar):
 * largo de 8 a 128 y que no sea una de las más comunes. SIN obligar mayúsculas, números ni símbolos
 * (NIST 800-63B-4: las reglas de composición no hacen más seguras las contraseñas, sólo frenan al usuario).
 *
 * Una cuenta que ya existe NO pasa por aquí: su contraseña vieja se compara con bcrypt, sin reglas de formato.
 */
export const CONTRASENA_MIN = 8
export const CONTRASENA_MAX = 128

/**
 * Las contraseñas más comunes (en español y en inglés), SIEMPRE en minúsculas y de 8+ caracteres (las más cortas
 * ya las frena el mínimo). Se compara sin importar mayúsculas.
 * 🔴 El DASHBOARD copia esta MISMA lista (`avoqado-web-dashboard`): si cambias una, cambia la otra.
 */
export const CONTRASENAS_COMUNES: readonly string[] = [
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  '87654321',
  '987654321',
  '9876543210',
  '11111111',
  '111111111',
  '1111111111',
  '22222222',
  '00000000',
  '000000000',
  '0000000000',
  '12341234',
  '12121212',
  '123123123',
  '11223344',
  '1q2w3e4r',
  '1qaz2wsx',
  'abcd1234',
  'abc12345',
  'qwerty123',
  'qwertyui',
  'qwertyuiop',
  'asdfghjk',
  'asdfghjkl',
  'zxcvbnm1',
  'password',
  'password1',
  'password12',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  'contraseña',
  'contraseña1',
  'contraseña123',
  'contrasena',
  'contrasena1',
  'contrasena123',
  'iloveyou',
  'welcome1',
  'welcome123',
  'admin123',
  'admin1234',
  'administrador',
  'avoqado1',
  'avoqado123',
  'avoqado1234',
  'avoqado2026',
  'mexico123',
  'teamo123',
]

const COMUNES = new Set(CONTRASENAS_COMUNES)

/** El motivo (en español) por el que una contraseña NUEVA no sirve, o `null` si sirve. */
export function motivoContrasenaInvalida(password: string): string | null {
  if (password.length < CONTRASENA_MIN) return `La contraseña debe tener al menos ${CONTRASENA_MIN} caracteres.`
  if (password.length > CONTRASENA_MAX) return `La contraseña no puede tener más de ${CONTRASENA_MAX} caracteres.`
  if (COMUNES.has(password.toLowerCase())) return 'Esa contraseña es muy común. Elige otra.'
  return null
}

/** La misma regla como esquema de Zod. Es un `ZodEffects`, no un `ZodString`: no encadenes `.min()` ni `.regex()`. */
export const contrasenaNuevaSchema = z
  .string({ required_error: 'La contraseña es requerida.', invalid_type_error: 'La contraseña debe ser texto.' })
  .superRefine((password, ctx) => {
    const motivo = motivoContrasenaInvalida(password)
    if (motivo) ctx.addIssue({ code: z.ZodIssueCode.custom, message: motivo })
  })
