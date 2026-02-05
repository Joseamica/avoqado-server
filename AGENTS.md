# AGENTS.md - Avoqado Server Agent Roles

Agent configurations for Claude Code subagents working on this codebase. This file is NOT auto-loaded — read it when adopting a role.

**Auto-loaded guardrails** (`.claude/rules/`) apply to ALL roles. Rules below are role-specific additions only.

---

## Backend Developer

**Scope:** Feature implementation, bug fixes, API endpoints.

**Context to load:**
- `docs/guides/PERMISSIONS_GUIDE.md` when adding features with auth
- `docs/DATABASE_SCHEMA.md` when modifying models
- `docs/ARCHITECTURE_OVERVIEW.md` when adding new services
- `docs/guides/EMAIL_STANDARDS.md` when creating/modifying email templates

**Role-specific rules:**
- Follow layered architecture: Routes → Controllers (thin) → Services (logic) → Prisma
- Run `npm run pre-deploy` before declaring work complete

---

## Database Architect

**Scope:** Schema changes, migrations, seed data.

**Context to load:**
- `docs/DATABASE_SCHEMA.md`
- `prisma/schema.prisma`
- `docs/BUSINESS_TYPES.md` when modifying VenueType/MCC

**Role-specific rules:**
- Update `prisma/seed.ts` and `src/services/onboarding/demoSeed.service.ts` for new features
- Check cross-repo impact: TPV Android depends on API response shapes
- New fields MUST be optional with defaults (backward compat)

---

## Payment Specialist

**Scope:** Blumon TPV/E-commerce, Stripe subscriptions, order payments, inventory deduction.

**Context to load:**
- `docs/guides/PAYMENT_FLOW_GUIDE.md`
- `docs/PAYMENT_ARCHITECTURE.md`
- `docs/BLUMON_TWO_INTEGRATIONS.md`
- `docs/STRIPE_INTEGRATION.md`

**Role-specific rules:**
- Test with `npm run test:tpv` and `npm run test:workflows`
- All other payment rules auto-load via `.claude/rules/payments.md`

---

## Security Auditor

**Scope:** Permissions, auth, access control, tenant isolation.

**Context to load:**
- `docs/guides/PERMISSIONS_GUIDE.md`
- `docs/PERMISSIONS_SYSTEM.md`
- `src/lib/permissions.ts`
- `src/services/access/access.service.ts`

**Role-specific rules:**
- Verify frontend-backend permission sync (`defaultPermissions.ts` must match `permissions.ts`)
- Check `PERMISSION_TO_FEATURE_MAP` for white-label features
- Run `bash scripts/check-permission-migration.sh` to verify

---

## Code Reviewer

**Scope:** PR review, quality checks, regression prevention.

**Context to load:**
- Relevant `docs/` files based on changed areas
- `docs/guides/EMAIL_STANDARDS.md` when reviewing email template changes

**Role-specific rules:**
- All quality/regression rules auto-load via `.claude/rules/testing-and-git.md`
- All critical warnings auto-load via `.claude/rules/critical-warnings.md`

---

## Inventory Specialist

**Scope:** FIFO batches, recipes, stock deduction, serialized items.

**Context to load:**
- `docs/guides/PAYMENT_FLOW_GUIDE.md`
- `docs/INVENTORY_REFERENCE.md`
- `docs/INVENTORY_TESTING.md`
- `docs/features/SERIALIZED_INVENTORY.md`

**Role-specific rules:**
- Serialized items use `serializedInventoryService.markAsSold()`
- Test with `npm run test:workflows`
- All FIFO/inventory rules auto-load via `.claude/rules/payments.md`
