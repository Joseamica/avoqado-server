import entitlementFixture from '@/contracts/commercial/fixtures/v2/entitlement-pos.json'
import { validateCommercialEntitlementsV2 } from '@/services/commercial/commercialContractV2.service'
import { cloneJson, expectTrustedSnapshot } from './commercialContractV2.testSupport'

const productOrigin = { kind: 'PRODUCT', sourceCode: 'POS', lineKey: 'PRODUCT:POS:POS_MONTHLY' }

const positiveOriginCases = [
  ['FREE', [{ kind: 'FREE', sourceCode: 'FREE', lineKey: 'PRODUCT:FREE:FREE_MONTHLY' }]],
  ['PRODUCT', [productOrigin]],
  ['BUNDLE', [{ kind: 'BUNDLE', sourceCode: 'ALL_MODULES', lineKey: 'BUNDLE:ALL_MODULES:ALL_MODULES_MONTHLY' }]],
  [
    'BUNDLE_COMPONENT',
    [
      {
        kind: 'BUNDLE_COMPONENT',
        sourceCode: 'KITCHEN_DISPLAY_MODULE',
        parentSourceCode: 'ALL_MODULES',
        lineKey: 'BUNDLE:ALL_MODULES:ALL_MODULES_MONTHLY',
      },
    ],
  ],
  [
    'CAMPAIGN',
    [
      productOrigin,
      {
        kind: 'CAMPAIGN',
        sourceCode: 'POS_50',
        sourceId: 'campaign-version-pos-50-v2',
        lineKey: 'PRODUCT:POS:POS_MONTHLY',
      },
    ],
  ],
  ['TRIAL', [{ kind: 'TRIAL', sourceId: 'trial-001' }]],
  ['GRANDFATHERED', [{ kind: 'GRANDFATHERED', sourceId: 'grandfathered-001' }]],
  ['CONTRACT', [{ kind: 'CONTRACT', sourceId: 'contract-001' }]],
  ['MANUAL', [{ kind: 'MANUAL', sourceId: 'manual-001' }]],
] as const

describe('commercial entitlement origin union v2', () => {
  it.each(positiveOriginCases)('accepts and recursively freezes the valid %s origin arm', (_kind, origins) => {
    const value = cloneJson(entitlementFixture) as any
    value.capabilities[0].entitlement.origins = cloneJson(origins)
    expectTrustedSnapshot(validateCommercialEntitlementsV2(value), value)
  })
})
