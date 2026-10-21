/**
 * Cruces DETERMINISTAS contra Postgres real: detener una transacción con sus candados tomados y OBSERVAR quién la espera.
 *
 * 🔴 Por qué (revisión final y auditoría de Codex del código, 15-oct-2026): las primeras pruebas de concurrencia espiaban el
 * cliente Prisma exterior mientras las lecturas ya ocurrían dentro de `tx`, así que no demostraban que el cruce buscado
 * hubiera pasado. Aquí el cruce se fuerza y se COMPRUEBA en `pg_stat_activity` / `pg_blocking_pids`, no se supone por tiempos.
 */
import type { PrismaClient } from '@prisma/client'

/** Rechaza a los `ms` con un mensaje claro: la prueba nunca se cuelga si algo no llega a donde se esperaba. */
export function aTiempo<T>(p: Promise<T>, ms: number, que: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${que}`)), ms).unref())])
}

export interface TransaccionAparcada {
  /** El pid del backend de la transacción aparcada (resuelve cuando su cuerpo terminó y espera, sin commit). */
  pid: Promise<number>
  /** Deja que haga commit. */
  soltar: () => void
  /** Quita la espía (siempre en un `finally`). */
  restaurar: () => void
}

/**
 * La PRÓXIMA transacción interactiva de `prisma` corre su cuerpo completo y se queda esperando ANTES del commit, con todos sus
 * candados (filas, `pg_advisory_xact_lock`) tomados. Las transacciones siguientes pasan intactas.
 */
export function aparcarLaSiguienteTransaccion(prisma: PrismaClient): TransaccionAparcada {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
  let soltar: () => void = () => undefined
  const puedeTerminar = new Promise<void>(r => (soltar = r))
  let avisar: (pid: number) => void = () => undefined
  const pid = new Promise<number>(r => (avisar = r))
  let usada = false
  const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((arg: unknown, opciones?: Record<string, unknown>) => {
    if (usada || typeof arg !== 'function') return original(arg, opciones)
    usada = true
    const cuerpo = arg as (tx: any) => Promise<unknown>
    return original(
      async (tx: any) => {
        const r = await cuerpo(tx)
        const [{ pid: propio }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
        avisar(Number(propio))
        await puedeTerminar
        return r
      },
      { ...(opciones ?? {}), timeout: 30_000 },
    )
  }) as never)
  return { pid, soltar: () => soltar(), restaurar: () => espia.mockRestore() }
}

export interface Espera {
  pid: number
  waitEventType: string | null
  waitEvent: string | null
  query: string
  bloqueadores: number[]
}

/**
 * Espera a que aparezca un backend ESPERANDO un candado que tenga a alguno de `bloqueadoPor` entre sus bloqueadores
 * (`pg_blocking_pids`) y cuya consulta case con `consulta`. Lo devuelve, o `null` si no aparece en `ms`.
 */
export async function esperarBloqueado(
  prisma: PrismaClient,
  e: { bloqueadoPor: number[]; consulta: RegExp; excepto?: number[]; ms?: number },
): Promise<Espera | null> {
  const limite = Date.now() + (e.ms ?? 10_000)
  while (Date.now() < limite) {
    const filas = await prisma.$queryRawUnsafe<
      Array<{ pid: number; wait_event_type: string | null; wait_event: string | null; query: string; bloqueadores: number[] }>
    >(
      `SELECT pid, wait_event_type, wait_event, query, pg_blocking_pids(pid) AS bloqueadores
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
    )
    const hallada = filas.find(
      f =>
        !(e.excepto ?? []).includes(Number(f.pid)) &&
        e.consulta.test(f.query) &&
        f.bloqueadores.map(Number).some(b => e.bloqueadoPor.includes(b)),
    )
    if (hallada) {
      return {
        pid: Number(hallada.pid),
        waitEventType: hallada.wait_event_type,
        waitEvent: hallada.wait_event,
        query: hallada.query,
        bloqueadores: hallada.bloqueadores.map(Number),
      }
    }
    await new Promise(r => setTimeout(r, 20))
  }
  return null
}
