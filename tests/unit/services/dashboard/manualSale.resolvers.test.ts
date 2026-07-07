/**
 * Row resolver helpers for "Subir ventas fuera de TPV" (manual sales bulk upload).
 *
 * Each resolver turns one opaque string value from an Excel/CSV row into a real
 * domain entity scoped to the organization — or a Spanish `{ error }` when it
 * can't be resolved. They are pure functions over a Prisma transaction client
 * (no side effects), so they're tested here with lightweight in-memory mocks
 * rather than a real database.
 */
import { Prisma } from '@prisma/client'
import {
  resolveIccid,
  resolveStaffByCode,
  resolveVenue,
  resolveCategory,
  mapPaymentForm,
  parseAmount,
} from '../../../../src/services/dashboard/manualSale.resolvers'

/**
 * Builds a minimal fake Prisma.TransactionClient exposing only the model
 * methods each test needs. Cast to `any` at the call site — matches the
 * brief's example test style.
 */
function mockTx(overrides: Record<string, Record<string, (...args: any[]) => any>>) {
  return overrides
}

describe('resolveIccid', () => {
  it('available org item matches case-insensitively', async () => {
    const tx = mockTx({
      serializedItem: {
        findFirst: async () => ({ id: 'si1', status: 'AVAILABLE', organizationId: 'org1', serialNumber: '8952...F' }),
      },
    })
    const r = await resolveIccid('org1', '8952...f', tx as any) // lowercase input
    expect('item' in r && r.item.id).toBe('si1')
  })

  it('passes the trimmed+case-insensitive filter to findFirst', async () => {
    let capturedWhere: any = null
    const tx = mockTx({
      serializedItem: {
        findFirst: async (args: any) => {
          capturedWhere = args.where
          return { id: 'si1', status: 'AVAILABLE', organizationId: 'org1', serialNumber: '8952X' }
        },
      },
    })
    await resolveIccid('org1', '  8952x  ', tx as any)
    expect(capturedWhere).toEqual({
      organizationId: 'org1',
      serialNumber: { equals: '8952x', mode: 'insensitive' },
    })
  })

  it('not found → error', async () => {
    const tx = mockTx({ serializedItem: { findFirst: async () => null } })
    expect(await resolveIccid('org1', 'x', tx as any)).toEqual({ error: 'ICCID no existe' })
  })

  it('already-sold → error', async () => {
    const tx = mockTx({
      serializedItem: { findFirst: async () => ({ id: 'si1', status: 'SOLD', organizationId: 'org1' }) },
    })
    expect(await resolveIccid('org1', 'x', tx as any)).toEqual({ error: 'ICCID ya vendido' })
  })

  it('belongs to a different organization → error', async () => {
    const tx = mockTx({
      serializedItem: {
        findFirst: async () => ({ id: 'si1', status: 'AVAILABLE', organizationId: 'other-org' }),
      },
    })
    expect(await resolveIccid('org1', 'x', tx as any)).toEqual({ error: 'ICCID pertenece a otra organización' })
  })

  it('RETURNED/DAMAGED (not AVAILABLE, not SOLD) → not-exists error (not sellable)', async () => {
    const tx = mockTx({
      serializedItem: { findFirst: async () => ({ id: 'si1', status: 'DAMAGED', organizationId: 'org1' }) },
    })
    expect(await resolveIccid('org1', 'x', tx as any)).toEqual({ error: 'ICCID no existe' })
  })
})

describe('resolveStaffByCode', () => {
  it('matches by employeeCode case-insensitively and confirms org membership', async () => {
    const staff = { id: 'staff1', employeeCode: 'BSCLOXH0405', firstName: 'Ana', lastName: 'Ruiz' }
    const tx = mockTx({
      staff: {
        findFirst: async (args: any) => (args.where.employeeCode ? staff : null),
      },
    })
    const r = await resolveStaffByCode('org1', 'bscloxh0405', undefined, tx as any)
    expect('staff' in r && r.staff.id).toBe('staff1')
  })

  it('falls back to normalized firstName+lastName when code is empty', async () => {
    const staff = { id: 'staff2', employeeCode: null, firstName: 'Juan', lastName: 'Pérez' }
    const tx = mockTx({
      staff: {
        // code is empty, so the resolver should skip straight to the
        // name-fallback branch (findMany over org-scoped candidates).
        findFirst: async () => {
          throw new Error('findFirst should not be called when code is empty')
        },
        findMany: async () => [staff],
      },
    })
    const r = await resolveStaffByCode('org1', '', 'Juan Pérez', tx as any)
    expect('staff' in r && r.staff.id).toBe('staff2')
  })

  it('not found by code or name → error', async () => {
    const tx = mockTx({ staff: { findFirst: async () => null, findMany: async () => [] } })
    expect(await resolveStaffByCode('org1', 'ZZZ', 'Nadie Nada', tx as any)).toEqual({ error: 'Vendedor no encontrado' })
  })

  it('scopes BOTH queries to an ACTIVE org membership (active venue OR active org)', async () => {
    // The resolver never loads the whole Staff table — every lookup is gated by
    // an org-membership filter. Capture the `where` actually passed to each
    // query and assert it requires an ACTIVE membership on BOTH paths, so a
    // regression in orgMembershipFilter (wrong org, or a dropped isActive/active)
    // is caught here. A staff row that isn't an active member simply won't match
    // → 'Vendedor no encontrado'.
    let codeWhere: any = null
    let nameWhere: any = null
    const tx = mockTx({
      staff: {
        findFirst: async (args: any) => {
          codeWhere = args.where
          return null // no active-member match by code
        },
        findMany: async (args: any) => {
          nameWhere = args.where
          return [] // no active-member candidates for the name fallback
        },
      },
    })

    const r = await resolveStaffByCode('org1', 'BSCLOXH0405', 'Ana Ruiz', tx as any)
    expect(r).toEqual({ error: 'Vendedor no encontrado' })

    // The expected org-membership filter: active StaffVenue in the org, OR
    // active StaffOrganization in the org.
    const expectedOrgMembership = {
      OR: [
        { venues: { some: { venue: { organizationId: 'org1' }, active: true } } },
        { organizations: { some: { organizationId: 'org1', isActive: true } } },
      ],
    }

    // Code query: employeeCode match AND active org membership.
    expect(codeWhere).toEqual({
      employeeCode: { equals: 'BSCLOXH0405', mode: 'insensitive' },
      ...expectedOrgMembership,
    })
    // Name-fallback query: purely the active org-membership scope.
    expect(nameWhere).toEqual(expectedOrgMembership)
  })
})

describe('resolveVenue', () => {
  it('matches by trailing (NNNN) number in storeName', async () => {
    const venue = { id: 'v1', name: 'BAE MUÑOZ SLP (898)', slug: 'bae-munoz-slp' }
    const tx = mockTx({
      venue: {
        // The resolver should try a numeric-id-based lookup first when it can
        // extract a trailing (NNNN) from storeName.
        findFirst: async () => venue,
      },
    })
    const r = await resolveVenue('org1', 'BAE MUÑOZ SLP (898)', undefined, tx as any)
    expect('venue' in r && r.venue.id).toBe('v1')
  })

  it('falls back to name/slug (insensitive) when no trailing number present', async () => {
    const venue = { id: 'v2', name: 'BAE Papagayo', slug: 'bae-papagayo' }
    const tx = mockTx({
      venue: { findFirst: async () => venue },
    })
    const r = await resolveVenue('org1', 'bae papagayo', undefined, tx as any)
    expect('venue' in r && r.venue.id).toBe('v2')
  })

  it('not found → error', async () => {
    const tx = mockTx({ venue: { findFirst: async () => null } })
    expect(await resolveVenue('org1', 'Sucursal Fantasma', undefined, tx as any)).toEqual({ error: 'Tienda no encontrada' })
  })
})

describe('resolveCategory', () => {
  it('matches org-level ItemCategory by name case-insensitively', async () => {
    const tx = mockTx({
      itemCategory: { findFirst: async () => ({ id: 'cat1', name: 'SIM de intercambio' }) },
    })
    const r = await resolveCategory('org1', 'sim de intercambio', tx as any)
    expect(r).toEqual({ categoryId: 'cat1' })
  })

  it('empty simType falls back to the resolved item categoryId', async () => {
    const tx = mockTx({ itemCategory: { findFirst: async () => null } })
    const r = await resolveCategory('org1', '', tx as any, 'existing-cat-id')
    expect(r).toEqual({ categoryId: 'existing-cat-id' })
  })

  it('simType provided but no match, and no fallback categoryId → error', async () => {
    const tx = mockTx({ itemCategory: { findFirst: async () => null } })
    expect(await resolveCategory('org1', 'Categoría Inexistente', tx as any)).toEqual({ error: 'Categoría no encontrada' })
  })
})

describe('mapPaymentForm', () => {
  it('Efectivo → CASH, amountApplies true', () => {
    expect(mapPaymentForm('Efectivo')).toEqual({ method: 'CASH', amountApplies: true })
  })

  it('Tarjeta → CREDIT_CARD, amountApplies true', () => {
    expect(mapPaymentForm('Tarjeta')).toEqual({ method: 'CREDIT_CARD', amountApplies: true })
  })

  it('Débito → CREDIT_CARD, amountApplies true', () => {
    expect(mapPaymentForm('Débito')).toEqual({ method: 'CREDIT_CARD', amountApplies: true })
  })

  it('Crédito → CREDIT_CARD, amountApplies true', () => {
    expect(mapPaymentForm('Crédito')).toEqual({ method: 'CREDIT_CARD', amountApplies: true })
  })

  it('No aplica → OTHER, amountApplies false', () => {
    expect(mapPaymentForm('No aplica')).toEqual({ method: 'OTHER', amountApplies: false })
  })

  it('is case-insensitive', () => {
    expect(mapPaymentForm('efectivo')).toEqual({ method: 'CASH', amountApplies: true })
    expect(mapPaymentForm('NO APLICA')).toEqual({ method: 'OTHER', amountApplies: false })
  })

  it('unknown value → OTHER, amountApplies true', () => {
    expect(mapPaymentForm('Vale de despensa')).toEqual({ method: 'OTHER', amountApplies: true })
  })
})

describe('parseAmount', () => {
  it('"No aplica" → 0', () => {
    expect(parseAmount('No aplica', false).toString()).toBe('0')
  })

  it('!amountApplies → 0 regardless of raw value', () => {
    expect(parseAmount('500', false).toString()).toBe('0')
  })

  it('numeric string → Decimal', () => {
    expect(parseAmount('350.50', true).toString()).toBe('350.5')
  })

  it('number → Decimal', () => {
    expect(parseAmount(200, true).toString()).toBe('200')
  })

  it('returns a real Prisma.Decimal instance', () => {
    expect(parseAmount(100, true)).toBeInstanceOf(Prisma.Decimal)
  })
})
