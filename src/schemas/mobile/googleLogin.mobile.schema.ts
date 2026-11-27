import { z } from 'zod'

/**
 * Entrar con Google en el POS (hz:6bfcd3a1:D1). Dos variantes, cada una `.strict()`: el cliente manda sólo la suya
 * (ANDROID: el `state` de la vuelta que ya llegó al SERVIDOR + su verificador PKCE; WINDOWS: `code` + PKCE + dirección de
 * regreso en 127.0.0.1). Un cuerpo con las dos, con un `null` de la otra o con el `idToken` de antes, se rechaza ANTES de
 * hablar con Google.
 */
const puertoEntre1024y65535 = (uri: string) => {
  const puerto = Number(uri.slice('http://127.0.0.1:'.length))
  return Number.isInteger(puerto) && puerto >= 1024 && puerto <= 65535
}

const VERIFICADOR = /^[A-Za-z0-9\-._~]{43,128}$/

const deAndroid = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Pase de Google inválido'),
    codeVerifier: z.string().regex(VERIFICADOR, 'Verificador inválido'),
    rememberMe: z.boolean().optional(),
  })
  .strict()

const deEscritorio = z
  .object({
    code: z.string().min(1, 'Falta el código de Google'),
    codeVerifier: z.string().regex(VERIFICADOR, 'Verificador inválido'),
    redirectUri: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:(\d{4,5})$/, 'Dirección de regreso inválida')
      .refine(puertoEntre1024y65535, 'Dirección de regreso inválida'),
    rememberMe: z.boolean().optional(),
  })
  .strict()

export const googleLoginSchema = z.object({ body: z.union([deAndroid, deEscritorio]) })
