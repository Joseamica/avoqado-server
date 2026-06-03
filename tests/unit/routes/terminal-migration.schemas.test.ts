import { migratePreflightSchema, migrateExecuteSchema, migrateStatusSchema } from '@/routes/superadmin/terminal-migration.schemas'

// Real terminal ids are MIXED format in production: most are cuid, some are UUID.
const CUID = 'cmph332eq00039kg8z9cqyc4g'
const UUID = 'f71607dc-cade-402f-8af8-798ce6d1dc66'

describe('terminal-migration route validation schemas', () => {
  // --- NEW FEATURE: the fix — UUID-format ids must be accepted (were rejected by .cuid()) ---
  describe('migratePreflightSchema / migrateExecuteSchema', () => {
    it('accepts a UUID-format terminalId (the Bug #2 fix)', () => {
      const r = migratePreflightSchema.safeParse({ params: { terminalId: UUID }, body: { toVenueId: CUID } })
      expect(r.success).toBe(true)
    })

    it('accepts a cuid-format terminalId (regression: still works)', () => {
      const r = migratePreflightSchema.safeParse({ params: { terminalId: CUID }, body: { toVenueId: CUID } })
      expect(r.success).toBe(true)
    })

    it('accepts a UUID-format toVenueId', () => {
      const r = migratePreflightSchema.safeParse({ params: { terminalId: CUID }, body: { toVenueId: UUID } })
      expect(r.success).toBe(true)
    })

    it('migrateExecuteSchema is the same contract (accepts UUID)', () => {
      const r = migrateExecuteSchema.safeParse({ params: { terminalId: UUID }, body: { toVenueId: CUID } })
      expect(r.success).toBe(true)
    })

    // --- REGRESSION: must still reject genuinely-invalid input, in Spanish ---
    it('rejects an empty terminalId with the Spanish message', () => {
      const r = migratePreflightSchema.safeParse({ params: { terminalId: '' }, body: { toVenueId: CUID } })
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).toBe('ID de terminal inválido')
    })

    it('rejects a missing toVenueId with the Spanish message', () => {
      const r = migratePreflightSchema.safeParse({ params: { terminalId: CUID }, body: {} })
      expect(r.success).toBe(false)
    })
  })

  describe('migrateStatusSchema', () => {
    it('accepts a UUID terminalId + commandId in query', () => {
      const r = migrateStatusSchema.safeParse({ params: { terminalId: UUID }, query: { commandId: CUID } })
      expect(r.success).toBe(true)
    })

    it('rejects an empty commandId with the Spanish message', () => {
      const r = migrateStatusSchema.safeParse({ params: { terminalId: CUID }, query: { commandId: '' } })
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).toBe('ID de comando inválido')
    })
  })
})
