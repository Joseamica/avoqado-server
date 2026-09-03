/**
 * Guardia de resultados gigantes de Prisma — la red de seguridad del incidente 2026-09-01.
 *
 * El server corre en UNA instancia con UNA vCPU (regla `una-sola-instancia.md`): un
 * findMany que devuelve decenas de miles de filas se materializa y serializa en el hilo
 * único, congela el event loop, /health deja de contestar y Render reemplaza la
 * instancia. El caso que lo demostró: el detalle del venue con las 33k órdenes + 33k
 * pagos de Testarudo. El barrido estático encontró 186 findMany sin `take` sobre tablas
 * grandes — esta guardia existe porque ese inventario es imposible de garantizar a mano
 * y porque los datos crecen: lo que hoy devuelve 300 filas devuelve 30,000 en un año.
 *
 * Qué hace: cuando un findMany devuelve >= umbral filas, escribe UN `logger.warn`
 * `[query-guard]` con el modelo y el tamaño. El contexto de ejecución
 * (`src/observability/`) le estampa solo el entrypoint y el venue, así que el log dice
 * exactamente QUÉ endpoint pidió el resultado gigante. La alerta de Better Stack sobre
 * ese patrón cierra el circuito.
 *
 * Qué NO hace, a propósito: nunca recorta, nunca lanza, nunca toca el resultado. Una
 * guardia de observabilidad jamás puede ser la razón de que una consulta falle (misma
 * regla que el eventLoopGuard).
 */
import logger from '../config/logger'

export const UMBRAL_FILAS_DEFAULT = 2000

export interface AvisoResultadoGigante {
  model: string
  rows: number
  take: number | null
  umbral: number
}

/**
 * Función PURA que decide si un resultado amerita denuncia. Devuelve el aviso a
 * loguear, o null. El `take` se reporta (null = la consulta no tenía tope) porque es
 * la primera pregunta al triagear: ¿faltó el tope, o el tope está absurdamente alto?
 */
export function evaluarResultadoGigante(input: {
  model: string
  rows: number
  take: number | undefined
  umbral: number
}): AvisoResultadoGigante | null {
  const { model, rows, take, umbral } = input
  if (!Number.isFinite(rows) || rows < umbral) return null
  return { model, rows, take: take ?? null, umbral }
}

function umbralConfigurado(): number {
  const crudo = Number(process.env.QUERY_GUARD_ROWS)
  return Number.isFinite(crudo) && crudo > 0 ? crudo : UMBRAL_FILAS_DEFAULT
}

/**
 * La extensión de Prisma que aplica la guardia a TODO findMany de TODO modelo.
 * Se engancha en `src/utils/prismaClient.ts`.
 */
export const extensionResultadoGigante = {
  name: 'query-result-guard',
  query: {
    $allModels: {
      async findMany({
        model,
        args,
        query,
      }: {
        model: string
        args: { take?: number } & Record<string, unknown>
        query: (a: unknown) => Promise<unknown>
      }) {
        const result = await query(args)
        try {
          if (Array.isArray(result)) {
            const aviso = evaluarResultadoGigante({ model, rows: result.length, take: args?.take, umbral: umbralConfigurado() })
            if (aviso) {
              logger.warn('[query-guard] findMany gigante', { ...aviso })
            }
          }
        } catch {
          // La guardia nunca puede romper la consulta.
        }
        return result
      },
    },
  },
} as const
