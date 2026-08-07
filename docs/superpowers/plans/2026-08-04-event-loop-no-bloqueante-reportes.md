# Reportes que no traban el servidor de pagos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que ninguna petición de reportes retenga el event loop de `avoqado-server` más de 50 ms, bajando 12 agregaciones de
`sale-verification.org` a `GROUP BY` de Postgres, y dejando instalado un guardia que detecte la próxima vez.

**Architecture:** Las agregaciones hoy leen 5,446 filas por endpoint y las recorren en JS convirtiendo zona horaria por fila (~10,900
conversiones/petición). Se sustituyen por `$queryRaw` con `to_char(... AT TIME ZONE ...)` — Postgres devuelve ~20 renglones ya agrupados y
las conversiones desaparecen. Un módulo puro de llaves de fecha (`venueDateKeys`) queda como la única fuente de verdad en JS y se prueba
contra el mismo formato que emite Postgres. Encima, un guardia de lag del event loop (middleware en prod, helper en tests) hace medible el
presupuesto.

**Tech Stack:** TypeScript, Express, Prisma (`$queryRaw`), PostgreSQL 15, Jest, `perf_hooks`.

**Spec:** `docs/superpowers/specs/2026-08-04-event-loop-no-bloqueante-reportes-design.md`

## Global Constraints

- **Completitud sobre latencia.** Ningún reporte se trunca, muestrea ni pagina para hacerlo rápido. Si hay que tardar más, se tarda más.
  Requisito textual del founder: _"quiero que sí salga el reporte completo pero que no cause lo que está causando; y si eso es que tarde
  más, no me importa."_
- **Dinero en PESOS, unidades mayores, 1:1.** Nunca `* 100`. `Payment.amount` es `Decimal(x,2)`; convertir con `Number(...)` al salir de
  SQL.
- **Fechas VENUE-LOCAL.** Toda expresión SQL de fecha usa `"createdAt" AT TIME ZONE 'UTC' AT TIME ZONE <tz>`. Nunca `new Date('YYYY-MM-DD')`
  ni `parseISO` sobre una fecha desnuda.
- **Zona horaria fija del módulo:** `VENUE_TIMEZONE_DEFAULT = 'America/Mexico_City'` (ya existe en
  `sale-verification.org.dashboard.service.ts:23`). Toda tz que entre a SQL pasa por `assertValidIANATimezone` de
  `src/utils/sanitizeTimezone.ts` antes de interpolarse.
- **Aislamiento multi-tenant:** toda consulta filtra por `Venue."organizationId" = <orgId>`. Sin excepción.
- **Ningún campo de respuesta cambia de nombre, tipo ni forma.** Los 11 endpoints del dashboard y los 11 tools del MCP
  (`src/mcp/tools/saleVerifications.ts`) consumen estas funciones; el contrato es idéntico antes y después.
- **Los tests de fecha corren bajo `TZ=UTC` Y bajo `TZ=America/Mexico_City`.** Prod no define `TZ` (corre UTC); dev suele correr en México.
  Un test que sólo pasa en uno de los dos no prueba nada.
- **Mensajes de error de Zod en español** (no aplica a este plan, pero la regla del repo sigue vigente).
- **Prohibido `prisma db push`.** Este plan no toca el esquema; no hay migraciones.
- **Presupuesto:** 50 ms de retención del event loop en CI. 200 ms para alertar en producción.
- **Sin commits sin permiso explícito del founder.** Los pasos de `git commit` de este plan se ejecutan sólo cuando el founder lo autorice;
  si no, se acumulan los cambios y se le pregunta.

---

## File Structure

**Nuevos:**

- `src/utils/venueDateKeys.ts` — llaves de fecha venue-local (mes, día, semana ISO). Puro, sin I/O, formateadores cacheados. Única fuente de
  verdad en JS.
- `src/utils/eventLoopBudget.ts` — medición de retención del event loop; usado por tests y por el middleware.
- `src/middlewares/eventLoopGuard.middleware.ts` — registro de peticiones en vuelo + muestreo de lag; loguea la ruta culpable.
- `src/services/dashboard/sale-verification.org.sql.ts` — expresiones SQL compartidas (bucket de fecha, `WHERE` base). Aísla el SQL del
  servicio para poder probarlo solo.
- `tests/unit/utils/venueDateKeys.test.ts`
- `tests/unit/utils/eventLoopBudget.test.ts`
- `tests/unit/middlewares/eventLoopGuard.test.ts`
- `tests/unit/services/dashboard/sale-verification.org.sql.test.ts`
- `tests/unit/services/dashboard/sale-verification.org.eventloop-budget.test.ts`
- `tests/api-tests/sale-verification.org.week-parity.test.ts` — prueba contra Postgres real que JS y SQL coinciden.

**Modificados:**

- `src/services/dashboard/sale-verification.org.dashboard.service.ts` — las 12 agregaciones; se borran `toWeekLabel`, `toIsoWeekKey`,
  `toMonthKey`, `toDayKey`.
- `src/app.ts` — montar el middleware del guardia.
- `tests/__helpers__/setup.ts` — registrar `$queryRaw` en `prismaMock`.
- `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts` — adaptar mocks de `findMany` a `$queryRaw`.

---

### Task 1: Llaves de fecha venue-local (arregla la semana ISO y quita el costo por fila)

Este es el arreglo del bug latente del §3.1 del spec y la base de todo lo demás. Hoy `toWeekLabel` depende del `TZ` del proceso: en
producción (UTC) 2026 sale bien pero 2027 sale mal el 95% del año; en una Mac en México ya sale mal el 3.7% de las horas de hoy.

**Files:**

- Create: `src/utils/venueDateKeys.ts`
- Test: `tests/unit/utils/venueDateKeys.test.ts`

**Interfaces:**

- Consumes: nada (módulo hoja).
- Produces:

  - `venueCivilDate(d: Date, tz: string): { year: number; month: number; day: number }`
  - `venueMonthKey(d: Date, tz: string): string` → `"2026-08"`
  - `venueDayKey(d: Date, tz: string): string` → `"2026-08-04"`
  - `venueIsoWeek(d: Date, tz: string): { isoYear: number; week: number }`
  - `venueWeekLabel(d: Date, tz: string): string` → `"W32"`
  - `venueIsoWeekKey(d: Date, tz: string): string` → `"2026-W32"`

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/utils/venueDateKeys.test.ts`:

```typescript
/**
 * Llaves de fecha venue-local.
 *
 * El bug que estos tests previenen: `toWeekLabel` construía un Date parseando
 * un string local y luego leía sus componentes con getUTC*, así que el epoch se
 * recorría según el TZ del PROCESO. Resultado medido (2026-08-04): en prod (UTC)
 * 2027 divergía en 8,320 de 8,760 horas; en una Mac en México, 2026 ya divergía
 * en 312 horas. Estos tests corren la misma hora bajo las DOS zonas de host y
 * exigen resultado idéntico.
 */
import { venueCivilDate, venueMonthKey, venueDayKey, venueIsoWeek, venueWeekLabel, venueIsoWeekKey } from '@/utils/venueDateKeys'

const TZ = 'America/Mexico_City'

describe('venueDateKeys', () => {
  describe('venueCivilDate', () => {
    it('convierte un instante UTC a la fecha civil de México', () => {
      // 2026-08-05 02:00 UTC = 2026-08-04 20:00 en México
      expect(venueCivilDate(new Date('2026-08-05T02:00:00Z'), TZ)).toEqual({ year: 2026, month: 8, day: 4 })
    })

    it('cruza el cambio de mes correctamente', () => {
      // 2026-09-01 04:00 UTC = 2026-08-31 22:00 en México
      expect(venueCivilDate(new Date('2026-09-01T04:00:00Z'), TZ)).toEqual({ year: 2026, month: 8, day: 31 })
    })
  })

  describe('venueMonthKey / venueDayKey', () => {
    it('formatea con ceros a la izquierda', () => {
      expect(venueMonthKey(new Date('2026-03-09T18:00:00Z'), TZ)).toBe('2026-03')
      expect(venueDayKey(new Date('2026-03-09T18:00:00Z'), TZ)).toBe('2026-03-09')
    })

    it('usa el día de México, no el del host', () => {
      // 2026-01-01 03:00 UTC = 2025-12-31 21:00 en México
      expect(venueMonthKey(new Date('2026-01-01T03:00:00Z'), TZ)).toBe('2025-12')
      expect(venueDayKey(new Date('2026-01-01T03:00:00Z'), TZ)).toBe('2025-12-31')
    })
  })

  describe('venueIsoWeek — ISO 8601 real', () => {
    // Referencia: ISO 8601. La semana 1 es la que contiene el primer jueves del año.
    it.each([
      // instante UTC              isoYear  week   por qué importa
      ['2026-01-01T18:00:00Z', 2026, 1], // jue 1-ene-2026 → W01
      ['2026-01-11T23:00:00Z', 2026, 2], // dom por la noche: el bug viejo daba W02 aquí bajo ciertos hosts
      ['2026-08-04T18:00:00Z', 2026, 32],
      ['2027-01-04T18:00:00Z', 2027, 1], // 🔴 LA BOMBA: el código viejo decía W02
      ['2027-01-03T18:00:00Z', 2026, 53], // dom 3-ene-2027 pertenece a la W53 de 2026
      ['2028-01-01T18:00:00Z', 2027, 52], // sáb 1-ene-2028 pertenece a la W52 de 2027
    ])('%s → %i-W%i', (iso, expectedYear, expectedWeek) => {
      expect(venueIsoWeek(new Date(iso), TZ)).toEqual({ isoYear: expectedYear, week: expectedWeek })
    })
  })

  describe('venueWeekLabel / venueIsoWeekKey', () => {
    it('formatea con dos dígitos', () => {
      expect(venueWeekLabel(new Date('2026-01-01T18:00:00Z'), TZ)).toBe('W01')
      expect(venueIsoWeekKey(new Date('2026-01-01T18:00:00Z'), TZ)).toBe('2026-W01')
      expect(venueIsoWeekKey(new Date('2027-01-04T18:00:00Z'), TZ)).toBe('2027-W01')
    })

    it('la llave usa el AÑO ISO, no el calendario (3-ene-2027 es 2026-W53)', () => {
      expect(venueIsoWeekKey(new Date('2027-01-03T18:00:00Z'), TZ)).toBe('2026-W53')
    })
  })

  describe('independencia del TZ del host — la regresión que motivó el módulo', () => {
    it('barrido hora por hora 2026-2028 es estable bajo cualquier TZ de host', () => {
      // Se calcula la llave de cada hora y se compara contra una referencia
      // independiente construida con aritmética pura sobre la fecha civil.
      const ref = (d: Date): string => {
        const p = new Intl.DateTimeFormat('en-CA', {
          timeZone: TZ,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d)
        const get = (t: string) => Number(p.find(x => x.type === t)!.value)
        const t = Date.UTC(get('year'), get('month') - 1, get('day'))
        const dow = new Date(t).getUTCDay() || 7
        const thu = t + (4 - dow) * 86400000
        const isoYear = new Date(thu).getUTCFullYear()
        const week = Math.floor((thu - Date.UTC(isoYear, 0, 1)) / 604800000) + 1
        return `${isoYear}-W${String(week).padStart(2, '0')}`
      }

      let checked = 0
      for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2029-01-01T00:00:00Z'); t += 3600_000) {
        const d = new Date(t)
        expect(venueIsoWeekKey(d, TZ)).toBe(ref(d))
        checked++
      }
      expect(checked).toBeGreaterThan(26_000) // 3 años de horas
    })
  })

  describe('rendimiento — el formateador se reusa, no se reconstruye por fila', () => {
    it('10,000 conversiones tardan menos de 500 ms', () => {
      const rows = Array.from({ length: 10_000 }, (_, i) => new Date(Date.UTC(2026, 6, 1) + i * 3600_000))
      const t0 = process.hrtime.bigint()
      for (const r of rows) venueIsoWeekKey(r, TZ)
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      expect(ms).toBeLessThan(500)
    })
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx jest tests/unit/utils/venueDateKeys.test.ts
```

Esperado: FAIL — `Cannot find module '@/utils/venueDateKeys'`.

- [ ] **Step 3: Implementar el módulo**

Crear `src/utils/venueDateKeys.ts`:

```typescript
/**
 * Llaves de fecha en la zona horaria del venue — mes, día y semana ISO 8601.
 *
 * 🔴 POR QUÉ EXISTE ESTE MÓDULO (incidente 2026-08-04, dos bugs de un solo golpe):
 *
 * 1. COSTO. El patrón anterior era `new Date(d.toLocaleString('en-US', { timeZone }))`
 *    POR CADA FILA: construía un formateador ICU nuevo, formateaba a texto y volvía a
 *    parsear el texto. Con 5,446 ventas y dos llamadas por fila son ~10,900 conversiones
 *    por petición, medidas en 1,814 ms (y en el servidor de prod, ~13.5 s). Aquí el
 *    formateador se cachea por zona y se leen las PARTES numéricas — sin texto intermedio.
 *
 * 2. CORRECCIÓN. Aquel patrón construía el Date en la zona del PROCESO y luego leía sus
 *    componentes con `getUTC*`. El epoch se recorría según el `TZ` del host, así que dev y
 *    prod daban semanas distintas para la misma venta. Medido: bajo `TZ=UTC` (prod), 2027
 *    divergía del ISO real en 8,320 de 8,760 horas; bajo `TZ=America/Mexico_City`, 2026 ya
 *    divergía en 312 horas. Aquí toda la aritmética ocurre sobre la FECHA CIVIL (sin hora),
 *    en UTC puro, así que el resultado no depende del host.
 *
 * Estas llaves DEBEN coincidir carácter por carácter con lo que emite Postgres en
 * `src/services/dashboard/sale-verification.org.sql.ts`:
 *   mes    → to_char(..., 'YYYY-MM')
 *   día    → to_char(..., 'YYYY-MM-DD')
 *   semana → to_char(..., 'IYYY-"W"IW')
 * La paridad está probada contra Postgres real en
 * `tests/api-tests/sale-verification.org.week-parity.test.ts`.
 */

const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 604_800_000

/** Un formateador por zona, construido una sola vez. Reconstruirlo por fila es el bug #1. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function civilFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatterCache.set(timezone, formatter)
  }
  return formatter
}

export interface CivilDate {
  year: number
  month: number // 1-12
  day: number // 1-31
}

/** La fecha de calendario que se ve en el venue en ese instante. Sin hora: la hora es justo lo que rompía la semana ISO. */
export function venueCivilDate(date: Date, timezone: string): CivilDate {
  let year = 0
  let month = 0
  let day = 0
  for (const part of civilFormatter(timezone).formatToParts(date)) {
    if (part.type === 'year') year = Number(part.value)
    else if (part.type === 'month') month = Number(part.value)
    else if (part.type === 'day') day = Number(part.value)
  }
  return { year, month, day }
}

/** "YYYY-MM" — igual a to_char(..., 'YYYY-MM'). */
export function venueMonthKey(date: Date, timezone: string): string {
  const { year, month } = venueCivilDate(date, timezone)
  return `${year}-${String(month).padStart(2, '0')}`
}

/** "YYYY-MM-DD" — igual a to_char(..., 'YYYY-MM-DD'). */
export function venueDayKey(date: Date, timezone: string): string {
  const { year, month, day } = venueCivilDate(date, timezone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Semana ISO 8601: la semana 1 es la que contiene el primer jueves del año, y las
 * semanas empiezan en lunes. El año ISO puede diferir del calendario en los bordes
 * (3-ene-2027 pertenece a 2026-W53).
 *
 * Se trabaja sobre la fecha civil a medianoche UTC — sin hora local no hay residuo
 * fraccionario, que era exactamente el defecto del código anterior.
 */
export function venueIsoWeek(date: Date, timezone: string): { isoYear: number; week: number } {
  const { year, month, day } = venueCivilDate(date, timezone)
  const civilUtc = Date.UTC(year, month - 1, day)
  const dayOfWeek = new Date(civilUtc).getUTCDay() || 7 // domingo 0 → 7
  const thursdayOfThisWeek = civilUtc + (4 - dayOfWeek) * MS_PER_DAY
  const isoYear = new Date(thursdayOfThisWeek).getUTCFullYear()
  const week = Math.floor((thursdayOfThisWeek - Date.UTC(isoYear, 0, 1)) / MS_PER_WEEK) + 1
  return { isoYear, week }
}

/** "Wxx" — sin año. Sólo para gráficas de un rango corto donde el año se sobreentiende. */
export function venueWeekLabel(date: Date, timezone: string): string {
  return `W${String(venueIsoWeek(date, timezone).week).padStart(2, '0')}`
}

/** "YYYY-Www" — ordenable entre años. Igual a to_char(..., 'IYYY-"W"IW'). */
export function venueIsoWeekKey(date: Date, timezone: string): string {
  const { isoYear, week } = venueIsoWeek(date, timezone)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}
```

- [ ] **Step 4: Correr los tests bajo LAS DOS zonas de host**

```bash
TZ=UTC npx jest tests/unit/utils/venueDateKeys.test.ts
```

```bash
TZ=America/Mexico_City npx jest tests/unit/utils/venueDateKeys.test.ts
```

Esperado: PASS en ambas, con los mismos resultados. Si una pasa y la otra no, el módulo sigue dependiendo del host y la tarea NO está
terminada.

- [ ] **Step 5: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/utils/venueDateKeys.ts tests/unit/utils/venueDateKeys.test.ts
git commit -m "fix(reportes): llaves de fecha venue-local independientes del TZ del host

La semana ISO se calculaba parseando un string local y leyendo componentes UTC,
asi que el resultado dependia del TZ del proceso: bajo UTC (prod) 2027 divergia
en 8,320 de 8,760 horas; bajo America/Mexico_City, 2026 ya divergia en 312.
Ademas construia un formateador ICU por fila (~10,900 por peticion).

Ahora la aritmetica ocurre sobre la fecha civil y el formateador se cachea."
```

---

### Task 2: Medir la retención del event loop

Sin esto no hay forma de probar que el arreglo sirvió ni de detectar la próxima regresión. Se construye antes que las migraciones, a
propósito: da la medición de "antes".

**Files:**

- Create: `src/utils/eventLoopBudget.ts`
- Test: `tests/unit/utils/eventLoopBudget.test.ts`

**Interfaces:**

- Consumes: nada.
- Produces:

  - `measureEventLoopBlock<T>(fn: () => Promise<T>, sampleIntervalMs?: number): Promise<{ result: T; maxBlockMs: number }>`
  - `EVENT_LOOP_BUDGET_MS = 50`

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/utils/eventLoopBudget.test.ts`:

```typescript
/**
 * Medición de retención del event loop.
 *
 * La prueba de que la medición SIRVE son los dos casos opuestos: una función que
 * bloquea a propósito debe detectarse, y una que hace el MISMO trabajo total pero
 * cediendo el hilo debe pasar. Si ambas pasan o ambas fallan, la medición no mide.
 */
import { measureEventLoopBlock, EVENT_LOOP_BUDGET_MS } from '@/utils/eventLoopBudget'

/** Quema CPU de forma síncrona durante al menos `ms` milisegundos. */
function burnCpuSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* girar a propósito */
  }
}

const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve))

describe('measureEventLoopBlock', () => {
  it('detecta un bloqueo síncrono largo', async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      burnCpuSync(300)
    })
    expect(maxBlockMs).toBeGreaterThan(200)
  })

  it('NO acusa a un trabajo igual de largo que cede el hilo en trozos', async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      for (let i = 0; i < 30; i++) {
        burnCpuSync(10) // 300 ms de trabajo TOTAL, igual que arriba
        await yieldToLoop()
      }
    })
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
  })

  it('devuelve el resultado de la función sin alterarlo', async () => {
    const { result } = await measureEventLoopBlock(async () => ({ filas: 42 }))
    expect(result).toEqual({ filas: 42 })
  })

  it('limpia el muestreador aunque la función lance', async () => {
    await expect(
      measureEventLoopBlock(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // Si el interval quedara vivo, Jest se quejaría de un handle abierto al cerrar.
  })

  it('expone el presupuesto acordado de 50 ms', () => {
    expect(EVENT_LOOP_BUDGET_MS).toBe(50)
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx jest tests/unit/utils/eventLoopBudget.test.ts
```

Esperado: FAIL — `Cannot find module '@/utils/eventLoopBudget'`.

- [ ] **Step 3: Implementar**

Crear `src/utils/eventLoopBudget.ts`:

```typescript
/**
 * Presupuesto de retención del event loop.
 *
 * Node corre en un solo hilo: mientras un handler hace CPU síncrono, NADIE más se
 * atiende. El 2026-08-04 la pantalla de Ventas de PlayTelecom retuvo el hilo ~9 s por
 * endpoint y `/dashboard/auth/status` —un endpoint trivial— tardó 33.7 s.
 *
 * Esto NO mide cuánto tarda una operación (eso puede ser mucho y estar bien: esperar a
 * Postgres no retiene el hilo). Mide cuánto tiempo seguido el hilo estuvo secuestrado.
 */

/** Máximo que un handler puede retener el hilo. Lo exige CI; en prod se alerta más arriba (200 ms). */
export const EVENT_LOOP_BUDGET_MS = 50

const DEFAULT_SAMPLE_INTERVAL_MS = 5

/**
 * Corre `fn` mientras muestrea el retraso del event loop.
 *
 * Cómo funciona: se programa un intervalo cada `sampleIntervalMs`. Si el hilo está libre,
 * cada tick llega puntual. Si algo lo está reteniendo, el tick llega TARDE, y ese retraso
 * es exactamente cuánto duró el bloqueo. Se resta el intervalo nominal para quedarse con
 * el exceso.
 */
export async function measureEventLoopBlock<T>(
  fn: () => Promise<T>,
  sampleIntervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS,
): Promise<{ result: T; maxBlockMs: number }> {
  let maxBlockMs = 0
  let lastTick = process.hrtime.bigint()

  const sampler = setInterval(() => {
    const now = process.hrtime.bigint()
    const elapsedMs = Number(now - lastTick) / 1e6
    const blockedMs = elapsedMs - sampleIntervalMs
    if (blockedMs > maxBlockMs) maxBlockMs = blockedMs
    lastTick = now
  }, sampleIntervalMs)

  // No mantener vivo el proceso por el muestreador.
  if (typeof sampler.unref === 'function') sampler.unref()

  try {
    const result = await fn()
    return { result, maxBlockMs }
  } finally {
    clearInterval(sampler)
  }
}
```

- [ ] **Step 4: Correr los tests**

```bash
npx jest tests/unit/utils/eventLoopBudget.test.ts
```

Esperado: PASS (5 tests).

- [ ] **Step 5: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/utils/eventLoopBudget.ts tests/unit/utils/eventLoopBudget.test.ts
git commit -m "feat(observabilidad): medir retencion del event loop con presupuesto de 50ms"
```

---

### Task 3: Guardia en producción — quién retuvo el hilo

`measureEventLoopBlock` sirve en tests, pero en producción hay que saber **qué ruta** fue. Este middleware mantiene el registro de
peticiones en vuelo y, cuando el lag se dispara, las loguea.

**Files:**

- Create: `src/middlewares/eventLoopGuard.middleware.ts`
- Modify: `src/app.ts`
- Test: `tests/unit/middlewares/eventLoopGuard.test.ts`

**Interfaces:**

- Consumes: `EVENT_LOOP_BUDGET_MS` de `@/utils/eventLoopBudget`.
- Produces:

  - `eventLoopGuardMiddleware(req, res, next): void`
  - `startEventLoopMonitor(options?: { thresholdMs?: number; sampleIntervalMs?: number }): () => void` — devuelve la función para detenerlo.
  - `getInFlightRequests(): Array<{ method: string; url: string; ageMs: number }>`

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/middlewares/eventLoopGuard.test.ts`:

```typescript
import {
  eventLoopGuardMiddleware,
  getInFlightRequests,
  startEventLoopMonitor,
  __resetInFlightForTests,
} from '@/middlewares/eventLoopGuard.middleware'
import logger from '@/config/logger'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

function fakeReqRes(method: string, url: string) {
  const handlers: Record<string, () => void> = {}
  const res = {
    on: (event: string, cb: () => void) => {
      handlers[event] = cb
    },
    finish: () => handlers.finish?.(),
  }
  return { req: { method, originalUrl: url } as any, res: res as any, res_: res }
}

describe('eventLoopGuardMiddleware', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
  })

  it('registra la petición mientras está en vuelo', () => {
    const { req, res } = fakeReqRes('GET', '/api/v1/dashboard/organizations/abc/sale-verifications/by-week')
    const next = jest.fn()

    eventLoopGuardMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    const inFlight = getInFlightRequests()
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0].method).toBe('GET')
    expect(inFlight[0].url).toContain('/sale-verifications/by-week')
  })

  it('la quita del registro cuando la respuesta termina', () => {
    const { req, res, res_ } = fakeReqRes('GET', '/api/v1/dashboard/auth/status')
    eventLoopGuardMiddleware(req, res, jest.fn())
    expect(getInFlightRequests()).toHaveLength(1)

    res_.finish()

    expect(getInFlightRequests()).toHaveLength(0)
  })

  it('no crece sin límite: descarta el registro más viejo pasado el tope', () => {
    for (let i = 0; i < 600; i++) {
      const { req, res } = fakeReqRes('GET', `/ruta/${i}`)
      eventLoopGuardMiddleware(req, res, jest.fn())
    }
    expect(getInFlightRequests().length).toBeLessThanOrEqual(500)
  })
})

describe('startEventLoopMonitor', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
  })

  it('avisa con las rutas en vuelo cuando el hilo se retiene de más', async () => {
    const { req, res } = fakeReqRes('GET', '/api/v1/dashboard/organizations/abc/sale-verifications/by-store')
    eventLoopGuardMiddleware(req, res, jest.fn())

    const stop = startEventLoopMonitor({ thresholdMs: 50, sampleIntervalMs: 5 })
    const until = Date.now() + 200
    while (Date.now() < until) {
      /* retener el hilo a propósito */
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    stop()

    expect(logger.warn).toHaveBeenCalled()
    const call = (logger.warn as jest.Mock).mock.calls[0]
    expect(JSON.stringify(call)).toContain('/sale-verifications/by-store')
  })

  it('no avisa cuando el hilo está libre', async () => {
    const stop = startEventLoopMonitor({ thresholdMs: 50, sampleIntervalMs: 5 })
    await new Promise(resolve => setTimeout(resolve, 100))
    stop()

    expect(logger.warn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
npx jest tests/unit/middlewares/eventLoopGuard.test.ts
```

Esperado: FAIL — `Cannot find module '@/middlewares/eventLoopGuard.middleware'`.

- [ ] **Step 3: Implementar el middleware**

Crear `src/middlewares/eventLoopGuard.middleware.ts`:

```typescript
/**
 * Guardia de retención del event loop.
 *
 * Node atiende de uno en uno. Cuando un handler hace CPU síncrono, todas las demás
 * peticiones esperan formadas. El 2026-08-04 eso llevó a `/dashboard/auth/status` —que
 * no hace nada pesado— a tardar 33.7 s mientras la pantalla de Ventas de PlayTelecom
 * hacía cuentas fila por fila.
 *
 * El guardia NO previene: detecta y nombra al culpable. Mantiene el registro de las
 * peticiones en vuelo y, cuando el hilo se retiene más del umbral, las escribe al log.
 *
 * 🔴 Nota de operación: al 2026-08-04 los 4 monitores de uptime de Better Stack están
 * PAUSADOS desde el 26-jun-2026, así que este log es hoy la ÚNICA vía de enterarse. Ver
 * §6.2 del spec.
 */
import type { Request, Response, NextFunction } from 'express'
import logger from '../config/logger'

/** Umbral de aviso en producción. Más flojo que el de CI (50 ms) a propósito: una alerta ruidosa se ignora. */
const PROD_ALERT_THRESHOLD_MS = Number(process.env.EVENT_LOOP_ALERT_MS) || 200

const DEFAULT_SAMPLE_INTERVAL_MS = 20

/** Tope duro del registro. Si algo dejara de emitir 'finish', esto evita una fuga de memoria. */
const MAX_TRACKED_REQUESTS = 500

interface InFlightRequest {
  method: string
  url: string
  startedAt: number
}

const inFlight = new Map<symbol, InFlightRequest>()

export function eventLoopGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = Symbol('req')

  if (inFlight.size >= MAX_TRACKED_REQUESTS) {
    const oldest = inFlight.keys().next()
    if (!oldest.done) inFlight.delete(oldest.value)
  }

  inFlight.set(key, {
    method: req.method,
    url: req.originalUrl ?? (req as unknown as { url?: string }).url ?? 'desconocida',
    startedAt: Date.now(),
  })

  res.on('finish', () => {
    inFlight.delete(key)
  })
  res.on('close', () => {
    inFlight.delete(key)
  })

  next()
}

export function getInFlightRequests(): Array<{ method: string; url: string; ageMs: number }> {
  const now = Date.now()
  return Array.from(inFlight.values()).map(r => ({
    method: r.method,
    url: r.url,
    ageMs: now - r.startedAt,
  }))
}

/**
 * Arranca el muestreo del lag. Devuelve la función para detenerlo.
 *
 * Si un tick del intervalo llega tarde, ese retraso ES el tiempo que el hilo estuvo
 * secuestrado. Cuando pasa del umbral, se loguean las peticiones en vuelo: la más vieja
 * es casi siempre la culpable.
 */
export function startEventLoopMonitor(options: { thresholdMs?: number; sampleIntervalMs?: number } = {}): () => void {
  const thresholdMs = options.thresholdMs ?? PROD_ALERT_THRESHOLD_MS
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS

  let lastTick = process.hrtime.bigint()

  const sampler = setInterval(() => {
    const now = process.hrtime.bigint()
    const blockedMs = Number(now - lastTick) / 1e6 - sampleIntervalMs
    lastTick = now

    if (blockedMs > thresholdMs) {
      const culprits = getInFlightRequests().sort((a, b) => b.ageMs - a.ageMs)
      logger.warn('[event-loop] hilo retenido', {
        blockedMs: Math.round(blockedMs),
        thresholdMs,
        inFlightCount: culprits.length,
        // La más vieja primero: la que lleva más tiempo corriendo suele ser la que bloquea.
        topInFlight: culprits.slice(0, 5),
      })
    }
  }, sampleIntervalMs)

  if (typeof sampler.unref === 'function') sampler.unref()

  return () => clearInterval(sampler)
}

/** Sólo para tests: limpia el registro entre casos. */
export function __resetInFlightForTests(): void {
  inFlight.clear()
}
```

- [ ] **Step 4: Correr los tests**

```bash
npx jest tests/unit/middlewares/eventLoopGuard.test.ts
```

Esperado: PASS (5 tests).

- [ ] **Step 5: Montar en la app**

En `src/app.ts`, montar el middleware **después** de los webhooks de Stripe (que necesitan el body crudo y van antes de `express.json()`) y
**antes** de las rutas de negocio. Buscar dónde se montan los demás middlewares globales y agregar:

```typescript
import { eventLoopGuardMiddleware, startEventLoopMonitor } from './middlewares/eventLoopGuard.middleware'

// ... después de los webhooks con body crudo y de express.json():
app.use(eventLoopGuardMiddleware)

// Arranca el muestreo una sola vez al levantar el proceso.
startEventLoopMonitor()
```

Verificar con `grep -n "express.json()" src/app.ts` dónde va la línea exacta; el middleware debe quedar **después**.

- [ ] **Step 6: Verificar que la app levanta**

```bash
npm run build
```

Esperado: 0 errores de TypeScript.

- [ ] **Step 7: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/middlewares/eventLoopGuard.middleware.ts src/app.ts tests/unit/middlewares/eventLoopGuard.test.ts
git commit -m "feat(observabilidad): guardia que nombra la ruta que retiene el event loop"
```

---

### Task 4: Cimiento SQL compartido

Las 12 agregaciones comparten el mismo `WHERE` y las mismas expresiones de fecha. Se aíslan en su propio módulo para poder probar el SQL sin
base de datos, y para que un cambio de zona o de filtro ocurra en un solo lugar.

**Files:**

- Create: `src/services/dashboard/sale-verification.org.sql.ts`
- Test: `tests/unit/services/dashboard/sale-verification.org.sql.test.ts`
- Modify: `tests/__helpers__/setup.ts` (registrar `$queryRaw` en `prismaMock`)

**Interfaces:**

- Consumes: `assertValidIANATimezone` de `@/utils/sanitizeTimezone`.
- Produces:
  - `venueLocalExpr(column: string, timezone: string): string` — `("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City')`
  - `monthBucketSql(column: string, timezone: string): string`
  - `dayBucketSql(column: string, timezone: string): string`
  - `isoWeekKeySql(column: string, timezone: string): string`
  - `weekLabelSql(column: string, timezone: string): string`
  - `buildRangeConditions(range: AggregationRange, column: string): Prisma.Sql` — **dos** argumentos; usa `Prisma.sql` parametrizado (nunca
    interpolación de fechas)
  - `AggregationRange` — el tipo se **mueve** aquí desde el servicio

**⚠️ `AggregationRange` ya existe en `sale-verification.org.dashboard.service.ts`.** Para no tener dos definiciones: dejar la fuente en el
módulo SQL y en el servicio reemplazar la declaración por un re-export, de modo que los consumidores externos (controller, MCP) no se
enteren:

```typescript
// en sale-verification.org.dashboard.service.ts, donde estaba la interface:
export type { AggregationRange } from './sale-verification.org.sql'
import type { AggregationRange } from './sale-verification.org.sql'
```

Verificar quién importa el tipo antes de moverlo:

```bash
grep -rn "AggregationRange" src/ --include="*.ts"
```

- [ ] **Step 1: Registrar `$queryRaw` en el mock de Prisma**

`tests/__helpers__/setup.ts` lista los modelos a mano; un método no registrado revienta al usarse (ver memoria
`prismamock-manual-registry`). Agregar `$queryRaw` al objeto del mock:

```typescript
// en el objeto que exporta prismaMock, junto a los modelos:
$queryRaw: jest.fn(),
$queryRawUnsafe: jest.fn(),
```

- [ ] **Step 2: Escribir el test que falla**

Crear `tests/unit/services/dashboard/sale-verification.org.sql.test.ts`:

```typescript
/**
 * Expresiones SQL compartidas de las agregaciones de ventas org.
 *
 * Estas cadenas se interpolan en SQL crudo, así que hay dos cosas que probar:
 * que produzcan el bucket correcto, y que una zona horaria inventada NO pueda
 * colarse como inyección.
 */
import { venueLocalExpr, monthBucketSql, dayBucketSql, isoWeekKeySql, weekLabelSql } from '@/services/dashboard/sale-verification.org.sql'

const TZ = 'America/Mexico_City'

describe('expresiones de fecha', () => {
  it('convierte de UTC almacenado a hora local del venue', () => {
    expect(venueLocalExpr('sv."createdAt"', TZ)).toBe(`(sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City')`)
  })

  it('mes en formato YYYY-MM, igual que venueMonthKey', () => {
    expect(monthBucketSql('sv."createdAt"', TZ)).toBe(
      `to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM')`,
    )
  })

  it('día en formato YYYY-MM-DD', () => {
    expect(dayBucketSql('sv."createdAt"', TZ)).toBe(
      `to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM-DD')`,
    )
  })

  it('semana ISO usa IYYY/IW — el año ISO, no el calendario', () => {
    expect(isoWeekKeySql('sv."createdAt"', TZ)).toBe(
      `to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), 'IYYY-"W"IW')`,
    )
  })

  it('etiqueta de semana sin año', () => {
    expect(weekLabelSql('sv."createdAt"', TZ)).toBe(
      `to_char((sv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'), '"W"IW')`,
    )
  })
})

describe('defensa contra inyección por zona horaria', () => {
  it.each([`America/Mexico_City'; DROP TABLE "Payment"; --`, `'; SELECT 1; --`, 'Zona/Inventada', ''])('rechaza %p', bad => {
    expect(() => monthBucketSql('sv."createdAt"', bad)).toThrow()
  })

  it('acepta zonas IANA reales', () => {
    expect(() => monthBucketSql('sv."createdAt"', 'UTC')).not.toThrow()
    expect(() => monthBucketSql('sv."createdAt"', 'America/Monterrey')).not.toThrow()
  })
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.sql.test.ts
```

Esperado: FAIL — `Cannot find module '@/services/dashboard/sale-verification.org.sql'`.

- [ ] **Step 4: Implementar**

Crear `src/services/dashboard/sale-verification.org.sql.ts`:

```typescript
/**
 * Expresiones SQL compartidas por las agregaciones de ventas de la organización.
 *
 * POR QUÉ EXISTE: antes cada agregación leía las 5,446 filas y las agrupaba en JS,
 * convirtiendo zona horaria por fila. Postgres hace ese trabajo en C y devuelve ~20
 * renglones. Aquí viven las expresiones para que el bucket sea idéntico en las 12
 * agregaciones y para poder probarlas sin base de datos.
 *
 * 🔴 Los formatos DEBEN coincidir carácter por carácter con `src/utils/venueDateKeys.ts`:
 *   'YYYY-MM'      ↔ venueMonthKey
 *   'YYYY-MM-DD'   ↔ venueDayKey
 *   'IYYY-"W"IW'   ↔ venueIsoWeekKey   (IYYY = año ISO, NO el calendario)
 *   '"W"IW'        ↔ venueWeekLabel
 *
 * 🔴 `createdAt` es `timestamp without time zone` guardando UTC real. Por eso el doble
 * `AT TIME ZONE`: el primero lo marca como UTC, el segundo lo lleva a hora del venue.
 * Precedente en `src/services/command-center/commandCenter.service.ts:590`.
 */
import { Prisma } from '@prisma/client'
import { assertValidIANATimezone } from '../../utils/sanitizeTimezone'

export interface AggregationRange {
  fromDate?: Date
  toDate?: Date
}

/** Instante almacenado (UTC) → hora de pared del venue. La tz se valida antes de interpolarse. */
export function venueLocalExpr(column: string, timezone: string): string {
  assertValidIANATimezone(timezone)
  return `(${column} AT TIME ZONE 'UTC' AT TIME ZONE '${timezone}')`
}

export function monthBucketSql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, 'YYYY-MM')`
}

export function dayBucketSql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, 'YYYY-MM-DD')`
}

/** "2026-W32" — ordenable entre años porque usa el año ISO. */
export function isoWeekKeySql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, 'IYYY-"W"IW')`
}

/** "W32" — sin año. */
export function weekLabelSql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, '"W"IW')`
}

/**
 * Condiciones de rango como SQL PARAMETRIZADO. Las fechas nunca se interpolan como
 * texto: van como parámetros de Prisma.
 */
export function buildRangeConditions(range: AggregationRange, column: string): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (range.fromDate) parts.push(Prisma.sql`AND ${Prisma.raw(column)} >= ${range.fromDate}`)
  if (range.toDate) parts.push(Prisma.sql`AND ${Prisma.raw(column)} <= ${range.toDate}`)
  return parts.length > 0 ? Prisma.join(parts, ' ') : Prisma.empty
}
```

- [ ] **Step 5: Verificar que `assertValidIANATimezone` existe y lanza**

```bash
grep -n "export function assertValidIANATimezone\|export const assertValidIANATimezone" src/utils/sanitizeTimezone.ts
```

Si el nombre real difiere (p. ej. `sanitizeTimezone` o `assertValidTimezone`), usar ese e importar el correcto. Si no existe ninguna
variante que **lance** ante una zona inválida, escribirla en `src/utils/sanitizeTimezone.ts` reusando `isValidIANATimezone`:

```typescript
export function assertValidIANATimezone(timezone: string): void {
  if (!isValidIANATimezone(timezone)) {
    throw new BadRequestError(`Zona horaria inválida: ${timezone}`)
  }
}
```

- [ ] **Step 6: Correr los tests**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.sql.test.ts
```

Esperado: PASS (11 tests).

- [ ] **Step 7: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/services/dashboard/sale-verification.org.sql.ts tests/unit/services/dashboard/sale-verification.org.sql.test.ts tests/__helpers__/setup.ts src/utils/sanitizeTimezone.ts
git commit -m "feat(reportes): expresiones SQL compartidas para bucketing venue-local"
```

---

### Task 5: Paridad JS ↔ Postgres contra base real

Antes de migrar una sola agregación hay que **probar** que `venueIsoWeekKey` y `to_char(..., 'IYYY-"W"IW')` dan lo mismo. Si difieren, todas
las migraciones quedan mal y no nos enteraríamos hasta enero de 2027.

**Files:**

- Create: `tests/api-tests/sale-verification.org.week-parity.test.ts`

**Interfaces:**

- Consumes: `venueMonthKey`, `venueDayKey`, `venueIsoWeekKey` (Task 1); `monthBucketSql`, `dayBucketSql`, `isoWeekKeySql` (Task 4).
- Produces: nada — es una red de seguridad.

- [ ] **Step 1: Escribir el test**

Crear `tests/api-tests/sale-verification.org.week-parity.test.ts`:

```typescript
/**
 * Paridad JS ↔ Postgres para las llaves de fecha.
 *
 * Las agregaciones agrupan en SQL, pero varias partes del sistema (el MCP, tests,
 * fallbacks) siguen calculando llaves en JS. Si las dos implementaciones se separan,
 * los números dejan de cuadrar SIN error visible. Este test recorre instantes de
 * frontera —cambios de año, de mes, domingos por la noche, el 4-ene-2027— y exige
 * que Postgres y JS digan exactamente lo mismo.
 */
import prisma from '@/utils/prismaClient'
import { venueMonthKey, venueDayKey, venueIsoWeekKey, venueWeekLabel } from '@/utils/venueDateKeys'
import { monthBucketSql, dayBucketSql, isoWeekKeySql, weekLabelSql } from '@/services/dashboard/sale-verification.org.sql'

const TZ = 'America/Mexico_City'

// Instantes elegidos por peligrosos, no al azar.
const INSTANTES = [
  '2026-01-01T06:00:00Z', // 1-ene medianoche México
  '2026-01-01T18:00:00Z',
  '2026-01-11T23:00:00Z', // domingo por la noche
  '2026-01-12T05:59:00Z', // un minuto antes de medianoche México
  '2026-03-30T00:00:00Z', // primer dato real de PlayTelecom
  '2026-08-04T18:00:00Z',
  '2026-12-31T23:59:00Z',
  '2027-01-03T18:00:00Z', // domingo: pertenece a 2026-W53
  '2027-01-04T07:00:00Z', // 🔴 la bomba: el código viejo decía W02
  '2027-01-04T18:00:00Z',
  '2027-12-31T18:00:00Z',
  '2028-01-01T18:00:00Z',
]

describe('paridad de llaves de fecha JS ↔ Postgres', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it.each(INSTANTES)('%s da la misma llave en JS y en Postgres', async iso => {
    const d = new Date(iso)

    const rows = await prisma.$queryRawUnsafe<Array<{ mes: string; dia: string; semana: string; etiqueta: string }>>(
      `SELECT ${monthBucketSql('$1::timestamp', TZ)} AS mes,
              ${dayBucketSql('$1::timestamp', TZ)} AS dia,
              ${isoWeekKeySql('$1::timestamp', TZ)} AS semana,
              ${weekLabelSql('$1::timestamp', TZ)} AS etiqueta`,
      d,
    )

    expect(rows[0].mes).toBe(venueMonthKey(d, TZ))
    expect(rows[0].dia).toBe(venueDayKey(d, TZ))
    expect(rows[0].semana).toBe(venueIsoWeekKey(d, TZ))
    expect(rows[0].etiqueta).toBe(venueWeekLabel(d, TZ))
  })
})
```

- [ ] **Step 2: Correr contra la base real, bajo LAS DOS zonas de host**

```bash
TZ=UTC npx jest tests/api-tests/sale-verification.org.week-parity.test.ts
```

```bash
TZ=America/Mexico_City npx jest tests/api-tests/sale-verification.org.week-parity.test.ts
```

Esperado: PASS en ambas.

**Si falla:** parar y no seguir con las migraciones. Una divergencia aquí significa que `venueDateKeys` y las expresiones SQL no están de
acuerdo, y toda la migración quedaría mal. Diagnosticar cuál de los dos lados está mal antes de continuar. Sospechosos por orden: (a) `IYYY`
escrito como `YYYY` en el SQL — es el error clásico y sólo se nota en los bordes de año; (b) el doble `AT TIME ZONE` invertido.

- [ ] **Step 3: Commitear**

```bash
git add tests/api-tests/sale-verification.org.week-parity.test.ts
git commit -m "test(reportes): paridad de llaves de fecha entre JS y Postgres"
```

---

### Task 6: Migrar las agregaciones de sólo fecha

`getSalesByMonth`, `getSalesByWeek` y `getSalesBySaleTypeWeekly` comparten forma: agrupan por bucket de fecha (y a lo mucho un booleano),
sin joins más allá de `Venue` para el filtro de organización. Son las tres más simples y establecen el patrón que siguen las demás.

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts:446-465` (`getSalesByMonth`), `:511-529` (`getSalesByWeek`),
  `:536-558` (`getSalesBySaleTypeWeekly`)
- Test: `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts`

**Interfaces:**

- Consumes: `monthBucketSql`, `weekLabelSql`, `isoWeekKeySql`, `buildRangeConditions` (Task 4).
- Produces: las mismas tres funciones con la MISMA firma y la MISMA forma de respuesta. Ningún consumidor cambia.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts`:

```typescript
describe('agregaciones de sólo fecha — ahora agrupan en SQL', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('getSalesByMonth devuelve lo que agrupó Postgres, ordenado desc', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { bucket: '2026-06', count: BigInt(3), revenue: '450.50' },
      { bucket: '2026-08', count: BigInt(5), revenue: '1200.00' },
      { bucket: '2026-07', count: BigInt(2), revenue: '300.25' },
    ])

    const result = await getSalesByMonth('org-1', {})

    expect(result).toEqual([
      { month: '2026-08', count: 5, revenue: 1200.0 },
      { month: '2026-07', count: 2, revenue: 300.25 },
      { month: '2026-06', count: 3, revenue: 450.5 },
    ])
  })

  it('getSalesByMonth NO trae filas crudas: una sola consulta agregada', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([])

    await getSalesByMonth('org-1', {})

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.saleVerification.findMany).not.toHaveBeenCalled()
  })

  it('getSalesByWeek convierte count y revenue a número (nunca BigInt ni Decimal a la respuesta)', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ bucket: 'W32', count: BigInt(7), revenue: '999.99' }])

    const result = await getSalesByWeek('org-1', {})

    expect(result).toEqual([{ week: 'W32', count: 7, revenue: 999.99 }])
    expect(typeof result[0].count).toBe('number')
    expect(typeof result[0].revenue).toBe('number')
  })

  it('getSalesBySaleTypeWeekly siempre devuelve las dos filas, en orden fijo, aunque una venga vacía', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ bucket: '2026-W32', is_portabilidad: false, count: BigInt(4) }])

    const result = await getSalesBySaleTypeWeekly('org-1', {})

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: 'Líneas Nuevas', byWeek: { '2026-W32': 4 }, total: 4 })
    expect(result[1]).toEqual({ name: 'Portabilidades', byWeek: {}, total: 0 })
  })

  it('getSalesBySaleTypeWeekly suma ambos tipos en semanas distintas', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { bucket: '2026-W32', is_portabilidad: false, count: BigInt(4) },
      { bucket: '2026-W32', is_portabilidad: true, count: BigInt(1) },
      { bucket: '2026-W33', is_portabilidad: true, count: BigInt(2) },
    ])

    const result = await getSalesBySaleTypeWeekly('org-1', {})

    expect(result[0]).toEqual({ name: 'Líneas Nuevas', byWeek: { '2026-W32': 4 }, total: 4 })
    expect(result[1]).toEqual({ name: 'Portabilidades', byWeek: { '2026-W32': 1, '2026-W33': 2 }, total: 3 })
  })
})
```

- [ ] **Step 2: Correr para verificar que fallan**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts -t "sólo fecha"
```

Esperado: FAIL — las funciones siguen llamando a `findMany`.

- [ ] **Step 3: Reemplazar las tres implementaciones**

En `src/services/dashboard/sale-verification.org.dashboard.service.ts`, agregar los imports:

```typescript
import { Prisma } from '@prisma/client'
import { monthBucketSql, weekLabelSql, isoWeekKeySql, buildRangeConditions } from './sale-verification.org.sql'
```

Reemplazar `getSalesByMonth` (líneas 446-465):

```typescript
export async function getSalesByMonth(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ month: string; count: number; revenue: number }>> {
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; count: bigint; revenue: string | null }>>(Prisma.sql`
    SELECT ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)                        AS count,
           COALESCE(SUM(p."amount"), 0)    AS revenue
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Payment" p ON p."id" = sv."paymentId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY ${Prisma.raw(bucket)}
    ORDER BY bucket DESC
  `)

  return rows.map(r => ({
    month: r.bucket,
    count: Number(r.count),
    revenue: Number(r.revenue ?? 0),
  }))
}
```

Reemplazar `getSalesByWeek` (líneas 511-529):

```typescript
export async function getSalesByWeek(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ week: string; count: number; revenue: number }>> {
  const bucket = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; count: bigint; revenue: string | null }>>(Prisma.sql`
    SELECT ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)                     AS count,
           COALESCE(SUM(p."amount"), 0) AS revenue
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Payment" p ON p."id" = sv."paymentId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY ${Prisma.raw(bucket)}
    ORDER BY bucket DESC
  `)

  return rows.map(r => ({
    week: r.bucket,
    count: Number(r.count),
    revenue: Number(r.revenue ?? 0),
  }))
}
```

Reemplazar `getSalesBySaleTypeWeekly` (líneas 536-558):

```typescript
export async function getSalesBySaleTypeWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ name: 'Líneas Nuevas' | 'Portabilidades'; byWeek: Record<string, number>; total: number }>> {
  const bucket = isoWeekKeySql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; is_portabilidad: boolean; count: bigint }>>(Prisma.sql`
    SELECT ${Prisma.raw(bucket)}  AS bucket,
           sv."isPortabilidad"    AS is_portabilidad,
           COUNT(*)               AS count
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY ${Prisma.raw(bucket)}, sv."isPortabilidad"
  `)

  // Las dos filas SIEMPRE presentes y en orden fijo: la gráfica las espera así
  // aunque una venga vacía.
  const nuevas: Record<string, number> = {}
  const portabilidades: Record<string, number> = {}
  let totalNuevas = 0
  let totalPortabilidades = 0

  for (const r of rows) {
    const n = Number(r.count)
    if (r.is_portabilidad) {
      portabilidades[r.bucket] = (portabilidades[r.bucket] ?? 0) + n
      totalPortabilidades += n
    } else {
      nuevas[r.bucket] = (nuevas[r.bucket] ?? 0) + n
      totalNuevas += n
    }
  }

  return [
    { name: 'Líneas Nuevas', byWeek: nuevas, total: totalNuevas },
    { name: 'Portabilidades', byWeek: portabilidades, total: totalPortabilidades },
  ]
}
```

- [ ] **Step 4: Verificar el nombre real de la FK de pago**

El SQL de arriba asume `sv."paymentId"`. Confirmar:

```bash
grep -n "model SaleVerification" -A 30 prisma/schema.prisma | grep -n "paymentId\|payment "
```

Si la columna se llama distinto, corregir las tres consultas antes de seguir.

- [ ] **Step 5: Correr los tests**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
```

Esperado: PASS, incluidos los tests viejos del archivo (algunos mockeaban `findMany` para estas tres funciones y hay que actualizarlos a
`$queryRaw`).

- [ ] **Step 6: Comprobar contra datos reales que los números no cambiaron**

Crear `scripts/temp-verify-aggregation-parity.ts` (temporal — se borra antes de commitear, según `.claude/rules/testing-and-git.md`):

```typescript
// DELETE AFTER: verificación puntual de la migración a SQL (incidente 2026-08-04)
// Compara la salida NUEVA (SQL) contra la implementación VIEJA (JS) sobre los
// MISMOS datos de producción. Read-only: no escribe nada.
import prisma from '../src/utils/prismaClient'
import { getSalesByMonth, getSalesByWeek } from '../src/services/dashboard/sale-verification.org.dashboard.service'

const ORG_PLAYTELECOM = 'cmietitbn000zpr2d8213qkzq'

/** Réplica EXACTA de la implementación vieja, para comparar contra ella. */
async function viejoPorMes(orgId: string) {
  const verifications = await prisma.saleVerification.findMany({
    where: { status: 'COMPLETED', venue: { organizationId: orgId } },
    include: { payment: { select: { amount: true } } },
  })
  const map = new Map<string, { count: number; revenue: number }>()
  for (const v of verifications) {
    const local = new Date(v.createdAt.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }))
    const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}`
    const prev = map.get(key) ?? { count: 0, revenue: 0 }
    map.set(key, {
      count: prev.count + 1,
      revenue: prev.revenue + (v.payment?.amount ? Number(v.payment.amount) : 0),
    })
  }
  return Array.from(map.entries())
    .map(([month, agg]) => ({ month, ...agg }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

async function main() {
  const nuevo = await getSalesByMonth(ORG_PLAYTELECOM, {})
  const viejo = await viejoPorMes(ORG_PLAYTELECOM)

  console.log('mes      | nuevo cnt | viejo cnt | nuevo $      | viejo $      | ¿cuadra?')
  let todoCuadra = true
  const meses = new Set([...nuevo.map(r => r.month), ...viejo.map(r => r.month)])
  for (const mes of Array.from(meses).sort().reverse()) {
    const n = nuevo.find(r => r.month === mes)
    const v = viejo.find(r => r.month === mes)
    const cuadra = n?.count === v?.count && Math.abs((n?.revenue ?? 0) - (v?.revenue ?? 0)) < 0.005
    if (!cuadra) todoCuadra = false
    console.log(
      `${mes}  | ${String(n?.count ?? 0).padStart(9)} | ${String(v?.count ?? 0).padStart(9)} | ` +
        `${(n?.revenue ?? 0).toFixed(2).padStart(12)} | ${(v?.revenue ?? 0).toFixed(2).padStart(12)} | ${cuadra ? 'sí' : '🔴 NO'}`,
    )
  }

  const totalNuevo = nuevo.reduce((a, r) => a + r.revenue, 0)
  const totalViejo = viejo.reduce((a, r) => a + r.revenue, 0)
  console.log(`\nTOTAL nuevo: ${totalNuevo.toFixed(2)} · viejo: ${totalViejo.toFixed(2)}`)
  console.log(todoCuadra ? '\n✅ Cuadra al centavo.' : '\n🔴 NO CUADRA — no commitear, diagnosticar primero.')

  // Semanas: en 2026 NO debe haber diferencia (verificado hora por hora en el spec §3.1).
  const semanas = await getSalesByWeek(ORG_PLAYTELECOM, {})
  console.log(`\nSemanas devueltas: ${semanas.map(s => s.week).join(', ')}`)

  await prisma.$disconnect()
}

main()
```

```bash
npx tsx scripts/temp-verify-aggregation-parity.ts
```

Esperado: **"✅ Cuadra al centavo."** Si sale 🔴, parar: la migración cambió números y hay que diagnosticar antes de seguir.

- [ ] **Step 7: Formatear y commitear**

```bash
npm run format && npm run lint:fix && rm -f scripts/temp-verify-aggregation-parity.ts
```

```bash
git add src/services/dashboard/sale-verification.org.dashboard.service.ts tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
git commit -m "perf(reportes): agrupar por mes y semana en Postgres, no fila por fila en JS"
```

---

### Task 7: Migrar las agregaciones con join de un salto

`getOrgSalesSummary`, `getSalesByCity`, `getSalesByStore`, `getSalesByPromoter` y `getSalesByPromoterDaily` agrupan por un atributo que está
a un join de distancia (`Venue.city`, `Venue.name`, `Staff`). Mismo patrón que la Task 6 más una columna de agrupación.

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts` — `getOrgSalesSummary:379-440`, `getSalesByCity:606-628`,
  `getSalesByStore:828-853`, `getSalesByPromoter:860-886`, `getSalesByPromoterDaily:931-1007`
- Test: `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts`

**Interfaces:**

- Consumes: `monthBucketSql`, `weekLabelSql`, `dayBucketSql`, `buildRangeConditions` (Task 4); `venueDayKey`, `venueMonthKey` (Task 1, para
  las columnas de días del mes actual).
- Produces: las mismas cinco funciones, firmas y formas de respuesta idénticas.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts`:

```typescript
describe('agregaciones con join de un salto — ahora agrupan en SQL', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('getOrgSalesSummary calcula los 8 KPIs en una sola consulta', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      {
        total_revenue: '5000.00',
        confirmed_revenue: '3000.00',
        total_count: BigInt(10),
        completed_count: BigInt(6),
        pending_count: BigInt(2),
        failed_count: BigInt(1),
        rejected_count: BigInt(1),
        without_verification_count: BigInt(0),
      },
    ])

    const result = await getOrgSalesSummary('org-1', {})

    expect(result).toEqual({
      totalRevenue: 5000,
      confirmedRevenue: 3000,
      totalCount: 10,
      completedCount: 6,
      pendingCount: 2,
      failedCount: 1,
      rejectedCount: 1,
      withoutVerificationCount: 0,
    })
    expect(prisma.payment.findMany).not.toHaveBeenCalled()
  })

  it('getOrgSalesSummary devuelve ceros cuando no hay pagos (no undefined ni NaN)', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      {
        total_revenue: null,
        confirmed_revenue: null,
        total_count: BigInt(0),
        completed_count: BigInt(0),
        pending_count: BigInt(0),
        failed_count: BigInt(0),
        rejected_count: BigInt(0),
        without_verification_count: BigInt(0),
      },
    ])

    const result = await getOrgSalesSummary('org-1', {})

    expect(result.totalRevenue).toBe(0)
    expect(result.confirmedRevenue).toBe(0)
    expect(Number.isNaN(result.totalRevenue)).toBe(false)
  })

  it('getSalesByCity agrupa por ciudad × mes y ordena por total desc', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { city: 'Querétaro', bucket: '2026-07', count: BigInt(2) },
      { city: 'Querétaro', bucket: '2026-08', count: BigInt(5) },
      { city: 'San Luis Potosí', bucket: '2026-08', count: BigInt(3) },
    ])

    const result = await getSalesByCity('org-1', {})

    expect(result).toEqual([
      { city: 'Querétaro', byMonth: { '2026-07': 2, '2026-08': 5 }, total: 7 },
      { city: 'San Luis Potosí', byMonth: { '2026-08': 3 }, total: 3 },
    ])
  })

  it('getSalesByCity usa "Sin ciudad" cuando la sucursal no la tiene', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ city: null, bucket: '2026-08', count: BigInt(4) }])

    const result = await getSalesByCity('org-1', {})

    expect(result[0].city).toBe('Sin ciudad')
  })

  it('getSalesByStore expone byWeek y byMonth de la misma tienda', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { venue_id: 'v1', venue_name: 'BAE Papagayo', week: 'W32', month: '2026-08', count: BigInt(5) },
      { venue_id: 'v1', venue_name: 'BAE Papagayo', week: 'W33', month: '2026-08', count: BigInt(2) },
    ])

    const result = await getSalesByStore('org-1', {})

    expect(result).toEqual([
      {
        venueId: 'v1',
        venueName: 'BAE Papagayo',
        byWeek: { W32: 5, W33: 2 },
        byMonth: { '2026-08': 7 },
        total: 7,
      },
    ])
  })

  it('getSalesByPromoter arma el nombre y usa "Sin promotor" cuando no hay staff', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { staff_id: 's1', first_name: 'Ana', last_name: 'López', bucket: '2026-08', count: BigInt(9) },
      { staff_id: null, first_name: null, last_name: null, bucket: '2026-08', count: BigInt(1) },
    ])

    const result = await getSalesByPromoter('org-1', {})

    expect(result[0]).toEqual({ staffId: 's1', promoterName: 'Ana López', byMonth: { '2026-08': 9 }, total: 9 })
    expect(result[1]).toEqual({ staffId: null, promoterName: 'Sin promotor', byMonth: { '2026-08': 1 }, total: 1 })
  })
})
```

- [ ] **Step 2: Correr para verificar que fallan**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts -t "join de un salto"
```

Esperado: FAIL.

- [ ] **Step 3: Reemplazar `getOrgSalesSummary`**

```typescript
export async function getOrgSalesSummary(
  orgId: string,
  range: AggregationRange,
): Promise<{
  totalRevenue: number
  confirmedRevenue: number
  totalCount: number
  completedCount: number
  pendingCount: number
  failedCount: number
  rejectedCount: number
  withoutVerificationCount: number
}> {
  const rows = await prisma.$queryRaw<
    Array<{
      total_revenue: string | null
      confirmed_revenue: string | null
      total_count: bigint
      completed_count: bigint
      pending_count: bigint
      failed_count: bigint
      rejected_count: bigint
      without_verification_count: bigint
    }>
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(p."amount"), 0)                                                    AS total_revenue,
      COALESCE(SUM(p."amount") FILTER (WHERE sv."status" = 'COMPLETED'), 0)           AS confirmed_revenue,
      COUNT(*)                                                                        AS total_count,
      COUNT(*) FILTER (WHERE sv."status" = 'COMPLETED')                               AS completed_count,
      COUNT(*) FILTER (WHERE sv."status" = 'PENDING')                                 AS pending_count,
      COUNT(*) FILTER (WHERE sv."status" = 'FAILED')                                  AS failed_count,
      COUNT(*) FILTER (WHERE sv."status" = 'REJECTED')                                AS rejected_count,
      COUNT(*) FILTER (WHERE sv."id" IS NULL)                                         AS without_verification_count
    FROM "Payment" p
    JOIN "Order" o ON o."id" = p."orderId"
    JOIN "Venue" v ON v."id" = o."venueId"
    LEFT JOIN "SaleVerification" sv ON sv."paymentId" = p."id"
    WHERE p."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'p."createdAt"')}
  `)

  const r = rows[0]
  return {
    totalRevenue: Number(r?.total_revenue ?? 0),
    confirmedRevenue: Number(r?.confirmed_revenue ?? 0),
    totalCount: Number(r?.total_count ?? 0),
    completedCount: Number(r?.completed_count ?? 0),
    pendingCount: Number(r?.pending_count ?? 0),
    failedCount: Number(r?.failed_count ?? 0),
    rejectedCount: Number(r?.rejected_count ?? 0),
    withoutVerificationCount: Number(r?.without_verification_count ?? 0),
  }
}
```

- [ ] **Step 4: Reemplazar `getSalesByCity`**

```typescript
export async function getSalesByCity(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ city: string; byMonth: Record<string, number>; total: number }>> {
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ city: string | null; bucket: string; count: bigint }>>(Prisma.sql`
    SELECT v."city"              AS city,
           ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)              AS count
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY v."city", ${Prisma.raw(bucket)}
  `)

  const map = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const city = r.city || 'Sin ciudad'
    const row = map.get(city) ?? {}
    row[r.bucket] = (row[r.bucket] ?? 0) + Number(r.count)
    map.set(city, row)
  }

  return Array.from(map.entries())
    .map(([city, byMonth]) => ({
      city,
      byMonth,
      total: Object.values(byMonth).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
}
```

- [ ] **Step 5: Reemplazar `getSalesByStore`**

```typescript
export async function getSalesByStore(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ venueId: string; venueName: string; byWeek: Record<string, number>; byMonth: Record<string, number>; total: number }>> {
  const week = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)
  const month = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<
    Array<{ venue_id: string; venue_name: string | null; week: string; month: string; count: bigint }>
  >(Prisma.sql`
    SELECT v."id"               AS venue_id,
           v."name"             AS venue_name,
           ${Prisma.raw(week)}  AS week,
           ${Prisma.raw(month)} AS month,
           COUNT(*)             AS count
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY v."id", v."name", ${Prisma.raw(week)}, ${Prisma.raw(month)}
  `)

  const map = new Map<string, { name: string; byWeek: Record<string, number>; byMonth: Record<string, number> }>()
  for (const r of rows) {
    const n = Number(r.count)
    const row = map.get(r.venue_id) ?? { name: r.venue_name ?? 'Sin tienda', byWeek: {}, byMonth: {} }
    row.byWeek[r.week] = (row.byWeek[r.week] ?? 0) + n
    row.byMonth[r.month] = (row.byMonth[r.month] ?? 0) + n
    map.set(r.venue_id, row)
  }

  return Array.from(map.entries())
    .map(([venueId, val]) => ({
      venueId,
      venueName: val.name,
      byWeek: val.byWeek,
      byMonth: val.byMonth,
      total: Object.values(val.byWeek).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
}
```

- [ ] **Step 6: Reemplazar `getSalesByPromoter`**

```typescript
export async function getSalesByPromoter(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ staffId: string | null; promoterName: string; byMonth: Record<string, number>; total: number }>> {
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<
    Array<{ staff_id: string | null; first_name: string | null; last_name: string | null; bucket: string; count: bigint }>
  >(Prisma.sql`
    SELECT s."id"               AS staff_id,
           s."firstName"        AS first_name,
           s."lastName"         AS last_name,
           ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)             AS count
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Staff" s ON s."id" = sv."staffId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY s."id", s."firstName", s."lastName", ${Prisma.raw(bucket)}
  `)

  const map = new Map<string, { staffId: string | null; name: string; byMonth: Record<string, number> }>()
  for (const r of rows) {
    const key = r.staff_id ?? 'unassigned'
    const name = r.staff_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : 'Sin promotor'
    const row = map.get(key) ?? { staffId: r.staff_id, name, byMonth: {} }
    row.byMonth[r.bucket] = (row.byMonth[r.bucket] ?? 0) + Number(r.count)
    map.set(key, row)
  }

  return Array.from(map.values())
    .map(v => ({
      staffId: v.staffId,
      promoterName: v.name,
      byMonth: v.byMonth,
      total: Object.values(v.byMonth).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
}
```

- [ ] **Step 7: Reemplazar `getSalesByPromoterDaily`**

Esta además arregla el `new Date(...toLocaleString(...))` de la línea 934 y el `fromZonedTime(new Date(...))` de la 939 — ambos dependen del
`TZ` del host.

```typescript
export async function getSalesByPromoterDaily(orgId: string): Promise<PromoterDailyResult> {
  const tz = VENUE_TIMEZONE_DEFAULT

  // "Hoy" en hora del venue, sin depender del TZ del proceso.
  const hoy = venueCivilDate(new Date(), tz)
  const monthKey = `${hoy.year}-${String(hoy.month).padStart(2, '0')}`
  // Cadena explícita → fromZonedTime la lee en la zona del VENUE, no en la del host.
  const rangeStart = fromZonedTime(`${monthKey}-01T00:00:00.000`, tz)

  const days: string[] = []
  for (let d = 1; d <= hoy.day; d++) days.push(`${monthKey}-${String(d).padStart(2, '0')}`)

  const dayBucket = dayBucketSql('sv."createdAt"', tz)
  const monthBucket = monthBucketSql('sv."createdAt"', tz)

  // Una sola consulta: COMPLETED del mes en curso por día, más los FAILED de
  // SIEMPRE separados en "este mes" vs "meses anteriores".
  const rows = await prisma.$queryRaw<
    Array<{
      staff_id: string | null
      first_name: string | null
      last_name: string | null
      day_key: string | null
      completed_count: bigint
      to_review: bigint
      to_review_previous: bigint
    }>
  >(Prisma.sql`
    SELECT s."id"        AS staff_id,
           s."firstName" AS first_name,
           s."lastName"  AS last_name,
           CASE WHEN sv."status" = 'COMPLETED' AND sv."createdAt" >= ${rangeStart}
                THEN ${Prisma.raw(dayBucket)} END AS day_key,
           COUNT(*) FILTER (WHERE sv."status" = 'COMPLETED' AND sv."createdAt" >= ${rangeStart}) AS completed_count,
           COUNT(*) FILTER (WHERE sv."status" = 'FAILED' AND ${Prisma.raw(monthBucket)} = ${monthKey}) AS to_review,
           COUNT(*) FILTER (WHERE sv."status" = 'FAILED' AND ${Prisma.raw(monthBucket)} <> ${monthKey}) AS to_review_previous
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Staff" s ON s."id" = sv."staffId"
    WHERE v."organizationId" = ${orgId}
      AND (
        (sv."status" = 'COMPLETED' AND sv."createdAt" >= ${rangeStart})
        OR sv."status" = 'FAILED'
      )
    GROUP BY s."id", s."firstName", s."lastName",
             CASE WHEN sv."status" = 'COMPLETED' AND sv."createdAt" >= ${rangeStart}
                  THEN ${Prisma.raw(dayBucket)} END
  `)

  const map = new Map<string, PromoterDailyRow>()
  for (const r of rows) {
    const key = r.staff_id ?? 'unassigned'
    const row =
      map.get(key) ??
      ({
        staffId: r.staff_id,
        promoterName: r.staff_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : 'Sin promotor',
        byDay: {},
        total: 0,
        toReview: 0,
        toReviewPrevious: 0,
      } as PromoterDailyRow)

    if (r.day_key) {
      const n = Number(r.completed_count)
      row.byDay[r.day_key] = (row.byDay[r.day_key] ?? 0) + n
      row.total += n
    }
    row.toReview += Number(r.to_review)
    row.toReviewPrevious += Number(r.to_review_previous)
    map.set(key, row)
  }

  return {
    month: monthKey,
    days,
    rows: Array.from(map.values()).sort((a, b) => b.total - a.total),
  }
}
```

Agregar el import de `venueCivilDate`:

```typescript
import { venueCivilDate } from '../../utils/venueDateKeys'
```

- [ ] **Step 8: Correr los tests**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
```

Esperado: PASS.

- [ ] **Step 9: Comprobar contra datos reales**

Repetir el script temporal de la Task 6 Step 6 para estas cinco funciones. **Los KPIs de `summary` tienen que cuadrar al peso** contra lo
que muestra hoy el dashboard. Borrar el script al terminar.

- [ ] **Step 10: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/services/dashboard/sale-verification.org.dashboard.service.ts tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
git commit -m "perf(reportes): agrupar summary, ciudad, tienda y promotor en Postgres"
```

---

### Task 8: Migrar supervisor y promotor semanal

`getSalesBySupervisor` y `getSalesByPromoterWeekly` son mixtas: el agrupado baja a SQL, pero la resolución tienda→supervisor sigue en JS
porque es una regla de negocio (MANAGER primero, ADMIN como respaldo, desempate determinista por `staffId`) sobre ~39 sucursales — un costo
despreciable.

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts:721-767` (`getSalesBySupervisor`), `:773-825`
  (`getSalesByPromoterWeekly`)
- Test: `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts`

**Interfaces:**

- Consumes: `weekLabelSql`, `monthBucketSql`, `buildRangeConditions` (Task 4); `resolveSupervisorByVenue` (ya existe, línea 642, sin
  cambios).
- Produces: las dos funciones con firma y forma de respuesta idénticas.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
describe('supervisor y promotor semanal — agrupado en SQL, atribución en JS', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('getSalesBySupervisor atribuye por sucursal y suma byWeek y byMonth', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { venue_id: 'v1', week: 'W32', month: '2026-08', count: BigInt(5) },
      { venue_id: 'v2', week: 'W32', month: '2026-08', count: BigInt(3) },
    ])
    ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValueOnce([
      { venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Luis', lastName: 'Pérez' } },
      { venueId: 'v2', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Luis', lastName: 'Pérez' } },
    ])

    const result = await getSalesBySupervisor('org-1', {})

    expect(result).toEqual([
      {
        supervisorId: 'sup1',
        supervisorName: 'Luis Pérez',
        byWeek: { W32: 8 },
        byMonth: { '2026-08': 8 },
        total: 8,
      },
    ])
  })

  it('getSalesBySupervisor agrupa bajo "Sin supervisor" las sucursales sin responsable', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ venue_id: 'v9', week: 'W32', month: '2026-08', count: BigInt(2) }])
    ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValueOnce([])

    const result = await getSalesBySupervisor('org-1', {})

    expect(result[0].supervisorId).toBeNull()
    expect(result[0].supervisorName).toBe('Sin supervisor')
    expect(result[0].total).toBe(2)
  })

  it('getSalesByPromoterWeekly abre una fila por par (promotor, tienda)', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { staff_id: 's1', first_name: 'Ana', last_name: 'López', venue_id: 'v1', venue_name: 'BAE Papagayo', week: 'W32', count: BigInt(4) },
      { staff_id: 's1', first_name: 'Ana', last_name: 'López', venue_id: 'v2', venue_name: 'BAE Pavón', week: 'W32', count: BigInt(1) },
    ])
    ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValueOnce([
      { venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Luis', lastName: 'Pérez' } },
    ])

    const result = await getSalesByPromoterWeekly('org-1', {})

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      staffId: 's1',
      promoterName: 'Ana López',
      venueId: 'v1',
      venueName: 'BAE Papagayo',
      supervisorId: 'sup1',
      supervisorName: 'Luis Pérez',
      byWeek: { W32: 4 },
      total: 4,
    })
    expect(result[1]).toMatchObject({ venueId: 'v2', supervisorId: null, supervisorName: 'Sin supervisor', total: 1 })
  })

  it('getSalesByPromoterWeekly descarta ventas sin promotor o sin tienda', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { staff_id: null, first_name: null, last_name: null, venue_id: 'v1', venue_name: 'BAE Papagayo', week: 'W32', count: BigInt(3) },
    ])
    ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValueOnce([])

    const result = await getSalesByPromoterWeekly('org-1', {})

    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Correr para verificar que fallan**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts -t "supervisor y promotor semanal"
```

Esperado: FAIL.

- [ ] **Step 3: Reemplazar `getSalesBySupervisor`**

```typescript
export async function getSalesBySupervisor(
  orgId: string,
  range: AggregationRange,
): Promise<
  Array<{
    supervisorId: string | null
    supervisorName: string
    byWeek: Record<string, number>
    byMonth: Record<string, number>
    total: number
  }>
> {
  const week = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)
  const month = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ venue_id: string; week: string; month: string; count: bigint }>>(
    Prisma.sql`
      SELECT sv."venueId"         AS venue_id,
             ${Prisma.raw(week)}  AS week,
             ${Prisma.raw(month)} AS month,
             COUNT(*)             AS count
      FROM "SaleVerification" sv
      JOIN "Venue" v ON v."id" = sv."venueId"
      WHERE sv."status" = 'COMPLETED'
        AND v."organizationId" = ${orgId}
        ${buildRangeConditions(range, 'sv."createdAt"')}
      GROUP BY sv."venueId", ${Prisma.raw(week)}, ${Prisma.raw(month)}
    `,
  )

  // Atribución de supervisor: regla de negocio sobre ~39 sucursales, no sobre miles
  // de filas. Se queda en JS a propósito (MANAGER primero, ADMIN de respaldo).
  const venueIds = Array.from(new Set(rows.map(r => r.venue_id).filter(Boolean)))
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)

  const map = new Map<string, { name: string; byWeek: Record<string, number>; byMonth: Record<string, number> }>()
  for (const r of rows) {
    const supervisor = supervisorByVenue.get(r.venue_id)
    const key = supervisor?.id ?? 'unassigned'
    const name = supervisor?.name ?? 'Sin supervisor'
    const n = Number(r.count)
    const row = map.get(key) ?? { name, byWeek: {}, byMonth: {} }
    row.byWeek[r.week] = (row.byWeek[r.week] ?? 0) + n
    row.byMonth[r.month] = (row.byMonth[r.month] ?? 0) + n
    map.set(key, row)
  }

  return Array.from(map.entries())
    .map(([supervisorId, val]) => ({
      supervisorId: supervisorId === 'unassigned' ? null : supervisorId,
      supervisorName: val.name,
      byWeek: val.byWeek,
      byMonth: val.byMonth,
      total: Object.values(val.byWeek).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
}
```

- [ ] **Step 4: Reemplazar `getSalesByPromoterWeekly`**

```typescript
export async function getSalesByPromoterWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<
  Array<{
    staffId: string
    promoterName: string
    venueId: string
    venueName: string
    supervisorId: string | null
    supervisorName: string
    byWeek: Record<string, number>
    total: number
  }>
> {
  const week = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<
    Array<{
      staff_id: string | null
      first_name: string | null
      last_name: string | null
      venue_id: string | null
      venue_name: string | null
      week: string
      count: bigint
    }>
  >(Prisma.sql`
    SELECT s."id"              AS staff_id,
           s."firstName"       AS first_name,
           s."lastName"        AS last_name,
           v."id"              AS venue_id,
           v."name"            AS venue_name,
           ${Prisma.raw(week)} AS week,
           COUNT(*)            AS count
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Staff" s ON s."id" = sv."staffId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
    GROUP BY s."id", s."firstName", s."lastName", v."id", v."name", ${Prisma.raw(week)}
  `)

  const venueIds = Array.from(new Set(rows.map(r => r.venue_id).filter((x): x is string => !!x)))
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)

  const map = new Map<
    string,
    { staffId: string; promoterName: string; venueId: string; venueName: string; byWeek: Record<string, number> }
  >()
  for (const r of rows) {
    // Sin promotor o sin tienda no se puede atribuir: se descarta, igual que antes.
    if (!r.staff_id || !r.venue_id) continue
    const key = `${r.staff_id}|${r.venue_id}`
    const row = map.get(key) ?? {
      staffId: r.staff_id,
      promoterName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
      venueId: r.venue_id,
      venueName: r.venue_name ?? 'Sin tienda',
      byWeek: {},
    }
    row.byWeek[r.week] = (row.byWeek[r.week] ?? 0) + Number(r.count)
    map.set(key, row)
  }

  return Array.from(map.values())
    .map(r => {
      const sup = supervisorByVenue.get(r.venueId)
      return {
        ...r,
        supervisorId: sup?.id ?? null,
        supervisorName: sup?.name ?? 'Sin supervisor',
        total: Object.values(r.byWeek).reduce((a, b) => a + b, 0),
      }
    })
    .sort((a, b) => b.total - a.total)
}
```

- [ ] **Step 5: Correr los tests**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
```

Esperado: PASS, incluidos los tests de atribución de supervisor que ya existían (MANAGER sobre ADMIN).

- [ ] **Step 6: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/services/dashboard/sale-verification.org.dashboard.service.ts tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
git commit -m "perf(reportes): agrupar supervisor y promotor-semanal en Postgres"
```

---

### Task 9: Migrar tipo de SIM y quitarle el azar

`getSalesBySimType` y `getSalesBySimTypeWeekly` resuelven la categoría con `payment.order.items.find(oi => oi.serializedItem)` — "el primer
item con serializado". La relación no tiene `orderBy`, así que ese "primero" lo decide Postgres y puede cambiar entre corridas (§3.2 del
spec). En SQL se elige explícitamente con `DISTINCT ON` ordenado.

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts:477-508` (`getSalesBySimType`), `:566-603`
  (`getSalesBySimTypeWeekly`)
- Test: `tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts`

**Interfaces:**

- Consumes: `monthBucketSql`, `isoWeekKeySql`, `buildRangeConditions` (Task 4); `toSimBucket`, `SIM_FIXED_BUCKETS`, `SIM_OTHERS` (ya
  existen).
- Produces: las dos funciones con firma y forma idénticas.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
describe('tipo de SIM — categoría elegida de forma determinista', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('getSalesBySimType agrupa por mes × bucket y ordena por mes desc', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { bucket: '2026-07', category_name: 'SIM Prepago', count: BigInt(2) },
      { bucket: '2026-08', category_name: 'SIM Prepago', count: BigInt(5) },
    ])

    const result = await getSalesBySimType('org-1', {})

    expect(result[0].month).toBe('2026-08')
    expect(result[1].month).toBe('2026-07')
    expect(result[0].total).toBe(5)
  })

  it('getSalesBySimType manda las categorías desconocidas al bucket de otros', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { bucket: '2026-08', category_name: 'Categoría Que No Existe', count: BigInt(3) },
    ])

    const result = await getSalesBySimType('org-1', {})

    expect(result[0].byCategory[toSimBucket('Categoría Que No Existe')]).toBe(3)
    expect(result[0].total).toBe(3)
  })

  it('getSalesBySimType trata la categoría nula igual que antes', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ bucket: '2026-08', category_name: null, count: BigInt(1) }])

    const result = await getSalesBySimType('org-1', {})

    expect(result[0].byCategory[toSimBucket(null)]).toBe(1)
  })

  it('getSalesBySimTypeWeekly siempre devuelve las filas fijas, aunque vengan en cero', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([])

    const result = await getSalesBySimTypeWeekly('org-1', {})

    expect(result.map(r => r.name)).toEqual([...SIM_FIXED_BUCKETS])
    expect(result.every(r => r.total === 0)).toBe(true)
  })

  it('getSalesBySimTypeWeekly sólo agrega la fila de otros cuando tiene ventas', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{ bucket: '2026-W32', category_name: 'Categoría Rarísima', count: BigInt(2) }])

    const result = await getSalesBySimTypeWeekly('org-1', {})

    expect(result[result.length - 1].name).toBe(SIM_OTHERS)
    expect(result[result.length - 1].total).toBe(2)
  })
})
```

Importar `SIM_FIXED_BUCKETS` y `SIM_OTHERS` en el test si aún no están; si no se exportan desde el servicio, exportarlos.

- [ ] **Step 2: Correr para verificar que fallan**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts -t "tipo de SIM"
```

Esperado: FAIL.

- [ ] **Step 3: Reemplazar `getSalesBySimType`**

```typescript
export async function getSalesBySimType(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ month: string; byCategory: Record<string, number>; total: number }>> {
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; category_name: string | null; count: bigint }>>(
    Prisma.sql`
      WITH categoria_por_venta AS (
        -- Una categoría por verificación, elegida de forma DETERMINISTA.
        -- El código anterior usaba .find() sobre una lista sin ordenar, así que
        -- una orden con dos serializados de categorías distintas podía cambiar de
        -- bucket entre corridas. El ORDER BY dentro del DISTINCT ON lo fija.
        SELECT DISTINCT ON (sv."id")
               sv."id"        AS verification_id,
               sv."createdAt" AS created_at,
               ic."name"      AS category_name
        FROM "SaleVerification" sv
        JOIN "Venue" v ON v."id" = sv."venueId"
        LEFT JOIN "Payment" p ON p."id" = sv."paymentId"
        LEFT JOIN "OrderItem" oi ON oi."orderId" = p."orderId"
        LEFT JOIN "SerializedItem" si ON si."id" = oi."serializedItemId"
        LEFT JOIN "ItemCategory" ic ON ic."id" = si."categoryId"
        WHERE sv."status" = 'COMPLETED'
          AND v."organizationId" = ${orgId}
          ${buildRangeConditions(range, 'sv."createdAt"')}
        ORDER BY sv."id", (si."id" IS NULL), oi."id"
      )
      SELECT ${Prisma.raw(bucket.replace(/sv\."createdAt"/g, 'cv."created_at"'))} AS bucket,
             cv."category_name"                                                   AS category_name,
             COUNT(*)                                                             AS count
      FROM categoria_por_venta cv
      GROUP BY 1, 2
    `,
  )

  const map = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const row = map.get(r.bucket) ?? {}
    const b = toSimBucket(r.category_name)
    row[b] = (row[b] ?? 0) + Number(r.count)
    map.set(r.bucket, row)
  }

  return Array.from(map.entries())
    .map(([month, byCategory]) => ({
      month,
      byCategory,
      total: Object.values(byCategory).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.month.localeCompare(a.month))
}
```

**Nota sobre `ORDER BY sv."id", (si."id" IS NULL), oi."id"`:** el segundo término empuja al final las filas sin serializado, así que
`DISTINCT ON` se queda con un item que **sí** trae serializado si existe alguno — igual que hacía `.find(oi => oi.serializedItem)`. El
tercer término (`oi."id"`) es el desempate estable que faltaba.

- [ ] **Step 4: Verificar los nombres reales de columnas del join**

El SQL asume `OrderItem."serializedItemId"`, `SerializedItem."categoryId"`, `ItemCategory."name"` y `Payment."orderId"`. Confirmar cada uno:

```bash
grep -n "model OrderItem" -A 40 prisma/schema.prisma | grep -n "serializedItem"
```

```bash
grep -n "model SerializedItem" -A 60 prisma/schema.prisma | grep -n "categoryId\|category "
```

Corregir el SQL si algún nombre difiere. **No seguir con nombres supuestos.**

- [ ] **Step 5: Reemplazar `getSalesBySimTypeWeekly`**

Idéntico patrón, cambiando el bucket a semana ISO:

```typescript
export async function getSalesBySimTypeWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ name: SimBucket; byWeek: Record<string, number>; total: number }>> {
  const bucket = isoWeekKeySql('cv."created_at"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; category_name: string | null; count: bigint }>>(
    Prisma.sql`
      WITH categoria_por_venta AS (
        SELECT DISTINCT ON (sv."id")
               sv."id"        AS verification_id,
               sv."createdAt" AS created_at,
               ic."name"      AS category_name
        FROM "SaleVerification" sv
        JOIN "Venue" v ON v."id" = sv."venueId"
        LEFT JOIN "Payment" p ON p."id" = sv."paymentId"
        LEFT JOIN "OrderItem" oi ON oi."orderId" = p."orderId"
        LEFT JOIN "SerializedItem" si ON si."id" = oi."serializedItemId"
        LEFT JOIN "ItemCategory" ic ON ic."id" = si."categoryId"
        WHERE sv."status" = 'COMPLETED'
          AND v."organizationId" = ${orgId}
          ${buildRangeConditions(range, 'sv."createdAt"')}
        ORDER BY sv."id", (si."id" IS NULL), oi."id"
      )
      SELECT ${Prisma.raw(bucket)} AS bucket,
             cv."category_name"    AS category_name,
             COUNT(*)              AS count
      FROM categoria_por_venta cv
      GROUP BY 1, 2
    `,
  )

  const acc = new Map<SimBucket, { byWeek: Record<string, number>; total: number }>()
  const ensure = (b: SimBucket) => {
    let r = acc.get(b)
    if (!r) {
      r = { byWeek: {}, total: 0 }
      acc.set(b, r)
    }
    return r
  }
  for (const b of SIM_FIXED_BUCKETS) ensure(b) // las filas fijas siempre presentes

  for (const r of rows) {
    const target = ensure(toSimBucket(r.category_name))
    const n = Number(r.count)
    target.byWeek[r.bucket] = (target.byWeek[r.bucket] ?? 0) + n
    target.total += n
  }

  const ordered: SimBucket[] = [...SIM_FIXED_BUCKETS]
  const others = acc.get(SIM_OTHERS)
  if (others && others.total > 0) ordered.push(SIM_OTHERS)
  return ordered.map(name => ({ name, ...ensure(name) }))
}
```

Por consistencia, cambiar también el bucket de `getSalesBySimType` a `monthBucketSql('cv."created_at"', VENUE_TIMEZONE_DEFAULT)` y quitar el
`.replace(...)` del Step 3 — el `replace` funciona pero es frágil.

- [ ] **Step 6: Correr los tests**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
```

Esperado: PASS.

- [ ] **Step 7: Verificar que el total de SIM cuadra con el total semanal**

Regla de negocio explícita de Isaac (2026-06-29): _"el total debe cuadrar en todas las tablas y gráficas"_. Comprobar contra datos reales
que `sum(getSalesBySimTypeWeekly[].total) === sum(getSalesByWeek[].count)` para el mismo rango. Si no cuadra, el `DISTINCT ON` está
perdiendo o duplicando filas.

- [ ] **Step 8: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/services/dashboard/sale-verification.org.dashboard.service.ts tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
git commit -m "perf(reportes): agrupar tipo de SIM en Postgres con eleccion determinista de categoria

La categoria salia de .find() sobre una relacion sin orderBy, asi que una orden
con dos serializados de categorias distintas podia cambiar de bucket entre
corridas. DISTINCT ON con ORDER BY explicito lo fija."
```

---

### Task 10: Borrar los helpers viejos y poner el presupuesto a prueba

Cierre: se eliminan las cuatro funciones que causaron el incidente y se agrega el test que hace fallar CI si alguna agregación vuelve a
retener el hilo.

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts` — borrar `toWeekLabel:351`, `toIsoWeekKey:363`,
  `toMonthKey:373`, `toDayKey:889`
- Create: `tests/unit/services/dashboard/sale-verification.org.eventloop-budget.test.ts`

**Interfaces:**

- Consumes: `measureEventLoopBlock`, `EVENT_LOOP_BUDGET_MS` (Task 2); las 12 agregaciones migradas.
- Produces: nada.

- [ ] **Step 1: Verificar que ya nadie usa los helpers viejos**

```bash
grep -n "toWeekLabel\|toIsoWeekKey\|toMonthKey\|toDayKey" src/ -r
```

Esperado: **sin resultados**. Si aparece alguno, esa agregación no se migró — volver a la tarea correspondiente antes de seguir.

- [ ] **Step 2: Borrar las cuatro funciones**

Eliminar de `src/services/dashboard/sale-verification.org.dashboard.service.ts` los bloques de `toWeekLabel`, `toIsoWeekKey`, `toMonthKey` y
`toDayKey` completos, incluyendo sus comentarios.

- [ ] **Step 3: Escribir el test de presupuesto**

Crear `tests/unit/services/dashboard/sale-verification.org.eventloop-budget.test.ts`:

```typescript
/**
 * Presupuesto de event loop de las agregaciones de ventas org.
 *
 * Este test es el que impide que vuelva a pasar el 2026-08-04. No mide cuánto TARDA
 * una agregación (esperar a Postgres puede tardar y está bien): mide cuánto tiempo
 * SEGUIDO retiene el hilo. Si alguien vuelve a meter un bucle pesado sobre miles de
 * filas, esto truena antes de llegar a producción.
 *
 * El mock devuelve un resultado agregado realista (~20 renglones), que es justo lo
 * que Postgres regresa ahora. Si una agregación volviera a leer filas crudas, el
 * post-procesamiento en JS se dispararía y el presupuesto se rompería.
 */
import {
  getSalesByMonth,
  getSalesByWeek,
  getSalesBySaleTypeWeekly,
  getSalesByCity,
  getSalesByStore,
  getSalesByPromoter,
  getSalesBySupervisor,
  getSalesBySimType,
  getSalesBySimTypeWeekly,
  getSalesByPromoterWeekly,
  getSalesByPromoterDaily,
  getOrgSalesSummary,
} from '@/services/dashboard/sale-verification.org.dashboard.service'
import { measureEventLoopBlock, EVENT_LOOP_BUDGET_MS } from '@/utils/eventLoopBudget'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    payment: { findMany: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
  },
}))

/** ~20 renglones agrupados: lo que Postgres devuelve tras la migración. */
function filasAgregadas() {
  return Array.from({ length: 20 }, (_, i) => ({
    bucket: `2026-W${String(i + 10).padStart(2, '0')}`,
    week: `W${String(i + 10).padStart(2, '0')}`,
    month: `2026-${String((i % 12) + 1).padStart(2, '0')}`,
    city: `Ciudad ${i % 3}`,
    venue_id: `v${i % 5}`,
    venue_name: `BAE ${i % 5}`,
    staff_id: `s${i % 4}`,
    first_name: 'Ana',
    last_name: 'López',
    category_name: 'SIM Prepago',
    is_portabilidad: i % 2 === 0,
    count: BigInt(i + 1),
    revenue: '150.50',
  }))
}

describe('presupuesto de event loop — ninguna agregación retiene el hilo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue(filasAgregadas())
    ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValue([])
  })

  const agregaciones: Array<[string, () => Promise<unknown>]> = [
    ['getOrgSalesSummary', () => getOrgSalesSummary('org-1', {})],
    ['getSalesByMonth', () => getSalesByMonth('org-1', {})],
    ['getSalesByWeek', () => getSalesByWeek('org-1', {})],
    ['getSalesBySaleTypeWeekly', () => getSalesBySaleTypeWeekly('org-1', {})],
    ['getSalesByCity', () => getSalesByCity('org-1', {})],
    ['getSalesByStore', () => getSalesByStore('org-1', {})],
    ['getSalesByPromoter', () => getSalesByPromoter('org-1', {})],
    ['getSalesBySupervisor', () => getSalesBySupervisor('org-1', {})],
    ['getSalesBySimType', () => getSalesBySimType('org-1', {})],
    ['getSalesBySimTypeWeekly', () => getSalesBySimTypeWeekly('org-1', {})],
    ['getSalesByPromoterWeekly', () => getSalesByPromoterWeekly('org-1', {})],
    ['getSalesByPromoterDaily', () => getSalesByPromoterDaily('org-1')],
  ]

  it.each(agregaciones)('%s se mantiene bajo el presupuesto', async (_nombre, fn) => {
    const { maxBlockMs } = await measureEventLoopBlock(fn)
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
  })

  it('las 12 juntas, en paralelo como las dispara el dashboard, tampoco lo rompen', async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      await Promise.all(agregaciones.map(([, fn]) => fn()))
    })
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
  })
})
```

- [ ] **Step 4: Correr el test de presupuesto**

```bash
npx jest tests/unit/services/dashboard/sale-verification.org.eventloop-budget.test.ts
```

Esperado: PASS (13 tests).

- [ ] **Step 4b: Capa 2 del spec — sólo si el presupuesto falla**

El spec (§5, Capa 2) contempla partir en tandas con respiro lo que quede en JS. **Después de las Tasks 6-9 no debería quedar nada que lo
necesite**: el post-procesamiento es armar mapas sobre ~20 renglones, no sobre 5,446 filas. Por eso NO se construye por adelantado — sería
complejidad sin problema que resolver.

**Si el test del Step 4 falla en alguna agregación**, entonces sí hace falta y se implementa así:

```typescript
// src/utils/chunkedForEach.ts
/**
 * Recorre `items` en tandas, soltando el event loop entre cada una.
 *
 * El trabajo TOTAL es el mismo — el reporte sale completo, ni una fila menos —
 * pero deja de hacerse de corrido, así que las demás peticiones se atienden en
 * los huecos. Es exactamente el trato del spec: "que tarde más, pero que no trabe".
 */
export async function chunkedForEach<T>(items: readonly T[], chunkSize: number, fn: (item: T, index: number) => void): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    fn(items[i], i)
    if ((i + 1) % chunkSize === 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
}
```

Aplicarlo sólo en el bucle que rompió el presupuesto, con `chunkSize = 500`, y volver a correr el Step 4.

- [ ] **Step 5: Compilar y correr la suite completa**

```bash
npm run build
```

```bash
npm test
```

Esperado: 0 errores de TypeScript, suite completa verde. Comparar el conteo de suites/tests contra la línea base de esta mañana (5,446+
tests) — no debe **bajar**.

- [ ] **Step 6: Correr los tests de fecha bajo la zona de producción**

```bash
TZ=UTC npx jest tests/unit/utils/venueDateKeys.test.ts tests/unit/services/dashboard/sale-verification.org.aggregations.test.ts
```

Esperado: PASS.

- [ ] **Step 7: Simulación de CI**

```bash
npm run pre-deploy
```

Esperado: PASS. Es el portón obligatorio antes de cualquier push.

- [ ] **Step 8: Formatear y commitear**

```bash
npm run format && npm run lint:fix
```

```bash
git add src/services/dashboard/sale-verification.org.dashboard.service.ts tests/unit/services/dashboard/sale-verification.org.eventloop-budget.test.ts
git commit -m "perf(reportes): borrar los helpers de zona por fila y fijar el presupuesto en CI

Cierra el incidente del 2026-08-04: la pantalla de Ventas de PlayTelecom retenia
el event loop ~9s por endpoint y dejaba /dashboard/auth/status en 33.7s."
```

---

## Verificación final (después de la última tarea)

- [ ] **Contrato del MCP intacto.** Los 11 tools de `src/mcp/tools/saleVerifications.ts` consumen estas funciones directo, sin pasar por el
      controller (§2.4 del spec). Verificar que devuelven exactamente lo mismo que antes:

```bash
npx jest tests/unit/mcp
```

- [ ] **Medir el antes/después en producción.** Con el guardia de la Task 3 desplegado, abrir la pantalla de Ventas de PlayTelecom y
      consultar Better Stack (source `render log stream`, id 1720702) para confirmar que `durationMs` de los endpoints
      `/sale-verifications/*` bajó de 4,000-9,000 ms a menos de 1,000 ms, y que `/dashboard/auth/status` ya no se dispara durante esas
      ráfagas.

- [ ] **Decidir D7 con el founder** (§6.2 del spec): reactivar los 4 monitores de uptime pausados desde el 26-jun-2026, o dejar la detección
      sólo en el log stream. Sin esta decisión, el guardia loguea en un cuarto vacío.

- [ ] **Avisar a PlayTelecom** del cambio de cálculo de semana (§9 del spec). Los números de 2026 no se mueven, pero los reportes semanales
      alimentan el cobro a Walmart.

---

## Fuera de alcance (documentado a propósito en §6 y §6.1 del spec)

Este plan **no** toca, y sigue pendiente:

1. **`/dashboard/auth/status` a 1,655 ms de mediana sin reportes corriendo** — problema independiente, probablemente el N+1 del
   venue-switcher.
2. **Los endpoints del TPV entre 6 y 19 s con el servidor ocioso** — independiente de los reportes (verificado: en los 25 minutos más lentos
   había cero reportes). Ligado a las 29 órdenes PENDING huérfanas. **El founder pidió explícitamente no tocarlo todavía.**
3. **`stock-control/overview` (mediana 3.5 s, máximo 12 s)** — otra pantalla, otra causa, sin diagnosticar.
4. **426 `findMany` en servicios de dashboard**, varios sin `take`.
