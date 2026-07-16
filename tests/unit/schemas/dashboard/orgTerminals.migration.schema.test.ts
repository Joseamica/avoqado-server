import { orgMigratePreflightSchema, orgMigrateExecuteSchema } from '@/schemas/dashboard/orgTerminals.schema'

/**
 * Org-namespace terminal-migration schemas — `migrateMerchant` flag.
 *
 * The org namespace (`/dashboard/organizations/:orgId/terminals/:terminalId/migrate-*`)
 * validates against its OWN Zod schemas here — completely separate from the
 * superadmin namespace's `src/routes/superadmin/terminal-migration.schemas.ts`
 * (covered by `tests/unit/routes/terminal-migration.schemas.test.ts`). Without
 * `migrateMerchant` on THESE schemas, the field is silently stripped by
 * `validateRequest` before it ever reaches `migratePreflightForOrg`/
 * `migrateExecuteForOrg` — the checkbox would be dead for org OWNER users.
 */
describe('org terminal-migration schemas — migrateMerchant', () => {
  const params = { orgId: 'org-1', terminalId: 'term-1' }

  describe('orgMigratePreflightSchema', () => {
    it('acepta migrateMerchant=true y lo deja pasar al body parseado', () => {
      const r = orgMigratePreflightSchema.safeParse({
        params,
        body: { toVenueId: 'venue-new', migrateMerchant: true },
      })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.body.migrateMerchant).toBe(true)
    })

    it('migrateMerchant es opcional (regresión: el body de hoy sigue pasando)', () => {
      const r = orgMigratePreflightSchema.safeParse({
        params,
        body: { toVenueId: 'venue-new' },
      })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.body.migrateMerchant).toBeUndefined()
    })

    it('rechaza migrateMerchant no-booleano con mensaje en español', () => {
      const r = orgMigratePreflightSchema.safeParse({
        params,
        body: { toVenueId: 'venue-new', migrateMerchant: 'sí' },
      })
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).toBe('La opción de migrar el comercio debe ser verdadero o falso')
    })
  })

  describe('orgMigrateExecuteSchema', () => {
    it('acepta migrateMerchant=true junto con assignedMerchantIds y lo deja pasar al body parseado', () => {
      const r = orgMigrateExecuteSchema.safeParse({
        params,
        body: { toVenueId: 'venue-new', assignedMerchantIds: ['merch-1'], migrateMerchant: true },
      })
      expect(r.success).toBe(true)
      if (r.success) {
        expect(r.data.body.migrateMerchant).toBe(true)
        expect(r.data.body.assignedMerchantIds).toEqual(['merch-1'])
      }
    })

    it('migrateMerchant es opcional (regresión: el body de hoy sigue pasando)', () => {
      const r = orgMigrateExecuteSchema.safeParse({
        params,
        body: { toVenueId: 'venue-new' },
      })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.body.migrateMerchant).toBeUndefined()
    })

    it('rechaza migrateMerchant no-booleano con mensaje en español', () => {
      const r = orgMigrateExecuteSchema.safeParse({
        params,
        body: { toVenueId: 'venue-new', migrateMerchant: 'sí' },
      })
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).toBe('La opción de migrar el comercio debe ser verdadero o falso')
    })
  })
})
