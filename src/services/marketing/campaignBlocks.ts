import { z } from 'zod'

/**
 * Catálogo de bloques del cuerpo de una campaña.
 *
 * 🔴 Decisión del founder (2026-09-02): el contenido va por BLOQUES y el SERVIDOR genera el HTML.
 * Nadie escribe HTML, así que no hay nada que sanitizar — el riesgo desaparece en vez de mitigarse
 * con una allowlist, que es una superficie de ataque permanente (un solo hueco = un correo de
 * phishing firmado con nuestro dominio de marketing).
 *
 * `discriminatedUnion` es lo que impide guardar un bloque con un `type` inventado: se rechaza AL
 * ESCRIBIR. Ignorar lo desconocido al LEER es la defensa del cliente viejo, no la del servidor.
 * Mismo molde que los anuncios de plataforma (`announcement.superadmin.controller.ts`).
 */

// Sólo http(s): un `javascript:` o un `data:` en un href convierte el correo en un vector.
const urlSegura = z
  .string()
  .url()
  .refine(u => /^https?:\/\//i.test(u), 'La dirección debe empezar con http:// o https://')

const textoNoVacio = z.string().trim().min(1)

export const bloqueCampanaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: textoNoVacio }),
  z.object({ type: z.literal('paragraph'), text: textoNoVacio }),
  z.object({ type: z.literal('image'), url: urlSegura, alt: textoNoVacio }),
  z.object({ type: z.literal('button'), label: textoNoVacio, url: urlSegura }),
  z.object({ type: z.literal('divider') }),
])

export type BloqueCampana = z.infer<typeof bloqueCampanaSchema>

// Una campaña sin un solo bloque no tiene contenido que mandar.
export const bloquesCampanaSchema = z.array(bloqueCampanaSchema).min(1)
