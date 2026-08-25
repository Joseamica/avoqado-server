/**
 * Fase 0.C — auditoría de SOLO LECTURA: reservas con más de UNA orden viva.
 *
 * Correr ANTES de aplicar la migración que crea el índice único parcial
 * `Order_reservationId_alive_key` (reservationId WHERE status NOT IN ('CANCELLED','DELETED')):
 * si existe un duplicado, `prisma migrate deploy` falla al crear el índice. Los duplicados se
 * resuelven A MANO (cancelar la orden sobrante). 🔴 Dos órdenes PAGADAS en la misma reserva ⇒
 * PARAR y preguntar: no se cancela dinero cobrado desde un script.
 *
 *   npx tsx scripts/audit-duplicate-reservation-orders.ts
 *   (contra prod: exportar DATABASE_URL de sólo lectura; el script NO escribe nada.
 *    ts-node revienta por memoria: typechea todo el proyecto; tsx es transpile-only.)
 *   Salida: exit 0 sin duplicados · exit 2 con duplicados listados · exit 1 error.
 */
import prisma from '../src/utils/prismaClient'

type Row = { reservationId: string; venueIds: string[]; aliveOrders: number; paidOrders: number; orderIds: string[] }

async function main() {
  // Agrupa EXACTAMENTE como el índice parcial (sólo por reservationId, sin venue): dos
  // órdenes vivas de la misma reserva repartidas entre venues también harían fallar el índice.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "reservationId",
           ARRAY_AGG(DISTINCT "venueId")                                   AS "venueIds",
           COUNT(*)::int                                                   AS "aliveOrders",
           COUNT(*) FILTER (WHERE "paymentStatus" = 'PAID')::int           AS "paidOrders",
           ARRAY_AGG("id" ORDER BY "createdAt")                            AS "orderIds"
    FROM "Order"
    WHERE "reservationId" IS NOT NULL
      AND "status" NOT IN ('CANCELLED', 'DELETED')
    GROUP BY "reservationId"
    HAVING COUNT(*) > 1
    ORDER BY "paidOrders" DESC, "aliveOrders" DESC
  `

  if (rows.length === 0) {
    console.log('✅ Sin duplicados: ninguna reserva tiene más de una orden viva. El índice parcial puede crearse.')
    return
  }

  console.log(`⚠️  ${rows.length} reserva(s) con más de una orden viva — resolver a mano ANTES de crear el índice:\n`)
  for (const r of rows) {
    const venues = await prisma.venue.findMany({ where: { id: { in: r.venueIds } }, select: { name: true, slug: true } })
    const venue = { name: venues.map(v => v.name).join(' / ') || r.venueIds.join(','), slug: venues.map(v => v.slug).join(' / ') }
    const reservation = await prisma.reservation.findUnique({
      where: { id: r.reservationId },
      select: { confirmationCode: true, status: true, startsAt: true },
    })
    const flag =
      r.paidOrders >= 2
        ? '🔴 DOS O MÁS PAGADAS — PARAR, no tocar desde script'
        : r.paidOrders === 1
          ? '🟡 una pagada: cancelar las NO pagadas'
          : '🟢 ninguna pagada: dejar la más reciente'
    console.log('---')
    console.log(`Venue(s): ${venue.name} (${venue.slug || '?'})`)
    console.log(
      `Reserva: ${reservation?.confirmationCode ?? r.reservationId} · ${reservation?.status} · ${reservation?.startsAt?.toISOString()}`,
    )
    console.log(`Órdenes vivas: ${r.aliveOrders} (pagadas: ${r.paidOrders}) → ${r.orderIds.join(', ')}`)
    console.log(flag)
  }
  process.exitCode = 2
}

main()
  .catch(err => {
    console.error('❌ Falló la auditoría:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
