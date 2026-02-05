# Login & Invitation Scenarios - Complete Reference

This document covers ALL possible login and invitation scenarios in Avoqado.

## Table of Contents
1. [Login Methods](#1-login-methods)
2. [Login Scenarios by User State](#2-login-scenarios-by-user-state)
3. [Invitation Types](#3-invitation-types)
4. [Invitation Acceptance Scenarios](#4-invitation-acceptance-scenarios)
5. [Edge Cases & Error Handling](#5-edge-cases--error-handling)
6. [Test Coverage](#6-test-coverage)

---

## 1. Login Methods

| Method | Service | Who Can Use |
|--------|---------|-------------|
| Email + Password | `auth.service.ts` | Regular users with password |
| Google OAuth | `googleOAuth.service.ts` | Users with Google account |
| Google One Tap | `googleOAuth.service.ts` | Users with Google account |
| TOTP (8-digit code) | `auth.service.ts` | SUPERADMIN only (`master@avoqado.io`) |
| PIN | `auth.tpv.service.ts` | TPV-only staff (terminal access only) |

---

## 2. Login Scenarios by User State

### 2.1 Normal User with Venues

| Scenario | Result | Token venueId |
|----------|--------|---------------|
| User has 1 venue | Login OK, selects that venue | `venue-id` |
| User has N venues | Login OK, selects first venue | First venue's ID |
| User has N venues + specifies venueId | Login OK, selects specified venue | Specified venue ID |
| User specifies venueId they don't have access to | **ERROR**: "No tienes acceso a este establecimiento" | N/A |

#### Smart Venue Selection (Stripe/Shopify Pattern)

**Frontend redirect logic after login:**

```typescript
// In AuthContext loginMutation.onSuccess
const getSmartVenue = () => {
  // 1. Check localStorage for last used venue
  const lastUsedSlug = localStorage.getItem('avoqado_current_venue_slug')
  if (lastUsedSlug) {
    const lastUsedVenue = userVenues.find(v => v.slug === lastUsedSlug)
    if (lastUsedVenue) return lastUsedVenue
  }

  // 2. Fall back to highest-role venue
  const roleHierarchy = { SUPERADMIN: 100, OWNER: 90, ADMIN: 80, ... }
  return userVenues.sort((a, b) =>
    roleHierarchy[b.role] - roleHierarchy[a.role]
  )[0]
}
```

**Key behaviors:**
- `avoqado_current_venue_slug` persists across logout (NOT cleared by `clearAllChatStorage()`)
- Venues switcher saves current venue to localStorage when user changes venue
- On login, user returns to their last used venue (if still has access)
- Falls back to highest-role venue if last used venue no longer accessible

### 2.2 OWNER Without Venues

| Scenario | Result | Token venueId |
|----------|--------|---------------|
| OWNER + onboarding NOT completed | Login OK, redirect to onboarding | `"pending"` |
| OWNER + onboarding completed + pending invitations | Login OK + `pendingInvitations[]` | `"pending-invitation"` |
| OWNER + onboarding completed + NO invitations | **ERROR**: NO_VENUE_ACCESS | N/A |

**Note**: OWNER is detected by `staff.email === organization.email` (primary owner created during signup)

### 2.3 Non-OWNER Without Venues

| Scenario | Result | Token venueId |
|----------|--------|---------------|
| Has pending invitations | Login OK + `pendingInvitations[]` | `"pending-invitation"` |
| NO pending invitations | **ERROR**: NO_VENUE_ACCESS | N/A |

### 2.4 SUPERADMIN (TOTP Login)

| Scenario | Result |
|----------|--------|
| Valid TOTP code | Login OK as synthetic `MASTER_ADMIN` user |
| Invalid TOTP code | **ERROR**: "Codigo invalido o expirado" |
| TOTP_MASTER_SECRET not configured | **ERROR**: "Sistema de autenticacion no configurado" |

### 2.5 Account State Issues

| Scenario | Result |
|----------|--------|
| Account locked (lockedUntil > now) | **ERROR**: "Account temporarily locked... try again in X minutes" |
| Lock expired (lockedUntil < now) | Login OK (lock cleared) |
| Wrong password (attempts < 5) | **ERROR**: "Correo electronico o contrasena incorrectos" + increment attempts |
| Wrong password (attempts >= 5) | **ERROR**: "Account locked" + set lockedUntil = now + 60 min |
| Email not verified | **ERROR**: "Please verify your email before logging in" |
| Account inactive (active = false) | **ERROR**: "Tu cuenta esta desactivada" |
| User not found | **ERROR**: "Correo electronico o contrasena incorrectos" |
| User has no password (Google-only) | **ERROR**: "Correo electronico o contrasena incorrectos" |

### 2.6 Venue Status & Demo Venues

#### VenueStatus Categories

```typescript
// src/lib/venueStatus.constants.ts

// Can login and process payments
OPERATIONAL_VENUE_STATUSES = [
  LIVE_DEMO,           // Public anonymous demo
  TRIAL,               // Private 30-day trial
  ONBOARDING,          // Setting up (KYC pending)
  PENDING_ACTIVATION,  // KYC complete, awaiting payment setup
  ACTIVE,              // Fully operational
]

// Cannot login (except SUPERADMIN)
NON_OPERATIONAL_VENUE_STATUSES = [
  SUSPENDED,           // Payment issues, user-initiated pause
  ADMIN_SUSPENDED,     // Avoqado admin action (fraud, TOS violation)
  CLOSED,              // Permanently closed
]

// Can be hard deleted (fake data)
DEMO_VENUE_STATUSES = [LIVE_DEMO, TRIAL]

// Cannot be deleted (SAT compliance - Mexican tax law)
PRODUCTION_VENUE_STATUSES = [ONBOARDING, PENDING_ACTIVATION, ACTIVE, SUSPENDED, ADMIN_SUSPENDED, CLOSED]
```

#### Live Demo (demo.dashboard.avoqado.io)

Anonymous public demo with auto-created venue:

```
Browser visits demo.dashboard.avoqado.io
        │
        ▼
┌─────────────────────────────────────┐
│ Check sessionId cookie              │
└─────────────────────────────────────┘
        │
   ┌────┴────┐
   │         │
   ▼         ▼
Exists?    New session
   │              │
   ▼              ▼
Return      Create:
existing    - Organization (shared)
tokens      - Venue (status: LIVE_DEMO)
            - Staff (no password)
            - StaffVenue (OWNER)
            - Seed demo data
            - Enable ALL features (free)
            - Generate tokens
            - Session expires in 5 hours
```

| Aspect | Behavior |
|--------|----------|
| Authentication | Auto-login, no password |
| Staff email | `demo-{timestamp}@livedemo.avoqado.io` |
| Role | OWNER |
| Features | ALL enabled (free) |
| Duration | 5 hours of inactivity |
| Cleanup | Auto-deleted by cron job |
| KYC | Auto-verified |

#### Trial Venue (Onboarding Demo)

Private demo for registered users during onboarding:

| Aspect | Behavior |
|--------|----------|
| Created when | User completes signup |
| Status | `TRIAL` |
| Duration | 30 days |
| Features | Based on selected plan (trial) |
| Data | Seeded demo data |
| After trial | Convert to ACTIVE (paid) or SUSPENDED |

#### Login Behavior by VenueStatus

| User's Venues | Login Result |
|---------------|--------------|
| Only ACTIVE venues | Login OK |
| Only TRIAL venues | Login OK |
| Only LIVE_DEMO venues | Login OK (anonymous demo) |
| Only ONBOARDING venues | Login OK |
| Only SUSPENDED venues | **ERROR**: NO_VENUE_ACCESS |
| Only CLOSED venues | **ERROR**: NO_VENUE_ACCESS |
| Mix of ACTIVE + SUSPENDED | Login OK (only ACTIVE shown) |
| SUPERADMIN + any status | Login OK (sees ALL venues) |

#### Venue Status Transitions

```
                    ┌─────────────┐
                    │  LIVE_DEMO  │ ─── cleanup ───► (deleted)
                    └─────────────┘

┌──────────┐      ┌─────────────┐      ┌───────────────────┐
│  TRIAL   │ ───► │ ONBOARDING  │ ───► │ PENDING_ACTIVATION│
└──────────┘      └─────────────┘      └───────────────────┘
     │                   │                      │
     │                   │                      │
     ▼                   ▼                      ▼
(deleted)          ┌──────────┐           ┌──────────┐
                   │  ACTIVE  │◄──────────┤  ACTIVE  │
                   └──────────┘           └──────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   ┌───────────┐  ┌───────────────┐  ┌────────┐
   │ SUSPENDED │  │ADMIN_SUSPENDED│  │ CLOSED │
   └───────────┘  └───────────────┘  └────────┘
          │             │
          └──────┬──────┘
                 ▼
           ┌──────────┐
           │  ACTIVE  │ (reactivation)
           └──────────┘
```

### 2.7 Venue Status Change Edge Cases

What happens when a venue's status changes while user is logged in or between sessions:

| Scenario | Behavior |
|----------|----------|
| User logged in, venue becomes SUSPENDED | Token still works until expiry, then NO_VENUE_ACCESS |
| User has access token for SUSPENDED venue | API calls may still work (depends on endpoint) |
| User refreshes token for SUSPENDED venue | Refresh fails, must re-login |
| User's only venue deleted (LIVE_DEMO cleanup) | NO_VENUE_ACCESS on next login |
| TRIAL expires, becomes SUSPENDED | User sees "trial expired" message, must upgrade |
| Venue reactivated (SUSPENDED → ACTIVE) | User can login normally again |

**Token + Venue Status Check:**

```typescript
// Most endpoints check venue status via middleware
// But token itself doesn't auto-invalidate when venue status changes

// Good practice: Always check venue status on sensitive operations
const venue = await prisma.venue.findUnique({ where: { id: venueId } })
if (!isVenueOperational(venue.status)) {
  throw new ForbiddenError('Venue is not operational')
}
```

### 2.8 Multi-Venue Navigation (Post-Login)

**The Problem:** JWT token contains fixed `venueId` and `role` from login time. User navigates to different venue where they have a different role.

**The Solution:** Backend `checkPermission` middleware dynamically looks up role:

```typescript
// In checkPermission.middleware.ts
const urlVenueId = req.params.venueId
const venueId = urlVenueId || authContext.venueId

let userRole: StaffRole
if (urlVenueId && urlVenueId !== authContext.venueId) {
  // Look up user's ACTUAL role in the target venue
  const staffVenue = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId: authContext.userId, venueId: urlVenueId } }
  })

  if (!staffVenue) {
    return 403 // No access to this venue
  }

  userRole = staffVenue.role  // Use actual role, not token role
} else {
  userRole = authContext.role  // Same venue, use token role
}
```

**Example scenario:**
```
User logged in → Token has venueId=A, role=CASHIER
User navigates to /venues/B/features
→ Backend checks: User's role in venue B is ADMIN
→ Permission check uses ADMIN role (not CASHIER)
→ Access granted
```

| Navigation Scenario | Token Role | Actual Role | Result |
|---------------------|------------|-------------|--------|
| Same venue as token | ADMIN | ADMIN | Use token role |
| Different venue, user is OWNER | CASHIER | OWNER | Use OWNER role |
| Different venue, no access | ADMIN | - | **403 Forbidden** |

---

## 3. Invitation Types

### 3.1 By Delivery Method

| Type | Email | PIN | Dashboard Access | TPV Access | Status After Creation |
|------|-------|-----|------------------|------------|----------------------|
| **Con correo** (email) | Real email | Optional | Yes | Yes | `PENDING` |
| **Solo TPV** (tpv-only) | Placeholder `@internal.avoqado.io` | Required | No | Yes | `ACCEPTED` immediately |

### 3.2 TPV-Only Details

```
Email format: tpv-{venueSlug}-{timestamp}-{random}@internal.avoqado.io
Example: tpv-mi-restaurante-1704067200000-abc123@internal.avoqado.io
```

- Staff created immediately with PIN
- StaffVenue created immediately with PIN
- Invitation marked as ACCEPTED immediately
- **Cannot login to dashboard** (no password)
- **Can only login to TPV** with PIN

### 3.3 By Permission Level (InvitationType enum)

| Type | Description |
|------|-------------|
| `ORGANIZATION_ADMIN` | Admin for entire organization |
| `VENUE_STAFF` | Staff for specific venue (default) |
| `VENUE_ADMIN` | Admin for specific venue |

### 3.4 OWNER Invitations with `inviteToAllVenues`

When creating an invitation for OWNER role, you can set `inviteToAllVenues: true`:

```typescript
// Request to POST /api/v2/dashboard/venues/{venueId}/team/invite
{
  email: "nuevo-owner@example.com",
  firstName: "Nuevo",
  lastName: "Owner",
  role: "OWNER",
  inviteToAllVenues: true  // Only works for OWNER role
}
```

**Creation Logic:**

```typescript
// In team.dashboard.service.ts
const shouldInviteToAllVenues = request.inviteToAllVenues && request.role === StaffRole.OWNER

// For TPV-only: Creates StaffVenue for ALL org venues immediately
// For email: Stores flag in permissions JSON, applied on acceptance
permissions: shouldInviteToAllVenues ? { inviteToAllVenues: true } : undefined
```

| Role | inviteToAllVenues | Result |
|------|-------------------|--------|
| OWNER | `true` | Creates/updates StaffVenue for ALL venues in org |
| OWNER | `false` | Creates StaffVenue for invitation venue only |
| ADMIN | `true` | **Ignored** - only applies to OWNER |
| CASHIER | `true` | **Ignored** - only applies to OWNER |

---

## 4. Invitation Acceptance Scenarios

### 4.1 User State When Accepting

| User State | Frontend Shows | Backend Behavior |
|------------|----------------|------------------|
| Not logged in + new user | Password creation form | Creates Staff, StaffOrg, StaffVenue |
| Not logged in + existing user with password | Password verification form | Verifies password, adds StaffVenue |
| Logged in + same email as invitation | "Direct Accept" button | Just adds StaffVenue |
| Logged in + different email | "Email Mismatch Warning" | Must logout first |

### 4.2 Detailed Flows

#### A) New User (no account exists)

```
1. Open /invite/{token}
2. See password creation form
3. Enter firstName, lastName, password, (optional PIN)
4. Backend creates:
   - Staff record
   - StaffOrganization membership
   - StaffVenue relationship
5. Mark invitation as ACCEPTED
6. Generate tokens, auto-login
7. Redirect to dashboard
```

#### B) Existing User with Password (not logged in)

```
1. Open /invite/{token}
2. Backend detects userAlreadyHasPassword = true
3. See password verification form (not creation)
4. Enter existing password
5. Backend verifies password (bcrypt compare)
6. Backend creates StaffVenue relationship
7. Mark invitation as ACCEPTED
8. Generate tokens, auto-login
9. Redirect to dashboard
```

#### C) Logged In with Same Email

```
1. Open /invite/{token}
2. Frontend detects session email === invitation email
3. See "Direct Accept" UI
4. Click accept button
5. Backend creates StaffVenue relationship
6. Mark invitation as ACCEPTED
7. Refresh auth status
8. Redirect to dashboard (now has new venue)
```

#### D) Logged In with Different Email

```
1. Open /invite/{token}
2. Frontend detects session email !== invitation email
3. See "Email Mismatch Warning"
4. Options:
   a) Logout → Returns to scenario A or B
   b) Cancel → Go back
5. CANNOT accept invitation for different email while logged in
```

### 4.3 Cross-Organization Invitations

| Scenario | Result |
|----------|--------|
| User exists in Org A, invited to Org B | Creates new StaffOrganization for Org B |
| User already in this venue | Updates existing StaffVenue (role, PIN) |
| PIN already used in venue | **ERROR**: "PIN no disponible" |

### 4.4 OWNER Invitations (Special Handling)

When someone is invited with `role: OWNER`:

| Aspect | Behavior |
|--------|----------|
| OrgRole assigned | `OrgRole.OWNER` (not MEMBER) |
| `inviteToAllVenues` flag | If `true`, assigns to ALL org venues |
| PIN assignment | Only on primary venue (invitation.venueId) |

**inviteToAllVenues Flow:**

```
1. Invitation created with permissions: { inviteToAllVenues: true }
2. User accepts invitation
3. Backend fetches ALL venues in organization
4. Creates StaffVenue for EACH venue with OWNER role
5. PIN only set on the primary venue (invitation.venueId)
```

**Example: Inviting a new OWNER to org with 5 venues:**

```typescript
// Invitation
{
  email: "nuevo-owner@example.com",
  role: "OWNER",
  organizationId: "org-123",
  venueId: "venue-1",  // Primary venue
  permissions: { inviteToAllVenues: true }
}

// Result after acceptance:
// - StaffOrganization: { role: OWNER, isPrimary: true }
// - StaffVenue × 5: { role: OWNER } for each venue
```

### 4.5 Organization-Level Invitations (No Venue)

When `invitation.venueId` is `null`:

| Aspect | Behavior |
|--------|----------|
| StaffVenue created? | **No** - user has org membership only |
| StaffOrganization created? | Yes, with appropriate OrgRole |
| Access Token generated? | Only if user has other venues |
| Post-accept state | User may have org access but no venue dashboard |

**When to use:**

- Inviting an organization admin who will later be assigned to specific venues
- ORGANIZATION_ADMIN invitation type
- Cross-org scenarios where venue assignment happens separately

**Token generation logic:**

```typescript
// If invitation.venueId is null:
if (!venueId) {
  // Find user's first venue assignment (from previous invitations)
  const firstVenueAssignment = await findFirst(staffVenue)

  if (firstVenueAssignment) {
    // Use that venue for access token
    venueId = firstVenueAssignment.venueId
  } else {
    // No venues at all - accessToken will be null
    // User redirected to pending state or invitation flow
  }
}
```

### 4.6 Cross-Org Invitation Details

When existing user in Org A accepts invitation to Org B:

| Aspect | Behavior |
|--------|----------|
| Detects cross-org | `existingStaffOrgId !== invitation.organizationId` |
| Creates StaffOrganization | Yes, with `isPrimary: false` |
| OrgRole determination | OWNER invitation → `OrgRole.OWNER`, else derived from existing roles |
| Password verification | Required (existing user) |
| Password overwrite | **Never** - existing credentials preserved |

**OrgRole derivation for non-OWNER cross-org:**

```typescript
if (invitation.role === StaffRole.OWNER) {
  orgRoleForCrossOrg = OrgRole.OWNER
} else {
  // Check existing venue roles
  const venueRoles = existingStaff.venues.map(v => v.role)

  if (venueRoles.includes(OWNER) || venueRoles.includes(ADMIN)) {
    orgRoleForCrossOrg = OrgRole.ADMIN
  } else {
    orgRoleForCrossOrg = OrgRole.MEMBER
  }
}
```

### 4.7 Existing User Edge Cases

| Scenario | Behavior |
|----------|----------|
| User has password, provides correct | Verification OK, add to venue |
| User has password, provides wrong | **ERROR**: "Contrasena incorrecta" |
| User has password, doesn't provide | **ERROR**: "Se requiere contrasena para verificar" |
| User has no password (PIN-only upgrade) | Accept new password, add to venue |
| User's name already set | Name NOT overwritten |
| User's password already set | Password NOT overwritten |

### 4.8 Deactivated User Re-Invitation (Edge Case)

**Scenario:** User was OWNER in a venue, got deactivated, then re-invited with different role.

```
Timeline:
─────────────────────────────────────────────────────────────────────────►

1. Maria is OWNER in "Taqueria El Sol"
   StaffVenue: { role: OWNER, active: true }

2. Admin deactivates Maria (left the company)
   StaffVenue: { role: OWNER, active: false }

3. New admin invites maria@example.com as CASHIER
   → Check: Is active? NO → Invitation ALLOWED

4. Maria accepts invitation
   → StaffVenue.update({ role: CASHIER, active: true })
   → Maria is now CASHIER (DOWNGRADED from OWNER!)
```

**Why this happens:**

| Check | Location | What it validates |
|-------|----------|-------------------|
| Creation | `team.dashboard.service.ts:422` | Only blocks if `active: true` |
| Acceptance | `invitation.service.ts:334` | Overwrites role, no hierarchy check |

**Current behavior:**

| User State | Invitation | Creation | Acceptance |
|------------|------------|----------|------------|
| OWNER (active) | CASHIER | **BLOCKED** | - |
| OWNER (inactive) | CASHIER | Allowed | **Role overwritten to CASHIER** |
| CASHIER (inactive) | OWNER | Allowed | Role upgraded to OWNER |

**Note:** This is a rare edge case. Multi-venue different roles (OWNER in venue A, CASHIER in venue B) is completely normal and expected.

**Potential fix (not implemented):**

```typescript
// On acceptance, compare role hierarchy and keep higher role
const roleHierarchy = { OWNER: 90, ADMIN: 80, MANAGER: 70, CASHIER: 60, ... }
const currentRank = roleHierarchy[existingAssignment.role] || 0
const newRank = roleHierarchy[invitation.role] || 0
const finalRole = newRank >= currentRank ? invitation.role : existingAssignment.role
```

### 4.9 Post-Acceptance Token States

| Scenario | accessToken | refreshToken | Frontend Behavior |
|----------|-------------|--------------|-------------------|
| Invitation has venueId | ✅ Generated | ✅ Generated | Redirect to venue dashboard |
| No venueId, user has other venues | ✅ (first venue) | ✅ Generated | Redirect to first venue |
| No venueId, user has no venues | ❌ null | ✅ Generated | Redirect to pending/invitation flow |

---

## 5. Edge Cases & Error Handling

### 5.1 Invitation Errors

| Scenario | HTTP Status | Error Message |
|----------|-------------|---------------|
| Token not found | 404 | "Invitacion no encontrada o ya utilizada" |
| Invitation already used | 404 | "Invitacion no encontrada o ya utilizada" |
| Invitation expired | 410 | "La invitacion ha expirado" |
| PIN already in use | 409 | "PIN no disponible" |
| Missing required fields (new user) | 400 | "Se requiere nombre, apellido y contrasena" |
| Wrong password (existing user) | 401 | "Contrasena incorrecta" |
| Existing user didn't provide password | 400 | "Se requiere contrasena para verificar tu identidad" |

### 5.2 pendingInvitations Feature

**When is `pendingInvitations` returned?**

```typescript
// Only when ALL conditions are true:
1. staff.venues.length === 0  // No active venues
2. !hasOwnerRole || organization.onboardingCompletedAt  // Not OWNER with pending onboarding
3. pendingInvitations.length > 0  // Has pending invitations
```

**What's included in pendingInvitations?**

```typescript
{
  id: string
  token: string
  role: string
  venueId: string | null
  venueName: string | null
  organizationId: string
  organizationName: string
  expiresAt: string (ISO)
}
```

**Frontend handling:**

```typescript
// In AuthContext loginMutation.onSuccess:
if (data?.pendingInvitations?.length > 0) {
  // Show toast about invitation
  // Redirect to /invite/{firstInvitation.token}
}
```

### 5.3 TPV-Only Staff Edge Cases

| Scenario | Result |
|----------|--------|
| TPV-only tries dashboard login | **ERROR**: No password set |
| TPV-only tries Google login | Not possible (email is placeholder) |
| TPV-only has pending invitations | N/A - invitations are ACCEPTED immediately |
| Check `isTPVOnlyEmail()` | Returns `true` for `tpv-*@internal.avoqado.io` |

### 5.4 Google OAuth vs Email/Password Differences

| Aspect | Email/Password | Google OAuth |
|--------|----------------|--------------|
| Filters venues by OPERATIONAL status | Yes | **No** (potential inconsistency) |
| SUPERADMIN sees all venues | Yes | N/A (SUPERADMIN uses TOTP) |
| New user without invitation | Not possible | **ERROR**: NO_VENUE_ACCESS |
| New user with invitation | Creates from invitation | Creates from invitation |

---

## 6. Test Coverage

### 6.1 Backend Tests (24 scenarios)

File: `tests/unit/services/auth.login.scenarios.test.ts`

| # | Scenario | Status |
|---|----------|--------|
| 1 | Normal login with venues | ✅ |
| 2 | Login with specific venueId | ✅ |
| 3 | OWNER without venues + onboarding incomplete | ✅ |
| 4 | OWNER without venues + onboarding complete | ✅ |
| 5 | Non-OWNER without venues + pending invitations | ✅ |
| 6 | Non-OWNER without venues + no invitations | ✅ |
| 7 | User with venues + pending invitations (normal login) | ✅ |
| 8 | Locked account | ✅ |
| 9 | Wrong password | ✅ |
| 10 | Email not verified | ✅ |
| 11 | Inactive account | ✅ |
| 12 | White-label venue login | ✅ |
| 13 | Multi-org user login | ✅ |
| 14 | User not found | ✅ |
| 15 | Expired invitations ignored | ✅ |
| 16 | Only PENDING invitations count | ✅ |

### 6.2 Frontend Tests (11 scenarios)

File: `src/context/__tests__/AuthContext.login.test.ts`

| # | Scenario | Status |
|---|----------|--------|
| 1 | Redirect to /invite/{token} with pending invitations | ✅ |
| 2 | Redirect to first invitation when multiple exist | ✅ |
| 3 | Normal flow when pendingInvitations empty | ✅ |
| 4 | Normal flow when pendingInvitations undefined | ✅ |
| 5 | Success toast and refetch for user with venues | ✅ |
| 6 | Clear previous login errors | ✅ |
| 7 | Handle special characters in token | ✅ |
| 8 | Handle org-level invitation (no venueId) | ✅ |
| 9 | Handle user with venues AND invitations | ✅ |
| 10 | Document user journey for pending invitations | ✅ |
| 11 | Document active venues + new invitation scenario | ✅ |

### 6.3 Not Covered by Automated Tests (TODO)

| Scenario | Reason | Priority |
|----------|--------|----------|
| SUPERADMIN TOTP login | Uses separate system | Low |
| Google OAuth all scenarios | Code is correct, no tests written | Medium |
| TPV PIN login | Different service (auth.tpv.service.ts) | Low |
| OWNER invitation with `inviteToAllVenues` | New feature | High |
| Cross-org invitation acceptance | Complex flow | High |
| Org-level invitation (no venueId) | Edge case | Medium |
| Multi-venue permission check (dynamic role lookup) | Backend middleware | High |
| Smart venue selection on login | Frontend localStorage | Medium |

### 6.4 Recommended Test Additions

**Backend (invitation.service.ts):**
```typescript
// test: OWNER invitation with inviteToAllVenues assigns to all org venues
// test: OWNER invitation without inviteToAllVenues assigns to single venue
// test: Non-OWNER invitation ignores inviteToAllVenues flag
// test: Cross-org invitation creates new StaffOrganization with isPrimary=false
// test: Cross-org invitation derives OrgRole from existing venue roles
// test: Org-level invitation (no venueId) only creates StaffOrganization
// test: Token generation with no venueId returns null accessToken
// test: Deactivated OWNER re-invited as CASHIER → role overwritten (current behavior)
```

**Backend (team.dashboard.service.ts):**
```typescript
// test: Active user in venue blocks new invitation (same venue)
// test: Inactive user in venue allows new invitation (same venue)
// test: inviteToAllVenues=true bypasses active user check for OWNER role
// test: Pending invitation for same email+venue blocks duplicate
```

**Backend (liveDemo.service.ts):**
```typescript
// test: New session creates venue with LIVE_DEMO status
// test: Existing session returns same venue
// test: Expired session creates new venue
// test: Live demo staff has no password (auto-login)
// test: All features enabled for live demo
```

**Backend (auth - venue status):**
```typescript
// test: Login with only SUSPENDED venues returns NO_VENUE_ACCESS
// test: Login with mix of ACTIVE + SUSPENDED returns only ACTIVE
// test: SUPERADMIN can see SUSPENDED venues
// test: TRIAL venue login works normally
// test: ONBOARDING venue login works normally
// test: Refresh token fails for SUSPENDED venue
```

**Backend (checkPermission.middleware.ts):**
```typescript
// test: Same venue as token uses token role
// test: Different venue looks up actual role from StaffVenue
// test: Different venue with no access returns 403
// test: Permission check uses looked-up role, not token role
```

**Frontend (AuthContext.tsx):**
```typescript
// test: Smart venue selection returns last used venue from localStorage
// test: Smart venue selection falls back to highest-role venue
// test: avoqado_current_venue_slug NOT cleared on logout
```

---

## 7. Quick Reference: Decision Tree

```
User attempts login
├── Is SUPERADMIN (master@avoqado.io)?
│   └── Validate TOTP → OK or ERROR
├── User not found?
│   └── ERROR: Invalid credentials
├── Has password?
│   └── No → ERROR: Invalid credentials
├── Account locked?
│   └── Yes → ERROR: Account locked
├── Password correct?
│   └── No → Increment attempts → ERROR or LOCK
├── Email verified?
│   └── No → ERROR: Verify email
├── Account active?
│   └── No → ERROR: Account deactivated
├── Has venues?
│   ├── Yes → LOGIN OK (select first or specified venue)
│   └── No
│       ├── Is OWNER + onboarding incomplete?
│       │   └── LOGIN OK (venueId = "pending")
│       ├── Has pending invitations?
│       │   └── LOGIN OK + pendingInvitations[]
│       └── No invitations?
│           └── ERROR: NO_VENUE_ACCESS
```

---

## 8. Related Files

### Backend (avoqado-server)

| File | Purpose |
|------|---------|
| `src/services/dashboard/auth.service.ts` | Email/password login |
| `src/services/dashboard/googleOAuth.service.ts` | Google OAuth login |
| `src/services/invitation.service.ts` | Invitation acceptance |
| `src/services/dashboard/team.dashboard.service.ts` | Create invitations |
| `src/services/liveDemo.service.ts` | Live demo venue creation/management |
| `src/lib/venueStatus.constants.ts` | VenueStatus categories and helpers |
| `src/middlewares/checkPermission.middleware.ts` | Dynamic role lookup for multi-venue |
| `src/middlewares/authenticateToken.middleware.ts` | JWT validation, authContext creation |

### Frontend (avoqado-web-dashboard)

| File | Purpose |
|------|---------|
| `src/context/AuthContext.tsx` | Auth state, smart venue selection |
| `src/pages/InviteAccept.tsx` | Invitation acceptance UI |
| `src/components/Sidebar/venues-switcher.tsx` | Venue switching, localStorage persistence |
| `src/services/chatService.ts` | Chat storage (separated from user prefs) |

### Key LocalStorage Keys

| Key | Purpose | Cleared on Logout |
|-----|---------|-------------------|
| `avoqado_current_venue_slug` | Last used venue for smart redirect | **No** |
| `avoqado_chat_history` | Chat conversation history | Yes |
| `avoqado_chat_daily_usage` | Daily token usage | Yes |
| `avoqado_chat_conversations` | Conversations list | Yes |
