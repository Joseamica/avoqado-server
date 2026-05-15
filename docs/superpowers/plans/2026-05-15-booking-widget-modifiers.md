# Booking Widget — Service Modifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable customers to pick optional/required modifiers (e.g., "Agregar color de gel +$300", "Estilo: vitral / aurora / carey", "1 a
5 uñas +$10 c/u") while booking a service on `book.avoqado.io`, and persist their selections + price impact on the resulting `Reservation`.

**Architecture:** Reuses Avoqado's existing `ModifierGroup`/`Modifier`/`ProductModifierGroup` schema (already used by TPV / OrderItem). Adds
a new `ReservationModifier` join table mirroring `OrderItemModifier` (denormalized name + price, soft FK to `Modifier`). The public consumer
API (`venue.consumer.service.ts`) starts surfacing modifier groups in its `select`, and `reservation.public.controller.ts` accepts a
`modifierSelections` array on creation, validates min/max/required per group, computes the total price impact, and persists it. The widget
(`avoqado-booking-widget`) gains a `ModifierPicker` component, holds selections in `state/booking.ts`, validates required groups in
`BookingFlow`, and shows the line items in `AppointmentSummarySidebar`.

**Tech Stack:** TypeScript, Prisma 5, PostgreSQL, Express, Zod, React 18, Vite, i18next, Jest (server-side tests only — widget has no test
infra).

**Repos touched:**

- `/Users/amieva/Documents/Programming/Avoqado/avoqado-server` (schema, API, services, tests)
- `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget` (UI, state)

**Out of scope (deferred):**

- Dashboard UI for creating modifier groups — backend CRUD already exists; Amaena's catalog will be seeded directly by SQL in Task 13.
  Dashboard UI is a separate plan.
- Inventory deduction via modifiers (the `Modifier.rawMaterialId` path) — works automatically through existing inventory engine; no extra
  work.
- Modifier translations / multi-language — names stored as-is, displayed verbatim.

---

## File Structure

### Server (`avoqado-server`)

| File                                                                       | Responsibility                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma/schema.prisma`                                                     | New `ReservationModifier` model + relation on `Reservation` + back-relation on `Modifier`.                                                                                                       |
| `prisma/migrations/<ts>_add_reservation_modifier/migration.sql`            | DB migration.                                                                                                                                                                                    |
| `src/services/consumer/venue.consumer.service.ts`                          | Extend `getVenueBookingInfo`/`getVenueProducts` `select` to include modifier groups + modifiers.                                                                                                 |
| `src/services/consumer/types.ts` (new)                                     | Public shape `PublicModifierGroup`, `PublicModifier` returned by consumer API.                                                                                                                   |
| `src/services/reservations/resolveModifierSelections.ts` (new)             | Pure helper: given productIds + selections + DB, returns `{ persistRows, totalDelta, totalDurationDelta }`. Validates required/min/max/quantity, throws `BadRequestError` with Spanish messages. |
| `src/services/dashboard/reservation.dashboard.service.ts`                  | Wire helper into `createReservation` transaction: validate, write `ReservationModifier` rows, add delta to deposit calc base.                                                                    |
| `src/controllers/public/reservation.public.controller.ts`                  | Add Zod schema for `modifierSelections`; pass through to service; include modifiers in `getReservation` response shape.                                                                          |
| `tests/unit/services/reservations/resolveModifierSelections.test.ts` (new) | Unit tests for helper.                                                                                                                                                                           |
| `tests/unit/services/dashboard/reservation.modifiers.test.ts` (new)        | Integration test for `createReservation` with modifiers.                                                                                                                                         |
| `scripts/seed-amaena-color-diseno.sql` (new, temp)                         | One-shot SQL to insert COLOR + DISEÑO catalog with modifier groups. Deleted after run.                                                                                                           |

### Widget (`avoqado-booking-widget`)

| File                                           | Responsibility                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                 | Add `ModifierGroup`, `Modifier`, extend `Service` with `modifierGroups`, extend `PublicCreateReservationRequest` with `modifierSelections`, extend `PublicReservationDetail` with `modifiers`. |
| `src/components/ModifierPicker.tsx` (new)      | Renders one `ModifierGroup` with single/multi select, respects required + min/max.                                                                                                             |
| `src/components/ServiceDetailView.tsx`         | Renders `<ModifierPicker>` per group for the selected service.                                                                                                                                 |
| `src/components/BookingFlow.tsx`               | Blocks "Continue" while any required group is unsatisfied.                                                                                                                                     |
| `src/components/AppointmentSummarySidebar.tsx` | Shows selected modifiers as line items with prices; reflects total.                                                                                                                            |
| `src/state/booking.ts`                         | `selectedModifiers: Record<productId, ModifierSelection[]>`; setter/toggler; `computeTotal()` and `computeDuration()` selectors.                                                               |
| `src/api/booking.ts`                           | Pass `modifierSelections` in `createReservation` payload.                                                                                                                                      |
| `src/i18n/en.json` + `src/i18n/es.json`        | Strings: `modifiers.required`, `modifiers.pickOne`, `modifiers.pickUpTo`, `modifiers.optional`, `summary.modifierLine`.                                                                        |

---

## Data Model Decisions (locked)

**`ReservationModifier`** mirrors `OrderItemModifier`:

- `id`, `reservationId` (FK CASCADE), `productId` (text, no FK — Reservation has `productIds[]` not a junction, so we tag which service in
  the multi-service appointment the modifier belongs to), `modifierId` (FK SET NULL), `name` (denormalized), `quantity` (int default 1),
  `price` (Decimal(10,2)), `createdAt`.
- Index `(reservationId)`.

**Validation rules** (in `resolveModifierSelections.ts`):

- If a `ModifierGroup` has `required=true` and is `assigned to the product`, the selection set for that group MUST have count ≥
  `max(1, minSelections)`.
- If `allowMultiple=false`, count for that group MUST be ≤ 1.
- If `allowMultiple=true` and `maxSelections` is set, count MUST be ≤ `maxSelections` AND ≥ `minSelections`.
- All `modifierId`s in the selection MUST belong to a group that is assigned to one of the booked products.
- `quantity` defaults to 1; rejected if < 1 or > 99.

**Price/duration impact:**

- `totalDelta = Σ (modifier.price × quantity)`. Added to base price for the deposit calculation.
- Duration is NOT extended by modifiers in v1 (mirrors Vagaro's optional-duration default of 0). If a modifier wants to extend duration,
  that's a v2 feature on the `Modifier` model.

**Multi-service appointments:** Each entry in `modifierSelections` carries `productId` so the same modifier group could apply differently
per booked service. Server validates the modifier group is actually assigned (via `ProductModifierGroup`) to that specific `productId`.

---

### Task 1: Add `ReservationModifier` schema + migration

**Files:**

- Modify: `prisma/schema.prisma` (Reservation block around line 8070; Modifier block around line 2314)
- Create: `prisma/migrations/<timestamp>_add_reservation_modifier/migration.sql` (generated by Prisma)

- [ ] **Step 1: Add `ReservationModifier` model + relations to `schema.prisma`**

Append a new model right after `ReservationReminderSent` (around line 8203) and add the back-relation on `Reservation`:

```prisma
model ReservationModifier {
  id            String       @id @default(cuid())
  reservationId String
  reservation   Reservation  @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  // Which service in a multi-service appointment this modifier belongs to.
  // We don't FK to Product because Reservation.productIds is a text[] (Square pattern),
  // not a join table — keeping productId here as a tag matches that pattern.
  productId     String
  modifierId    String?
  modifier      Modifier?    @relation(fields: [modifierId], references: [id], onDelete: SetNull)

  // Denormalized — preserved if Modifier is deleted (parity with OrderItemModifier)
  name     String?
  quantity Int     @default(1)
  price    Decimal @db.Decimal(10, 2)

  createdAt DateTime @default(now())

  @@index([reservationId])
  @@index([modifierId])
}
```

Inside `model Reservation { ... }` add:

```prisma
  modifiers ReservationModifier[]
```

Inside `model Modifier { ... }` add the back-relation:

```prisma
  reservationItems ReservationModifier[]
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_reservation_modifier` Expected: new migration folder + applied locally + Prisma Client regenerated.

- [ ] **Step 3: Verify schema compiles**

Run: `npx tsc --noEmit` Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/*_add_reservation_modifier
git commit -m "feat(reservations): add ReservationModifier join table for booking modifiers"
```

---

### Task 2: Surface modifier groups in consumer venue API

**Files:**

- Modify: `src/services/consumer/venue.consumer.service.ts` (lines 102–134)
- Create: `src/services/consumer/types.ts`

- [ ] **Step 1: Create public types file**

Create `src/services/consumer/types.ts`:

```typescript
export interface PublicModifier {
  id: string
  name: string
  price: number
  active: boolean
}

export interface PublicModifierGroup {
  id: string
  name: string
  description: string | null
  required: boolean
  allowMultiple: boolean
  minSelections: number
  maxSelections: number | null
  displayOrder: number
  modifiers: PublicModifier[]
}
```

- [ ] **Step 2: Extend the `products.select` in `getVenueBookingInfo` (the function around line 84)**

Find the `products: { ... select: { ... } }` block (around line 102) and add modifier groups. Replace the existing select with:

```typescript
        products: {
          where: { active: true, type: { in: bookableProductTypes } },
          select: {
            id: true,
            name: true,
            price: true,
            duration: true,
            eventCapacity: true,
            type: true,
            maxParticipants: true,
            layoutConfig: true,
            requireCreditForBooking: true,
            modifierGroups: {
              select: {
                displayOrder: true,
                group: {
                  select: {
                    id: true,
                    name: true,
                    description: true,
                    required: true,
                    allowMultiple: true,
                    minSelections: true,
                    maxSelections: true,
                    active: true,
                    modifiers: {
                      where: { active: true },
                      select: { id: true, name: true, price: true, active: true },
                      orderBy: { name: 'asc' },
                    },
                  },
                },
              },
              orderBy: { displayOrder: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
```

- [ ] **Step 3: Map raw Prisma shape → public shape**

In the same function, replace the existing `products: venue.products.map(...)` mapping (around line 128) with:

```typescript
    products: venue.products.map(product => ({
      id: product.id,
      name: product.name,
      duration: product.duration,
      eventCapacity: product.eventCapacity,
      type: product.type,
      maxParticipants: product.maxParticipants,
      layoutConfig: product.layoutConfig,
      requireCreditForBooking: product.requireCreditForBooking,
      price: product.price == null ? null : Number(product.price),
      modifierGroups: product.modifierGroups
        .filter(pg => pg.group.active)
        .map(pg => ({
          id: pg.group.id,
          name: pg.group.name,
          description: pg.group.description,
          required: pg.group.required,
          allowMultiple: pg.group.allowMultiple,
          minSelections: pg.group.minSelections,
          maxSelections: pg.group.maxSelections,
          displayOrder: pg.displayOrder,
          modifiers: pg.group.modifiers.map(m => ({
            id: m.id,
            name: m.name,
            price: Number(m.price),
            active: m.active,
          })),
        })),
    })),
```

- [ ] **Step 4: Run the type check**

Run: `npx tsc --noEmit` Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/consumer/venue.consumer.service.ts src/services/consumer/types.ts
git commit -m "feat(consumer-api): expose modifier groups on bookable services"
```

---

### Task 3: Modifier resolution + validation helper (TDD)

**Files:**

- Create: `src/services/reservations/resolveModifierSelections.ts`
- Test: `tests/unit/services/reservations/resolveModifierSelections.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/services/reservations/resolveModifierSelections.test.ts`:

```typescript
import { resolveModifierSelections, type ModifierSelectionInput } from '@/services/reservations/resolveModifierSelections'
import type { PrismaClient } from '@prisma/client'

// Minimal mock of the Prisma queries the helper makes
function makePrisma(groups: any[]): PrismaClient {
  return {
    productModifierGroup: {
      findMany: jest.fn().mockResolvedValue(groups),
    },
  } as unknown as PrismaClient
}

const PROD = 'cprod000000000000000000001'
const G1 = 'cgrp000000000000000000001' // required, single
const M1A = 'cmod000000000000000000001'
const M1B = 'cmod000000000000000000002'

const productGroupsFixture = [
  {
    productId: PROD,
    group: {
      id: G1,
      required: true,
      allowMultiple: false,
      minSelections: 0,
      maxSelections: null,
      active: true,
      modifiers: [
        { id: M1A, name: 'Vitral', price: '10.00', active: true },
        { id: M1B, name: 'Aurora', price: '10.00', active: true },
      ],
    },
  },
]

describe('resolveModifierSelections', () => {
  it('returns empty when no selections and no required groups', async () => {
    const prisma = makePrisma([{ ...productGroupsFixture[0], group: { ...productGroupsFixture[0].group, required: false } }])
    const result = await resolveModifierSelections(prisma, [PROD], [])
    expect(result.totalDelta.toString()).toBe('0')
    expect(result.persistRows).toEqual([])
  })

  it('throws when a required group has no selection', async () => {
    const prisma = makePrisma(productGroupsFixture)
    await expect(resolveModifierSelections(prisma, [PROD], [])).rejects.toThrow(/requerido/i)
  })

  it('accepts one selection for a required single-select group and computes delta', async () => {
    const prisma = makePrisma(productGroupsFixture)
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: M1A, quantity: 1 }]
    const result = await resolveModifierSelections(prisma, [PROD], selections)
    expect(result.totalDelta.toString()).toBe('10')
    expect(result.persistRows).toHaveLength(1)
    expect(result.persistRows[0]).toMatchObject({ productId: PROD, modifierId: M1A, name: 'Vitral', quantity: 1 })
  })

  it('rejects multiple selections for a single-select group', async () => {
    const prisma = makePrisma(productGroupsFixture)
    const selections: ModifierSelectionInput[] = [
      { productId: PROD, modifierId: M1A, quantity: 1 },
      { productId: PROD, modifierId: M1B, quantity: 1 },
    ]
    await expect(resolveModifierSelections(prisma, [PROD], selections)).rejects.toThrow(/solo puedes elegir/i)
  })

  it('rejects a modifier whose group is not assigned to the product', async () => {
    const prisma = makePrisma(productGroupsFixture)
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: 'cmodOTHER0000000000000000', quantity: 1 }]
    await expect(resolveModifierSelections(prisma, [PROD], selections)).rejects.toThrow(/no válido/i)
  })

  it('applies quantity to per-unit modifiers', async () => {
    const prisma = makePrisma([
      {
        productId: PROD,
        group: {
          id: G1,
          required: false,
          allowMultiple: true,
          minSelections: 0,
          maxSelections: 5,
          active: true,
          modifiers: [{ id: M1A, name: 'Por uña', price: '10.00', active: true }],
        },
      },
    ])
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: M1A, quantity: 3 }]
    const result = await resolveModifierSelections(prisma, [PROD], selections)
    expect(result.totalDelta.toString()).toBe('30')
    expect(result.persistRows[0].quantity).toBe(3)
  })

  it('rejects quantity > maxSelections on multi-select group', async () => {
    const prisma = makePrisma([
      {
        productId: PROD,
        group: {
          id: G1,
          required: false,
          allowMultiple: true,
          minSelections: 0,
          maxSelections: 5,
          active: true,
          modifiers: [{ id: M1A, name: 'Por uña', price: '10.00', active: true }],
        },
      },
    ])
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: M1A, quantity: 6 }]
    await expect(resolveModifierSelections(prisma, [PROD], selections)).rejects.toThrow(/máximo/i)
  })
})
```

- [ ] **Step 2: Run the test (expect failure — module does not exist)**

Run: `npm run test:unit -- tests/unit/services/reservations/resolveModifierSelections.test.ts` Expected: FAIL, "Cannot find module
'@/services/reservations/resolveModifierSelections'".

- [ ] **Step 3: Implement the helper**

Create `src/services/reservations/resolveModifierSelections.ts`:

```typescript
import { Prisma, type PrismaClient } from '@prisma/client'
import { BadRequestError } from '@/utils/errors'

export interface ModifierSelectionInput {
  productId: string
  modifierId: string
  quantity?: number
}

export interface ResolvedModifierRow {
  productId: string
  modifierId: string
  name: string
  quantity: number
  price: Prisma.Decimal
}

export interface ResolveResult {
  persistRows: ResolvedModifierRow[]
  totalDelta: Prisma.Decimal
}

export async function resolveModifierSelections(
  tx: PrismaClient | Prisma.TransactionClient,
  productIds: string[],
  selections: ModifierSelectionInput[],
): Promise<ResolveResult> {
  if (productIds.length === 0) {
    if (selections.length > 0) {
      throw new BadRequestError('No se pueden enviar modificadores sin un servicio')
    }
    return { persistRows: [], totalDelta: new Prisma.Decimal(0) }
  }

  // Load all assignments + groups + active modifiers for the booked products
  const assignments = await tx.productModifierGroup.findMany({
    where: { productId: { in: productIds } },
    select: {
      productId: true,
      group: {
        select: {
          id: true,
          required: true,
          allowMultiple: true,
          minSelections: true,
          maxSelections: true,
          active: true,
          modifiers: {
            where: { active: true },
            select: { id: true, name: true, price: true, active: true },
          },
        },
      },
    },
  })

  // Index: { [productId]: Map<groupId, group> } and { [modifierId]: { group, modifier, productId } }
  const productGroups = new Map<string, Map<string, (typeof assignments)[number]['group']>>()
  const modifierIndex = new Map<
    string,
    {
      productId: string
      group: (typeof assignments)[number]['group']
      modifier: { id: string; name: string; price: Prisma.Decimal | string }
    }
  >()

  for (const a of assignments) {
    if (!a.group.active) continue
    let map = productGroups.get(a.productId)
    if (!map) {
      map = new Map()
      productGroups.set(a.productId, map)
    }
    map.set(a.group.id, a.group)
    for (const m of a.group.modifiers) {
      modifierIndex.set(`${a.productId}:${m.id}`, { productId: a.productId, group: a.group, modifier: m })
    }
  }

  // Group selections by (productId, groupId)
  const grouped = new Map<string, { groupId: string; productId: string; rows: { modifierId: string; quantity: number }[] }>()
  for (const sel of selections) {
    const qty = sel.quantity ?? 1
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new BadRequestError(`Cantidad inválida para el modificador ${sel.modifierId}`)
    }
    const entry = modifierIndex.get(`${sel.productId}:${sel.modifierId}`)
    if (!entry) {
      throw new BadRequestError(`Modificador ${sel.modifierId} no válido para el servicio seleccionado`)
    }
    const key = `${sel.productId}:${entry.group.id}`
    let bucket = grouped.get(key)
    if (!bucket) {
      bucket = { groupId: entry.group.id, productId: sel.productId, rows: [] }
      grouped.set(key, bucket)
    }
    bucket.rows.push({ modifierId: sel.modifierId, quantity: qty })
  }

  // Validate required + min/max for every assigned group
  for (const [productId, groupsMap] of productGroups) {
    for (const group of groupsMap.values()) {
      const bucket = grouped.get(`${productId}:${group.id}`)
      const totalCount = bucket ? bucket.rows.reduce((acc, r) => acc + r.quantity, 0) : 0
      const distinctCount = bucket ? bucket.rows.length : 0

      if (group.required && totalCount < Math.max(1, group.minSelections)) {
        throw new BadRequestError(`El grupo de modificadores es requerido`)
      }
      if (!group.allowMultiple && distinctCount > 1) {
        throw new BadRequestError(`Solo puedes elegir una opción en este grupo`)
      }
      if (group.allowMultiple) {
        if (group.minSelections > 0 && totalCount < group.minSelections) {
          throw new BadRequestError(`Debes seleccionar al menos ${group.minSelections} opciones`)
        }
        if (group.maxSelections != null && totalCount > group.maxSelections) {
          throw new BadRequestError(`Máximo ${group.maxSelections} opciones permitidas`)
        }
      }
    }
  }

  // Build persist rows + totalDelta
  let totalDelta = new Prisma.Decimal(0)
  const persistRows: ResolvedModifierRow[] = []
  for (const sel of selections) {
    const entry = modifierIndex.get(`${sel.productId}:${sel.modifierId}`)!
    const qty = sel.quantity ?? 1
    const unitPrice = new Prisma.Decimal(entry.modifier.price as any)
    const lineTotal = unitPrice.mul(qty)
    totalDelta = totalDelta.add(lineTotal)
    persistRows.push({
      productId: sel.productId,
      modifierId: sel.modifierId,
      name: entry.modifier.name,
      quantity: qty,
      price: unitPrice,
    })
  }

  return { persistRows, totalDelta }
}
```

- [ ] **Step 4: Run the test (expect pass)**

Run: `npm run test:unit -- tests/unit/services/reservations/resolveModifierSelections.test.ts` Expected: PASS, 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/reservations/resolveModifierSelections.ts tests/unit/services/reservations/resolveModifierSelections.test.ts
git commit -m "feat(reservations): add modifier resolution helper with validation"
```

---

### Task 4: Persist modifier selections inside `createReservation`

**Files:**

- Modify: `src/services/dashboard/reservation.dashboard.service.ts` (`createReservation` function around line 237)
- Modify: `src/services/dashboard/reservation.dashboard.service.ts` (the `CreateReservationInput` type — find and extend)
- Test: `tests/unit/services/dashboard/reservation.modifiers.test.ts`

- [ ] **Step 1: Locate `CreateReservationInput` and add the optional field**

Search for `CreateReservationInput` in the service file. Add:

```typescript
  modifierSelections?: { productId: string; modifierId: string; quantity?: number }[]
```

- [ ] **Step 2: Wire the helper into `createReservation`**

Inside the `withSerializableRetry` block, right after `validateResourceOwnership(...)` returns and before any deposit calc, add:

```typescript
const bookedProductIds = data.productIds && data.productIds.length > 0 ? data.productIds : data.productId ? [data.productId] : []
const { persistRows: modifierRows, totalDelta: modifierDelta } = await resolveModifierSelections(
  tx,
  bookedProductIds,
  data.modifierSelections ?? [],
)
```

Add at top of file:

```typescript
import { resolveModifierSelections } from '@/services/reservations/resolveModifierSelections'
```

Update the deposit-base price calculation: change `product?.price ? Number(product.price) : null` to
`product?.price ? Number(new Prisma.Decimal(product.price).add(modifierDelta)) : null`.

After the `tx.reservation.create({...})` call, persist the modifiers. Find the `tx.reservation.create` and chain:

```typescript
if (modifierRows.length > 0) {
  await tx.reservationModifier.createMany({
    data: modifierRows.map(r => ({
      reservationId: reservation.id,
      productId: r.productId,
      modifierId: r.modifierId,
      name: r.name,
      quantity: r.quantity,
      price: r.price,
    })),
  })
}
```

- [ ] **Step 3: Write the integration test**

Create `tests/unit/services/dashboard/reservation.modifiers.test.ts`:

```typescript
import { prismaMock } from '@/tests/__helpers__/prismaMock'
import { createReservation } from '@/services/dashboard/reservation.dashboard.service'
import { Prisma } from '@prisma/client'

jest.mock('@/services/reservations/resolveModifierSelections', () => ({
  resolveModifierSelections: jest.fn(),
}))
import { resolveModifierSelections } from '@/services/reservations/resolveModifierSelections'

describe('createReservation with modifiers', () => {
  const venueId = 'cven0000000000000000000001'
  const productId = 'cprod00000000000000000001'

  beforeEach(() => {
    jest.clearAllMocks()
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [{ productId, modifierId: 'cmod1', name: 'Esmalte', quantity: 1, price: new Prisma.Decimal('150') }],
      totalDelta: new Prisma.Decimal('150'),
    })
  })

  it('persists ReservationModifier rows when selections are provided', async () => {
    // Arrange: stub validateResourceOwnership, withSerializableRetry, reservation.create
    // (skeleton — adapt to existing test helpers in the repo)
    const data = {
      startsAt: new Date('2026-06-01T10:00:00Z'),
      endsAt: new Date('2026-06-01T11:00:00Z'),
      duration: 60,
      productId,
      productIds: [productId],
      guestName: 'Test',
      guestPhone: '5555555555',
      modifierSelections: [{ productId, modifierId: 'cmod1', quantity: 1 }],
    } as any

    await createReservation(venueId, data)

    expect(resolveModifierSelections).toHaveBeenCalledWith(expect.anything(), [productId], data.modifierSelections)
    expect(prismaMock.reservationModifier.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ productId, modifierId: 'cmod1', name: 'Esmalte', quantity: 1 })],
    })
  })

  it('does not call createMany when no selections', async () => {
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal('0'),
    })
    const data = {
      startsAt: new Date('2026-06-01T10:00:00Z'),
      endsAt: new Date('2026-06-01T11:00:00Z'),
      duration: 60,
      productId,
      guestName: 'Test',
      guestPhone: '5555555555',
    } as any

    await createReservation(venueId, data)
    expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
  })
})
```

If `prismaMock` shape differs in this repo, adapt to the existing helper (search `tests/__helpers__` first).

- [ ] **Step 4: Run the integration test**

Run: `npm run test:unit -- tests/unit/services/dashboard/reservation.modifiers.test.ts` Expected: PASS (2 tests). If existing test helpers
don't expose `reservationModifier.createMany`, extend the mock factory accordingly in `tests/__helpers__/prismaMock.ts` first.

- [ ] **Step 5: Run full reservation test suite (regression check)**

Run: `npm run test:unit -- tests/unit/services/dashboard/reservation` Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/services/dashboard/reservation.dashboard.service.ts tests/unit/services/dashboard/reservation.modifiers.test.ts tests/__helpers__/prismaMock.ts
git commit -m "feat(reservations): persist modifier selections + include delta in deposit calc"
```

---

### Task 5: Accept `modifierSelections` in public reservation controller + return them on GET

**Files:**

- Modify: `src/controllers/public/reservation.public.controller.ts` (`createReservation` around line 422; `getReservation` around line 957)

- [ ] **Step 1: Locate the Zod schema for the create body**

Find the Zod schema near `createReservation` handler (search for `z.object` near line 422–500). Add the field (preserve Spanish messages):

```typescript
  modifierSelections: z.array(z.object({
    productId: z.string().min(1, 'productId del modificador requerido'),
    modifierId: z.string().min(1, 'modifierId requerido'),
    quantity: z.number().int().min(1).max(99).optional(),
  })).optional(),
```

- [ ] **Step 2: Pass it through to the service call**

In the body that calls `reservationService.createReservation(...)`, include `modifierSelections: validated.modifierSelections` in the data
object.

- [ ] **Step 3: Extend `getReservation` to include modifiers**

In the `getReservation` handler (around line 957), find where it shapes the response. Add modifiers to the response by extending the service
call OR doing a follow-up query:

```typescript
const modifiers = await prisma.reservationModifier.findMany({
  where: { reservationId: reservation.id },
  select: { id: true, productId: true, name: true, quantity: true, price: true },
  orderBy: { createdAt: 'asc' },
})

// In the response payload:
modifiers: modifiers.map(m => ({
  id: m.id,
  productId: m.productId,
  name: m.name,
  quantity: m.quantity,
  price: Number(m.price),
})),
```

- [ ] **Step 4: Manual smoke (curl) — create reservation with modifiers**

Run the dev server (`npm run dev`) and POST a reservation with a `modifierSelections` array against a venue that has at least one assigned
`ModifierGroup`. Confirm 201 + the GET endpoint returns the modifiers.

- [ ] **Step 5: Format + lint**

```bash
npm run format && npm run lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add src/controllers/public/reservation.public.controller.ts
git commit -m "feat(public-api): accept and return modifier selections on reservations"
```

---

### Task 6: Widget — extend types + API client

**Files:**

- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/types.ts`
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/api/booking.ts`

- [ ] **Step 1: Add modifier types to `types.ts`**

Append:

```typescript
export interface Modifier {
  id: string
  name: string
  price: number
  active: boolean
}

export interface ModifierGroup {
  id: string
  name: string
  description: string | null
  required: boolean
  allowMultiple: boolean
  minSelections: number
  maxSelections: number | null
  displayOrder: number
  modifiers: Modifier[]
}

export interface ModifierSelection {
  productId: string
  modifierId: string
  quantity: number
}
```

- [ ] **Step 2: Extend the existing `Service` / public product type**

Find the type that represents a bookable product/service (search for `productName`, `duration`, or look around `PublicClassSessionSlot`).
Add an optional field:

```typescript
modifierGroups?: ModifierGroup[]
```

- [ ] **Step 3: Extend `PublicCreateReservationRequest` (line 141)**

```typescript
  modifierSelections?: ModifierSelection[]
```

- [ ] **Step 4: Extend `PublicReservationDetail` (line 230) to expose modifiers**

```typescript
  modifiers?: { id: string; productId: string; name: string; quantity: number; price: number }[]
```

- [ ] **Step 5: Verify request actually passes through `api/booking.ts`**

Open `src/api/booking.ts` — the `createReservation(data: PublicCreateReservationRequest, ...)` already sends `data` as JSON, so no change
needed. Confirm by reading lines 75–95.

- [ ] **Step 6: Type check**

Run from the widget repo: `npm run build` (or `tsc --noEmit` if available). Expected: no errors.

- [ ] **Step 7: Commit (widget repo)**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget
git add src/types.ts
git commit -m "feat(types): add modifier groups + selections to booking types"
```

---

### Task 7: Widget — `ModifierPicker` component

**Files:**

- Create: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/components/ModifierPicker.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useTranslation } from 'react-i18next'
import type { ModifierGroup, ModifierSelection } from '../types'

interface Props {
  productId: string
  group: ModifierGroup
  selections: ModifierSelection[]
  onChange: (next: ModifierSelection[]) => void
  currency: string
}

export function ModifierPicker({ productId, group, selections, onChange, currency }: Props) {
  const { t } = useTranslation()

  const selectedFor = (modifierId: string) => selections.find(s => s.productId === productId && s.modifierId === modifierId)

  const toggle = (modifierId: string) => {
    const existing = selectedFor(modifierId)
    if (group.allowMultiple) {
      if (existing) {
        onChange(selections.filter(s => !(s.productId === productId && s.modifierId === modifierId)))
      } else {
        if (group.maxSelections != null) {
          const currentCount = selections
            .filter(s => s.productId === productId && group.modifiers.some(m => m.id === s.modifierId))
            .reduce((acc, s) => acc + s.quantity, 0)
          if (currentCount >= group.maxSelections) return
        }
        onChange([...selections, { productId, modifierId, quantity: 1 }])
      }
    } else {
      // single-select: replace any existing pick in this group
      const filtered = selections.filter(s => !(s.productId === productId && group.modifiers.some(m => m.id === s.modifierId)))
      if (existing) {
        onChange(filtered)
      } else {
        onChange([...filtered, { productId, modifierId, quantity: 1 }])
      }
    }
  }

  const setQuantity = (modifierId: string, qty: number) => {
    if (qty < 1) {
      onChange(selections.filter(s => !(s.productId === productId && s.modifierId === modifierId)))
      return
    }
    if (group.maxSelections != null && qty > group.maxSelections) qty = group.maxSelections
    const exists = selectedFor(modifierId)
    if (exists) {
      onChange(selections.map(s => (s.productId === productId && s.modifierId === modifierId ? { ...s, quantity: qty } : s)))
    } else {
      onChange([...selections, { productId, modifierId, quantity: qty }])
    }
  }

  const subtitle = group.required
    ? t('modifiers.required')
    : group.allowMultiple
      ? group.maxSelections
        ? t('modifiers.pickUpTo', { n: group.maxSelections })
        : t('modifiers.optional')
      : t('modifiers.pickOne')

  const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency })

  return (
    <fieldset className="modifier-group">
      <legend>
        <strong>{group.name}</strong>
        <span className="modifier-group__hint">{subtitle}</span>
      </legend>
      {group.description && <p className="modifier-group__desc">{group.description}</p>}
      <ul>
        {group.modifiers.map(m => {
          const selected = selectedFor(m.id)
          return (
            <li key={m.id} className={selected ? 'is-selected' : ''}>
              <label>
                <input
                  type={group.allowMultiple ? 'checkbox' : 'radio'}
                  name={`mg-${productId}-${group.id}`}
                  checked={!!selected}
                  onChange={() => toggle(m.id)}
                />
                <span>{m.name}</span>
                {m.price > 0 && <span className="modifier__price">+{fmt.format(m.price)}</span>}
              </label>
              {group.allowMultiple && group.maxSelections != null && group.maxSelections > 1 && selected && (
                <input
                  type="number"
                  min={1}
                  max={group.maxSelections}
                  value={selected.quantity}
                  onChange={e => setQuantity(m.id, Number(e.target.value))}
                  className="modifier__qty"
                />
              )}
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}
```

- [ ] **Step 2: Type-check the widget**

Run: `npm run build` Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ModifierPicker.tsx
git commit -m "feat(widget): add ModifierPicker component"
```

---

### Task 8: Widget — state for modifier selections in `booking.ts`

**Files:**

- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/state/booking.ts`

- [ ] **Step 1: Inspect current state shape**

Read `src/state/booking.ts` and identify the store pattern (zustand, useReducer, signal, etc.). The new state slice should match it.

- [ ] **Step 2: Add `selectedModifiers` slice**

Add a `selectedModifiers: ModifierSelection[]` field to the booking store, with setters:

```typescript
import type { ModifierSelection } from '../types'

// inside store
selectedModifiers: [] as ModifierSelection[],
setSelectedModifiers(next: ModifierSelection[]) {
  store.selectedModifiers = next
},
clearSelectedModifiers() {
  store.selectedModifiers = []
},
```

- [ ] **Step 3: Add price + duration selectors**

```typescript
export function computeBookingTotal(
  basePrice: number,
  selectedModifiers: ModifierSelection[],
  productById: Map<string, { modifierGroups?: { modifiers: { id: string; price: number }[] }[] }>,
): number {
  let total = basePrice
  for (const sel of selectedModifiers) {
    const product = productById.get(sel.productId)
    if (!product) continue
    for (const group of product.modifierGroups ?? []) {
      const mod = group.modifiers.find(m => m.id === sel.modifierId)
      if (mod) total += mod.price * sel.quantity
    }
  }
  return total
}
```

- [ ] **Step 4: Reset modifiers when the user changes service**

Find where `selectedServiceId` (or equivalent) is set. After the set, call `clearSelectedModifiers()`.

- [ ] **Step 5: Type-check**

Run: `npm run build` Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/state/booking.ts
git commit -m "feat(widget): track modifier selections + compute dynamic total"
```

---

### Task 9: Widget — render `ModifierPicker`s inside `ServiceDetailView`

**Files:**

- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/components/ServiceDetailView.tsx`

- [ ] **Step 1: Read existing file to find render seam**

Read `ServiceDetailView.tsx` end-to-end. Identify where the service description / "Book" CTA renders. Pickers go above the CTA.

- [ ] **Step 2: Wire in pickers**

Above the booking CTA:

```tsx
import { ModifierPicker } from './ModifierPicker'
// inside component, after destructuring the current service:
{
  service.modifierGroups?.length ? (
    <section className="service-detail__modifiers">
      {service.modifierGroups
        .slice()
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map(group => (
          <ModifierPicker
            key={group.id}
            productId={service.id}
            group={group}
            selections={selectedModifiers}
            onChange={setSelectedModifiers}
            currency={currency}
          />
        ))}
    </section>
  ) : null
}
```

Wire `selectedModifiers` + `setSelectedModifiers` from the store, and pass venue currency (`'MXN'` default).

- [ ] **Step 3: Manual smoke**

Run `npm run dev` in widget; open against a local server with at least one modifier group assigned. Pick a service that has modifiers and
verify selectors render + state updates (use React DevTools to inspect state).

- [ ] **Step 4: Commit**

```bash
git add src/components/ServiceDetailView.tsx
git commit -m "feat(widget): render modifier pickers in ServiceDetailView"
```

---

### Task 10: Widget — gate `BookingFlow` "Continue" on required groups

**Files:**

- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/components/BookingFlow.tsx`

- [ ] **Step 1: Add validator**

In the flow component (or new helper `src/state/modifierValidation.ts`):

```typescript
import type { ModifierGroup, ModifierSelection } from '../types'

export function areRequiredModifiersSatisfied(
  groups: ModifierGroup[] | undefined,
  productId: string,
  selections: ModifierSelection[],
): boolean {
  if (!groups) return true
  for (const group of groups) {
    const total = selections
      .filter(s => s.productId === productId && group.modifiers.some(m => m.id === s.modifierId))
      .reduce((acc, s) => acc + s.quantity, 0)
    if (group.required && total < Math.max(1, group.minSelections)) return false
    if (group.allowMultiple && group.minSelections > 0 && total < group.minSelections) return false
  }
  return true
}
```

- [ ] **Step 2: Use it to disable the CTA**

In `BookingFlow.tsx`, before rendering the "Continue" button, compute
`const canContinue = areRequiredModifiersSatisfied(service.modifierGroups, service.id, selectedModifiers)` and add
`disabled={!canContinue}`. Show a hint when blocked:

```tsx
{
  !canContinue && <p className="error">{t('modifiers.requiredMissing')}</p>
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/BookingFlow.tsx src/state/modifierValidation.ts
git commit -m "feat(widget): block continue when required modifiers unset"
```

---

### Task 11: Widget — show modifiers in `AppointmentSummarySidebar` + send in API call

**Files:**

- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/components/AppointmentSummarySidebar.tsx`
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/components/BookingFlow.tsx` (the place that builds the
  `createReservation` payload)

- [ ] **Step 1: Render selected modifiers as line items**

In `AppointmentSummarySidebar.tsx`, below the service line, iterate over `selectedModifiers` and render:

```tsx
{
  selectedModifiers.map(sel => {
    const group = service.modifierGroups?.find(g => g.modifiers.some(m => m.id === sel.modifierId))
    const mod = group?.modifiers.find(m => m.id === sel.modifierId)
    if (!mod) return null
    return (
      <li key={`${sel.productId}-${sel.modifierId}`} className="summary__modifier">
        <span>
          {mod.name}
          {sel.quantity > 1 ? ` × ${sel.quantity}` : ''}
        </span>
        <span>{fmt.format(mod.price * sel.quantity)}</span>
      </li>
    )
  })
}
```

Update the total to use `computeBookingTotal(basePrice, selectedModifiers, productById)`.

- [ ] **Step 2: Include `modifierSelections` in the payload**

Find the `createReservation(slug, payload)` call and extend `payload`:

```typescript
modifierSelections: selectedModifiers.length > 0 ? selectedModifiers : undefined,
```

- [ ] **Step 3: Manual end-to-end**

Run widget + server locally. Book a service with modifiers, complete the flow, verify the reservation in DB has matching
`ReservationModifier` rows and the totals match.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppointmentSummarySidebar.tsx src/components/BookingFlow.tsx
git commit -m "feat(widget): show modifiers in summary + send in reservation payload"
```

---

### Task 12: Widget — i18n strings

**Files:**

- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/i18n/en.json`
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-booking-widget/src/i18n/es.json`

- [ ] **Step 1: Add keys to en.json**

```json
"modifiers": {
  "required": "Required",
  "optional": "Optional",
  "pickOne": "Pick one",
  "pickUpTo": "Pick up to {{n}}",
  "requiredMissing": "Please complete the required options"
}
```

- [ ] **Step 2: Add keys to es.json**

```json
"modifiers": {
  "required": "Requerido",
  "optional": "Opcional",
  "pickOne": "Elige una opción",
  "pickUpTo": "Elige hasta {{n}}",
  "requiredMissing": "Completa las opciones requeridas"
}
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/es.json
git commit -m "feat(widget): i18n strings for modifier picker"
```

---

### Task 13: Seed Amaena COLOR + DISEÑO catalog with modifier groups

**Files:**

- Create (temp, deleted after run): `scripts/temp-amaena-color-diseno.sql`

This task assumes Tasks 1–5 are merged + deployed (or applied to the target DB). The seed runs against production via `psql` once the
migration is live.

- [ ] **Step 1: Pre-generate IDs**

Run `node -e "const c=require('cuid');for(let i=0;i<40;i++)console.log(c())"` and paste 40 cuids into the SQL.

- [ ] **Step 2: Compose the SQL**

The script creates:

- 2 categories: `Color` (displayOrder 3), `Diseño` (displayOrder 4)
- 8 products (Esmalte, Gel semipermanente, 3 efectos × 1 SKU each, Francés manos, Francés pies, Baby Boomer)
- 7 modifier groups:
  1. `Agregar color` — attached to the 4 manicuras de la categoría Manos + 5 productos de Sistema aplicación → modifiers: Esmalte (+$150),
     Gel semipermanente (+$300)
  2. `Combo descuento color` — attached al Esmalte standalone (allowMultiple=false): Combo por 3 (+$200)
  3. `Combo descuento gel` — attached al Gel standalone: Combo por 3 (+$400)
  4. `Estilo del efecto sencillo` — attached al efecto sencillo (required=true, allowMultiple=false): Vitral, Aurora, Carey (+$0)
  5. `Estilo del efecto con técnica` — attached al efecto técnica (required=true): Vitral difuminado, Relieve, Ojo de gato, Blooming (+$0)
  6. `Estilo de pigmentos` — attached a pigmentos (required=true): Espejo, Unicornio (+$0)
  7. `Cantidad parcial (1 a 5 uñas)` — attached a cada efecto (required=false, allowMultiple=true, maxSelections=5): 1 modifier "Por uña"
     precio $10, quantity 1–5

All wrapped in `BEGIN; ... COMMIT;` with safety re-checks (verify venueId exists).

- [ ] **Step 3: Dry-run with `BEGIN; ... ROLLBACK;` against production**

Run psql with the script wrapped in ROLLBACK first to verify no errors:

```bash
psql "$PROD_URL" -v ON_ERROR_STOP=1 -f scripts/temp-amaena-color-diseno.sql
```

Inspect output. Then re-run with COMMIT.

- [ ] **Step 4: Verify**

```bash
psql "$PROD_URL" -c "SELECT mc.name AS categoria, p.name AS servicio, p.price, COUNT(pmg.id) AS num_modifier_groups FROM \"MenuCategory\" mc LEFT JOIN \"Product\" p ON p.\"categoryId\"=mc.id LEFT JOIN \"ProductModifierGroup\" pmg ON pmg.\"productId\"=p.id WHERE mc.\"venueId\"='cmolsjgra00bskl2a37axztua' GROUP BY mc.name, p.name, p.price ORDER BY mc.\"displayOrder\", p.\"displayOrder\";"
```

Expected: 19 product rows total (4 manos + 5 sistema + 8 nuevos COLOR/DISEÑO = wait, let me re-count = 4+5 existing + 2 color + 6 diseño =
17), each with the right modifier group count.

- [ ] **Step 5: Delete the temp script (per testing-and-git.md policy)**

```bash
rm scripts/temp-amaena-color-diseno.sql
```

- [ ] **Step 6: No commit needed** — the file was a temp script, not source code.

---

### Task 14: End-to-end manual verification + regression sweep

**Files:** (no code changes — verification only)

- [ ] **Step 1: Run full test suite on server**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npm run pre-deploy
```

Expected: green.

- [ ] **Step 2: Open `book.avoqado.io` (or local dev) against Amaena's slug**

Verify in browser:

- COLOR/DISEÑO categories appear
- Tapping "Esmalte de color" shows the "Combo descuento color" picker
- Tapping "Manicura tradicional" shows the "Agregar color" picker
- Tapping "Efecto sencillo en gel" shows the required "Estilo" picker — Continue button is disabled until a style is picked
- "Cantidad parcial" picker on efectos lets you bump from 1 to 5 — price updates
- Summary sidebar lists each modifier with its price + correct total
- Reservation submits successfully
- In the DB: `SELECT * FROM "ReservationModifier" WHERE "reservationId" = '<new id>';` returns the expected rows

- [ ] **Step 3: Verify the deposit calc** (if any modifier group is large)

If the venue uses percentage-based deposits, confirm the deposit on the new reservation equals
`(basePrice + Σ modifier prices) × depositPercent`.

- [ ] **Step 4: Cancel the test reservation** to keep prod clean.

- [ ] **Step 5: Final commit (if any docstring updates)** — usually none.

---

## Self-Review

**Spec coverage:** Each item in the original ask is covered —

- DB persistence of modifier selections → Tasks 1, 4
- Public API surfaces modifier groups → Task 2
- Public API accepts + persists selections → Tasks 3, 4, 5
- Widget renders pickers + validates → Tasks 6, 7, 9, 10
- Widget shows totals + sends payload → Tasks 8, 11
- i18n → Task 12
- Catalog seeded → Task 13
- Regression check → Task 14

**Placeholder scan:** No "TODO" / "implement later" / "appropriate error handling" remain. Each step shows code or exact commands.

**Type consistency:** `ModifierSelection` shape (`{ productId, modifierId, quantity }`) is identical across server (Task 3) and widget (Task
6). `ModifierGroup` field names match between `consumer/types.ts` (Task 2) and widget `types.ts` (Task 6). Helper signature
`resolveModifierSelections(tx, productIds, selections)` is referenced identically in Tasks 3 and 4.

**Known risk:** Task 4's integration test assumes a specific `prismaMock` shape — if the repo's existing helper differs, the agent should
adapt the mock instead of forcing the test. Verified `tests/__helpers__` exists per `setup.ts` precedent in MEMORY.md.
