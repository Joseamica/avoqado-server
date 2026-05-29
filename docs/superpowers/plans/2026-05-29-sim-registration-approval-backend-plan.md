# SIM Registration Approval — Backend Implementation Plan (avoqado-server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En avoqado-server, hacer que el alta de SIMs desde la TPV genere una *solicitud de aprobación* (en vez de inventario vendible) cuando la org está en modo `ENFORCE`, dar al OWNER endpoints para aprobar/rechazar, y bloquear la venta de SIMs no aprobadas.

**Architecture:** Capa aditiva sobre el sistema de custodia existente. Dos modelos Prisma nuevos (`SimRegistrationRequest`, `SimRegistrationRequestItem`) + un servicio nuevo (`simRegistration.service.ts`). El endpoint TPV `register-batch` se bifurca según `Organization.simCustodyEnforcementMode`. Al aprobar, se crean `SerializedItem` en `ADMIN_HELD` reutilizando la cadena de custodia ya existente (Owner→Supervisor→Promotor→acepta). El gate de venta `applyCustodyPrecheck` (ya implementado) se activa poniendo la org en `ENFORCE`. **No se modifica `SerializedItem` ni la state machine de custodia.**

**Tech Stack:** Express + TypeScript, PostgreSQL/Prisma, Zod (validación, mensajes ES), Jest (`npm run test:unit`).

**Spec:** `../../avoqado-tpv/docs/superpowers/specs/2026-05-29-sim-registration-approval-design.md`

---

## File Structure

**Crear:**
- `prisma/migrations/<timestamp>_sim_registration_requests/migration.sql` — migración aditiva (generada por Prisma).
- `src/services/serialized-inventory/simRegistration.service.ts` — lógica de solicitudes (crear, listar, aprobar, rechazar, contar) + helper `isApprovalModeEnabled`.
- `src/controllers/dashboard/simRegistration.dashboard.controller.ts` — controladores thin (Zod ES + tenant check + delega al servicio).
- `src/routes/dashboard/simRegistration.dashboard.routes.ts` — rutas dashboard (auth + rate-limit + permiso).
- `tests/unit/services/serialized-inventory/simRegistration.service.test.ts` — tests del servicio (puros + con mock de Prisma).
- `tests/unit/services/serialized-inventory/iccidFormat.test.ts` — test del validador de formato ICCID.

**Modificar:**
- `prisma/schema.prisma` — 2 modelos + 2 enums + relaciones inversas opcionales.
- `src/services/serialized-inventory/serializedInventory.service.ts` — extraer/usar `isValidMxIccid`, bloquear `registerAndSell` en modo ENFORCE.
- `src/routes/tpv.routes.ts:5838` — bifurcar `register-batch` a `createRequest` cuando la org está en ENFORCE; mantener respuesta retrocompatible.
- `src/routes/tpv.routes.ts` (sell endpoint ~6060) — devolver `SIM_NOT_REGISTERED` claro cuando se intente vender no-registrada en ENFORCE.
- `src/lib/permissions.ts` — permiso `sim-custody:approve-registration` (OWNER + SUPERADMIN).
- `src/routes/dashboard.routes.ts:3582` — montar el router nuevo bajo `/organizations/:orgId`.

---

## Task 1: Validador de formato ICCID (compartido, DB-free)

Extrae el guard de formato mexicano a una función reutilizable en el servicio. Hoy el regex
vive solo en la TPV; el backend necesita su propia copia como defensa en profundidad.

**Files:**
- Modify: `src/services/serialized-inventory/serializedInventory.service.ts` (agregar export `isValidMxIccid` cerca de `normalizeSerial`, ~línea 30)
- Test: `tests/unit/services/serialized-inventory/iccidFormat.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/serialized-inventory/iccidFormat.test.ts
/**
 * Format guard for Mexican ICCIDs (ITU-T E.118): 8952 prefix + 15-16 digits,
 * optional trailing F. Mirrors the TPV regex (SerializedInventoryViewModel.kt:441).
 */
import { isValidMxIccid } from '@/services/serialized-inventory/serializedInventory.service'

describe('isValidMxIccid', () => {
  it('accepts a real 19-digit ALTAN ICCID', () => {
    expect(isValidMxIccid('8952140000001234567')).toBe(true)
  })
  it('accepts a 20-digit ICCID', () => {
    expect(isValidMxIccid('89521400000012345678')).toBe(true)
  })
  it('accepts a trailing F (BCD padding)', () => {
    expect(isValidMxIccid('8952140000001234567F')).toBe(true)
  })
  it('normalizes lowercase f and surrounding whitespace before checking', () => {
    expect(isValidMxIccid('  8952140000001234567f  ')).toBe(true)
  })
  it('rejects a non-8952 prefix', () => {
    expect(isValidMxIccid('8951140000001234567')).toBe(false)
  })
  it('rejects too-short input', () => {
    expect(isValidMxIccid('895214000000')).toBe(false)
  })
  it('rejects letters in the middle', () => {
    expect(isValidMxIccid('89521400ABCD01234567')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/serialized-inventory/iccidFormat.test.ts`
Expected: FAIL — `isValidMxIccid is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

En `serializedInventory.service.ts`, justo después de `normalizeSerial` (~línea 38), agregar:

```typescript
/**
 * Mexican ICCID format guard per ITU-T E.118: `8952` (MII 89 + country MX 52) +
 * 15-16 digits + optional trailing `F` (BCD padding). Verified against 1,021 real
 * ALTAN SIMs. Mirrors the TPV regex (SerializedInventoryViewModel.kt MX_ICCID_REGEX).
 * Defense-in-depth: the TPV validates first, this re-validates server-side.
 */
const MX_ICCID_REGEX = /^8952\d{15,16}F?$/
export function isValidMxIccid(raw: string): boolean {
  return MX_ICCID_REGEX.test(normalizeSerial(raw))
}
```

> Verifica que `normalizeSerial` haga trim + uppercase. Si solo hace uppercase sin trim,
> usar `normalizeSerial(raw.trim())` aquí.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/serialized-inventory/iccidFormat.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/serialized-inventory/serializedInventory.service.ts tests/unit/services/serialized-inventory/iccidFormat.test.ts
git commit -m "feat(sim-registration): add isValidMxIccid server-side format guard"
```

---

## Task 2: Modelos Prisma + migración (aditivo)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_sim_registration_requests/migration.sql` (generada)

- [ ] **Step 1: Agregar enums** al final de la sección de enums serializados (después de `SerializedItemCustodyEventType`, ~línea 7531):

```prisma
enum SimRegistrationRequestStatus {
  PENDING
  APPROVED
  REJECTED
  PARTIAL
}

enum SimRegistrationItemStatus {
  PENDING
  APPROVED
  REJECTED
  DUPLICATE
}
```

- [ ] **Step 2: Agregar modelos** después de `SerializedItemCustodyEvent` (~línea 7555):

```prisma
/// Solicitud de alta de SIMs creada por un promotor desde la TPV cuando la org
/// está en modo ENFORCE. Al aprobar, se crean SerializedItem en ADMIN_HELD.
/// Capa aditiva: NO reemplaza ni modifica SerializedItem.
model SimRegistrationRequest {
  id                    String   @id @default(cuid())
  organizationId        String
  organization          Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  registeredFromVenueId String?
  registeredFromVenue   Venue?   @relation("SimRegRequestVenue", fields: [registeredFromVenueId], references: [id])
  requestedByStaffId    String
  requestedBy           Staff    @relation("SimRegRequestRequester", fields: [requestedByStaffId], references: [id])
  proposedCategoryId    String?
  proposedCategory      ItemCategory? @relation("SimRegRequestCategory", fields: [proposedCategoryId], references: [id])
  status                SimRegistrationRequestStatus @default(PENDING)
  reviewedByStaffId     String?
  reviewedBy            Staff?   @relation("SimRegRequestReviewer", fields: [reviewedByStaffId], references: [id])
  reviewedAt            DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  items                 SimRegistrationRequestItem[]

  @@index([organizationId, status])
  @@index([requestedByStaffId])
}

model SimRegistrationRequestItem {
  id                      String  @id @default(cuid())
  requestId               String
  request                 SimRegistrationRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  serialNumber            String
  status                  SimRegistrationItemStatus @default(PENDING)
  rejectionReason         String?
  createdSerializedItemId String?
  createdAt               DateTime @default(now())

  @@unique([requestId, serialNumber])
  @@index([serialNumber])
}
```

- [ ] **Step 3: Agregar relaciones inversas opcionales** (arrays) en los modelos existentes:

En `model Organization` (~línea 60-80), agregar:
```prisma
  simRegistrationRequests SimRegistrationRequest[]
```
En `model Venue`, agregar:
```prisma
  simRegRequestsFromHere SimRegistrationRequest[] @relation("SimRegRequestVenue")
```
En `model Staff`, agregar:
```prisma
  simRegRequestsMade     SimRegistrationRequest[] @relation("SimRegRequestRequester")
  simRegRequestsReviewed SimRegistrationRequest[] @relation("SimRegRequestReviewer")
```
En `model ItemCategory` (~línea 7369), agregar:
```prisma
  simRegRequests SimRegistrationRequest[] @relation("SimRegRequestCategory")
```

- [ ] **Step 4: Validar el schema**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 5: Generar la migración**

Run: `npx prisma migrate dev --name sim_registration_requests`
Expected: migración creada; `prisma generate` corre automáticamente.

- [ ] **Step 6: Verificar que la migración es aditiva**

Run: `grep -iE "DROP|ALTER TABLE \"SerializedItem\"|ALTER TABLE \"ItemCategory\"" prisma/migrations/*sim_registration_requests*/migration.sql`
Expected: SIN salida (solo `CREATE TABLE`/`CREATE TYPE` + `ALTER TABLE ... ADD CONSTRAINT` para FKs nuevas). Cero DROP/cambio destructivo en tablas existentes.

- [ ] **Step 7: Typecheck**

Run: `npm run build`
Expected: compila sin errores (los nuevos tipos Prisma existen).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(sim-registration): add SimRegistrationRequest models (additive migration)"
```

---

## Task 3: Servicio — `isApprovalModeEnabled` + `createRequest`

**Files:**
- Create: `src/services/serialized-inventory/simRegistration.service.ts`
- Test: `tests/unit/services/serialized-inventory/simRegistration.service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/serialized-inventory/simRegistration.service.test.ts
import { SimRegistrationService } from '@/services/serialized-inventory/simRegistration.service'

// Minimal Prisma mock — only the methods the service touches.
function makeDb(overrides: any = {}) {
  return {
    organization: { findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: 'ENFORCE' }) },
    serializedItem: { findMany: jest.fn().mockResolvedValue([]) },
    simRegistrationRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'req_1', ...data })),
    },
    simRegistrationRequestItem: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(makeTxStub())),
    ...overrides,
  } as any
}
function makeTxStub() {
  return {
    simRegistrationRequest: { create: jest.fn().mockResolvedValue({ id: 'req_1' }) },
    simRegistrationRequestItem: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  }
}

describe('SimRegistrationService.isApprovalModeEnabled', () => {
  it('returns true when org is ENFORCE', async () => {
    const db = makeDb()
    const svc = new SimRegistrationService(db)
    expect(await svc.isApprovalModeEnabled('org_1')).toBe(true)
  })
  it('returns false when org is OFF', async () => {
    const db = makeDb({ organization: { findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: 'OFF' }) } })
    const svc = new SimRegistrationService(db)
    expect(await svc.isApprovalModeEnabled('org_1')).toBe(false)
  })
  it('returns false when org missing', async () => {
    const db = makeDb({ organization: { findUnique: jest.fn().mockResolvedValue(null) } })
    const svc = new SimRegistrationService(db)
    expect(await svc.isApprovalModeEnabled('org_x')).toBe(false)
  })
})

describe('SimRegistrationService.createRequest', () => {
  it('rejects ICCIDs with bad format (status DUPLICATE not used; returns invalid list)', async () => {
    const db = makeDb()
    const svc = new SimRegistrationService(db)
    const res = await svc.createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      registeredFromVenueId: 'venue_1',
      proposedCategoryId: 'cat_1',
      serialNumbers: ['BADFORMAT123'],
    })
    expect(res.invalid).toContain('BADFORMAT123')
    expect(res.submitted).toBe(0)
  })

  it('marks already-existing SerializedItems as duplicates', async () => {
    const db = makeDb({
      serializedItem: { findMany: jest.fn().mockResolvedValue([{ serialNumber: '8952140000001234567' }]) },
    })
    const svc = new SimRegistrationService(db)
    const res = await svc.createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      registeredFromVenueId: 'venue_1',
      proposedCategoryId: 'cat_1',
      serialNumbers: ['8952140000001234567'],
    })
    expect(res.duplicates).toContain('8952140000001234567')
    expect(res.submitted).toBe(0)
  })

  it('creates a request with valid new ICCIDs', async () => {
    const db = makeDb()
    const svc = new SimRegistrationService(db)
    const res = await svc.createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      registeredFromVenueId: 'venue_1',
      proposedCategoryId: 'cat_1',
      serialNumbers: ['8952140000001234567', '89521400000012345678'],
    })
    expect(res.submitted).toBe(2)
    expect(res.requestId).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/serialized-inventory/simRegistration.service.test.ts`
Expected: FAIL — module/class not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/serialized-inventory/simRegistration.service.ts
import { Prisma, PrismaClient, SimRegistrationItemStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { isValidMxIccid, normalizeSerial } from './serializedInventory.service'

export interface CreateRequestInput {
  organizationId: string
  requestedByStaffId: string
  registeredFromVenueId?: string | null
  proposedCategoryId?: string | null
  serialNumbers: string[]
}

export interface CreateRequestResult {
  requestId: string | null
  submitted: number
  duplicates: string[]
  invalid: string[]
}

export class SimRegistrationService {
  constructor(private db: PrismaClient = prisma) {}

  /** Approval feature + sale gate share one switch: org.simCustodyEnforcementMode === 'ENFORCE'. */
  async isApprovalModeEnabled(organizationId: string): Promise<boolean> {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { simCustodyEnforcementMode: true },
    })
    return org?.simCustodyEnforcementMode === 'ENFORCE'
  }

  async createRequest(input: CreateRequestInput): Promise<CreateRequestResult> {
    const normalized = input.serialNumbers.map(normalizeSerial)
    const invalid = normalized.filter(sn => !isValidMxIccid(sn))
    const wellFormed = normalized.filter(sn => isValidMxIccid(sn))

    // Dedup vs existing SerializedItem (org scope, case-insensitive handled by storing normalized).
    const existing = await this.db.serializedItem.findMany({
      where: { organizationId: input.organizationId, serialNumber: { in: wellFormed } },
      select: { serialNumber: true },
    })
    const existingSet = new Set(existing.map(e => e.serialNumber))

    // Dedup vs other PENDING requests in this org.
    const pendingItems = await this.db.simRegistrationRequestItem.findMany({
      where: {
        serialNumber: { in: wellFormed },
        status: 'PENDING',
        request: { organizationId: input.organizationId, status: 'PENDING' },
      },
      select: { serialNumber: true },
    })
    const pendingSet = new Set(pendingItems.map(p => p.serialNumber))

    const duplicates = wellFormed.filter(sn => existingSet.has(sn) || pendingSet.has(sn))
    const toSubmit = wellFormed.filter(sn => !existingSet.has(sn) && !pendingSet.has(sn))

    if (toSubmit.length === 0) {
      return { requestId: null, submitted: 0, duplicates, invalid }
    }

    const request = await this.db.simRegistrationRequest.create({
      data: {
        organizationId: input.organizationId,
        requestedByStaffId: input.requestedByStaffId,
        registeredFromVenueId: input.registeredFromVenueId ?? null,
        proposedCategoryId: input.proposedCategoryId ?? null,
        status: 'PENDING',
        items: {
          create: toSubmit.map(serialNumber => ({
            serialNumber,
            status: 'PENDING' as SimRegistrationItemStatus,
          })),
        },
      },
      select: { id: true },
    })

    return { requestId: request.id, submitted: toSubmit.length, duplicates, invalid }
  }
}

export const simRegistrationService = new SimRegistrationService()
```

> Nota: el test mockea `simRegistrationRequest.create` (no usa `$transaction` para createRequest).
> Si prefieres transacción, ajusta el test. La versión simple de arriba usa create anidado
> (atómico por sí mismo) — suficiente porque crea una sola fila + sus items.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/serialized-inventory/simRegistration.service.test.ts`
Expected: PASS (isApprovalModeEnabled ×3 + createRequest ×3).

- [ ] **Step 5: Commit**

```bash
git add src/services/serialized-inventory/simRegistration.service.ts tests/unit/services/serialized-inventory/simRegistration.service.test.ts
git commit -m "feat(sim-registration): service createRequest + isApprovalModeEnabled"
```

---

## Task 4: Servicio — `approve`, `reject`, `listPending`, `countPending`

**Files:**
- Modify: `src/services/serialized-inventory/simRegistration.service.ts`
- Test: `tests/unit/services/serialized-inventory/simRegistration.service.test.ts` (añadir describes)

- [ ] **Step 1: Write the failing tests** (añadir al archivo de test)

```typescript
function makeApproveDb(items: any[], orgItems: any[] = []) {
  const txStub = {
    simRegistrationRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'req_1', organizationId: 'org_1', requestedByStaffId: 'staff_1',
        registeredFromVenueId: 'venue_1', proposedCategoryId: 'cat_1', status: 'PENDING',
        items,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    simRegistrationRequestItem: { update: jest.fn().mockResolvedValue({}) },
    serializedItem: {
      findMany: jest.fn().mockResolvedValue(orgItems),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'item_new', ...data })),
    },
  }
  const db: any = {
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(txStub)),
  }
  return { db, txStub }
}

describe('SimRegistrationService.approve', () => {
  it('creates a SerializedItem in ADMIN_HELD per approved item and marks item APPROVED', async () => {
    const { db, txStub } = makeApproveDb([
      { id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING' },
    ])
    const svc = new SimRegistrationService(db)
    const res = await svc.approve({
      organizationId: 'org_1', requestId: 'req_1', reviewedByStaffId: 'owner_1', categoryId: 'cat_1',
    })
    expect(txStub.serializedItem.create).toHaveBeenCalledTimes(1)
    const createArg = txStub.serializedItem.create.mock.calls[0][0].data
    expect(createArg.custodyState).toBe('ADMIN_HELD')
    expect(createArg.organizationId).toBe('org_1')
    expect(createArg.createdBy).toBe('staff_1') // promoter who requested
    expect(res.approved).toBe(1)
  })

  it('skips items that already exist (idempotent re-approval marks DUPLICATE, no double create)', async () => {
    const { db, txStub } = makeApproveDb(
      [{ id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING' }],
      [{ serialNumber: '8952140000001234567' }], // already in SerializedItem
    )
    const svc = new SimRegistrationService(db)
    const res = await svc.approve({
      organizationId: 'org_1', requestId: 'req_1', reviewedByStaffId: 'owner_1', categoryId: 'cat_1',
    })
    expect(txStub.serializedItem.create).not.toHaveBeenCalled()
    expect(res.approved).toBe(0)
    expect(res.duplicates).toBe(1)
  })
})

describe('SimRegistrationService.reject', () => {
  it('marks items REJECTED with reason and creates no SerializedItem', async () => {
    const { db, txStub } = makeApproveDb([
      { id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING' },
    ])
    const svc = new SimRegistrationService(db)
    const res = await svc.reject({
      organizationId: 'org_1', requestId: 'req_1', reviewedByStaffId: 'owner_1', reason: 'ICCID ilegible',
    })
    expect(txStub.serializedItem.create).not.toHaveBeenCalled()
    expect(txStub.simRegistrationRequestItem.update).toHaveBeenCalled()
    expect(res.rejected).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/serialized-inventory/simRegistration.service.test.ts`
Expected: FAIL — `approve`/`reject` not defined.

- [ ] **Step 3: Write minimal implementation** (añadir métodos a la clase)

```typescript
export interface ApproveInput {
  organizationId: string
  requestId: string
  reviewedByStaffId: string
  serialNumbers?: string[] // subset; omit = all PENDING items
  categoryId: string
}
export interface ApproveResult { approved: number; duplicates: number; requestStatus: string }

export interface RejectInput {
  organizationId: string
  requestId: string
  reviewedByStaffId: string
  serialNumbers?: string[]
  reason: string
}
export interface RejectResult { rejected: number; requestStatus: string }
```

```typescript
  async approve(input: ApproveInput): Promise<ApproveResult> {
    return this.db.$transaction(async tx => {
      const request = await tx.simRegistrationRequest.findUnique({
        where: { id: input.requestId },
        include: { items: true },
      })
      if (!request || request.organizationId !== input.organizationId) {
        throw new Error('REQUEST_NOT_FOUND')
      }

      const targetSet = input.serialNumbers ? new Set(input.serialNumbers.map(normalizeSerial)) : null
      const pending = request.items.filter(
        (it: any) => it.status === 'PENDING' && (!targetSet || targetSet.has(it.serialNumber)),
      )

      // Re-dedup inside the tx: another approval/upload may have created the SIM.
      const serials = pending.map((it: any) => it.serialNumber)
      const existing = await tx.serializedItem.findMany({
        where: { organizationId: input.organizationId, serialNumber: { in: serials } },
        select: { serialNumber: true },
      })
      const existingSet = new Set(existing.map((e: any) => e.serialNumber))

      let approved = 0
      let duplicates = 0
      for (const it of pending) {
        if (existingSet.has(it.serialNumber)) {
          await tx.simRegistrationRequestItem.update({
            where: { id: it.id },
            data: { status: 'DUPLICATE' },
          })
          duplicates++
          continue
        }
        const created = await tx.serializedItem.create({
          data: {
            organizationId: input.organizationId,
            categoryId: input.categoryId,
            serialNumber: it.serialNumber,
            createdBy: request.requestedByStaffId,
            registeredFromVenueId: request.registeredFromVenueId,
            status: 'AVAILABLE',
            custodyState: 'ADMIN_HELD',
          },
          select: { id: true },
        })
        await tx.simRegistrationRequestItem.update({
          where: { id: it.id },
          data: { status: 'APPROVED', createdSerializedItemId: created.id },
        })
        approved++
      }

      const requestStatus = await this.recalcStatus(tx, input.requestId)
      await tx.simRegistrationRequest.update({
        where: { id: input.requestId },
        data: { status: requestStatus as any, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() },
      })
      return { approved, duplicates, requestStatus }
    })
  }

  async reject(input: RejectInput): Promise<RejectResult> {
    return this.db.$transaction(async tx => {
      const request = await tx.simRegistrationRequest.findUnique({
        where: { id: input.requestId },
        include: { items: true },
      })
      if (!request || request.organizationId !== input.organizationId) {
        throw new Error('REQUEST_NOT_FOUND')
      }
      const targetSet = input.serialNumbers ? new Set(input.serialNumbers.map(normalizeSerial)) : null
      const pending = request.items.filter(
        (it: any) => it.status === 'PENDING' && (!targetSet || targetSet.has(it.serialNumber)),
      )
      let rejected = 0
      for (const it of pending) {
        await tx.simRegistrationRequestItem.update({
          where: { id: it.id },
          data: { status: 'REJECTED', rejectionReason: input.reason },
        })
        rejected++
      }
      const requestStatus = await this.recalcStatus(tx, input.requestId)
      await tx.simRegistrationRequest.update({
        where: { id: input.requestId },
        data: { status: requestStatus as any, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() },
      })
      return { rejected, requestStatus }
    })
  }

  private async recalcStatus(tx: Prisma.TransactionClient, requestId: string): Promise<string> {
    const items = await tx.simRegistrationRequestItem.findMany({
      where: { requestId },
      select: { status: true },
    })
    const hasPending = items.some(i => i.status === 'PENDING')
    if (hasPending) return 'PENDING'
    const approvedCount = items.filter(i => i.status === 'APPROVED').length
    const rejectedish = items.filter(i => i.status === 'REJECTED' || i.status === 'DUPLICATE').length
    if (approvedCount > 0 && rejectedish > 0) return 'PARTIAL'
    if (approvedCount > 0) return 'APPROVED'
    return 'REJECTED'
  }

  async listPending(organizationId: string) {
    return this.db.simRegistrationRequest.findMany({
      where: { organizationId, status: 'PENDING' },
      include: {
        items: true,
        requestedBy: { select: { id: true, firstName: true, lastName: true } },
        registeredFromVenue: { select: { id: true, name: true } },
        proposedCategory: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async countPending(organizationId: string): Promise<number> {
    return this.db.simRegistrationRequest.count({ where: { organizationId, status: 'PENDING' } })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/serialized-inventory/simRegistration.service.test.ts`
Expected: PASS (approve ×2, reject ×1 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/serialized-inventory/simRegistration.service.ts tests/unit/services/serialized-inventory/simRegistration.service.test.ts
git commit -m "feat(sim-registration): service approve/reject/listPending/countPending"
```

---

## Task 5: Permiso `sim-custody:approve-registration`

**Files:**
- Modify: `src/lib/permissions.ts`

- [ ] **Step 1: Agregar a PERMISSION_DEPENDENCIES** (junto a las otras `sim-custody:*`, ~línea 322):

```typescript
  'sim-custody:approve-registration': ['sim-custody:approve-registration', 'sim-custody:assign-to-supervisor', 'inventory:read'], // OWNER aprueba/rechaza solicitudes de alta de SIMs creadas por promotores en la TPV
```

- [ ] **Step 2: Agregar al rol OWNER en DEFAULT_PERMISSIONS** (junto a las otras `sim-custody:*` del OWNER, ~línea 849):

```typescript
    'sim-custody:approve-registration', // Aprobar/rechazar solicitudes de alta de SIMs
```

- [ ] **Step 3: Verificar que SUPERADMIN lo hereda** (wildcard `*:*` o lista explícita). Si SUPERADMIN usa lista explícita, agregarlo también.

Run: `grep -n "approve-registration" src/lib/permissions.ts`
Expected: aparece en dependencias + OWNER (+ SUPERADMIN si es lista explícita).

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: compila.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissions.ts
git commit -m "feat(sim-registration): add sim-custody:approve-registration permission (OWNER)"
```

---

## Task 6: Controlador + rutas dashboard (aprobar/rechazar/listar)

**Files:**
- Create: `src/controllers/dashboard/simRegistration.dashboard.controller.ts`
- Create: `src/routes/dashboard/simRegistration.dashboard.routes.ts`
- Modify: `src/routes/dashboard.routes.ts` (import + mount)

- [ ] **Step 1: Crear el controlador** (sigue el patrón de `simCustody.dashboard.controller.ts`):

```typescript
// src/controllers/dashboard/simRegistration.dashboard.controller.ts
/**
 * Dashboard controllers para solicitudes de alta de SIMs.
 * Montado bajo /dashboard/organizations/:orgId/sim-registration-requests.
 * Thin: valida (Zod ES) + tenant check + delega a SimRegistrationService.
 */
import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { simRegistrationService } from '../../services/serialized-inventory/simRegistration.service'

const ApproveBody = z.object({
  categoryId: z.string().min(1, 'La categoría es requerida'),
  serialNumbers: z.array(z.string().min(1)).optional(),
})
const RejectBody = z.object({
  reason: z.string().min(1, 'El motivo es requerido'),
  serialNumbers: z.array(z.string().min(1)).optional(),
})

function mapZodError(res: Response, error: z.ZodError) {
  res.status(422).json({ error: 'VALIDATION', message: error.errors[0]?.message ?? 'Datos inválidos' })
}
function tenantOk(req: Request): boolean {
  const { orgId, role } = (req as any).authContext ?? {}
  return orgId === req.params.orgId || role === 'SUPERADMIN'
}

export async function listRequests(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    const data = await simRegistrationService.listPending(req.params.orgId)
    res.status(200).json({ success: true, data })
  } catch (err) { next(err) }
}

export async function countRequests(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    const count = await simRegistrationService.countPending(req.params.orgId)
    res.status(200).json({ success: true, data: { count } })
  } catch (err) { next(err) }
}

export async function approveRequest(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    const parse = ApproveBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)
    const { userId } = (req as any).authContext
    const result = await simRegistrationService.approve({
      organizationId: req.params.orgId,
      requestId: req.params.id,
      reviewedByStaffId: userId,
      categoryId: parse.data.categoryId,
      serialNumbers: parse.data.serialNumbers,
    })
    res.status(200).json({ success: true, data: result })
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_NOT_FOUND') {
      return res.status(404).json({ error: 'REQUEST_NOT_FOUND', message: 'Solicitud no encontrada' })
    }
    next(err)
  }
}

export async function rejectRequest(req: Request, res: Response, next: NextFunction) {
  try {
    if (!tenantOk(req)) return res.status(403).json({ error: 'TENANT_MISMATCH', message: 'Organización no coincide' })
    const parse = RejectBody.safeParse(req.body)
    if (!parse.success) return mapZodError(res, parse.error)
    const { userId } = (req as any).authContext
    const result = await simRegistrationService.reject({
      organizationId: req.params.orgId,
      requestId: req.params.id,
      reviewedByStaffId: userId,
      reason: parse.data.reason,
      serialNumbers: parse.data.serialNumbers,
    })
    res.status(200).json({ success: true, data: result })
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_NOT_FOUND') {
      return res.status(404).json({ error: 'REQUEST_NOT_FOUND', message: 'Solicitud no encontrada' })
    }
    next(err)
  }
}
```

- [ ] **Step 2: Crear las rutas** (patrón de `simCustody.dashboard.routes.ts`):

```typescript
// src/routes/dashboard/simRegistration.dashboard.routes.ts
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import {
  approveRequest, countRequests, listRequests, rejectRequest,
} from '../../controllers/dashboard/simRegistration.dashboard.controller'

const router = Router({ mergeParams: true })
const actorKey = (req: any) => req.authContext?.userId ?? req.ip
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: actorKey,
  message: { error: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
})

router.get('/sim-registration-requests', authenticateTokenMiddleware, limiter,
  checkPermission('sim-custody:approve-registration'), listRequests)
router.get('/sim-registration-requests/count', authenticateTokenMiddleware, limiter,
  checkPermission('sim-custody:approve-registration'), countRequests)
router.post('/sim-registration-requests/:id/approve', authenticateTokenMiddleware, limiter,
  checkPermission('sim-custody:approve-registration'), approveRequest)
router.post('/sim-registration-requests/:id/reject', authenticateTokenMiddleware, limiter,
  checkPermission('sim-custody:approve-registration'), rejectRequest)

export default router
```

- [ ] **Step 3: Montar el router** en `src/routes/dashboard.routes.ts`:

Junto al import de `simCustodyDashboardRoutes` (~línea 247):
```typescript
import simRegistrationDashboardRoutes from './dashboard/simRegistration.dashboard.routes'
```
Junto al `router.use('/organizations/:orgId', simCustodyDashboardRoutes)` (~línea 3582):
```typescript
router.use('/organizations/:orgId', simRegistrationDashboardRoutes)
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: compila.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/dashboard/simRegistration.dashboard.controller.ts src/routes/dashboard/simRegistration.dashboard.routes.ts src/routes/dashboard.routes.ts
git commit -m "feat(sim-registration): dashboard endpoints approve/reject/list/count"
```

---

## Task 7: Bifurcar `register-batch` (TPV) — modo solicitud + respuesta retrocompatible

**Files:**
- Modify: `src/routes/tpv.routes.ts:5838-5906`
- Test: `tests/unit/services/serialized-inventory/simRegistration.service.test.ts` (ya cubre createRequest; aquí es wiring de ruta)

- [ ] **Step 1: Modificar el handler** `register-batch`. Tras resolver `venue.organizationId`, insertar el branch ANTES de llamar a `registerBatchOrg`/`registerBatch`:

```typescript
      const isOrgLevel = !!venue?.organizationId

      // Approval mode (org en ENFORCE): el alta NO crea inventario vendible; crea
      // una solicitud que el OWNER aprueba. Respuesta retrocompatible: las TPVs
      // viejas leen { created: 0, duplicates, assignedToYou: 0 } y NO añaden stock.
      if (isOrgLevel && (await simRegistrationService.isApprovalModeEnabled(venue!.organizationId!))) {
        const reqResult = await simRegistrationService.createRequest({
          organizationId: venue!.organizationId!,
          requestedByStaffId: staffId,
          registeredFromVenueId: venueId,
          proposedCategoryId: categoryId,
          serialNumbers,
        })
        return res.status(200).json({
          success: true,
          data: {
            created: 0,
            duplicates: reqResult.duplicates,
            assignedToYou: 0,
            // Campos nuevos opcionales (TPV nueva los usa; vieja los ignora):
            mode: 'approval',
            requestId: reqResult.requestId,
            submitted: reqResult.submitted,
            invalid: reqResult.invalid,
          },
        })
      }

      const result = isOrgLevel
        ? await serializedInventoryService.registerBatchOrg({ /* ...existing... */ })
        : await serializedInventoryService.registerBatch({ /* ...existing... */ })
```

> Agregar el import al inicio de `tpv.routes.ts`:
> `import { simRegistrationService } from '../services/serialized-inventory/simRegistration.service'`

- [ ] **Step 2: Verificar retrocompatibilidad manualmente** (revisión de código):
  - Con org en OFF → no entra al branch, comportamiento idéntico al actual.
  - Con org en ENFORCE → `data.created === 0`, `requestId` presente.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: compila.

- [ ] **Step 4: Commit**

```bash
git add src/routes/tpv.routes.ts
git commit -m "feat(sim-registration): register-batch creates approval request in ENFORCE mode"
```

---

## Task 8: Bloquear venta on-the-fly de no-registradas en ENFORCE

**Files:**
- Modify: `src/services/serialized-inventory/serializedInventory.service.ts` (método `registerAndSell`, ~línea 401) o el handler del endpoint `/serialized-inventory/sell` (`tpv.routes.ts` ~6060)
- Test: `tests/unit/services/serialized-inventory/simRegistration.service.test.ts` (añadir guard test si la lógica vive en servicio)

- [ ] **Step 1: Localizar dónde se llama `registerAndSell`** (venta de items `not_registered`):

Run: `grep -n "registerAndSell" src/routes/tpv.routes.ts src/services/**/*.ts`
Expected: identifica el handler de `/serialized-inventory/sell`.

- [ ] **Step 2: En ese handler**, antes de llamar a `registerAndSell`, agregar guard:

```typescript
      // ENFORCE: prohibido vender SIMs no registradas on-the-fly. Deben pasar por
      // alta → aprobación → custodia. Ver spec §3.3.
      const sellVenue = await prisma.venue.findUnique({
        where: { id: venueId }, select: { organizationId: true },
      })
      if (sellVenue?.organizationId &&
          (await simRegistrationService.isApprovalModeEnabled(sellVenue.organizationId))) {
        throw new AppError('Esta SIM no está dada de alta. Debe aprobarse antes de venderse.', 422, 'SIM_NOT_REGISTERED')
      }
```

> Ajustar la firma de `AppError` a la del proyecto (revisar otros usos: `new AppError(msg, status)`
> o `new AppError(msg, status, code)`).

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: compila.

- [ ] **Step 4: Commit**

```bash
git add src/routes/tpv.routes.ts
git commit -m "feat(sim-registration): block on-the-fly sale of unregistered SIMs in ENFORCE"
```

---

## Task 9: Suite completa + activar ENFORCE (deploy)

**Files:** ninguno de código (config/deploy).

- [ ] **Step 1: Correr toda la suite de serialized-inventory**

Run: `npx jest tests/unit/services/serialized-inventory`
Expected: PASS — incluye custody.state-machine, serial-normalization, iccidFormat, simRegistration.

- [ ] **Step 2: Correr build + lint**

Run: `npm run build`
Expected: compila sin errores.

- [ ] **Step 3: Audit Fase 0** (ANTES de activar). Query de seguridad:

```sql
SELECT "organizationId", COUNT(*) FROM "SerializedItem"
WHERE status = 'AVAILABLE' AND "custodyState" <> 'PROMOTER_HELD'
GROUP BY "organizationId";
```
Revisar resultados. Si hay orgs no-PlayTelecom con inventario en riesgo → activar ENFORCE solo en `cmietitbn000zpr2d8213qkzq`.

- [ ] **Step 4: Activar ENFORCE** en la(s) org(s) objetivo:

```sql
UPDATE "Organization" SET "simCustodyEnforcementMode" = 'ENFORCE'
WHERE id = 'cmietitbn000zpr2d8213qkzq';
```

- [ ] **Step 5: Deploy backend** y smoke test:
  - TPV vieja: `register-batch` sigue respondiendo (floor-version safeguard mantiene OFF para clientes < `minimumVersionWithMisSims`).
  - Endpoints de aprobación responden 200 con OWNER, 403 sin permiso.

- [ ] **Step 6: Commit** (si hubo cambios de seed/config versionados; si es solo SQL en prod, documentar en el PR).

---

## Self-Review (cobertura del spec)

- **§3.2 modelo de datos** → Task 2 ✅
- **§3.3(a) register-batch gated + retrocompat** → Task 7 ✅
- **§3.3(b) aprobar/rechazar + permiso** → Tasks 4, 5, 6 ✅
- **§3.3(c) gate de venta + bloquear registerAndSell** → Task 8 + Task 9 step 4 (activar ENFORCE) ✅
- **§4 migración aditiva + audit + orden** → Task 2 (step 6 verifica aditivo), Task 9 (audit + activar) ✅
- **§5 pruebas backend** → Tasks 1, 3, 4 (+ Task 9 suite) ✅
- **Validación formato 8952** (defensa en profundidad backend) → Task 1 ✅

Pendiente fuera de este plan (otros repos): guard de venta en TPV (8952 en SerializedSaleViewModel),
tab "Solicitudes" en dashboard. Ver plan cross-repo índice en avoqado-tpv.

**Nota de tipo:** el servicio usa `requestStatus: string` y castea a enum Prisma con `as any` al
persistir — aceptable porque `recalcStatus` solo devuelve valores válidos del enum
`SimRegistrationRequestStatus`. Si prefieres tipado estricto, importar el enum y tipar el retorno.
