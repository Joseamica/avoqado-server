import {
  createCommercialStripeCheckoutService,
  prismaCommercialStripeCheckoutRepository,
} from '@/services/commercial/commercialStripeCheckout.service'
import { commercialStripeGateway } from '@/services/commercial/commercialStripeGateway.service'
import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'
import { env } from '@/config/env'

export const commercialStripeCheckoutService = createCommercialStripeCheckoutService({
  repository: prismaCommercialStripeCheckoutRepository,
  gateway: commercialStripeGateway,
  assertCheckoutAllowed: () => assertCommercialV2CheckoutActive(env.COMMERCIAL_V2_CHECKOUT_MODE),
})
