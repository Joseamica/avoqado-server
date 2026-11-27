import { z } from 'zod'

/**
 * Entrar con Google en el POS (hz:6bfcd3a1:D1). Dos variantes, cada una `.strict()`: el cliente manda sólo la suya
 * (ANDROID: `idToken`; WINDOWS: `code` + PKCE + dirección de regreso en 127.0.0.1). Un cuerpo con las dos, o con
 * un `null` de la otra, se rechaza ANTES de hablar con Google.
 */
const puertoEntre1024y65535 = (uri: string) => {
  const puerto = Number(uri.slice('http://127.0.0.1:'.length))
  return Number.isInteger(puerto) && puerto >= 1024 && puerto <= 65535
}

const deAndroid = z
  .object({
    idToken: z.string().min(1, 'Falta el pase de Google'),
    rememberMe: z.boolean().optional(),
  })
  .strict()

const deEscritorio = z
  .object({
    code: z.string().min(1, 'Falta el código de Google'),
    codeVerifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, 'Verificador inválido'),
    redirectUri: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:(\d{4,5})$/, 'Dirección de regreso inválida')
      .refine(puertoEntre1024y65535, 'Dirección de regreso inválida'),
    rememberMe: z.boolean().optional(),
  })
  .strict()

export const googleLoginSchema = z.object({ body: z.union([deAndroid, deEscritorio]) })
