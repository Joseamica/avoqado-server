# Team Invitations System

## Overview

The team invitation system allows organization owners/admins to invite new staff members to their organization and specific venues. The
system supports **multi-venue assignments** where a single staff member can belong to multiple venues with different roles.

## Data Model

### Key Entities

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Organization  │────▶│      Staff      │────▶│   StaffVenue    │
│                 │  1:N│                 │  1:N│                 │
│  id             │     │  id             │     │  staffId        │
│  name           │     │  email (unique) │     │  venueId        │
│                 │     │  organizationId │     │  role           │
│                 │     │  password       │     │  pin            │
│                 │     │  firstName      │     │  active         │
│                 │     │  lastName       │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
┌─────────────────┐                                     │
│   Invitation    │                                     │
│                 │                              ┌──────▼──────────┐
│  id             │                              │     Venue       │
│  token (unique) │                              │                 │
│  email          │                              │  id             │
│  role           │                              │  name           │
│  organizationId │──────────────────────────────│  organizationId │
│  venueId?       │                              │                 │
│  status         │                              └─────────────────┘
│  expiresAt      │
└─────────────────┘
```

### Critical Constraint

**`Staff.email` is globally unique** - One person = One Staff record across the entire platform.

This means:

- A user cannot have two Staff records (even in different organizations)
- Multi-venue support is achieved through the `StaffVenue` junction table
- Cross-organization access is **NOT currently supported** (requires support intervention)

## Invitation Flow

### Scenario 1: Brand New User (Happy Path)

```
1. Admin invites juan@email.com to Venue A as WAITER
2. System creates Invitation record (status: PENDING)
3. Juan clicks invitation link → InviteAccept page
4. Juan fills form: firstName, lastName, password, PIN (optional)
5. System creates:
   - Staff record (new)
   - StaffVenue record (Venue A, role: WAITER)
6. Juan receives access tokens and is logged in
```

### Scenario 2: Existing User, Same Organization, New Venue (Multi-Venue)

```
1. Juan already works at Venue A (WAITER)
2. Admin invites juan@email.com to Venue B as MANAGER
3. System creates Invitation record (status: PENDING)
4. Juan clicks invitation link → InviteAccept page
5. System detects:
   - Staff record exists ✓
   - Same organization ✓
   - User already has password ✓
6. Frontend shows "You already have an account" → Login button
7. Juan logs in with existing credentials
8. System creates:
   - StaffVenue record (Venue B, role: MANAGER)
   - Keeps existing Staff record unchanged
```

### Scenario 3: Existing User, Different Organization (Blocked)

```
1. Maria works at Organization X
2. Organization Y admin invites maria@email.com
3. System creates Invitation record (status: PENDING)
4. Maria clicks invitation link → InviteAccept page
5. System detects:
   - Staff record exists ✓
   - DIFFERENT organization ✗
6. Frontend shows "Account registered in another organization"
7. Maria must contact support for cross-org access
```

### Scenario 4: Logged In User, Same Email (Direct Accept)

```
1. Juan is logged in as juan@email.com
2. Juan clicks invitation link for juan@email.com
3. System detects:
   - Session email matches invitation email ✓
   - User already authenticated ✓
4. Frontend shows "Accept directly" button (no form needed)
5. Juan clicks accept → StaffVenue created → Redirected to new venue
```

### Scenario 5: Logged In User, Different Email (Email Mismatch)

```
1. Admin (admin@company.com) is logged in
2. Admin clicks invitation link meant for juan@email.com
3. System detects session email ≠ invitation email
4. Frontend shows "Email Mismatch" warning
5. User must log out and continue with correct email
```

## API Endpoints

### GET `/api/v1/invitation/:token`

Returns invitation details for the frontend to render the appropriate UI.

**Response:**

```typescript
{
  id: string
  email: string
  role: StaffRole
  roleDisplayName: string | null // Custom role name from venue settings
  organizationName: string
  venueName: string | null
  inviterName: string
  expiresAt: string // ISO 8601
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED'

  // Pre-populated fields (if staff exists in same org)
  firstName: string | null
  lastName: string | null

  // Multi-venue support flags
  userAlreadyHasPassword: boolean // If true, skip password form
  existsInDifferentOrg: boolean // If true, show "contact support" message
}
```

### POST `/api/v1/invitation/:token/accept`

Accepts the invitation and creates/updates staff records.

**Request:**

```typescript
{
  firstName: string
  lastName: string
  password: string
  pin?: string  // 4-10 digits, optional
}
```

**Response:**

```typescript
{
  user: {
    id: string
    email: string
    firstName: string
    lastName: string
    organizationId: string
  }
  tokens: {
    accessToken: string | null
    refreshToken: string
  }
}
```

**Error Responses:**

- `404` - Invitation not found or already used
- `410` - Invitation expired
- `409` - Email registered in different organization
- `409` - PIN already used in this venue

## Frontend States

The `InviteAccept.tsx` page handles all invitation scenarios:

| State          | Condition                        | UI                                 |
| -------------- | -------------------------------- | ---------------------------------- |
| Loading        | Fetching invitation              | Spinner                            |
| Error          | Invalid token                    | Error message + Login link         |
| Expired        | `expiresAt < now`                | Expiration message + Contact admin |
| Different Org  | `existsInDifferentOrg: true`     | "Contact support" message          |
| Has Password   | `userAlreadyHasPassword: true`   | "Login to accept" button           |
| Email Mismatch | Session email ≠ invitation email | Logout + Continue button           |
| Direct Accept  | Session email = invitation email | "Accept" button (no form)          |
| New User       | Default                          | Full registration form             |

## Security Considerations

### Token Security

- Invitation tokens are UUID v4 (cryptographically random)
- Tokens are single-use (status changes to ACCEPTED)
- Default expiration: 7 days
- Tokens cannot be reused after expiration

### PIN Security

- PINs are stored as **plain text** (for fast TPV login comparison)
- PIN uniqueness is enforced per-venue (not globally)
- PINs are 4-10 digits only

### Password Security

- Passwords are hashed with bcrypt (12 rounds)
- Existing passwords are NEVER overwritten when accepting new venue invitations
- Users with existing accounts authenticate with their existing password

## Testing Scenarios

### Manual Testing Checklist

#### Test 1: New User Invitation

- [ ] Create invitation for non-existent email
- [ ] Access invitation link (should show full form)
- [ ] Submit form with valid data
- [ ] Verify Staff and StaffVenue records created
- [ ] Verify user can log in

#### Test 2: Multi-Venue (Same Org)

- [ ] Create invitation for existing user (different venue, same org)
- [ ] Access invitation link (should show "login to accept")
- [ ] Log in with existing credentials
- [ ] Verify new StaffVenue record created
- [ ] Verify existing Staff record unchanged
- [ ] Verify user has access to both venues

#### Test 3: Cross-Organization (Blocked)

- [ ] Create invitation for email that exists in different org
- [ ] Access invitation link (should show "contact support")
- [ ] Verify no new records created
- [ ] Verify existing records unchanged

#### Test 4: Direct Accept (Logged In)

- [ ] Log in as user X
- [ ] Access invitation link for user X (same email)
- [ ] Should show "Accept directly" UI
- [ ] Accept invitation
- [ ] Verify StaffVenue record created
- [ ] Verify redirect to new venue

#### Test 5: Email Mismatch

- [ ] Log in as user X
- [ ] Access invitation link for user Y (different email)
- [ ] Should show "Email Mismatch" warning
- [ ] Log out and continue
- [ ] Verify redirect back to invitation

#### Test 6: Expired Invitation

- [ ] Create invitation (manually set expiresAt in past)
- [ ] Access invitation link
- [ ] Should show "Invitation Expired" message

#### Test 7: PIN Collision

- [ ] User A has PIN 1234 in Venue X
- [ ] Invite User B to Venue X
- [ ] User B tries to use PIN 1234
- [ ] Should show "PIN not available" error

## Database Queries

### Check User's Venue Assignments

```sql
SELECT
  s.email,
  s."firstName",
  s."lastName",
  o.name as organization,
  v.name as venue,
  sv.role,
  sv.active
FROM "Staff" s
JOIN "Organization" o ON s."organizationId" = o.id
JOIN "StaffVenue" sv ON s.id = sv."staffId"
JOIN "Venue" v ON sv."venueId" = v.id
WHERE s.email = 'user@example.com';
```

### Check Pending Invitations

```sql
SELECT
  i.email,
  i.role,
  i.status,
  i."expiresAt",
  o.name as organization,
  v.name as venue
FROM "Invitation" i
JOIN "Organization" o ON i."organizationId" = o.id
LEFT JOIN "Venue" v ON i."venueId" = v.id
WHERE i.status = 'PENDING'
AND i."expiresAt" > NOW();
```

## Related Documentation

- [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) - Full schema reference
- [PERMISSIONS_SYSTEM.md](../PERMISSIONS_SYSTEM.md) - Role-based access control
- [SEED_CREDENTIALS.md](../SEED_CREDENTIALS.md) - Test user credentials

## Changelog

| Date       | Change                                          | Author |
| ---------- | ----------------------------------------------- | ------ |
| 2025-01-15 | Initial documentation + multi-venue support fix | Claude |
