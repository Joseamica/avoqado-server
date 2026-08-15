// src/services/dashboard/promotion.dashboard.service.ts
import { Prisma, PromotionStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { validatePromotionForPublish, type PromotionDraft } from '@/services/promotions/validatePromotion'
import type { CreatePromotionRequest, UpdatePromotionRequest } from '@/schemas/dashboard/promotion.schema'
import { logAction } from './activity-log.service'

const includeEstructura = {
  groups: {
    orderBy: { displayOrder: 'asc' as const },
    include: { options: { orderBy: { displayOrder: 'asc' as const } } },
  },
}

/** El API habla PESOS; priceCents es interno del modelo. */
function toDto(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl,
    type: row.type,
    pricingMode: row.pricingMode,
    price: row.priceCents / 100,
    status: row.status,
    displayOrder: row.displayOrder,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    daysOfWeek: row.daysOfWeek,
    timeFrom: row.timeFrom,
    timeUntil: row.timeUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    groups: (row.groups ?? []).map((g: any) => ({
      id: g.id,
      name: g.name,
      options: (g.options ?? []).map((o: any) => ({
        id: o.id,
        productId: o.productId,
        quantity: o.quantity,
        chargedQuantity: o.chargedQuantity,
        priceDelta: o.priceDeltaCents / 100,
      })),
    })),
  }
}

async function findOwnedOrThrow(venueId: string, promotionId: string) {
  const row = await prisma.promotion.findFirst({ where: { id: promotionId, venueId }, include: includeEstructura })
  if (!row) throw new NotFoundError('No encontramos esa promoción en este establecimiento.')
  return row
}

/**
 * 🔴 Tenant en la ESCRITURA, no sólo al publicar: un producto ajeno no entra ni
 * en DRAFT — el borrador viaja al editor y a la MCP, y un id ajeno guardado es
 * una bomba dormida aunque el validador de publicar lo atraparía después.
 */
async function assertProductsBelongToVenue(venueId: string, productIds: string[]) {
  const unicos = [...new Set(productIds)]
  const encontrados = await prisma.product.findMany({ where: { id: { in: unicos }, venueId }, select: { id: true } })
  if (encontrados.length !== unicos.length) {
    const halladas = new Set(encontrados.map(p => p.id))
    const faltante = unicos.find(id => !halladas.has(id))
    throw new BadRequestError(`El producto ${faltante} no existe o no pertenece a este establecimiento.`)
  }
}

function gruposCreate(groups: NonNullable<CreatePromotionRequest['groups']>) {
  return groups.map((g, gi) => ({
    name: g.name,
    displayOrder: gi,
    minSelect: 1,
    maxSelect: 1,
    options: {
      create: g.options.map((o, oi) => ({
        productId: o.productId,
        quantity: o.quantity,
        chargedQuantity: o.chargedQuantity,
        priceDeltaCents: Math.round((o.priceDelta ?? 0) * 100),
        displayOrder: oi,
      })),
    },
  }))
}

export async function getPromotions(venueId: string, page = 1, pageSize = 20, status?: PromotionStatus, search?: string) {
  const where: Prisma.PromotionWhereInput = {
    venueId,
    ...(status ? { status } : {}),
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  }
  const [totalCount, rows] = await Promise.all([
    prisma.promotion.count({ where }),
    prisma.promotion.findMany({
      where,
      include: includeEstructura,
      // `id` al final como desempate: sin una clave ÚNICA en el orderBy, dos
      // promociones con el mismo status/displayOrder/name pueden intercambiarse
      // entre páginas y una fila se pierde de la lista sin que nadie lo note
      // (guardrail: tests/unit/services/pagination-stability.guard.test.ts).
      orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return {
    data: rows.map(toDto),
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      hasNextPage: page * pageSize < totalCount,
      hasPrevPage: page > 1,
    },
  }
}

export async function getPromotionById(venueId: string, promotionId: string) {
  return toDto(await findOwnedOrThrow(venueId, promotionId))
}

export async function createPromotion(venueId: string, data: CreatePromotionRequest, staffId?: string) {
  await assertProductsBelongToVenue(
    venueId,
    data.groups.flatMap(g => g.options.map(o => o.productId)),
  )

  const created = await prisma.promotion.create({
    data: {
      venueId,
      name: data.name,
      description: data.description ?? null,
      imageUrl: data.imageUrl ?? null,
      type: data.type,
      pricingMode: data.pricingMode,
      priceCents: Math.round((data.price ?? 0) * 100),
      displayOrder: data.displayOrder ?? 0,
      validFrom: data.validFrom ?? null,
      validUntil: data.validUntil ?? null,
      daysOfWeek: data.daysOfWeek ?? [],
      timeFrom: data.timeFrom ?? null,
      timeUntil: data.timeUntil ?? null,
      status: 'DRAFT', // publicar es un acto aparte, siempre
      groups: { create: gruposCreate(data.groups) },
    },
    include: includeEstructura,
  })

  void logAction({ staffId, venueId, action: 'PROMOTION_CREATED', entity: 'Promotion', entityId: created.id, data: { name: created.name } })
  return toDto(created)
}

export async function updatePromotion(venueId: string, promotionId: string, data: UpdatePromotionRequest, staffId?: string) {
  const row = await findOwnedOrThrow(venueId, promotionId)

  if (data.groups) {
    await assertProductsBelongToVenue(
      venueId,
      data.groups.flatMap(g => g.options.map(o => o.productId)),
    )
  }

  const escalares: Prisma.PromotionUpdateInput = {
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
    ...(data.type !== undefined && { type: data.type }),
    ...(data.pricingMode !== undefined && { pricingMode: data.pricingMode }),
    ...(data.price !== undefined && { priceCents: Math.round(data.price * 100) }),
    ...(data.displayOrder !== undefined && { displayOrder: data.displayOrder }),
    ...(data.validFrom !== undefined && { validFrom: data.validFrom }),
    ...(data.validUntil !== undefined && { validUntil: data.validUntil }),
    ...(data.daysOfWeek !== undefined && { daysOfWeek: data.daysOfWeek }),
    ...(data.timeFrom !== undefined && { timeFrom: data.timeFrom }),
    ...(data.timeUntil !== undefined && { timeUntil: data.timeUntil }),
  }

  // 🔴 Editar una PUBLISHED pasa por el MISMO validador que publicarla — si no,
  // "publicar" y luego "editar" es una ruta que nunca vuelve a pisar
  // validatePromotionForPublish, y deja viva una promo que cobra de más
  // (ej. un 2x1 editado a chargedQuantity:3). DRAFT/ARCHIVED siguen editables
  // libres: un borrador puede estar incompleto a propósito.
  if (row.status === 'PUBLISHED') {
    const resultingType = data.type ?? (row.type as PromotionDraft['type'])
    const resultingPricingMode = data.pricingMode ?? (row.pricingMode as PromotionDraft['pricingMode'])
    const resultingPriceCents = data.price !== undefined ? Math.round(data.price * 100) : row.priceCents
    const resultingGroups = data.groups
      ? data.groups.map(g => ({
          name: g.name,
          minSelect: 1,
          maxSelect: 1,
          options: g.options.map(o => ({
            productId: o.productId,
            quantity: o.quantity,
            chargedQuantity: o.chargedQuantity,
            priceDeltaCents: Math.round((o.priceDelta ?? 0) * 100),
          })),
        }))
      : row.groups.map(g => ({
          name: g.name,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          options: g.options.map(o => ({
            productId: o.productId,
            quantity: o.quantity,
            chargedQuantity: o.chargedQuantity,
            priceDeltaCents: o.priceDeltaCents,
          })),
        }))

    const productIds = resultingGroups.flatMap(g => g.options.map(o => o.productId))
    const productos = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, venueId: true, active: true },
    })
    const porId = new Map(productos.map(p => [p.id, p]))

    const draft: PromotionDraft = {
      venueId,
      type: resultingType,
      pricingMode: resultingPricingMode,
      priceCents: resultingPriceCents,
      groups: resultingGroups.map(g => ({
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        options: g.options.map(o => ({
          productId: o.productId,
          productVenueId: porId.get(o.productId)?.venueId ?? 'desconocido',
          productActive: porId.get(o.productId)?.active ?? false,
          quantity: o.quantity,
          chargedQuantity: o.chargedQuantity,
          priceDeltaCents: o.priceDeltaCents,
        })),
      })),
    }

    const result = validatePromotionForPublish(draft)
    if (!result.ok) {
      // Mismo contrato que publishPromotion: el controller convierte el
      // BadRequestError en { errors: [...] } con TODOS los motivos juntos.
      throw new BadRequestError(result.errors.join('\n'))
    }
  }

  // Con groups: estructura completa se REEMPLAZA en una transacción (el editor
  // siempre manda todo; parchar grupo por grupo invita a estados imposibles).
  // Lo ya vendido no se toca: OrderPromotion guarda snapshot.
  const updated = await prisma.$transaction(async tx => {
    if (data.groups) {
      await tx.promotionGroup.deleteMany({ where: { promotionId } })
    }
    return tx.promotion.update({
      where: { id: promotionId },
      data: { ...escalares, ...(data.groups ? { groups: { create: gruposCreate(data.groups) } } : {}) },
      include: includeEstructura,
    })
  })

  void logAction({
    staffId,
    venueId,
    action: 'PROMOTION_UPDATED',
    entity: 'Promotion',
    entityId: promotionId,
    data: { fields: Object.keys(data) },
  })
  return toDto(updated)
}

export async function publishPromotion(venueId: string, promotionId: string, staffId?: string) {
  const row = await findOwnedOrThrow(venueId, promotionId)
  if (row.status === 'ARCHIVED') {
    throw new BadRequestError('Esta promoción está archivada: desarchívala antes de publicarla.')
  }
  if (row.status === 'PUBLISHED') {
    // Idempotente: re-publicar lo publicado no es error ni genera auditoría falsa.
    return toDto(row)
  }

  // El validador canónico decide — con los productos REALES del venue.
  const productIds = row.groups.flatMap(g => g.options.map(o => o.productId))
  const productos = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, venueId: true, active: true },
  })
  const porId = new Map(productos.map(p => [p.id, p]))

  const draft: PromotionDraft = {
    venueId,
    type: row.type as PromotionDraft['type'],
    pricingMode: row.pricingMode as PromotionDraft['pricingMode'],
    priceCents: row.priceCents,
    groups: row.groups.map(g => ({
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.options.map(o => ({
        productId: o.productId,
        productVenueId: porId.get(o.productId)?.venueId ?? 'desconocido',
        productActive: porId.get(o.productId)?.active ?? false,
        quantity: o.quantity,
        chargedQuantity: o.chargedQuantity,
        priceDeltaCents: o.priceDeltaCents,
      })),
    })),
  }

  const result = validatePromotionForPublish(draft)
  if (!result.ok) {
    // El controller convierte CUALQUIER BadRequestError de publish en
    // { errors: [...] } — todos los motivos juntos.
    throw new BadRequestError(result.errors.join('\n'))
  }

  // 🔴 CAS sobre el estado (audit 2026-08-14): entre validar y publicar, otra
  // sesión pudo archivarla — el where condicionado evita publicar una archivada.
  const updated = await prisma.promotion.updateMany({
    where: { id: promotionId, venueId, status: 'DRAFT' },
    data: { status: 'PUBLISHED' },
  })
  if (updated.count === 0) {
    throw new BadRequestError('La promoción cambió de estado mientras se validaba. Recarga e intenta de nuevo.')
  }
  void logAction({ staffId, venueId, action: 'PROMOTION_PUBLISHED', entity: 'Promotion', entityId: promotionId, data: { name: row.name } })
  return getPromotionById(venueId, promotionId)
}

export async function archivePromotion(venueId: string, promotionId: string, staffId?: string) {
  const row = await findOwnedOrThrow(venueId, promotionId)
  if (row.status === 'ARCHIVED') {
    return toDto(row) // idempotente: archivar lo archivado es no-op
  }
  const updated = await prisma.promotion.updateMany({
    where: { id: promotionId, venueId, status: { in: ['DRAFT', 'PUBLISHED'] } },
    data: { status: 'ARCHIVED' },
  })
  if (updated.count > 0) {
    void logAction({ staffId, venueId, action: 'PROMOTION_ARCHIVED', entity: 'Promotion', entityId: promotionId, data: { name: row.name } })
  }
  return getPromotionById(venueId, promotionId)
}

export async function unarchivePromotion(venueId: string, promotionId: string, staffId?: string) {
  const row = await findOwnedOrThrow(venueId, promotionId)
  if (row.status !== 'ARCHIVED') {
    throw new BadRequestError('Sólo una promoción archivada se puede desarchivar.')
  }
  // Siempre a DRAFT: re-publicar exige pasar el validador otra vez (el catálogo
  // pudo cambiar mientras estuvo archivada). CAS igual que publish.
  const updated = await prisma.promotion.updateMany({
    where: { id: promotionId, venueId, status: 'ARCHIVED' },
    data: { status: 'DRAFT' },
  })
  if (updated.count > 0) {
    void logAction({
      staffId,
      venueId,
      action: 'PROMOTION_UNARCHIVED',
      entity: 'Promotion',
      entityId: promotionId,
      data: { name: row.name },
    })
  }
  return getPromotionById(venueId, promotionId)
}

export async function deletePromotion(venueId: string, promotionId: string, staffId?: string) {
  const row = await findOwnedOrThrow(venueId, promotionId)
  if (row.status !== 'DRAFT') {
    throw new BadRequestError('Sólo un borrador se puede borrar. Si ya se publicó, archívala.')
  }
  const ventas = await prisma.orderPromotion.count({ where: { promotionId } })
  if (ventas > 0) {
    throw new BadRequestError('Esta promoción ya tiene ventas registradas: archívala en vez de borrarla.')
  }
  await prisma.promotion.delete({ where: { id: promotionId } })
  void logAction({ staffId, venueId, action: 'PROMOTION_DELETED', entity: 'Promotion', entityId: promotionId, data: { name: row.name } })
}
