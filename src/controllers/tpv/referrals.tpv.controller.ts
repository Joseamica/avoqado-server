/**
 * Referral program capture endpoints under `/tpv` (superficie /tpv, 2026-07-27).
 *
 * Re-exports VERBATIM the three referral-capture handlers the dashboard already uses
 * (`validate`, `captureCode`, `forceOverride`) — same services, same response shape — so the
 * TPV's Retrofit DTOs (`ReferralValidateResponse` / `ReferralCaptureResponse` in
 * avoqado-tpv/ReferralsApiService.kt) keep parsing byte-identical; only the URL prefix moves
 * from `/dashboard` to `/tpv`. Same re-export pattern as `menu.tpv.controller.ts`'s
 * `getProducts` (Task 5) — reusing the handler (not reimplementing it) guarantees parity
 * forever and avoids duplicating `referralCapture.service`'s logic (incl. its own
 * `ActivityLog` writes for capture/force-override — no second audit layer needed here).
 *
 * Deliberately narrow: only these three are exposed here — NOT the rest of the referrals
 * surface (config, summary, hall-of-fame, listing, manual-void, courtesy fulfillment). A
 * terminal mid-sale has no business reading program configuration or aggregate stats; a
 * smaller surface is the point of the /tpv isolation. See src/routes/tpv.routes.ts for the
 * routes and `.claude/rules` for why /tpv must stop calling `/dashboard/*` entirely.
 */
export { validate, captureCode, forceOverride } from '../dashboard/referrals/referrals.controller'
