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
