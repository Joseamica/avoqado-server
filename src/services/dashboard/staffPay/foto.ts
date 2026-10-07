// src/services/dashboard/staffPay/foto.ts — UNA instantánea de sólo lectura para las lecturas de pago al personal (fases 2-3).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { ConflictError } from '../../../errors/AppError'
import { runWithoutCancellation } from '../../../utils/requestCancellation'

type Db = Prisma.TransactionClient | typeof prisma

/** B13 (revisión de B12 #1): lo que contesta una foto que se pasó de su tiempo. Un 409 con qué hacer, nunca el P2028 crudo. */
export const MENSAJE_LECTURA_VENCIDA = 'La consulta tardó demasiado y se canceló; intenta de nuevo en un momento'

/**
 * UNA instantánea de sólo lectura (Codex R3-Nuevo 1): todo lo que una respuesta lee —el recibo, su total y sus páginas; la
 * vista previa del cierre, sus sedes y sus pendientes (B12); la vista previa de activar o desactivar una sede (B11); el estado
 * de las sedes (B13)— sale del MISMO instante. Sin esto, un cierre o una ventana que cambia entre dos lecturas deja números
 * que no cuadran.
 * 🔴 Regla (Codex R4-Nuevo 1): dentro de `fn` SÓLO se lee con `tx`; nunca `prisma.` global ni un helper que lo use
 * (`sedesConServicePay`, `sedesLegiblesDe`, `prepararLectura`, permisos): eso se resuelve ANTES y entra como datos.
 * `o.planPersonalizado` (la vista previa del cierre, B12): los lotes reusan el MISMO statement con otro cursor y, en UNA
 * conexión, Postgres les pondría un plan genérico desde la sexta ejecución (B7 r2: 11.7 s contra 3.3 s); como el cierre, se
 * fuerza el plan personalizado.
 * `o.timeoutMs` (B13, revisión de B12 #1): 60 s por defecto; la vista previa del cierre pide el de su cierre (sólo se cierra
 * con la huella de una vista previa). Si vence, 409 LECTURA_VENCIDA en español.
 * B14: el tope corta también en la BASE (`SET LOCAL statement_timeout`). El `timeout` de Prisma no interrumpe una sentencia que ya
 * corre: una de 8 s en una foto de 2 s contestaba el 409 a los 8.1 s, con la base trabajando y la conexión retenida hasta el final
 * (`foto.limite.test.ts`); ahora la base la cancela al tope. El resultado para quien pregunta es el mismo 409, sólo que a tiempo.
 */
export async function enUnaFoto<T>(fn: (tx: Db) => Promise<T>, o: { planPersonalizado?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = Math.trunc(o.timeoutMs ?? 60_000)
  try {
    return await prisma.$transaction(
      async tx => {
        // Codex R4-Nuevo 2: el freno de lecturas del MCP trata todo `$executeRaw` como escritura (`hasWritten = true`) y
        // dejaría de cortar las lecturas que siguen. Estos SET no escriben nada: van fuera del freno, y SÓLO ellos.
        await runWithoutCancellation(() => tx.$executeRaw`SET TRANSACTION READ ONLY`)
        await runWithoutCancellation(() => tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`))
        if (o.planPersonalizado) await runWithoutCancellation(() => tx.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_custom_plan'))
        return fn(tx)
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: timeoutMs },
    )
  } catch (e) {
    // P2028: la transacción interactiva venció (Prisma ya la revirtió); 57014: la base canceló la sentencia al tope (B14). Es
    // tiempo, no un defecto de quien pregunta.
    if (vencio(e)) throw new ConflictError(MENSAJE_LECTURA_VENCIDA, 'LECTURA_VENCIDA')
    throw e
  }
}

/** La foto se pasó de su tope: Prisma la dio por vencida (P2028) o la base canceló una sentencia por `statement_timeout` (57014). */
function vencio(e: unknown): boolean {
  const x = e as { code?: string; meta?: { code?: string }; message?: string } | null
  if (x?.code === 'P2028') return true
  if (x?.code === 'P2010' && x.meta?.code === '57014') return true
  return /canceling statement due to statement timeout/.test(String(x?.message ?? ''))
}
