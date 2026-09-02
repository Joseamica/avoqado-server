import type { CommercialCapabilityKind } from '@/types/commercial'

export type CommercialCapabilityActivationRequirement =
  | Readonly<{ mode: 'NOT_REQUIRED' }>
  | Readonly<{ mode: 'VENUE_SETTING'; settingKey: string; defaultState: 'ON' | 'OFF' }>

export interface CommercialCapabilityDefinition {
  readonly capabilityKind: CommercialCapabilityKind
  readonly activationRequirement: CommercialCapabilityActivationRequirement
}

function notRequired(capabilityKind: CommercialCapabilityKind): Readonly<CommercialCapabilityDefinition> {
  return Object.freeze({
    capabilityKind,
    activationRequirement: Object.freeze({ mode: 'NOT_REQUIRED' as const }),
  })
}

function venueSetting(
  capabilityKind: CommercialCapabilityKind,
  settingKey: string,
  defaultState: 'ON' | 'OFF',
): Readonly<CommercialCapabilityDefinition> {
  return Object.freeze({
    capabilityKind,
    activationRequirement: Object.freeze({ mode: 'VENUE_SETTING' as const, settingKey, defaultState }),
  })
}

/**
 * Canonical bridge from the commercial catalog to the runtime gate namespace.
 * A commercial product's shape does not decide where a capability is enforced:
 * plans may grant Module-backed gates and add-on products may grant Feature rows.
 */
export const COMMERCIAL_CAPABILITY_REGISTRY = Object.freeze({
  POS_CORE: notRequired('CORE'),
  CHATBOT: notRequired('FEATURE'),
  ADVANCED_REPORTS: notRequired('FEATURE'),
  AVAILABLE_BALANCE: notRequired('FEATURE'),
  AI_ASSISTANT_BUBBLE: notRequired('FEATURE'),
  LOYALTY_PROGRAM: notRequired('FEATURE'),
  REFERRAL_PROGRAM: notRequired('FEATURE'),
  PROMOTIONS: notRequired('FEATURE'),
  RESERVATIONS: notRequired('FEATURE'),
  ONLINE_ORDERING: notRequired('FEATURE'),
  BANK_RECONCILIATION: notRequired('FEATURE'),
  BANKING_HUB: notRequired('FEATURE'),
  VENUE_AUDIT_LOG: notRequired('FEATURE'),
  GOOGLE_REVIEW_REDIRECT: notRequired('FEATURE'),
  CASH_RECONCILIATION: venueSetting('FEATURE', 'cashReconciliationEnabled', 'OFF'),
  TABLE_SERVICE: notRequired('FEATURE'),
  KITCHEN_DISPLAY: notRequired('FEATURE'),
  UPSELL: notRequired('FEATURE'),
  AREA_TICKETS: notRequired('FEATURE'),
  VARIABLE_WEIGHT_BARCODE: notRequired('FEATURE'),
  CFDI: notRequired('FEATURE'),
  INVENTORY_TRACKING: notRequired('FEATURE'),
  AUTO_REORDER: notRequired('FEATURE'),
  TRANSACTION_EXPORT: notRequired('FEATURE'),
  MERCHANT_ROUTING_RULES: notRequired('FEATURE'),
  DELIVERY_CHANNELS: notRequired('FEATURE'),
  OFFLINE_LAN_HUB: notRequired('FEATURE'),
  SCALE_INTEGRATION: notRequired('FEATURE'),
  UPSELL_AI: notRequired('FEATURE'),
  MULTI_LOCATION: notRequired('FEATURE'),
  COMMISSIONS: notRequired('MODULE'),
  ATTENDANCE_TRACKING: notRequired('MODULE'),
  SERIALIZED_INVENTORY: notRequired('MODULE'),
  WHITE_LABEL_DASHBOARD: notRequired('MODULE'),
} as const satisfies Record<string, Readonly<CommercialCapabilityDefinition>>)

export function getCommercialCapabilityKind(code: string): CommercialCapabilityKind | undefined {
  return getCommercialCapabilityDefinition(code)?.capabilityKind
}

export function getCommercialCapabilityDefinition(code: string): Readonly<CommercialCapabilityDefinition> | undefined {
  if (!Object.prototype.hasOwnProperty.call(COMMERCIAL_CAPABILITY_REGISTRY, code)) return undefined
  return (COMMERCIAL_CAPABILITY_REGISTRY as Readonly<Record<string, Readonly<CommercialCapabilityDefinition>>>)[code]
}
