import { AccountType, OriginSystem, PaymentMethod, PaymentType, Prisma, TransactionStatus } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError } from '../../../errors/AppError'

export async function resolveMerchantAccountId(venueId: string, accountType: AccountType): Promise<string> {
  const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
  if (!config) throw new BadRequestError(`Venue ${venueId} has no payment configuration`)
  const id =
    accountType === AccountType.PRIMARY
      ? config.primaryAccountId
      : accountType === AccountType.SECONDARY
        ? config.secondaryAccountId
        : config.tertiaryAccountId
  if (!id) throw new BadRequestError(`Venue ${venueId} has no ${accountType} merchant account configured`)
  return id
}

export interface ScopeArgs {
  venueId: string
  merchantAccountId: string
  dateFrom?: Date
  dateTo?: Date
}

export function buildScopeWhere(args: ScopeArgs): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = {
    venueId: args.venueId,
    merchantAccountId: args.merchantAccountId,
    status: TransactionStatus.COMPLETED,
    originSystem: OriginSystem.AVOQADO,
    method: { not: PaymentMethod.CASH },
    // PaymentType.TEST is a valid enum member; field is nullable but { not: ... } accepts enum value
    type: { not: PaymentType.TEST },
  }
  if (args.dateFrom || args.dateTo) {
    where.createdAt = {
      ...(args.dateFrom ? { gte: args.dateFrom } : {}),
      ...(args.dateTo ? { lte: args.dateTo } : {}),
    }
  }
  return where
}
