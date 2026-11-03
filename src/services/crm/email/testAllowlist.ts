/**
 * 🔴 Fuera de producción no sale correo a nadie real.
 *
 * La base local trae correos de gente de verdad, y un servidor de pruebas con la llave de Resend puesta les escribiría.
 * En producción la respuesta es siempre «sí» (el comportamiento de hoy, intacto). En cualquier otro entorno sólo sale a las
 * direcciones de `CRM_CORREO_PRUEBAS` (lista separada por comas); vacía, no sale nada.
 *
 * Es UNA sola función para todo lo que manda el CRM: la prueba a sí mismo, las campañas, el Gmail, los avisos del equipo
 * y los dos correos del formulario de la landing.
 *
 * Se lee de `process.env` en cada llamada, no de `config/env`: así un cambio de entorno (o una prueba) vale en el momento.
 */
export const MOTIVO_FUERA_DE_LA_LISTA = 'fuera de la lista de prueba'

const normalizar = (correo: string) => correo.trim().toLowerCase()

export function puedeMandarFueraDeProduccion(email: string): boolean {
  if (process.env.NODE_ENV === 'production') return true
  const lista = (process.env.CRM_CORREO_PRUEBAS ?? '').split(',').map(normalizar).filter(Boolean)
  return lista.includes(normalizar(email))
}
