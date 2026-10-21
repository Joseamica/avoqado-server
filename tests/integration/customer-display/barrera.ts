// tests/integration/customer-display/barrera.ts
import prisma from '@/utils/prismaClient'

export interface OpcionesDeRetencion {
  /**
   * Cuánto puede retener la barrera antes de deshacerse SOLA si la prueba nunca la suelta (se olvidó de `soltar`, o
   * truena antes de llegar a él). Sin este tope, una barrera olvidada se quedó «idle in transaction» más de 5 minutos
   * (medido en la Task 7) y todo lo que tocara esa fila después esperaría en cascada.
   */
  maxRetencionMs?: number
  /**
   * El respaldo que no depende de JavaScript: la base corta la sesión si pasa este tiempo inactiva DENTRO de la
   * transacción. Va por encima de `maxRetencionMs`, así que normalmente nunca actúa; está para cuando el temporizador de
   * JS no corra (el proceso trabado, un `await` que nunca vuelve).
   */
  inactividadMaximaMs?: number
}

/**
 * Abre una transacción que RETIENE lo que `bloquear` toque (un `FOR UPDATE`, un `UPDATE` sin confirmar…) y deja que la
 * prueba decida cuándo soltarlo. Sirve para meter un cambio ENTRE la lectura inicial de una operación y su candado,
 * que es donde viven las carreras reales. `soltar(accion)` ejecuta `accion` dentro de esa misma transacción y confirma.
 *
 * 🔴 Con red de seguridad en dos capas: si nadie la suelta en `maxRetencionMs` (10 s), la transacción truena sola y
 * Prisma la deshace (`transaccion` rechaza con un mensaje que lo dice); y si ni eso ocurre, la base corta la sesión a
 * los `inactividadMaximaMs` (15 s). Una barrera olvidada nunca deja un candado vivo para las pruebas de después.
 */
export async function retener(bloquear: (tx: any) => Promise<unknown>, opciones: OpcionesDeRetencion = {}) {
  const maxRetencionMs = opciones.maxRetencionMs ?? 10_000
  const inactividadMaximaMs = opciones.inactividadMaximaMs ?? 15_000

  let listo!: (pid: number) => void
  let fallo!: (e: unknown) => void
  const tengoElCandado = new Promise<number>((r, f) => ((listo = r), (fallo = f)))
  let soltar!: (antesDeConfirmar?: (tx: any) => Promise<void>) => void
  const hastaSoltar = new Promise<((tx: any) => Promise<void>) | undefined>(r => (soltar = r))

  const transaccion = prisma.$transaction(
    async tx => {
      // PRIMERA sentencia: la red que pone la base, antes de retener nada. `SET` no acepta parámetros; es un entero nuestro.
      await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = '${Math.trunc(inactividadMaximaMs)}ms'`)
      await bloquear(tx)
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      listo(pid)

      let reloj: NodeJS.Timeout | undefined
      const vencida = new Promise<never>((_, f) => {
        reloj = setTimeout(
          () => f(new Error(`La barrera retuvo el candado ${maxRetencionMs} ms sin que la prueba la soltara: se deshace sola`)),
          maxRetencionMs,
        )
      })
      try {
        const accion = await Promise.race([hastaSoltar, vencida])
        if (accion) await accion(tx)
      } finally {
        clearTimeout(reloj)
      }
    },
    // El tope de Prisma, por encima de las dos redes: nunca es él quien decide.
    { timeout: Math.max(20_000, maxRetencionMs + 5_000) },
  )
  transaccion.catch(fallo) // si la transacción revienta antes del candado, la prueba no se cuelga
  const pid = await tengoElCandado
  return { pid, soltar, transaccion }
}

/** El caso más común: retener la fila de UNA terminal con el mismo candado que toman las operaciones reales. */
export const retenerTerminal = (terminalId: string, opciones?: OpcionesDeRetencion) =>
  retener(tx => tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE`, opciones)

/**
 * Espera a que ALGUNA sesión esté bloqueada por `pid`, o a que la operación termine sin haberse bloqueado nunca
 * (eso último es justo lo que pasa si alguien quitó el candado: la prueba lo detecta en vez de colgarse).
 */
export async function esperarBloqueado(pid: number, operacion: Promise<unknown>): Promise<'bloqueada' | 'termino'> {
  let termino = false
  operacion.then(
    () => (termino = true),
    () => (termino = true),
  )
  for (let i = 0; i < 400; i++) {
    if (termino) return 'termino'
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (n > 0) return 'bloqueada'
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('La operación ni se bloqueó ni terminó en 10 s')
}
