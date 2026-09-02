import {
  COMMERCIAL_CAPABILITY_REGISTRY,
  getCommercialCapabilityDefinition,
  getCommercialCapabilityKind,
} from '@/services/commercial/commercialCapabilityRegistry'

describe('commercial capability registry v2', () => {
  it('preserves every existing capability kind and exposes immutable definitions', () => {
    expect(Object.keys(COMMERCIAL_CAPABILITY_REGISTRY)).toEqual([
      'POS_CORE',
      'CHATBOT',
      'ADVANCED_REPORTS',
      'AVAILABLE_BALANCE',
      'AI_ASSISTANT_BUBBLE',
      'LOYALTY_PROGRAM',
      'REFERRAL_PROGRAM',
      'PROMOTIONS',
      'RESERVATIONS',
      'ONLINE_ORDERING',
      'BANK_RECONCILIATION',
      'BANKING_HUB',
      'VENUE_AUDIT_LOG',
      'GOOGLE_REVIEW_REDIRECT',
      'CASH_RECONCILIATION',
      'TABLE_SERVICE',
      'KITCHEN_DISPLAY',
      'UPSELL',
      'AREA_TICKETS',
      'VARIABLE_WEIGHT_BARCODE',
      'CFDI',
      'INVENTORY_TRACKING',
      'AUTO_REORDER',
      'TRANSACTION_EXPORT',
      'MERCHANT_ROUTING_RULES',
      'DELIVERY_CHANNELS',
      'OFFLINE_LAN_HUB',
      'SCALE_INTEGRATION',
      'UPSELL_AI',
      'MULTI_LOCATION',
      'COMMISSIONS',
      'ATTENDANCE_TRACKING',
      'SERIALIZED_INVENTORY',
      'WHITE_LABEL_DASHBOARD',
    ])
    expect(getCommercialCapabilityKind('POS_CORE')).toBe('CORE')
    expect(getCommercialCapabilityKind('COMMISSIONS')).toBe('MODULE')
    expect(getCommercialCapabilityKind('CFDI')).toBe('FEATURE')
    expect(getCommercialCapabilityKind('UNKNOWN')).toBeUndefined()
  })

  it('freezes CASH_RECONCILIATION as the only current venue setting and defaults it off', () => {
    expect(getCommercialCapabilityDefinition('CASH_RECONCILIATION')).toEqual({
      capabilityKind: 'FEATURE',
      activationRequirement: {
        mode: 'VENUE_SETTING',
        settingKey: 'cashReconciliationEnabled',
        defaultState: 'OFF',
      },
    })

    for (const code of Object.keys(COMMERCIAL_CAPABILITY_REGISTRY).filter(code => code !== 'CASH_RECONCILIATION')) {
      expect(getCommercialCapabilityDefinition(code)?.activationRequirement).toEqual({ mode: 'NOT_REQUIRED' })
    }
  })

  it('does not expose a mutable registry definition or nested activation requirement', () => {
    const definition = getCommercialCapabilityDefinition('CASH_RECONCILIATION')!
    expect(Object.isFrozen(COMMERCIAL_CAPABILITY_REGISTRY)).toBe(true)
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.activationRequirement)).toBe(true)

    expect(() => {
      ;(definition.activationRequirement as { mode: string }).mode = 'NOT_REQUIRED'
    }).toThrow(TypeError)
    expect(getCommercialCapabilityDefinition('CASH_RECONCILIATION')).toEqual({
      capabilityKind: 'FEATURE',
      activationRequirement: {
        mode: 'VENUE_SETTING',
        settingKey: 'cashReconciliationEnabled',
        defaultState: 'OFF',
      },
    })
  })

  it.each(['__proto__', 'constructor', 'toString'])('treats inherited property %s as an unknown capability', code => {
    expect(getCommercialCapabilityDefinition(code)).toBeUndefined()
    expect(getCommercialCapabilityKind(code)).toBeUndefined()
  })
})
