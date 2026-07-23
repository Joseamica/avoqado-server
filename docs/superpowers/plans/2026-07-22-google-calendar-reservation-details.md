# Google Calendar — Detalles Completos de la Reserva: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los eventos de Google Calendar muestren todos los servicios de una cita multi-servicio, sus modificadores, duración total, total estimado y teléfono, respetando los tres niveles de privacidad por venue.

**Architecture:** Se extrae un resolvedor de servicios compartido (hoy duplicado entre el dashboard y Google Calendar) a `src/services/reservation/reservation-services.resolver.ts`. El builder de eventos (`event-body.service.ts`) se mantiene **puro y sin acceso a DB**: recibe `services` ya resuelto como argumento. `push.service.ts` resuelve pasando su `tx`. Se agrega un script de re-push manual por venue.

**Tech Stack:** TypeScript, Express, Prisma/PostgreSQL, googleapis (Calendar v3), Jest.

**Spec:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/superpowers/specs/2026-07-22-google-calendar-reservation-details-design.md`

## 🔴 ANULACIÓN — ESTA CORRIDA NO HACE COMMITS

**Instrucción directa del founder (2026-07-22): trabajar sobre `develop` en el
repo actual y NO hacer NINGÚN commit.**

Esto **anula todos los pasos de commit** que aparecen más abajo. En cada tarea:

- **NO** ejecutar `git add`, `git commit`, `git stash`, `git checkout` ni `git restore`.
- Donde un paso diga "Commit", **saltarlo** y dejar los cambios en el árbol de trabajo.
- Sustituirlo por: `git status --short` y confirmar que solo aparecen los archivos
  de esa tarea.

**Hay trabajo AJENO sin commitear en el árbol** (11 archivos de AngelPay /
merchantAccount de otra sesión). No tocarlos, no formatearlos, no revertirlos.
Si `npm run format` los modifica, revertir **solo esos** con
`git checkout -- <ruta>` y avisar en el reporte.

---

## Global Constraints

- **Rama:** `develop`, en el repo actual. **CERO commits** (ver anulación arriba).
- **Dinero en PESOS, unidades mayores, 1:1.** `Decimal`, nunca float. Nunca `* 100` aquí (`.claude/rules/critical-warnings.md`).
- **Mensajes de usuario en español.** Los eventos los lee el dueño del negocio.
- **NUNCA quitar ni renombrar campos de respuestas de API** — clientes viejos dependen de ellos.
- **El builder `event-body.service.ts` NO accede a la DB.** Se mantiene síncrono y puro; sus tests no llevan mocks de Prisma.
- **El push corre dentro de `prisma.$transaction`**: toda lectura usa el `tx`, nunca el `prisma` global.
- Tras editar TS: `npm run format && npm run lint:fix`.
- **`npm run format` reformatea markdown/JSON no relacionados** en `docs/generated` y `docs/superpowers`. Revisar `git status` y revertir esos archivos antes de commitear.
- Niveles de privacidad: **MINIMAL** = cero PII, solo URL. **SERVICE** = servicios + duración, sin nombre/teléfono/dinero. **FULL** = todo.

---

### Task 1: Resolvedor de servicios compartido

Extrae la lógica que hoy vive privada en `reservation.dashboard.service.ts` (`reservationServiceIds` / `attachServicesMany`, líneas ~532-582) a un módulo propio, con cliente Prisma inyectable para que el push pueda pasar su `tx`.

**Files:**
- Create: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/reservation/reservation-services.resolver.ts`
- Test: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/reservation/reservation-services.resolver.test.ts`

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: `ResolvedService`, `reservationServiceIds()`, `resolveServicesMany()`, `resolveServices()`. Las tareas 2, 4 y 6 los consumen.

- [ ] **Step 1: Write the failing test**

Crear `tests/unit/services/reservation/reservation-services.resolver.test.ts`:

```typescript
import { reservationServiceIds, resolveServices, resolveServicesMany } from '@/services/reservation/reservation-services.resolver'

// Cliente Prisma falso: devuelve productos en orden ARBITRARIO a propósito,
// para probar que el resolvedor restaura el orden de reserva.
const fakeClient = (products: any[]) => ({
  product: { findMany: jest.fn(async () => products) },
})

describe('reservationServiceIds', () => {
  it('usa productIds cuando la cita es multi-servicio', () => {
    expect(reservationServiceIds({ productId: 'a', productIds: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c'])
  })

  it('cae al productId líder en filas legacy de un solo servicio', () => {
    expect(reservationServiceIds({ productId: 'a', productIds: [] })).toEqual(['a'])
  })

  it('devuelve [] para reservas de solo mesa (sin servicio)', () => {
    expect(reservationServiceIds({ productId: null, productIds: [] })).toEqual([])
  })
})

describe('resolveServices', () => {
  it('preserva el ORDEN DE RESERVA aunque la DB devuelva otro orden', async () => {
    const client = fakeClient([
      { id: 'c', name: 'Tercero', price: null, duration: 20 },
      { id: 'a', name: 'Primero', price: null, duration: 75 },
      { id: 'b', name: 'Segundo', price: null, duration: 25 },
    ])

    const services = await resolveServices({ productId: 'a', productIds: ['a', 'b', 'c'] }, client as any)

    expect(services.map(s => s.name)).toEqual(['Primero', 'Segundo', 'Tercero'])
  })

  it('omite ids que ya no existen en vez de meter undefined', async () => {
    const client = fakeClient([{ id: 'a', name: 'Primero', price: null, duration: 75 }])

    const services = await resolveServices({ productId: 'a', productIds: ['a', 'borrado'] }, client as any)

    expect(services).toHaveLength(1)
    expect(services[0].name).toBe('Primero')
  })

  it('no consulta la DB cuando no hay servicios', async () => {
    const client = fakeClient([])

    const services = await resolveServices({ productId: null, productIds: [] }, client as any)

    expect(services).toEqual([])
    expect(client.product.findMany).not.toHaveBeenCalled()
  })
})

describe('resolveServicesMany', () => {
  it('resuelve N reservas con UNA sola query', async () => {
    const client = fakeClient([
      { id: 'a', name: 'A', price: null, duration: 10 },
      { id: 'b', name: 'B', price: null, duration: 20 },
    ])

    const out = await resolveServicesMany(
      [
        { id: 'r1', productId: 'a', productIds: ['a', 'b'] },
        { id: 'r2', productId: 'b', productIds: [] },
      ],
      client as any,
    )

    expect(client.product.findMany).toHaveBeenCalledTimes(1)
    expect(out[0].services.map(s => s.name)).toEqual(['A', 'B'])
    expect(out[1].services.map(s => s.name)).toEqual(['B'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest tests/unit/services/reservation/reservation-services.resolver.test.ts
```

Expected: FAIL — `Cannot find module '@/services/reservation/reservation-services.resolver'`

- [ ] **Step 3: Write minimal implementation**

Crear `src/services/reservation/reservation-services.resolver.ts`:

```typescript
/**
 * Resolvedor compartido de los servicios de una reserva.
 *
 * `Reservation.productIds` es un `String[]` ESCALAR (patrón Square), no una
 * relación, así que Prisma no puede hacer `include` de él. Sin este resolvedor
 * cada superficie inventa la suya y termina mostrando solo el servicio líder —
 * que es exactamente el bug que se corrigió en el dashboard (2026-07-21) y en
 * Google Calendar (2026-07-22). Una sola definición para toda la plataforma.
 */
import type { Prisma } from '@prisma/client'
import prismaClient from '@/utils/prismaClient'

export type ResolvedService = {
  id: string
  name: string
  price: Prisma.Decimal | null
  duration: number | null
}

/** Prisma global o una transacción. El push DEBE pasar su `tx`. */
export type PrismaLike = {
  product: { findMany: (args: any) => Promise<any[]> }
}

export type ServiceResolvable = { productId: string | null; productIds: string[] }

/**
 * Los ids de servicio de una reserva, EN ORDEN DE RESERVA. Las citas
 * multi-servicio guardan el líder en `productId` y la lista completa en
 * `productIds`; las filas legacy solo tienen `productId`.
 */
export function reservationServiceIds(r: ServiceResolvable): string[] {
  return r.productIds?.length ? r.productIds : r.productId ? [r.productId] : []
}

/** Resuelve N reservas con UNA query. Preserva el orden de reserva de cada una. */
export async function resolveServicesMany<T extends ServiceResolvable>(
  reservations: T[],
  client: PrismaLike = prismaClient,
): Promise<(T & { services: ResolvedService[] })[]> {
  const allIds = new Set<string>()
  for (const r of reservations) for (const id of reservationServiceIds(r)) allIds.add(id)

  const products = allIds.size
    ? await client.product.findMany({
        where: { id: { in: [...allIds] } },
        select: { id: true, name: true, price: true, duration: true },
      })
    : []
  const byId = new Map<string, ResolvedService>(products.map(p => [p.id, p as ResolvedService]))

  return reservations.map(r => ({
    ...r,
    // Mapear sobre la lista de ids (NO sobre `products`) mantiene el orden.
    services: reservationServiceIds(r)
      .map(id => byId.get(id))
      .filter((p): p is ResolvedService => Boolean(p)),
  }))
}

/** Variante de una sola reserva — la usa el push, que procesa fila por fila. */
export async function resolveServices(reservation: ServiceResolvable, client: PrismaLike = prismaClient): Promise<ResolvedService[]> {
  const [withServices] = await resolveServicesMany([reservation], client)
  return withServices.services
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/unit/services/reservation/reservation-services.resolver.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Format and lint**

```bash
npm run format && npm run lint:fix
git status --short
```

Revertir cualquier archivo de `docs/` que prettier haya tocado y que no sea parte de esta tarea.

- [ ] **Step 6: Commit (PEDIR PERMISO ANTES)**

```bash
git add src/services/reservation/reservation-services.resolver.ts tests/unit/services/reservation/reservation-services.resolver.test.ts
git commit -m "refactor(reservations): extract shared reservation services resolver"
```

---

### Task 2: El dashboard usa el resolvedor compartido

Reemplaza la copia privada por el módulo de la Task 1. Cambio puramente interno: la salida debe ser idéntica.

**Files:**
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/reservation.dashboard.service.ts` (borrar `reservationServiceIds` y el cuerpo de `attachServicesMany`, líneas ~532-582)

**Interfaces:**
- Consumes: `resolveServicesMany`, `ResolvedService` (Task 1).
- Produces: nada nuevo. `attachServices` / `attachServicesMany` conservan su firma para no tocar sus 4 llamadas.

- [ ] **Step 1: Confirmar la red de regresión existente**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest tests/unit/services/dashboard/reservation --silent
```

Expected: PASS — 139 tests. Este es el baseline: debe seguir en 139 al final.

- [ ] **Step 2: Reemplazar la implementación privada**

En `src/services/dashboard/reservation.dashboard.service.ts`, borrar la función `reservationServiceIds` y el cuerpo de `attachServicesMany`, y dejar `attachServicesMany` como envoltura delgada del resolvedor compartido:

```typescript
/**
 * Batched `attachServices` para listas (calendario, etc.) — UNA query de
 * productos por página. La resolución vive en el resolvedor compartido para que
 * el dashboard y Google Calendar no tengan definiciones distintas de "los
 * servicios de una reserva".
 */
async function attachServicesMany<T extends ServiceResolvable>(reservations: T[]): Promise<(T & { services: ReservationService[] })[]> {
  return resolveServicesMany(reservations)
}
```

Agregar el import arriba del archivo:

```typescript
import { resolveServicesMany, type ServiceResolvable } from '@/services/reservation/reservation-services.resolver'
```

Borrar el `type ServiceResolvable = { productId: string | null; productIds: string[] }` local (ahora viene del resolvedor).

- [ ] **Step 3: Verificar que no hay regresión**

```bash
npx jest tests/unit/services/dashboard/reservation --silent
```

Expected: PASS — **139 tests**, el mismo número del Step 1.

- [ ] **Step 4: Verificar que compila**

```bash
npx tsc --noEmit 2>&1 | grep -i "reservation" || echo "SIN ERRORES"
```

Expected: `SIN ERRORES`

- [ ] **Step 5: Format, lint y commit (PEDIR PERMISO ANTES)**

```bash
npm run format && npm run lint:fix
git status --short
git add src/services/dashboard/reservation.dashboard.service.ts
git commit -m "refactor(reservations): dashboard uses the shared services resolver"
```

---

### Task 3: Helpers de formato del evento (duración, dinero, líneas)

Helpers puros dentro del builder. Se hacen primero y aparte porque son la parte con más casos borde y merecen su propio ciclo de test.

**Files:**
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/google-calendar/event-body.service.ts`
- Test: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/google-calendar/event-body.service.test.ts`

**Interfaces:**
- Consumes: `ResolvedService` (Task 1).
- Produces: `formatDuration(minutes)`, `formatMoney(amount)`, `EventModifier`. Las tareas 4 y 5 los consumen.

- [ ] **Step 1: Write the failing test**

Añadir al final de `tests/unit/services/google-calendar/event-body.service.test.ts`:

```typescript
import { formatDuration, formatMoney } from '@/services/google-calendar/event-body.service'

describe('formatDuration', () => {
  it('menos de una hora → solo minutos', () => {
    expect(formatDuration(45)).toBe('45 min')
  })

  it('horas exactas → sin minutos colgando', () => {
    expect(formatDuration(120)).toBe('2 h')
  })

  it('horas y minutos', () => {
    expect(formatDuration(190)).toBe('3 h 10 min')
  })

  it('null / 0 → null para que el caller omita la línea', () => {
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(0)).toBeNull()
  })
})

describe('formatMoney', () => {
  it('formatea pesos mexicanos en unidades mayores (NUNCA centavos)', () => {
    expect(formatMoney(1900)).toBe('$1,900.00')
  })

  it('respeta los centavos', () => {
    expect(formatMoney(300.5)).toBe('$300.50')
  })

  it('null / 0 → null para que el caller omita la línea', () => {
    expect(formatMoney(null)).toBeNull()
    expect(formatMoney(0)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts -t "formatDuration"
```

Expected: FAIL — `formatDuration is not a function`

- [ ] **Step 3: Write minimal implementation**

Añadir a `src/services/google-calendar/event-body.service.ts`, después de `GUEST_FALLBACK`:

```typescript
/** Un modificador ya elegido en la reserva. Campos denormalizados en
 * `ReservationModifier`, así que no hace falta join con `Modifier`. */
export type EventModifier = { name: string | null; quantity: number; price: unknown }

/**
 * "3 h 10 min" — legible para el dueño de un salón mirando su celular.
 * Devuelve `null` en 0/null para que el caller OMITA la línea en vez de
 * imprimir "Duración: 0 min".
 */
export function formatDuration(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} h`
  return `${h} h ${m} min`
}

/**
 * Pesos mexicanos en UNIDADES MAYORES, 1:1 — nunca centavos
 * (`.claude/rules/critical-warnings.md`). Devuelve `null` en 0/null para que el
 * caller omita la línea.
 */
export function formatMoney(amount: number | null | undefined): string | null {
  if (!amount || amount <= 0) return null
  return `$${amount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts -t "format"
```

Expected: PASS — 7 tests nuevos.

- [ ] **Step 5: Verificar que no se rompió nada**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts
```

Expected: PASS — 30 tests (23 originales + 7 nuevos).

- [ ] **Step 6: Format, lint y commit (PEDIR PERMISO ANTES)**

```bash
npm run format && npm run lint:fix
git add src/services/google-calendar/event-body.service.ts tests/unit/services/google-calendar/event-body.service.test.ts
git commit -m "feat(google-calendar): add duration and money formatting helpers"
```

---

### Task 4: El builder acepta servicios y modificadores

El corazón del cambio. El builder deja de leer `reservation.product` y usa la lista completa, respetando los tres niveles.

**Files:**
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/google-calendar/event-body.service.ts`
- Test: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/google-calendar/event-body.service.test.ts`

**Interfaces:**
- Consumes: `ResolvedService` (Task 1); `formatDuration`, `formatMoney`, `EventModifier` (Task 3).
- Produces: `EventBodyForReservationArgs` con el campo nuevo `services: ResolvedService[]`. La Task 6 lo consume.

- [ ] **Step 1: Write the failing test**

Añadir a `tests/unit/services/google-calendar/event-body.service.test.ts`. Fixture de la cita real que originó el trabajo:

```typescript
// La cita real de Amaena (RES-PY45XU, 2026-07-20) que dispara este trabajo:
// 4 servicios + 1 modificador. `duration` (190) ya incluye el tiempo del
// modificador — ver spec §4.4, NO recalcular sumando servicios.
const AMAENA_SERVICES = [
  { id: 'p1', name: 'Extensión con polygel', price: 680, duration: 75 },
  { id: 'p2', name: 'Francés manos', price: 100, duration: 25 },
  { id: 'p3', name: 'Retiro de Geles Blandos con Extensión', price: 200, duration: 20 },
  { id: 'p4', name: 'Manicure + Pedicure Spa + Gel', price: 1000, duration: 70 },
] as any

const AMAENA_MODIFIERS = [{ name: 'Gel semipermanente', quantity: 1, price: 300 }] as any

function makeMultiServiceReservation(overrides: any = {}): any {
  return makeReservation({
    duration: 190,
    productIds: ['p1', 'p2', 'p3', 'p4'],
    modifiers: AMAENA_MODIFIERS,
    customer: { id: 'c1', firstName: 'Hilda', lastName: '', email: null, phone: '55-1234-5678' },
    ...overrides,
  })
}

describe('buildEventBodyForReservation — multi-servicio', () => {
  it('FULL lista los 4 servicios EN ORDEN DE RESERVA', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.description).toContain('• Francés manos (25 min)')
    expect(body.description).toContain('• Retiro de Geles Blandos con Extensión (20 min)')
    expect(body.description).toContain('• Manicure + Pedicure Spa + Gel (70 min)')

    const d = body.description as string
    expect(d.indexOf('Extensión con polygel')).toBeLessThan(d.indexOf('Francés manos'))
  })

  it('FULL pone TODOS los servicios en el título (decisión D3 del spec)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.summary).toBe(
      'Reserva: Extensión con polygel + Francés manos + Retiro de Geles Blandos con Extensión + Manicure + Pedicure Spa + Gel — Hilda',
    )
  })

  it('FULL imprime extras con cantidad y precio', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('Extras:')
    expect(body.description).toContain('• Gel semipermanente ×1  +$300.00')
  })

  it('FULL imprime la duración de reservation.duration, NO la suma de servicios', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    // 190 = 3 h 10 min. La suma de servicios daría 190 también, pero la fuente
    // autoritativa es reservation.duration porque YA incluye el modificador.
    expect(body.description).toContain('Duración: 3 h 10 min')
  })

  it('FULL imprime el total estimado = servicios + modificadores × cantidad', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    // 680 + 100 + 200 + 1000 + (300 × 1) = 2280
    expect(body.description).toContain('Total estimado: $2,280.00')
  })

  it('FULL imprime el teléfono del cliente', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('Teléfono: 55-1234-5678')
  })

  it('SERVICE lista servicios y duración pero NUNCA nombre, teléfono ni dinero', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: AMAENA_SERVICES,
      detailLevel: 'SERVICE',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.description).toContain('Duración: 3 h 10 min')
    expect(body.description).not.toContain('Hilda')
    expect(body.description).not.toContain('55-1234-5678')
    expect(body.description).not.toContain('Total estimado')
    expect(body.description).not.toContain('$')
  })

  it('omite "(N min)" cuando el servicio no tiene duración — nunca imprime null', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation(),
      services: [{ id: 'p1', name: 'Sin duración', price: 500, duration: null }] as any,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Sin duración')
    expect(body.description).not.toContain('null')
    expect(body.description).not.toContain('(  min)')
  })

  it('omite la sección Extras cuando no hay modificadores', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation({ modifiers: [] }),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).not.toContain('Extras:')
  })

  it('un solo servicio usa la MISMA forma de lista (sin rama especial)', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation({ productIds: ['p1'], modifiers: [] }),
      services: [AMAENA_SERVICES[0]],
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).toContain('• Extensión con polygel (75 min)')
    expect(body.summary).toBe('Reserva: Extensión con polygel — Hilda')
  })

  it('omite la línea de teléfono cuando el cliente no tiene', () => {
    const body = buildEventBodyForReservation({
      reservation: makeMultiServiceReservation({
        customer: { id: 'c1', firstName: 'Hilda', lastName: '', email: null, phone: null },
      }),
      services: AMAENA_SERVICES,
      detailLevel: 'FULL',
      dashboardUrl: DASHBOARD,
    })

    expect(body.description).not.toContain('Teléfono:')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts -t "multi-servicio"
```

Expected: FAIL — el título trae solo el servicio líder y la descripción no tiene `Extras:`.

- [ ] **Step 3: Extender el tipo y la firma**

En `src/services/google-calendar/event-body.service.ts`, actualizar el tipo del payload y los args:

```typescript
export type ReservationWithRelations = Prisma.ReservationGetPayload<{
  include: {
    customer: true
    product: true
    venue: true
    modifiers: true
  }
}>

export interface EventBodyForReservationArgs {
  reservation: ReservationWithRelations
  /** Servicios YA resueltos, en orden de reserva. `productIds` es un String[]
   * escalar, así que Prisma no puede incluirlo — lo resuelve el caller con
   * `resolveServices()`. El builder se mantiene puro y sin acceso a DB. */
  services: ResolvedService[]
  detailLevel: EventDetailLevel
  dashboardUrl: string
}
```

Añadir el import:

```typescript
import type { ResolvedService } from '@/services/reservation/reservation-services.resolver'
```

- [ ] **Step 4: Implementar título y descripción**

Reemplazar `buildEventBodyForReservation` y `buildReservationDescription`:

```typescript
/** Nombres de los servicios en orden de reserva; cae al `product` líder en
 * filas legacy y al genérico si no hay nada. */
function resolveServiceNames(reservation: ReservationWithRelations, services: ResolvedService[]): string[] {
  if (services.length > 0) return services.map(s => s.name.trim()).filter(n => n.length > 0)
  const lead = resolveServiceName(reservation.product)
  return [lead]
}

/** Total esperado = servicios + modificadores × cantidad. NO es lo cobrado:
 * el cobro real ocurre en el POS y puede diferir (spec §4.4). */
function computeEstimatedTotal(services: ResolvedService[], modifiers: EventModifier[]): number {
  const servicesTotal = services.reduce((sum, s) => sum + (s.price != null ? Number(s.price) : 0), 0)
  const modifiersTotal = modifiers.reduce((sum, m) => sum + Number(m.price ?? 0) * (m.quantity ?? 1), 0)
  return servicesTotal + modifiersTotal
}

export function buildEventBodyForReservation(args: EventBodyForReservationArgs): calendar_v3.Schema$Event {
  const { reservation, services, detailLevel, dashboardUrl } = args
  const serviceNames = resolveServiceNames(reservation, services)
  const guestName = resolveGuestName(reservation)
  const reservationUrl = buildReservationUrl(dashboardUrl, reservation.venue.slug, reservation.id)

  // D3 del spec: TODOS los servicios en el título. Google lo trunca en vista de
  // mes, y el founder eligió esto con ese tradeoff a la vista. Decisión cerrada.
  const serviceTitle = serviceNames.join(' + ')

  let summary: string
  switch (detailLevel) {
    case 'MINIMAL':
      summary = 'Reserva Avoqado'
      break
    case 'SERVICE':
      summary = `Reserva: ${serviceTitle}`
      break
    case 'FULL':
    default:
      summary = `Reserva: ${serviceTitle} — ${guestName}`
      break
  }

  const description = buildReservationDescription({ reservation, services, detailLevel, reservationUrl, guestName })

  return {
    summary,
    description,
    location: buildVenueLocation(reservation.venue),
    start: { dateTime: reservation.startsAt.toISOString() },
    end: { dateTime: reservation.endsAt.toISOString() },
    transparency: 'opaque',
    colorId: '10',
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 1440 },
        { method: 'popup', minutes: 30 },
      ],
    },
    extendedProperties: {
      private: {
        avoqadoOrigin: 'avoqado',
        avoqadoReservationId: reservation.id,
        avoqadoVenueId: reservation.venueId,
      },
    },
  }
}

interface ReservationDescriptionArgs {
  reservation: ReservationWithRelations
  services: ResolvedService[]
  detailLevel: EventDetailLevel
  reservationUrl: string
  guestName: string
}

function buildReservationDescription(args: ReservationDescriptionArgs): string {
  const { reservation, services, detailLevel, reservationUrl, guestName } = args

  // MINIMAL: cero PII, cero branding. Solo la URL.
  if (detailLevel === 'MINIMAL') {
    return reservationUrl
  }

  const isFull = detailLevel === 'FULL'
  // `modifiers` está tipado vía ReservationWithRelations (include modifiers:true).
  // El `?? []` cubre los fixtures viejos de test que no lo traen.
  const modifiers = (reservation.modifiers ?? []) as EventModifier[]
  const serviceNames = resolveServiceNames(reservation, services)
  const lines: string[] = []

  if (isFull) {
    lines.push(`Cliente: ${guestName}`)
    const phone = reservation.customer?.phone
    if (phone && phone.trim().length > 0) {
      lines.push(`Teléfono: ${phone.trim()}`)
    }
  }
  lines.push(`Personas: ${reservation.partySize}`)

  // Duración: reservation.duration es la fuente AUTORITATIVA — ya incluye el
  // tiempo de los modificadores (spec §4.4). No recalcular sumando servicios.
  const duration = formatDuration(reservation.duration)
  if (duration) {
    lines.push(`Duración: ${duration}`)
  }

  lines.push('')
  lines.push('Servicios:')
  for (const [i, name] of serviceNames.entries()) {
    const mins = services[i]?.duration
    const suffix = mins && mins > 0 ? ` (${mins} min)` : ''
    lines.push(`• ${name}${suffix}`)
  }

  if (modifiers.length > 0) {
    lines.push('')
    lines.push('Extras:')
    for (const m of modifiers) {
      const label = m.name?.trim() || 'Extra'
      const qty = m.quantity ?? 1
      // El precio solo en FULL — SERVICE nunca lleva dinero.
      const price = isFull ? formatMoney(Number(m.price ?? 0) * qty) : null
      lines.push(price ? `• ${label} ×${qty}  +${price}` : `• ${label} ×${qty}`)
    }
  }

  if (isFull) {
    const total = formatMoney(computeEstimatedTotal(services, modifiers))
    if (total) {
      lines.push('')
      lines.push(`Total estimado: ${total}`)
    }

    if (reservation.specialRequests && reservation.specialRequests.trim().length > 0) {
      lines.push('')
      lines.push('Solicitudes especiales:')
      lines.push(reservation.specialRequests.trim())
    }
    if (reservation.internalNotes && reservation.internalNotes.trim().length > 0) {
      lines.push('')
      lines.push('Notas internas:')
      lines.push(reservation.internalNotes.trim())
    }
  }

  lines.push('')
  lines.push('¿Necesitas gestionar esta reservación?')
  lines.push('Ver detalles, editar o cancelar en Avoqado:')
  lines.push(reservationUrl)
  lines.push('')
  lines.push('— Powered by Avoqado')

  return lines.join('\n')
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts -t "multi-servicio"
```

Expected: PASS — 11 tests.

- [ ] **Step 6: Actualizar los tests existentes que asumían un solo servicio**

Los 23 tests originales llaman a `buildEventBodyForReservation` sin `services`. Añadirles `services: []` (dispara el fallback al `product` líder, que es exactamente lo que probaban). Ejemplo del de la línea ~99:

```typescript
const body = buildEventBodyForReservation({
  reservation: makeReservation(),
  services: [],
  detailLevel: 'SERVICE',
  dashboardUrl: DASHBOARD,
})
```

Excepción: el test *"SERVICE description includes service + party size + URL, but NOT guest name and NOT notes"* ahora también trae la sección `Servicios:`. **Conservar intactas** sus aserciones de privacidad (`not.toContain` del nombre y las notas) y ajustar solo la parte de formato.

- [ ] **Step 7: Verificar la suite completa del builder**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts
```

Expected: PASS — 41 tests (23 originales + 7 de Task 3 + 11 nuevos).

- [ ] **Step 8: Format, lint y commit (PEDIR PERMISO ANTES)**

```bash
npm run format && npm run lint:fix
git add src/services/google-calendar/event-body.service.ts tests/unit/services/google-calendar/event-body.service.test.ts
git commit -m "feat(google-calendar): include all booked services, extras, duration and total in events"
```

---

### Task 5: Reforzar el candado de privacidad

El test de regresión existente (línea ~174) es lo que impide que MINIMAL filtre PII. Ahora hay dos campos nuevos que puede filtrar: teléfono y dinero. **Es la tarea de seguridad del plan.**

**Files:**
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/google-calendar/event-body.service.test.ts` (test de la línea ~174)

**Interfaces:**
- Consumes: builder de la Task 4.
- Produces: nada. Solo endurece la red.

- [ ] **Step 1: Reforzar el test de regresión**

Reemplazar el test *"REGRESSION: same reservation rendered MINIMAL strips ALL PII visible in FULL"*:

```typescript
it('REGRESSION: la MISMA reserva en MINIMAL no filtra NADA de lo visible en FULL', () => {
  const reservation = makeMultiServiceReservation({
    specialRequests: 'Alergia al acetona',
    internalNotes: 'Clienta frecuente, cobrar al final',
  })
  const args = { reservation, services: AMAENA_SERVICES, dashboardUrl: DASHBOARD }

  const full = buildEventBodyForReservation({ ...args, detailLevel: 'FULL' })
  const minimal = buildEventBodyForReservation({ ...args, detailLevel: 'MINIMAL' })

  // Lo que FULL sí muestra — si esto falla, el fixture dejó de ser representativo.
  expect(full.description).toContain('Hilda')
  expect(full.description).toContain('55-1234-5678')
  expect(full.description).toContain('Total estimado')
  expect(full.description).toContain('Alergia al acetona')
  expect(full.description).toContain('Extensión con polygel')

  // MINIMAL: NADA de lo anterior. Ni título ni descripción.
  // Este es EL candado de privacidad del diseño — la única defensa contra que
  // un cambio futuro mueva el `return` temprano de MINIMAL por debajo de las
  // secciones de servicios/dinero y filtre todo a un calendario público.
  const leaked = ['Hilda', '55-1234-5678', 'Total estimado', '2,280', 'Alergia al acetona', 'Clienta frecuente', 'Extensión con polygel', 'Gel semipermanente']
  for (const secret of leaked) {
    expect(minimal.description).not.toContain(secret)
    expect(minimal.summary).not.toContain(secret)
  }

  expect(minimal.summary).toBe('Reserva Avoqado')
  expect(minimal.description).toBe(`${DASHBOARD}/venues/amaena/reservations/res-1`)
})

// 🔴 D6 (founder 2026-07-22): SERVICE SÍ muestra dinero. Lo que oculta es la
// IDENTIDAD de la clienta. Contrato: "qué se vendió y cuánto vale, no a quién".
it('REGRESSION: SERVICE oculta la IDENTIDAD pero sí muestra servicios y dinero', () => {
  const reservation = makeMultiServiceReservation({
    specialRequests: 'Alergia al acetona',
    internalNotes: 'Cobrar al final',
  })
  const body = buildEventBodyForReservation({
    reservation,
    services: AMAENA_SERVICES,
    detailLevel: 'SERVICE',
    dashboardUrl: DASHBOARD,
  })

  // Identidad: NADA, ni en descripción ni en título.
  for (const secret of ['Hilda', '55-1234-5678', 'Cliente:', 'Teléfono:', 'Alergia al acetona', 'Cobrar al final']) {
    expect(body.description).not.toContain(secret)
    expect(body.summary).not.toContain(secret)
  }

  // Servicio y dinero: SÍ (D6).
  expect(body.description).toContain('Extensión con polygel')
  expect(body.description).toContain('Total estimado')
})
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npx jest tests/unit/services/google-calendar/event-body.service.test.ts -t "REGRESSION"
```

Expected: PASS

- [ ] **Step 3: Commit (PEDIR PERMISO ANTES)**

```bash
git add tests/unit/services/google-calendar/event-body.service.test.ts
git commit -m "test(google-calendar): harden MINIMAL/SERVICE privacy regression for phone and money"
```

---

### Task 6: El push resuelve los servicios y pasa su `tx`

Conecta todo. `buildBodyForRow` pasa a `async` porque ahora necesita `await`.

**Files:**
- Modify: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/google-calendar/push.service.ts`

**Interfaces:**
- Consumes: `resolveServices` (Task 1); `buildEventBodyForReservation` con `services` (Task 4).
- Produces: nada nuevo hacia afuera.

- [ ] **Step 1: Añadir `modifiers` a los includes**

En `src/services/google-calendar/push.service.ts` hay **dos** sitios con el include de `reservation` (el tipo `OutboxRowWithRelations` en la línea ~69 y el `findUnique` en la línea ~103). Añadir `modifiers: true` en ambos:

```typescript
reservation: {
  include: {
    customer: true
    product: true
    modifiers: true
    venue: { include: { reservationSettings: true } }
  }
}
```

(En el `findUnique` va con comas: `modifiers: true,`)

- [ ] **Step 2: Hacer `buildBodyForRow` asíncrono**

Reemplazar la función de la línea ~371:

```typescript
async function buildBodyForRow(tx: Tx, row: OutboxRowWithRelations): Promise<calendar_v3.Schema$Event> {
  if (row.reservationId) {
    if (!row.reservation) {
      throw new Error('outbox row references reservation but include returned null')
    }
    const settings = (row.reservation.venue as any).reservationSettings as { googleCalendarEventDetailLevel?: string } | null | undefined
    // `productIds` es un String[] escalar — Prisma no puede incluirlo, así que
    // se resuelve aquí. Va con `tx`, NO con el prisma global: estamos dentro de
    // la transacción del push y leer por fuera rompería el aislamiento.
    const services = await resolveServices(row.reservation, tx)
    return buildEventBodyForReservation({
      reservation: row.reservation as ReservationWithRelations,
      services,
      detailLevel: normalizeDetailLevel(settings?.googleCalendarEventDetailLevel),
      dashboardUrl: DASHBOARD_URL,
    })
  }
  // ... el resto (classSession) queda igual
}
```

Añadir el import:

```typescript
import { resolveServices } from '@/services/reservation/reservation-services.resolver'
```

- [ ] **Step 3: Actualizar las dos llamadas**

Línea ~220 (`handleCreate`) y línea ~254 (`handleUpdate`). Ambas ya están en funciones `async`:

```typescript
const body = await buildBodyForRow(tx, row)
```

- [ ] **Step 4: Verificar que compila**

```bash
npx tsc --noEmit 2>&1 | grep -i "push.service" || echo "SIN ERRORES"
```

Expected: `SIN ERRORES`

- [ ] **Step 5: Verificar la suite de google-calendar**

```bash
npx jest tests/unit/services/google-calendar --silent
```

Expected: PASS. Si `push.service.test.ts` falla porque su mock de Prisma no tiene `product.findMany`, añadirlo al mock — el resolvedor lo necesita.

- [ ] **Step 6: Format, lint y commit (PEDIR PERMISO ANTES)**

```bash
npm run format && npm run lint:fix
git add src/services/google-calendar/push.service.ts
git commit -m "feat(google-calendar): resolve booked services within the push transaction"
```

---

### Task 7: Script de re-push manual por venue

Spec §7, decisión (b). Construirlo NO modifica ningún calendario; solo ejecutarlo lo hace.

**Files:**
- Create: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/scripts/repush-google-calendar-events.ts`

**Interfaces:**
- Consumes: el outbox existente (`CalendarSyncOutbox`).
- Produces: nada para otras tareas.

- [ ] **Step 1: Escribir el script**

Crear `scripts/repush-google-calendar-events.ts`:

```typescript
/**
 * Re-empuja a Google Calendar las reservas FUTURAS de UN venue, para que
 * adopten el formato de evento nuevo (todos los servicios, extras, duración,
 * total). Spec §7, decisión (b).
 *
 * Uso:
 *   npx tsx scripts/repush-google-calendar-events.ts <venueId>
 *   npx tsx scripts/repush-google-calendar-events.ts <venueId> --confirm
 *
 * Sin --confirm solo cuenta y no escribe nada. Encola en el outbox existente,
 * así que hereda reintentos, dead-letter y rate limiting ya probados.
 */
import prisma from '../src/utils/prismaClient'
import { enqueuePush, resolveReservationPushTargets } from '../src/services/google-calendar/outbox.service'

async function main() {
  const venueId = process.argv[2]
  const confirm = process.argv.includes('--confirm')

  if (!venueId) {
    console.error('Falta el venueId.\n  npx tsx scripts/repush-google-calendar-events.ts <venueId> [--confirm]')
    process.exit(1)
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true, slug: true } })
  if (!venue) {
    console.error(`No existe el venue ${venueId}`)
    process.exit(1)
  }

  const reservations = await prisma.reservation.findMany({
    where: { venueId, startsAt: { gte: new Date() }, status: { in: ['PENDING', 'CONFIRMED'] } },
    select: { id: true, confirmationCode: true, startsAt: true, assignedStaffId: true },
    orderBy: { startsAt: 'asc' },
  })

  console.log(`Venue: ${venue.name} (${venue.slug})`)
  console.log(`Reservas futuras PENDING/CONFIRMED: ${reservations.length}`)

  if (reservations.length === 0) {
    console.log('Nada que re-empujar.')
    return
  }

  if (!confirm) {
    console.log('\nDRY RUN — no se escribió nada. Repite con --confirm para encolar.')
    for (const r of reservations.slice(0, 10)) {
      console.log(`  ${r.confirmationCode}  ${r.startsAt.toISOString()}`)
    }
    if (reservations.length > 10) console.log(`  ... y ${reservations.length - 10} más`)
    return
  }

  // Se reusan los helpers del outbox en vez de insertar a mano: ellos derivan
  // el syncKey (`reservation:<id>:<connId>`), el idempotencyKey y una fila POR
  // CONEXIÓN destino — todos obligatorios en el modelo. Insertar a mano rompe.
  let queued = 0
  let skipped = 0
  for (const r of reservations) {
    const rowIds = await prisma.$transaction(async tx => {
      const targets = await resolveReservationPushTargets(tx, { venueId, assignedStaffId: r.assignedStaffId })
      if (targets.length === 0) return []
      return enqueuePush(tx, {
        source: { kind: 'reservation', reservationId: r.id },
        venueId,
        operation: 'UPDATE',
        // PushTarget expone `id` (el id de la conexión), no `connectionId`.
        targetConnectionIds: targets.map(t => t.id),
      })
    })
    if (rowIds.length === 0) skipped++
    else queued += rowIds.length
  }

  console.log(`\nEncoladas ${queued} filas de outbox. ${skipped} reservas sin calendario conectado (omitidas).`)
  console.log('El worker del outbox las empuja en su siguiente pasada.')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Verificar que compila**

```bash
npx tsc --noEmit 2>&1 | grep -i "repush-google" || echo "SIN ERRORES"
```

Expected: `SIN ERRORES`.

Nota de seguridad heredada: `resolveReservationPushTargets` respeta el kill switch
`googleCalendarPushEnabled` del venue y devuelve `[]` si el push está pausado. El
script hereda esa protección gratis — otra razón para no insertar a mano.

- [ ] **Step 3: Probar en DRY RUN contra el venue de Amaena**

```bash
npx tsx scripts/repush-google-calendar-events.ts cmolsjgra00bskl2a37axztua
```

Expected: imprime el conteo y `DRY RUN — no se escribió nada`. **No ejecutar con `--confirm` sin autorización explícita del founder.**

- [ ] **Step 4: Commit (PEDIR PERMISO ANTES)**

```bash
git add scripts/repush-google-calendar-events.ts
git commit -m "feat(google-calendar): add manual per-venue event re-push script"
```

---

### Task 8: Verificación final y aviso de privacidad

**Files:**
- Ninguno de código. Verificación + la tarea no-código del spec §9.

- [ ] **Step 1: Suite completa**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npm run test:unit --silent 2>&1 | grep -E "^Tests:|^Test Suites:|✕"
```

Expected: PASS. Baseline antes de este trabajo: **6,445 tests / 557 suites**. Debe subir en ~28 y no bajar en ninguno.

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: compila sin errores.

- [ ] **Step 3: Revisar que el diff no traiga ruido**

```bash
git status --short
```

Revertir cualquier `docs/generated/*` o `docs/superpowers/*` que prettier haya reformateado y no sea parte de este trabajo.

- [ ] **Step 4: Aviso de privacidad (spec §9, decisión D4)**

Tarea **no-código, parte del entregable**:

1. Revisar el aviso de privacidad de Avoqado: ¿describe que se transfiere PII de clientes finales (nombre, teléfono) a Google Calendar cuando el venue conecta su calendario? Si no, agregarlo.
2. Avisar a Amaena que su propio aviso de privacidad debe cubrir esa transferencia (LFPDPPP: ella es la responsable, Avoqado el encargado).

Marcar como bloqueante del deploy si el aviso no cubre la transferencia.

- [ ] **Step 5: Orden de deploy**

Backend primero, esperar estable. Este cambio es solo backend: no requiere APK ni deploy del dashboard.

---

## Notas de riesgo

1. **El candado de privacidad es la Task 5.** Si algo se corta por tiempo, no es eso. Teléfono y dinero en un calendario compartido es el riesgo real de todo el diseño.
2. **`reservation.duration` es autoritativa.** Ya incluye el tiempo de los modificadores (`reservation.dashboard.service.ts:296`). Recalcular sumando servicios da un número distinto y equivocado.
3. **El `tx` en la Task 6 no es opcional.** El push corre dentro de `prisma.$transaction`; leer con el `prisma` global rompe el aislamiento.
4. **50 servicios en producción no tienen duración** (Mindform 33, Alberto Dominguez 12, Amaena 5). El evento los imprime sin `(N min)` — correcto, pero la línea `Duración:` refleja el fallback del venue, no el tiempo real.
5. **D3 (título completo) es decisión cerrada del founder**, tomada con el tradeoff del truncado a la vista. No "arreglarla".
