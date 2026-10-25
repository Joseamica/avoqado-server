import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

export async function seedManySales(p: {
  venueId: string
  staffId: string
  productId: string
  count: number
  from: Date
  to: Date
}): Promise<string[]> {
  const rows = Array.from({ length: p.count }, (_, i) => ({
    id: cuid(),
    createdAt: new Date(p.from.getTime() + ((p.to.getTime() - p.from.getTime()) * i) / Math.max(1, p.count - 1)),
  }))
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000)
    await prisma.order.createMany({
      data: batch.map(row => ({
        ...row,
        venueId: p.venueId,
        orderNumber: `RECENT-${row.id}`,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        source: 'AVOQADO_IOS',
        createdById: p.staffId,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: new Prisma.Decimal(100),
        total: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
      })),
    })
    await prisma.orderItem.createMany({
      data: batch.map(row => ({
        id: cuid(),
        orderId: row.id,
        productId: p.productId,
        productName: 'Skirt',
        quantity: 1,
        unitPrice: new Prisma.Decimal(100),
        total: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
      })),
    })
    await prisma.payment.createMany({
      data: batch.map(row => ({
        id: cuid(),
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        venueId: p.venueId,
        orderId: row.id,
        processedById: p.staffId,
        amount: new Prisma.Decimal(100),
        netAmount: new Prisma.Decimal(100),
        feeAmount: new Prisma.Decimal(0),
        feePercentage: new Prisma.Decimal(0),
        method: 'CASH',
        source: 'POS',
        fundsFlow: 'CASH_DRAWER',
        status: 'COMPLETED',
        type: 'REGULAR',
      })),
    })
  }
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).map(row => row.id)
}
