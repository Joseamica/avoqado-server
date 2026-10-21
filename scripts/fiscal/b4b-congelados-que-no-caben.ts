/**
 * B4b (respuesta 13; fallo 4 de la ronda 6; Codex r4 R4-2, r5 R5-4): cuántos ajustes de Uber traen un congelado que el reporte
 * rechaza, contado con el MISMO código del reporte (`recorrerLibros`: misma composición, mismos topes, mismos lotes de
 * LOTE_DE_ORDENES) sobre TODAS las órdenes con un ajuste. Sólo lee: una transacción REPEATABLE READ de sólo lectura por negocio.
 * Si una orden del universo no se procesó, NO hay veredicto. Corre SÓLO contra una copia local de producción, nunca contra producción
 * (respuesta 15): DATABASE_URL="postgresql://postgres@127.0.0.1:65183/<copia>" npx tsx scripts/fiscal/b4b-congelados-que-no-caben.ts
 */
import { Prisma } from '@prisma/client'
import { LOTE_DE_ORDENES } from '../../src/services/dashboard/accounting.dashboard.service'
import { recorrerLibros } from '../../src/services/fiscal/librosDeOrdenes'
import prisma from '../../src/utils/prismaClient'

const MAX_ORDENES = 100_000

export async function contarCongeladosRechazados(
  o: { venueIds?: string[]; hasta?: Date } = {},
  db = prisma,
): Promise<{ ordenesEsperadas: number; ordenesProcesadas: number; congeladosRechazados: number; ordenesConRechazo: string[] }> {
  const hasta = o.hasta ?? new Date()
  const filtro = o.venueIds ? Prisma.sql`AND o."venueId" IN (${Prisma.join(o.venueIds)})` : Prisma.empty
  const universo = await db.$queryRaw<Array<{ venueId: string; id: string }>>`
    SELECT o."venueId", o.id FROM "Order" o
    WHERE o.status <> 'CANCELLED' ${filtro}
      AND EXISTS (SELECT 1 FROM "Payment" a WHERE a."orderId" = o.id AND a."venueId" = o."venueId" AND a.status = 'COMPLETED'
                  AND a.type = 'REFUND' AND a."processorData" ->> 'provenance' = 'PROVIDER_ADJUSTMENT')
    ORDER BY 1, 2
    LIMIT ${MAX_ORDENES + 1}`
  if (universo.length > MAX_ORDENES) throw new Error(`Más de ${MAX_ORDENES} órdenes con ajustes: se detiene y se le pregunta al founder.`)
  // Fallo 5 de la ronda 7 (Codex r6 R6-5): un arreglo por negocio, y `push`; copiarlo en cada orden era cuadrático (100,000 órdenes de
  // un negocio ⇒ unos 5,000 millones de copias, fuera del tiempo máximo de la transacción).
  const porNegocio = new Map<string, string[]>()
  for (const u of universo) {
    let ids = porNegocio.get(u.venueId)
    if (!ids) porNegocio.set(u.venueId, (ids = []))
    ids.push(u.id)
  }
  const procesadas = new Set<string>()
  const rechazadas = new Set<string>()
  let congeladosRechazados = 0
  for (const [venueId, ids] of porNegocio) {
    await db.$transaction(
      async tx => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`
        for (let i = 0; i < ids.length; i += LOTE_DE_ORDENES) {
          await recorrerLibros(tx, { venueId, orderIds: ids.slice(i, i + LOTE_DE_ORDENES), hasta }, (m, parte) => {
            procesadas.add(m.orderId)
            if (!parte.congeladoRechazado) return
            congeladosRechazados += 1
            rechazadas.add(m.orderId)
          })
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 600_000 },
    )
  }
  if (procesadas.size !== universo.length) {
    throw new Error(`Sin veredicto: no se procesó todo el universo (${procesadas.size} de ${universo.length} órdenes).`)
  }
  return { ordenesEsperadas: universo.length, ordenesProcesadas: procesadas.size, congeladosRechazados, ordenesConRechazo: [...rechazadas] }
}

if (require.main === module) {
  console.log(`base: ${new URL(process.env.DATABASE_URL ?? 'postgresql://x').host}`) // sólo el host, nunca la credencial
  contarCongeladosRechazados()
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
