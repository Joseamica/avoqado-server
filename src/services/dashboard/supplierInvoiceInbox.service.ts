import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'

export async function getSupplierInvoiceInbox(venueId: string, page = 1, requestedLimit = 20, search?: string) {
  const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit)))
  const where: Prisma.PurchaseOrderInvoiceWhereInput = {
    venueId,
    AND: [
      { OR: [{ purchaseOrderId: null }, { inventoryPreparedAt: { not: null } }] },
      ...(search
        ? [
            {
              OR: [
                { emisorNombre: { contains: search, mode: 'insensitive' as const } },
                { uuid: { contains: search, mode: 'insensitive' as const } },
                { folio: { contains: search, mode: 'insensitive' as const } },
                { emisorRfc: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ],
  }
  const [rows, total] = await Promise.all([
    prisma.purchaseOrderInvoice.findMany({
      where,
      take: limit,
      skip: (page - 1) * limit,
      orderBy: [{ fechaEmision: 'desc' }, { id: 'desc' }],
      include: {
        _count: { select: { lines: true } },
        lines: {
          take: 201,
          orderBy: { id: 'asc' },
          include: {
            rawMaterial: { select: { id: true, name: true, unit: true } },
            product: { select: { id: true, name: true, unit: true } },
          },
        },
        supplier: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, orderNumber: true, status: true } },
      },
    }),
    prisma.purchaseOrderInvoice.count({ where }),
  ])
  return { rows, total, page, limit, totalPages: Math.ceil(total / limit) }
}

/** Small pages for mapping invoice lines. No full-catalog downloads or per-row queries. */
export async function getInvoiceInventoryCatalog(venueId: string, kind: 'RAW' | 'PRODUCT', page = 1, requestedLimit = 25, search?: string) {
  const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit))),
    skip = (page - 1) * limit
  if (kind === 'RAW') {
    const where: Prisma.RawMaterialWhereInput = {
      venueId,
      active: true,
      deletedAt: null,
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    }
    const [rows, total] = await Promise.all([
      prisma.rawMaterial.findMany({
        where,
        take: limit,
        skip,
        select: { id: true, name: true, unit: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      prisma.rawMaterial.count({ where }),
    ])
    return { rows, total, page, limit, totalPages: Math.ceil(total / limit) }
  }
  const where: Prisma.ProductWhereInput = {
    venueId,
    active: true,
    deletedAt: null,
    trackInventory: true,
    unit: { not: null },
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      take: limit,
      skip,
      select: { id: true, name: true, unit: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.product.count({ where }),
  ])
  return { rows, total, page, limit, totalPages: Math.ceil(total / limit) }
}
