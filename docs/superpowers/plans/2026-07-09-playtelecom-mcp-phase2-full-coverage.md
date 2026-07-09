# PlayTelecom MCP — Phase 2: full WL-dashboard coverage

Wrap the remaining PlayTelecom dashboard reads (both WL scopes: org `/wl/organizations` + venue `/wl/venues`) as MCP tools, closing the ~10 gaps found in the 2026-07-09 coverage audit. Almost all backing service fns already exist (clean, reusable). Reads only. Same gating discipline as Phase 1.

## Global constraints
- Repo `avoqado-server`. Git READ-ONLY (no commits). TDD test-first. `npx jest <path>` for single files.
- Registration: serialized/stock/cash-out/sim tools under `serializedEnabled`; white-label ops (attendance, promoters, org analytics) under `whiteLabelEnabled`. Every tool keeps a call-time gate (module + scope + permission). Money pesos major units, dates venue-local.
- New tools files: `src/mcp/tools/whiteLabelOps.ts` (attendance + org analytics + deposits, registered under `whiteLabelEnabled`). Add stock/sim tools to `serialized.ts`; cash-out changes in `cash-out.ts`.
- Do NOT wire `getStaffAttendanceCalendar` (service ignores orgId — no self-scoping; covered by heatmap/promoter_detail instead).

## Batch A — Cash Out venue overrides (🔴 fixes wrong-answer) — `cash-out.ts`
Extend the two existing org tools with an optional `venueId`:
- `cash_out_org_commission_rates({ venueId? })` → when `venueId` given, return the EFFECTIVE table via `resolveRatesForVenue(venueId)` (venue rows else org); when omitted, current `listCommissionRatesForOrg` (org). Gate `cash-out:read`.
- `cash_out_org_active_days({ venueId? })` → same, via `resolveActiveDaysForVenue(venueId)`.
- Backing (exist, `cash-out.config.service.ts`): `resolveRatesForVenue(venueId): RateTier[]` (line ~261), `resolveActiveDaysForVenue(venueId): string[]` (line ~248).
- Preserve the org path exactly; add venueId branch. Update descriptions to say "pass venueId for the effective table of one store (its override, else the org default)."

## Batch B — Serialized stock ops (venue) — `serialized.ts` (serializedEnabled)
All gate `guard.venueFilter(venueId)` + `inventory:read` + `moduleService.isModuleEnabled(venueId, SERIALIZED_INVENTORY)`. Backing in `stockDashboard.service.ts`:
- `serialized_low_stock` → `stockDashboardService.getLowStockAlerts(venueId)` → `{categoryName, currentStock, minimumStock, alertLevel}` (per StockAlertConfig). Answers "¿qué tipo de SIM se está acabando?" (fixes the empty `low_stock`).
- `serialized_stock_movements` → `getRecentMovements(venueId, limit=20, {dateFrom?,dateTo?,responsibleStaffId?})` → live feed (REGISTERED/SOLD/RETURNED/DAMAGED/BULK_UPLOAD).
- `serialized_stock_trend` → `getStockVsSales(venueId, days=14)` → `[{date, stockLevel, salesCount}]`.
- `serialized_stock_metrics` → `getMetrics(venueId)` (stock KPIs: value, sold today/week). VERIFY the exact fn name in stockDashboard.service before building; if absent, skip metrics.

## Batch C — SIM approval queues (org) — `serialized.ts`
- `sim_pending_approvals({ queue: 'registration'|'stock', limit?, cursor?, search? })`. Gate: org-permission `sim-custody:approve-registration` (mirror the route). Backing `simRegistration.service.ts` (class `SimRegistrationService`): queue='registration' → `listPending(orgId)` (+ `countPending`); queue='stock' → `listPendingStockApprovals(orgId, {cursor,limit,search})` (+ `countPendingStockApprovals`). Resolve org via `scope.activeOrg`.

## Batch D — Promoter deposits (venue) — `whiteLabelOps.ts` (whiteLabelEnabled)
- `promoter_deposits({ venueId, promoterId, status? })`. Gate `guard.venueFilter(venueId)` + `teams:read` + WHITE_LABEL_DASHBOARD module. Backing `promoters.service.ts`: `getPromoterDeposits(venueId, promoterId, status?: CashDepositStatus)` → `[{amount, method, timestamp, status, rejectionReason, voucherImageUrl}]`. `CashDepositStatus = PENDING|APPROVED|REJECTED`.

## Batch E — Attendance / presence (org+venue) — `whiteLabelOps.ts` (whiteLabelEnabled)
Gate `teams:read` (staff-sensitive). Org-level tools use `scope.activeOrg` + an org-permission helper (like requireReviewAccess but `teams:read`); venue tools use `guard.venueFilter` + `teams:read` + WL module. Backing `organizationDashboard.service.ts` + `promoters.service.ts`:
- `staff_attendance({ venueId?, date?, statusFilter?, fromDate?, toDate? })` → `getStaffAttendance(orgId, date?, venueId?, statusFilter?, start?, end?)`. Answers "¿quién llegó/faltó/tarde hoy?".
- `staff_online({})` → `getOnlineStaff(orgId)` → `{onlineCount,totalCount,byVenue,onlineStaff}`. "¿quién está trabajando ahora?" (NOTE: counts CASHIER/WAITER only = promoters; server-local midnight — document in the tool description).
- `attendance_heatmap({ fromDate, toDate, venueId? })` → `getAttendanceHeatmap(orgId, from, to, scope.role, scope.staffId, venueId?)`. Max 90-day range (it throws a plain Error if exceeded — catch → friendly message). Needs the caller's effective role — use the max role across `scope.perVenueAccess` for the org (or SUPERADMIN flag).
- `promoter_detail({ venueId, promoterId })` → `promotersService.getPromoterDetail(venueId, promoterId)` → profile + todayMetrics + checkIn + attendance days. Venue-level + WL module.

## Batch F — Org analytics (org+venue) — `whiteLabelOps.ts` (whiteLabelEnabled)
Gate `teams:read` at org level (mix of sales+attendance). Backing `organizationDashboard.service.ts` + `commandCenter.service.ts`:
- `sales_vs_target({ metric: 'revenue'|'volume', venueId? })` → `getRevenueVsTarget(orgId, venueId?)` / `getVolumeVsTarget(orgId, venueId?)` → `{days:[{day,actual,target,date}], weekTotal}`. "¿cómo vamos contra la meta de la semana?"
- `store_anomalies({})` → `getCrossStoreAnomalies(orgId)` → `[{type,severity,storeName,title,description}]` (NO_CHECKINS/LOW_STOCK/PENDING_DEPOSITS/GPS_VIOLATION). "¿alguna tienda con algo raro?"
- `org_insights({})` → `{ topPromoter: getTopPromoter(orgId), worstAttendance: getWorstAttendance(orgId) }`. "¿mejor promotor hoy? ¿peor asistencia?"
- `store_sales_trend({ venueId, days? })` → `commandCenterService.getStockVsSales(venueId, {days})` → `{trend:[{date,sales,units,transactions}], comparison}`. Per-store sales time series. (Different fn/shape from `serialized_stock_trend` — do not conflate.)

## Registration wiring — `server.ts`
Add `registerWhiteLabelOpsTools` under `if (flags.whiteLabelEnabled)`. Stock/sim additions ride the existing `registerSerializedTools` (serializedEnabled); cash-out changes ride `registerCashOutTools`. Add conditional-registration test assertions for one tool per new group (present when flag on, absent when off).

## Testing
Per tool: module/permission gate returns the gated error; happy path calls the backing fn with mapped args + returns shaped result. Mirror existing tool tests. Then full `npm run test:unit` + tsc + lint. Live smoke (psql) on the sharpest ones (cash-out venue effective table; serialized_low_stock) against av-db-25 PlayTelecom.

## Notes / risks (from audit + mapping)
- `getOnlineStaff` uses server-local midnight (not venue tz) + counts only CASHIER/WAITER — document, don't "fix" here.
- `getStaffAttendanceCalendar` NOT wired (no org self-scoping).
- `serialized_stock_metrics` conditional on the fn existing.
- Tool-count: this adds ~14 tools; keep descriptions crisp to help model selection.
