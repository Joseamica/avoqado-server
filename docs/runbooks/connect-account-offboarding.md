# Stripe Connect Offboarding Runbook

Use this when a venue stops using Avoqado online reservation payments.

## Immediate action

1. Disable new online charges:
   `POST /api/v1/dashboard/superadmin/stripe-connect/venues/:venueId/offboard-payments`
2. Confirm the response lists:
   - `openDisputes`
   - `refundsInFlight`
   - `paidDeposits`
   - retained `acct_...` ids
3. Do not delete `providerCredentials.connectAccountId` or `providerMerchantId`.

## Retention window

Keep the Stripe connected account id in Avoqado for at least 180 days after the final paid reservation or final payout, whichever is later. Disputes can arrive after the venue has stopped taking new bookings.

## Pending money

- Existing paid deposits must still support refunds.
- Open disputes stay routed by `providerMerchantId`.
- If Stripe debits Avoqado because the connected account has insufficient balance, recover from the venue under the signed ToS.

## Final close

Only mark the offboarding complete manually after:

- No `Reservation.depositStatus = DISPUTED`
- No `Reservation.refundStatus = PENDING`
- No unsettled paid deposits requiring support action
- Stripe Dashboard shows no pending balance or unresolved requirements

Stripe account deletion is not performed by Avoqado. The venue must handle account closure from Stripe's hosted dashboard.
