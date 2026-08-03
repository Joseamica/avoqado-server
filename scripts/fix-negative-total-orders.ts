/**
 * Corrección puntual: órdenes con `total` NEGATIVO por descuentos apilados.
 *
 * Contexto: bug corregido en `268c5fc6` (descuentos manuales/catálogo/cupón se
 * calculaban contra el subtotal COMPLETO en vez del remanente). Ese fix impide
 * filas NUEVAS pero NO corrige las que ya existen. Este script arregla la única
 * orden donde la intención es inequívoca y NO se movió dinero.
 *
 * ── ALCANCE (deliberadamente estrecho) ───────────────────────────────────────
 * ✅ Mindform `cms6v9rpg00qrq92avcfhiz8r` (2026-07-30)
 *      subtotal 888 · 3 descuentos manuales (888 fijo + 100% + 100%) = 2664
 *      total −1776 · 0 pagos · 4 items
 *      → Se conserva SOLO el primer descuento ($888 = 100% de la cuenta, que es
 *        lo que el staff intentó tres veces) y se borran los 2 duplicados.
 *        Resultado: discountAmount 888, total 0, remainingBalance 0.
 *
 * ❌ Alberto Dominguez `cmmv0rjv002myqg299hicb94h` (2026-03-17) — NO SE TOCA.
 *      subtotal 0 · descuento 2400 · total −2400 · 0 items · pero **$100 cobrados
 *      con tarjeta (Payment COMPLETED)**. Poner total 0 dejaría un sobrepago de
 *      $100. El estado correcto depende de qué pasó realmente ese día — decisión
 *      humana, no automatizable.
 *
 * ── USO ──────────────────────────────────────────────────────────────────────
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/fix-negative-total-orders.ts
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/fix-negative-total-orders.ts --execute
 *
 * Sin `--execute` es DRY-RUN: solo imprime el antes/después. Idempotente: si la
 * orden ya está corregida, no hace nada. Deja rastro en ActivityLog.
 */
import 'dotenv/config'
import prisma from '../src/utils/prismaClient'

const ORDER_ID = 'cms6v9rpg00qrq92avcfhiz8r'
const EXECUTE = process.argv.includes('--execute')

async function main() {
  const order = await prisma.order.findUnique({
    where: { id: ORDER_ID },
    select: {
      id: true,
      venueId: true,
      subtotal: true,
      discountAmount: true,
      taxAmount: true,
      tipAmount: true,
      total: true,
      paidAmount: true,
      orderDiscounts: { select: { id: true, name: true, amount: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  })

  if (!order) {
    console.error(`❌ Orden ${ORDER_ID} no encontrada. Aborta.`)
    process.exit(1)
  }

  const n = (d: unknown) => Number(d)
  console.log(
    `\nAntes: subtotal=${n(order.subtotal)} descuento=${n(order.discountAmount)} total=${n(order.total)} pagado=${n(order.paidAmount)}`,
  )
  console.log(`Descuentos (${order.orderDiscounts.length}):`)
  order.orderDiscounts.forEach((d, i) => console.log(`  ${i + 1}. ${d.name} −$${n(d.amount)} (${d.id})`))

  // Guard de seguridad: si alguien pagó, el estado correcto ya no es obvio.
  if (n(order.paidAmount) !== 0) {
    console.error(`\n❌ La orden tiene pagos ($${n(order.paidAmount)}). Este script solo corrige órdenes sin dinero de por medio. Aborta.`)
    process.exit(1)
  }

  if (n(order.total) >= 0) {
    console.log('\n✅ La orden ya no tiene total negativo — nada que hacer (idempotente).')
    await prisma.$disconnect()
    return
  }

  // Conservar el PRIMER descuento (el de $888 = 100% de la cuenta) y borrar el resto.
  const [keep, ...remove] = order.orderDiscounts
  if (!keep) {
    console.error('\n❌ La orden no tiene descuentos pero su total es negativo — caso distinto. Aborta.')
    process.exit(1)
  }

  const newDiscountAmount = Math.min(n(keep.amount), n(order.subtotal))
  const newTotal = Math.max(0, n(order.subtotal) - newDiscountAmount + n(order.taxAmount) + n(order.tipAmount))

  console.log(`\nDespués: descuento=${newDiscountAmount} total=${newTotal} (se conserva "${keep.name}", se borran ${remove.length})`)

  if (!EXECUTE) {
    console.log('\n🔍 DRY-RUN. Corre con --execute para aplicar.')
    await prisma.$disconnect()
    return
  }

  await prisma.$transaction(async tx => {
    if (remove.length > 0) {
      await tx.orderDiscount.deleteMany({ where: { id: { in: remove.map(d => d.id) } } })
    }
    await tx.order.update({
      where: { id: ORDER_ID },
      data: {
        discountAmount: newDiscountAmount,
        total: newTotal,
        remainingBalance: Math.max(0, newTotal - n(order.paidAmount)),
      },
    })
    await tx.activityLog.create({
      data: {
        action: 'ORDER_NEGATIVE_TOTAL_CORRECTED',
        entity: 'Order',
        entityId: ORDER_ID,
        staffId: null, // corrección de datos, no acción de un usuario
        venueId: order.venueId,
        data: {
          reason: 'Descuentos manuales duplicados (bug corregido en 268c5fc6) dejaron total negativo',
          before: { discountAmount: n(order.discountAmount), total: n(order.total) },
          after: { discountAmount: newDiscountAmount, total: newTotal },
          removedOrderDiscountIds: remove.map(d => d.id),
        },
      },
    })
  })

  console.log('\n✅ Corregida. Rastro en ActivityLog como ORDER_NEGATIVE_TOTAL_CORRECTED.')
  await prisma.$disconnect()
}

main().catch(async err => {
  console.error('Error:', err)
  await prisma.$disconnect()
  process.exit(1)
})
