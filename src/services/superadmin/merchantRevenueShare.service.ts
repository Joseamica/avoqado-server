/**
 * MerchantRevenueShare CRUD — revenue-share configurable por merchant.
 * Una fila por `MerchantAccount` (constraint @unique en el schema).
 *
 * Spec: docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import type {
  SaveMerchantEconomicsInput,
  CreateMerchantRevenueShareInput,
  UpdateMerchantRevenueShareInput,
} from '../../schemas/dashboard/merchant-revenue-share.schema'

/** Prisma `Json?` no acepta `null` literal; usa `Prisma.JsonNull` para escribir
 *  null en la BD. Esto normaliza el `aggregatorPrice` del input para create/update. */
function toCreateData(input: CreateMerchantRevenueShareInput): Prisma.MerchantRevenueShareUncheckedCreateInput {
  const { aggregatorPrice, ...rest } = input
  return {
    ...rest,
    ...(aggregatorPrice !== undefined && {
      aggregatorPrice: aggregatorPrice === null ? Prisma.JsonNull : (aggregatorPrice as Prisma.InputJsonValue),
    }),
  }
}

function toUpdateData(input: UpdateMerchantRevenueShareInput): Prisma.MerchantRevenueShareUncheckedUpdateInput {
  const { aggregatorPrice, ...rest } = input
  return {
    ...rest,
    ...(aggregatorPrice !== undefined && {
      aggregatorPrice: aggregatorPrice === null ? Prisma.JsonNull : (aggregatorPrice as Prisma.InputJsonValue),
    }),
  }
}

export async function listMerchantRevenueShares(filters: { active?: boolean } = {}) {
  const where: { active?: boolean } = {}
  if (filters.active !== undefined) where.active = filters.active

  return prisma.merchantRevenueShare.findMany({
    where,
    include: {
      merchantAccount: {
        select: {
          id: true,
          externalMerchantId: true,
          alias: true,
          displayName: true,
          providerId: true,
          aggregatorId: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getMerchantRevenueShareByMerchant(merchantAccountId: string) {
  return prisma.merchantRevenueShare.findUnique({
    where: { merchantAccountId },
  })
}

export async function getMerchantRevenueShareById(id: string) {
  return prisma.merchantRevenueShare.findUnique({ where: { id } })
}

export async function createMerchantRevenueShare(input: CreateMerchantRevenueShareInput) {
  // Verificar que el merchant existe — feedback más claro que el FK error de Postgres.
  const merchant = await prisma.merchantAccount.findUnique({
    where: { id: input.merchantAccountId },
    select: { id: true },
  })
  if (!merchant) {
    throw new NotFoundError('El merchant indicado no existe')
  }

  try {
    return await prisma.merchantRevenueShare.create({ data: toCreateData(input) })
  } catch (err: unknown) {
    // P2002 = unique constraint violation. El @unique vive en merchantAccountId.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      throw new ConflictError('Este merchant ya tiene un revenue-share configurado')
    }
    throw err
  }
}

export async function updateMerchantRevenueShare(id: string, input: UpdateMerchantRevenueShareInput) {
  const existing = await prisma.merchantRevenueShare.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('Revenue-share no encontrado')
  }
  return prisma.merchantRevenueShare.update({ where: { id }, data: toUpdateData(input) })
}

export async function deleteMerchantRevenueShare(id: string) {
  const existing = await prisma.merchantRevenueShare.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('Revenue-share no encontrado')
  }
  await prisma.merchantRevenueShare.delete({ where: { id } })
}

/** Guarda costo y reparto juntos: si la segunda escritura falla, ninguna se conserva. */
export async function saveMerchantEconomics(merchantAccountId: string, input: SaveMerchantEconomicsInput) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${merchantAccountId}))`
    const merchant = await tx.merchantAccount.findUnique({ where: { id: merchantAccountId }, select: { id: true, providerId: true } })
    if (!merchant) throw new NotFoundError('El merchant indicado no existe')
    const now = new Date()
    const cost = await tx.providerCostStructure.findFirst({
      where: { merchantAccountId, active: true, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    })
    const share = await tx.merchantRevenueShare.findUnique({ where: { merchantAccountId } })
    if (input.costId !== (cost?.id ?? null)) {
      throw new ConflictError('El costo cambió. Recarga la economía antes de guardar.')
    }
    if (input.revenueShareId ? !share || share.id !== input.revenueShareId : !!share) {
      throw new ConflictError('El reparto cambió. Recarga la economía antes de guardar.')
    }
    const savedCost = input.costId
      ? await tx.providerCostStructure.update({ where: { id: input.costId }, data: input.cost })
      : await tx.providerCostStructure.create({
          data: { ...input.cost, merchantAccountId, providerId: merchant.providerId, effectiveFrom: now },
        })
    const savedShare = input.revenueShareId
      ? await tx.merchantRevenueShare.update({ where: { id: input.revenueShareId }, data: toUpdateData(input.revenueShare) })
      : await tx.merchantRevenueShare.create({ data: toCreateData({ ...input.revenueShare, merchantAccountId }) })
    return { cost: savedCost, revenueShare: savedShare }
  })
}
