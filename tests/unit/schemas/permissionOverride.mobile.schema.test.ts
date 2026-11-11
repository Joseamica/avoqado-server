import { createPermissionOverrideSchema } from '@/schemas/mobile/permissionOverride.mobile.schema'

const base = (extra: object) => ({ params: { venueId: 'v1' }, body: { pin: '1234', permission: 'cash-drawer:pay-out', ...extra } })

describe('createPermissionOverrideSchema.operationKey', () => {
  it('conserva operationKey válido', () => {
    const r = createPermissionOverrideSchema.parse(base({ operationKey: 'pay-out:loc-1:500000' }))
    expect(r.body.operationKey).toBe('pay-out:loc-1:500000')
  })
  it('sigue siendo opcional', () => {
    expect(createPermissionOverrideSchema.parse(base({})).body.operationKey).toBeUndefined()
  })
  it.each(['otra:loc-1:5', 'pay-out:loc-1:abc', 'pay-out::5', 'pay-out:a b:5', 'pay-out:loc-1:1234567890123', 'pay-out:sin-llave'])(
    'rechaza operationKey con otro formato (%s)',
    k => {
      expect(createPermissionOverrideSchema.safeParse(base({ operationKey: k })).success).toBe(false)
    },
  )
})
