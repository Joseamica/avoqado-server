// src/services/dashboard/staffPay/foto.ts — UNA instantánea de sólo lectura para las lecturas de pago al personal (fases 2-3).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { runWithoutCancellation } from '../../../utils/requestCancellation'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * UNA instantánea de sólo lectura (Codex R3-Nuevo 1): todo lo que una respuesta lee —el recibo, su total y sus páginas; la
 * vista previa del cierre, sus sedes y sus pendientes (B12); la vista previa de activar o desactivar una sede (B11)— sale del
 * MISMO instante. Sin esto, un cierre o una ventana que cambia entre dos lecturas deja números que no cuadran.
 * 🔴 Regla (Codex R4-Nuevo 1): dentro de `fn` SÓLO se lee con `tx`; nunca `prisma.` global ni un helper que lo use
 * (`sedesConServicePay`, `sedesLegiblesDe`, `alcanceLegibleDelPeriodo`, permisos): eso se resuelve ANTES y entra como datos.
 * `o.planPersonalizado` (la vista previa del cierre, B12): los lotes reusan el MISMO statement con otro cursor y, en UNA
 * conexión, Postgres les pondría un plan genérico desde la sexta ejecución (B7 r2: 11.7 s contra 3.3 s); como el cierre, se
 * fuerza el plan personalizado.
 */
export function enUnaFoto<T>(fn: (tx: Db) => Promise<T>, o: { planPersonalizado?: boolean } = {}): Promise<T> {
  return prisma.$transaction(
    async tx => {
      // Codex R4-Nuevo 2: el freno de lecturas del MCP trata todo `$executeRaw` como escritura (`hasWritten = true`) y
      // dejaría de cortar las lecturas que siguen. Estos SET no escriben nada: van fuera del freno, y SÓLO ellos.
      await runWithoutCancellation(() => tx.$executeRaw`SET TRANSACTION READ ONLY`)
      if (o.planPersonalizado) await runWithoutCancellation(() => tx.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_custom_plan'))
      return fn(tx)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 60_000 },
  )
}
