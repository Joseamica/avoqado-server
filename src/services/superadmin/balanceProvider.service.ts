import prisma from '../../utils/prismaClient'

/**
 * BalanceProvider catalog — read-only for now (managed via
 * `scripts/seed-balance-providers.ts`, not a CRUD UI). One row per
 * banking/fintech integration a merchant could have (an external bank today).
 */
export async function getBalanceProviders(filters: { active?: boolean } = {}) {
  const where: { active?: boolean } = {}
  if (filters.active !== undefined) where.active = filters.active

  return prisma.financialProvider.findMany({
    where,
    orderBy: { name: 'asc' },
  })
}
