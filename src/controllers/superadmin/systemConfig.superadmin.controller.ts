/**
 * «¿Este servidor tiene bien su configuración crítica?» — sin reiniciarlo y sin leer logs.
 *
 * Contesta lo MISMO que grita el arranque (`config/env.ts` llama a la misma función), con dos
 * diferencias que son la razón de existir: se puede preguntar cuando uno quiera, y la respuesta
 * llega aunque las líneas de arranque nunca hayan alcanzado el drenaje de logs.
 *
 * 🔴 Va bajo `/superadmin`, NO en el health público, y es deliberado: un endpoint sin
 * autenticación que enumera qué defensas están apagadas es un mapa para quien busca por dónde
 * entrar. Y el precedente pesa más que este caso — con una bandera pública, la siguiente sesión
 * agrega cinco. Es el mismo criterio de Spring Boot Actuator: resumen público, detalles sólo
 * autorizados. El router padre ya exige token + rol SUPERADMIN.
 *
 * 🔴 La respuesta NUNCA lleva el valor de una variable, sólo si está en el estado esperado. Hay
 * una prueba en `configCheck.test.ts` que lo fija sembrando un secreto reconocible.
 */
import { Request, Response } from 'express'

import { env } from '../../config/env'
import { revisarConfiguracionCritica } from '../../config/configCheck'

/**
 * @route GET /api/v1/superadmin/system/config-check
 */
export const getConfigCheck = (_req: Request, res: Response) => {
  // `{ data: <entidad> }` es la convención de la casa. No inventar otra forma: los tres clientes
  // ya leyeron `data` como si fuera la entidad una vez, y costó un cargador infinito en Android,
  // un nil en iOS y un modal vacío en el dashboard.
  res.status(200).json({ data: revisarConfiguracionCritica(env) })
}
