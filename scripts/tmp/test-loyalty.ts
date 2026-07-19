import prisma from '../../src/utils/prismaClient'
import { getCustomerLoyalty, redeemPointsToOrder } from '../../src/services/mobile/loyalty.mobile.service'
import { removeOrderDiscount } from '../../src/services/mobile/order.mobile.service'

const VENUE = 'cmpe64yq2001f9k92m0lbhmf4'

async function main() {
  // Programa activo con reglas conocidas
  await prisma.loyaltyConfig.upsert({
    where: { venueId: VENUE },
    create: { venueId: VENUE, active: true, pointsPerDollar: 1, redemptionRate: 0.5, minPointsRedeem: 10 },
    update: { active: true, redemptionRate: 0.5, minPointsRedeem: 10 },
  })

  const customer = await prisma.customer.create({
    data: { venueId: VENUE, firstName: 'TEST', lastName: 'Lealtad', loyaltyPoints: 100 },
  })

  // Orden de prueba CON artículos reales (subtotal 200 = 2 x Pizza $100)
  const PRODUCT = 'cmpe651n900jr9k92w4bbjgzn'
  const order = await prisma.order.create({
    data: {
      venueId: VENUE, orderNumber: `TEST-LOY-${Date.now()}`, type: 'DINE_IN',
      subtotal: 200, discountAmount: 0, taxAmount: 0, total: 200,
      items: {
        create: [
          { productId: PRODUCT, productName: 'Prueba lealtad', quantity: 2, unitPrice: 100, taxAmount: 0, total: 200 },
        ],
      },
    } as any,
  })

  const before = await getCustomerLoyalty(VENUE, customer.id, order.id)
  console.log('SALDO INICIAL:', { balance: before.balance, valor: before.balanceValue, maxPuntos: before.maxRedeemablePoints, canRedeem: before.canRedeem })

  // Canje de 40 puntos = $20
  const redeem = await redeemPointsToOrder(VENUE, order.id, customer.id, 40)
  const afterOrder = await prisma.order.findUnique({ where: { id: order.id }, select: { subtotal: true, discountAmount: true, total: true } })
  console.log('CANJE:', { puntos: redeem.pointsRedeemed, descuento: redeem.discountAmount, saldo: redeem.newBalance })
  console.log('ORDEN TRAS CANJE:', afterOrder)

  const od = await prisma.orderDiscount.findFirst({ where: { orderId: order.id } })
  console.log('DESCUENTO CREADO:', { name: od?.name, amount: String(od?.amount), ligado: !!od?.loyaltyTransactionId })

  // Quitar el descuento DEBE devolver los puntos
  await removeOrderDiscount(VENUE, order.id, od!.id)
  const afterRemove = await prisma.order.findUnique({ where: { id: order.id }, select: { discountAmount: true, total: true } })
  const cust = await prisma.customer.findUnique({ where: { id: customer.id }, select: { loyaltyPoints: true } })
  console.log('TRAS QUITAR:', { orden: afterRemove, saldoDevuelto: cust?.loyaltyPoints })
  console.log(cust?.loyaltyPoints === 100 ? '✅ PUNTOS DEVUELTOS CORRECTAMENTE' : '❌ PUNTOS PERDIDOS')

  // Tope: canjear todo el saldo (100 pts = $50) contra una cuenta de $30
  const small = await prisma.order.create({
    data: {
      venueId: VENUE, orderNumber: `TEST-LOY-S-${Date.now()}`, type: 'DINE_IN',
      subtotal: 30, discountAmount: 0, taxAmount: 0, total: 30,
      items: {
        create: [
          { productId: PRODUCT, productName: 'Prueba tope', quantity: 1, unitPrice: 30, taxAmount: 0, total: 30 },
        ],
      },
    } as any,
  })
  const capped = await redeemPointsToOrder(VENUE, small.id, customer.id, 100)
  const smallAfter = await prisma.order.findUnique({ where: { id: small.id }, select: { total: true } })
  const custAfter = await prisma.customer.findUnique({ where: { id: customer.id }, select: { loyaltyPoints: true } })
  console.log('TOPE:', { pedidos: 100, quemados: capped.pointsRedeemed, descuento: capped.discountAmount, totalOrden: smallAfter?.total, saldoRestante: custAfter?.loyaltyPoints })
  console.log(Number(smallAfter?.total) === 0 && capped.pointsRedeemed === 60 ? '✅ TOPE CORRECTO (solo quemó 60 pts por $30)' : '❌ TOPE MAL')

  // Limpieza
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: [order.id, small.id] } } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customerId: customer.id } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: [order.id, small.id] } } })
  await prisma.order.deleteMany({ where: { id: { in: [order.id, small.id] } } })
  await prisma.customer.delete({ where: { id: customer.id } })
  console.log('🧹 limpieza ok')
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1) }).finally(() => prisma.$disconnect())
