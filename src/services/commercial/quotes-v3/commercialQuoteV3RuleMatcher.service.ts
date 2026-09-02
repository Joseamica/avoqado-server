import type { CommercialProductKind } from '@/types/commercial'
import type { CommercialCampaignRuleV2 } from '@/types/commercialV2'

export interface CommercialQuoteV3RuleTargetLine {
  targetType: 'PRODUCT' | 'BUNDLE'
  targetCode: string
  productKind: CommercialProductKind | 'BUNDLE'
}

const productCodeKey = (code: string) => `PRODUCT_CODE:${code}`
const bundleCodeKey = (code: string) => `BUNDLE_CODE:${code}`
const productKindKey = (kind: CommercialProductKind) => `PRODUCT_KIND:${kind}`

/**
 * Canonical index keys for the same OR semantics enforced by
 * {@link commercialQuoteV3RuleTargetsLine}. Pair validation uses these keys to
 * avoid rescanning large target arrays while a catalog writer holds its lock.
 */
export function commercialQuoteV3RuleTargetKeys(rule: CommercialCampaignRuleV2): string[] {
  return [
    ...(rule.target.productCodes ?? []).map(productCodeKey),
    ...(rule.target.bundleCodes ?? []).map(bundleCodeKey),
    ...(rule.target.productKinds ?? []).map(productKindKey),
  ]
}

/** Canonical lookup keys for one concrete catalog or quote line. */
export function commercialQuoteV3LineTargetKeys(line: CommercialQuoteV3RuleTargetLine): string[] {
  return [
    ...(line.targetType === 'PRODUCT' ? [productCodeKey(line.targetCode)] : []),
    ...(line.targetType === 'BUNDLE' ? [bundleCodeKey(line.targetCode)] : []),
    ...(line.productKind !== 'BUNDLE' ? [productKindKey(line.productKind)] : []),
  ]
}

export function commercialQuoteV3RuleTargetsLine(
  rule: CommercialCampaignRuleV2,
  line: CommercialQuoteV3RuleTargetLine,
): boolean {
  return Boolean(
    (line.targetType === 'PRODUCT' && rule.target.productCodes?.includes(line.targetCode)) ||
      (line.targetType === 'BUNDLE' && rule.target.bundleCodes?.includes(line.targetCode)) ||
      (line.productKind !== 'BUNDLE' && rule.target.productKinds?.includes(line.productKind)),
  )
}
