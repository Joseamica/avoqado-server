import { Prisma } from '@prisma/client'
import { acquireCatalogMutationLock } from '@/services/master-catalog/catalogMutationLock.service'

// WHY: The SQL shape and parameterized versioned key are a cross-service
// contract: item assignment and reference retirement must serialize together.
describe('acquireCatalogMutationLock', () => {
  it('takes one transaction-scoped advisory lock with a parameterized org key', async () => {
    // WHY: PostgreSQL reports pg_advisory_xact_lock as `void`; the production
    // seam must execute the statement without asking Prisma to deserialize it.
    const executeRaw = jest.fn().mockResolvedValue(0)
    const tx = { $executeRaw: executeRaw }

    await acquireCatalogMutationLock(tx as unknown as Prisma.TransactionClient, 'org-pits')

    expect(executeRaw).toHaveBeenCalledTimes(1)
    const statement = executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] }
    expect(statement.strings.join('?')).toContain('pg_advisory_xact_lock')
    expect(statement.strings.join('?')).toContain('hashtextextended')
    expect(statement.values).toEqual(['h1a:catalog-mutation:v1:org-pits'])
  })

  it('does not concatenate an organization ID into SQL text', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0)
    const organizationId = "org'); SELECT pg_sleep(10); --"

    await acquireCatalogMutationLock({ $executeRaw: executeRaw } as unknown as Prisma.TransactionClient, organizationId)

    const statement = executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] }
    expect(statement.strings.join('')).not.toContain(organizationId)
    expect(statement.values).toEqual([`h1a:catalog-mutation:v1:${organizationId}`])
  })
})
