# Conciliador de estructura PlayTelecom / BAIT — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conciliar la estructura organizacional de PlayTelecom (supervisor → tienda → promotor) contra el Excel `Estructura BAIT.xlsx`, de
forma re-ejecutable e idempotente, poblando el número de empleado de Bait para que la próxima conciliación empareje por ID y no por nombre.

**Architecture:** Tres módulos puros y testeables en `scripts/lib/baitStructure/` (parseo del Excel, emparejamiento de identidad,
planificación del diff) más un runner en `scripts/conciliar-estructura-bait.ts` que hace todo el I/O contra Prisma. El runner es dry-run por
defecto; `--apply` escribe. La jerarquía NO se modela: vive derivada en `StaffVenue`, que es lo que los dashboards ya leen.

**Tech Stack:** TypeScript, Prisma, `xlsx@0.18.5` (ya en `package.json`, no se agrega dependencia), Jest (proyecto `unit`).

**Spec:** `docs/superpowers/specs/2026-08-23-estructura-bait-conciliador-design.md`

## Global Constraints

- **Nunca `DELETE`.** Toda baja es `active = false` o `Venue.status`. Hay `Order`, `Payment`, `SaleVerification` y `SerializedItem` con FK a
  `Staff.id`.
- 🔴 **CORREGIDO 2026-08-23 tras el primer dry-run contra producción — la versión anterior de esta restricción era FALSA.** Decía: "39 de
  las 42 filas `StaffVenue` con `role='WAITER'` activas son cuentas de TPV (email `tpv-…@internal.avoqado.io`); desasignarlas deja
  terminales sin poder cobrar". **No existe ninguna cuenta de máquina en esta organización.** El correo `tpv-…@internal.avoqado.io` es
  sencillamente cómo Avoqado da de alta a un promotor que no tiene correo propio: esas 39 filas son personas reales, con PIN y con SIMs en
  custodia (Karina de la Cruz 501, Yolanda González 481, Tirza Juárez 471…). La heurística del prefijo del correo se dedujo sin verificar
  quién estaba detrás. **Consecuencia medida:** excluirlas del emparejamiento hizo que 24 de las 25 personas salieran `NOT_FOUND` en el
  primer dry-run. El concepto `isTerminalAccount` se elimina del código; no hay nada que proteger por esa vía. La protección real es otra y
  ya existe: el conciliador solo toca venues nombrados en el Excel, y toda baja es `active = false`, reversible.
- **Nunca adivinar una persona.** Si un renglón del Excel resuelve a ≠1 staff, se reporta y se omite.
- **Todo filtrado por `organizationId`.** Ninguna consulta ni escritura puede salir de la org.
- **`ActivityLog` por cada mutación** (`.claude/rules/critical-warnings.md`), fuera de la transacción y fire-and-forget.
- **Mensajes de Zod y de consola en español** (`.claude/rules/critical-warnings.md`).
- **Dinero: no aplica.** Este cambio no toca importes, órdenes ni pagos.
- 🔴 **No commitear sin OK explícito del founder** (`.claude/rules/testing-and-git.md`). Los pasos de commit quedan escritos pero **no se
  ejecutan** hasta que él lo pida.
- Tras editar TS: `npm run format && npm run lint:fix`.
- Verificación pesada por `avq-verify` desde el root del workspace, nunca a pelo.

## Estructura de archivos

| Archivo                                       | Responsabilidad                                               |
| --------------------------------------------- | ------------------------------------------------------------- |
| `scripts/lib/baitStructure/types.ts`          | Tipos compartidos. Sin lógica.                                |
| `scripts/lib/baitStructure/parseStructure.ts` | Workbook → `StructureRow[]`. Puro.                            |
| `scripts/lib/baitStructure/identity.ts`       | Normalización, ID de tienda, cascada de emparejamiento. Puro. |
| `scripts/lib/baitStructure/planChanges.ts`    | (filas, snapshot, opciones) → `PlanResult`. Puro.             |
| `scripts/conciliar-estructura-bait.ts`        | CLI, lecturas Prisma, impresión del diff, `--apply`.          |
| `tests/unit/scripts/baitStructure/*.test.ts`  | Unitarias de los tres módulos puros.                          |

---

### Task 1: Parseo del Excel

**Files:**

- Create: `avoqado-server/scripts/lib/baitStructure/types.ts`
- Create: `avoqado-server/scripts/lib/baitStructure/parseStructure.ts`
- Test: `avoqado-server/tests/unit/scripts/baitStructure/parseStructure.test.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `StructureRow`, `Puesto`, `parseStructure(workbook: XLSX.WorkBook): StructureRow[]`.

El Excel tiene el encabezado en la fila 3 (columnas B..I) y datos en 4..41. Las filas de `Supervisor` no traen tienda: marcan a quién
cuelgan las filas siguientes hasta el próximo supervisor. Las celdas de relleno son `----------------` o `Variable`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/scripts/baitStructure/parseStructure.test.ts
import * as XLSX from 'xlsx'
import { parseStructure } from '../../../../scripts/lib/baitStructure/parseStructure'

const HEADER = ['ID', 'Nombre', 'Posición', 'Estado', 'Ciudad', 'ID de Tienda', 'Formato', 'Nombre de la tienda']
const DASH = '----------------'

function wb(rows: unknown[][]): XLSX.WorkBook {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[], [], HEADER, ...rows]), 'Estructura')
  return book
}

describe('parseStructure', () => {
  it('cuelga cada promotor del último supervisor leído', () => {
    const rows = parseStructure(
      wb([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
        ['BEQJURR8002', 'Ricardo Juárez Rivera', 'Promotor', 'Querétaro', 'Querétaro', '2978', 'BAE', 'RANCHO SAN PEDRO'],
        ['WMSNAOJ8201', 'Juan Joel Nájera Ortiz', 'Supervisor', 'SLP', 'SLP', DASH, DASH, DASH],
        ['BESCACM7905', 'Martha Paola Candelaria Cortes', 'Promotor', 'SLP', 'SLP', '3984', 'BAE', 'BAE LOMA DEL PEDREGAL'],
      ]),
    )

    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ puesto: 'SUPERVISOR', supervisorCode: null, storeId: null })
    expect(rows[1]).toMatchObject({ puesto: 'PROMOTOR', supervisorCode: 'WMQMEAE8008', storeId: '2978', formato: 'BAE' })
    expect(rows[3]).toMatchObject({ puesto: 'PROMOTOR', supervisorCode: 'WMSNAOJ8201', storeId: '3984' })
  })

  it('marca las vacantes y deja su tienda intacta', () => {
    const rows = parseStructure(
      wb([
        ['WMQMEAE8008', 'Elias Medina Alarcón', 'Supervisor', 'Querétaro', 'Querétaro', DASH, DASH, DASH],
        ['VacantePROMO6QRO1', 'VacantePROMO6QRO1', 'Promotor', 'Querétaro', 'Querétaro', '3636', 'BAE', 'PUERTA DEL SOL'],
      ]),
    )

    expect(rows[1]).toMatchObject({ isVacante: true, storeId: '3636' })
  })

  it('convierte los rellenos en null y reconoce cubre descanso y activaciones', () => {
    const rows = parseStructure(
      wb([
        ['BSSLPRECU02', 'Rene Osbaldo Cubos Alvarez', 'Supervisor', 'SLP', 'SLP', DASH, DASH, DASH],
        ['BSCBJOSE04', 'José Lopes', 'Cubre descanso', 'SLP', 'SLP', 'Variable', 'Variable', 'Variable'],
        ['BSSUPBRA01', 'Braulio Rodrigo Niño Burgos', 'Promotor', 'SLP', 'SLP', DASH, DASH, 'ACTIVACIONES'],
      ]),
    )

    expect(rows[1]).toMatchObject({ puesto: 'CUBRE_DESCANSO', storeId: null, formato: null, storeName: null })
    expect(rows[2]).toMatchObject({ puesto: 'PROMOTOR', storeId: null, storeName: 'ACTIVACIONES' })
  })

  it('ignora filas totalmente vacías', () => {
    expect(parseStructure(wb([[null, null, null, null, null, null, null, null]]))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Desde el root del workspace:

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/parseStructure" --ci
```

Esperado: FAIL — `Cannot find module '../../../../scripts/lib/baitStructure/parseStructure'`.

- [ ] **Step 3: Escribir los tipos**

```typescript
// scripts/lib/baitStructure/types.ts
export type Puesto = 'SUPERVISOR' | 'PROMOTOR' | 'CUBRE_DESCANSO'

/** Un renglón del Excel "Estructura BAIT.xlsx", ya interpretado. */
export interface StructureRow {
  /** Columna "ID": número de empleado de Bait, p.ej. "BEQJURR8002". */
  employeeCode: string
  fullName: string
  puesto: Puesto
  estado: string
  ciudad: string
  /** Columna "ID de Tienda" cuando es numérica; null en supervisores, cubre descanso y activaciones. */
  storeId: string | null
  /** "BAE" | "WE" | "MB" | null */
  formato: string | null
  storeName: string | null
  /** employeeCode del supervisor bajo el que aparece la fila; null si la fila ES el supervisor. */
  supervisorCode: string | null
  isVacante: boolean
}
```

- [ ] **Step 4: Escribir la implementación mínima**

```typescript
// scripts/lib/baitStructure/parseStructure.ts
import * as XLSX from 'xlsx'
import { Puesto, StructureRow } from './types'

const COLUMNS = ['ID', 'Nombre', 'Posición', 'Estado', 'Ciudad', 'ID de Tienda', 'Formato', 'Nombre de la tienda'] as const

/** Mayúsculas sin acentos ni espacios de más. */
function key(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** Las celdas de relleno del archivo ("----------------", "Variable") valen null. */
function cell(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^-+$/.test(raw)) return null
  if (key(raw) === 'VARIABLE') return null
  return raw
}

const PUESTOS: Record<string, Puesto> = {
  SUPERVISOR: 'SUPERVISOR',
  PROMOTOR: 'PROMOTOR',
  'CUBRE DESCANSO': 'CUBRE_DESCANSO',
}

export function parseStructure(workbook: XLSX.WorkBook): StructureRow[] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('El archivo no tiene ninguna hoja')

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: null })

  // El encabezado no está en una fila fija: se busca por contenido.
  const headerIndex = grid.findIndex(row => {
    const cells = (row ?? []).map(key)
    return cells.includes('ID') && cells.includes('NOMBRE') && cells.includes('ID DE TIENDA')
  })
  if (headerIndex === -1) throw new Error(`No encontré el encabezado (se esperaban las columnas: ${COLUMNS.join(', ')})`)

  const header = (grid[headerIndex] ?? []).map(key)
  const at = (row: unknown[], column: (typeof COLUMNS)[number]) => row[header.indexOf(key(column))]

  const rows: StructureRow[] = []
  let supervisorCode: string | null = null

  for (const raw of grid.slice(headerIndex + 1)) {
    const row = raw ?? []
    if (row.every(value => cell(value) === null)) continue

    const employeeCode = cell(at(row, 'ID'))
    const fullName = cell(at(row, 'Nombre'))
    if (!employeeCode || !fullName) continue

    const puesto = PUESTOS[key(at(row, 'Posición'))]
    if (!puesto) continue

    if (puesto === 'SUPERVISOR') supervisorCode = employeeCode

    const storeIdRaw = cell(at(row, 'ID de Tienda'))

    rows.push({
      employeeCode,
      fullName,
      puesto,
      estado: cell(at(row, 'Estado')) ?? '',
      ciudad: cell(at(row, 'Ciudad')) ?? '',
      storeId: storeIdRaw && /^\d+$/.test(storeIdRaw) ? storeIdRaw : null,
      formato: cell(at(row, 'Formato')),
      storeName: cell(at(row, 'Nombre de la tienda')),
      supervisorCode: puesto === 'SUPERVISOR' ? null : supervisorCode,
      isVacante: key(fullName).startsWith('VACANTE') || key(employeeCode).startsWith('VACANTE'),
    })
  }

  return rows
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/parseStructure" --ci
```

Esperado: PASS, 4 tests.

- [ ] **Step 6: Formato y lint**

```bash
cd avoqado-server && npm run format && npm run lint:fix
```

- [ ] **Step 7: Preparar el commit (NO ejecutar sin OK del founder)**

```bash
git add scripts/lib/baitStructure/types.ts scripts/lib/baitStructure/parseStructure.ts tests/unit/scripts/baitStructure/parseStructure.test.ts
git commit -m "feat(scripts): parsear la estructura BAIT desde el Excel"
```

---

### Task 2: Identidad — ID de tienda y emparejamiento de personas

**Files:**

- Create: `avoqado-server/scripts/lib/baitStructure/identity.ts`
- Test: `avoqado-server/tests/unit/scripts/baitStructure/identity.test.ts`

**Interfaces:**

- Consumes: `StructureRow` (Task 1).
- Produces: `norm(value: string): string`, `extractStoreId(venueName: string): string | null`, `ProdStaff`, `MatchResult`,
  `matchStaff(row: StructureRow, pool: ProdStaff[]): MatchResult`.

Es la pieza con riesgo real: 12 de 25 personas están en Avoqado con nombre corto ("Karina de la Cruz") contra el largo del Excel ("Marisol
Karina de la Cruz Zermeño"). La cascada es `employeeCode` → nombre exacto → nombre laxo, y **ante empate no elige**.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/scripts/baitStructure/identity.test.ts
import { extractStoreId, matchStaff, norm, ProdStaff } from '../../../../scripts/lib/baitStructure/identity'
import { StructureRow } from '../../../../scripts/lib/baitStructure/types'

function staff(over: Partial<ProdStaff> & { id: string; firstName: string; lastName: string }): ProdStaff {
  return { employeeCode: null, active: true, isTerminalAccount: false, ...over }
}

function row(over: Partial<StructureRow> & { fullName: string }): StructureRow {
  return {
    employeeCode: 'X1',
    puesto: 'PROMOTOR',
    estado: 'SLP',
    ciudad: 'SLP',
    storeId: null,
    formato: null,
    storeName: null,
    supervisorCode: null,
    isVacante: false,
    ...over,
  }
}

describe('extractStoreId', () => {
  it('saca el ID del final del nombre del venue', () => {
    expect(extractStoreId('BAE RANCHO SAN PEDRO (2978)')).toBe('2978')
    expect(extractStoreId('WE JURICA (5815)')).toBe('5815')
    expect(extractStoreId('BAE LAS FLORES DEL RIO (53)')).toBe('53')
  })

  it('devuelve null cuando el venue no trae ID', () => {
    expect(extractStoreId('Cubre Descanso')).toBeNull()
    expect(extractStoreId('ACTIVACIÓN SLP')).toBeNull()
    expect(extractStoreId('BAE Luis Pasteur')).toBeNull()
  })
})

describe('norm', () => {
  it('quita acentos, puntuación y mayúsculas', () => {
    expect(norm('Ma. del Rosario Ramírez Muñoz')).toBe('MA DEL ROSARIO RAMIREZ MUNOZ')
  })
})

describe('matchStaff', () => {
  const pool = [
    staff({ id: 's1', firstName: 'Karina', lastName: 'de la Cruz' }),
    staff({ id: 's2', firstName: 'Ricardo', lastName: 'Juárez Rivera' }),
    staff({ id: 's3', firstName: 'Tirza', lastName: 'Juárez' }),
    staff({ id: 's4', firstName: 'Braulio', lastName: 'Nino' }),
  ]

  it('gana el employeeCode sobre cualquier nombre', () => {
    const conCodigo = [...pool, staff({ id: 's9', firstName: 'Otro', lastName: 'Nombre', employeeCode: 'BSCBMAR03' })]
    expect(matchStaff(row({ fullName: 'Marisol Karina de la Cruz Zermeño', employeeCode: 'BSCBMAR03' }), conCodigo)).toEqual({
      status: 'MATCHED',
      staffId: 's9',
      via: 'employeeCode',
    })
  })

  it('empareja el nombre corto de prod contra el largo del Excel', () => {
    expect(matchStaff(row({ fullName: 'Marisol Karina de la Cruz Zermeño' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's1',
      via: 'looseName',
    })
    expect(matchStaff(row({ fullName: 'Braulio Rodrigo Niño Burgos' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's4',
      via: 'looseName',
    })
  })

  it('no confunde dos personas que comparten apellido', () => {
    expect(matchStaff(row({ fullName: 'Tirza Guishoba Juarez Guzman' }), pool)).toEqual({
      status: 'MATCHED',
      staffId: 's3',
      via: 'looseName',
    })
  })

  it('reporta ambigüedad en vez de elegir', () => {
    const gemelos = [staff({ id: 'a', firstName: 'Ana', lastName: 'Lopez' }), staff({ id: 'b', firstName: 'Ana', lastName: 'Lopez' })]
    expect(matchStaff(row({ fullName: 'Ana Lopez' }), gemelos)).toEqual({ status: 'AMBIGUOUS', candidates: ['a', 'b'] })
  })

  it('devuelve NOT_FOUND si no hay a quién parecerse', () => {
    expect(matchStaff(row({ fullName: 'Persona Que No Existe' }), pool)).toEqual({ status: 'NOT_FOUND' })
  })

  it('nunca empareja contra una cuenta de terminal', () => {
    const conTpv = [staff({ id: 't1', firstName: 'Braulio', lastName: 'Nino', isTerminalAccount: true })]
    expect(matchStaff(row({ fullName: 'Braulio Rodrigo Niño Burgos' }), conTpv)).toEqual({ status: 'NOT_FOUND' })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/identity" --ci
```

Esperado: FAIL — módulo inexistente.

- [ ] **Step 3: Escribir la implementación mínima**

```typescript
// scripts/lib/baitStructure/identity.ts
import { StructureRow } from './types'

export interface ProdStaff {
  id: string
  firstName: string
  lastName: string
  employeeCode: string | null
  active: boolean
  /** Cuenta de servicio de una terminal (email tpv-…@internal.avoqado.io). Nunca es una persona. */
  isTerminalAccount: boolean
}

export type MatchResult =
  | { status: 'MATCHED'; staffId: string; via: 'employeeCode' | 'exactName' | 'looseName' }
  | { status: 'AMBIGUOUS'; candidates: string[] }
  | { status: 'NOT_FOUND' }

/** Mayúsculas, sin acentos, sin puntuación, espacios colapsados. */
export function norm(value: string): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/**
 * El ID de tienda vive entre paréntesis al final del nombre del venue:
 * "BAE RANCHO SAN PEDRO (2978)" → "2978". Es la llave más estable que existe hoy.
 */
export function extractStoreId(venueName: string): string | null {
  const match = /\((\d+)\)\s*$/.exec(venueName ?? '')
  return match ? match[1] : null
}

const PARTICULAS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'DA', 'DOS', 'MA'])

/** Tokens con los que vale la pena comparar: ≥3 letras y que no sean partículas. */
function tokens(name: string): string[] {
  return norm(name)
    .split(' ')
    .filter(token => token.length >= 3 && !PARTICULAS.has(token))
}

function fullName(staff: ProdStaff): string {
  return `${staff.firstName} ${staff.lastName}`
}

function decide(matches: ProdStaff[], via: 'employeeCode' | 'exactName' | 'looseName'): MatchResult | null {
  if (matches.length === 1) return { status: 'MATCHED', staffId: matches[0].id, via }
  if (matches.length > 1) return { status: 'AMBIGUOUS', candidates: matches.map(m => m.id) }
  return null
}

export function matchStaff(row: StructureRow, pool: ProdStaff[]): MatchResult {
  // Las cuentas de terminal no son personas: nunca son candidatas.
  const candidates = pool.filter(staff => !staff.isTerminalAccount)

  if (row.employeeCode) {
    const byCode = candidates.filter(s => s.employeeCode && norm(s.employeeCode) === norm(row.employeeCode))
    const result = decide(byCode, 'employeeCode')
    if (result) return result
  }

  const byExact = candidates.filter(s => norm(fullName(s)) === norm(row.fullName))
  const exact = decide(byExact, 'exactName')
  if (exact) return exact

  // Laxo: TODOS los tokens significativos del nombre en prod aparecen en el nombre del Excel.
  // Exige al menos 2 tokens para no emparejar por un solo apellido común.
  const excelTokens = new Set(tokens(row.fullName))
  const byLoose = candidates.filter(staff => {
    const prodTokens = tokens(fullName(staff))
    return prodTokens.length >= 2 && prodTokens.every(token => excelTokens.has(token))
  })
  const loose = decide(byLoose, 'looseName')
  if (loose) return loose

  return { status: 'NOT_FOUND' }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/identity" --ci
```

Esperado: PASS, 9 tests.

- [ ] **Step 5: Formato, lint y preparar commit (NO ejecutar el commit sin OK)**

```bash
cd avoqado-server && npm run format && npm run lint:fix
git add scripts/lib/baitStructure/identity.ts tests/unit/scripts/baitStructure/identity.test.ts
git commit -m "feat(scripts): emparejar personas de BAIT por número de empleado con respaldo por nombre"
```

---

### Task 3: Planificador del diff

**Files:**

- Create: `avoqado-server/scripts/lib/baitStructure/planChanges.ts`
- Test: `avoqado-server/tests/unit/scripts/baitStructure/planChanges.test.ts`

**Interfaces:**

- Consumes: `StructureRow` (Task 1); `ProdStaff`, `matchStaff`, `extractStoreId` (Task 2).
- Produces: `ProdSnapshot`, `PlanOptions`, `Change`, `PlanResult`, `planChanges(rows, snapshot, options): PlanResult`.

Función pura: recibe el Excel ya parseado y una foto de producción, devuelve la lista de cambios. **Idempotente**: solo emite un cambio
cuando el estado actual difiere del deseado.

Reglas:

1. La tienda de cada promotor define quién es su supervisor (`supervisorCode` de su fila).
2. Un venue queda con **un solo** MANAGER activo: el designado. Los demás se desasignan **de ese venue**.
3. El promotor designado queda WAITER activo en su tienda. Otros promotores **reales** de ese venue se desasignan; las cuentas de terminal
   **nunca** se tocan.
4. Una fila vacante con `vacantes: 'conservar'` (default) no toca a nadie; con `'libre'` desasigna al promotor real actual.
5. `bajaAusentes` emite `CLOSE_VENUE` para los venues de la org con ID de tienda que no aparecen en el Excel. Los venues **sin** ID de
   tienda (`Cubre Descanso`, `ACTIVACIÓN SLP`, `CAMBACEO SLP`, `Virtual`) quedan siempre fuera: son de operación, no sucursales.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/scripts/baitStructure/planChanges.test.ts
import { planChanges, PlanOptions, ProdSnapshot } from '../../../../scripts/lib/baitStructure/planChanges'
import { ProdStaff } from '../../../../scripts/lib/baitStructure/identity'
import { StructureRow } from '../../../../scripts/lib/baitStructure/types'

const OPTIONS: PlanOptions = { bajaAusentes: false, vacantes: 'conservar' }

function staff(id: string, firstName: string, lastName: string, over: Partial<ProdStaff> = {}): ProdStaff {
  return { id, firstName, lastName, employeeCode: null, active: true, isTerminalAccount: false, ...over }
}

function supervisorRow(employeeCode: string, fullName: string): StructureRow {
  return {
    employeeCode,
    fullName,
    puesto: 'SUPERVISOR',
    estado: 'SLP',
    ciudad: 'SLP',
    storeId: null,
    formato: null,
    storeName: null,
    supervisorCode: null,
    isVacante: false,
  }
}

function promoterRow(employeeCode: string, fullName: string, storeId: string, supervisorCode: string, isVacante = false): StructureRow {
  return {
    employeeCode,
    fullName,
    puesto: 'PROMOTOR',
    estado: 'SLP',
    ciudad: 'SLP',
    storeId,
    formato: 'BAE',
    storeName: 'X',
    supervisorCode,
    isVacante,
  }
}

const SNAPSHOT: ProdSnapshot = {
  venues: [
    { id: 'v1', name: 'BAE EL PORTAL (2838)', status: 'ACTIVE' },
    { id: 'v2', name: 'BAE BANTHI (4494)', status: 'ACTIVE' },
    { id: 'vx', name: 'Cubre Descanso', status: 'ACTIVE' },
  ],
  staff: [
    staff('sup_hugo', 'Hugo', 'González'),
    staff('sup_juan', 'Juan', 'Nájera'),
    staff('promo', 'Alain', 'Rodríguez'),
    staff('tpv', 'TPV', 'Portal', { isTerminalAccount: true }),
  ],
  assignments: [
    { staffId: 'sup_hugo', venueId: 'v1', role: 'MANAGER', active: true },
    { staffId: 'tpv', venueId: 'v1', role: 'WAITER', active: true },
  ],
}

const ROWS = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('ALAIN01', 'Alain Rodríguez Romero', '2838', 'JUAN01')]

describe('planChanges', () => {
  it('cambia el supervisor de la tienda y quita al anterior', () => {
    const kinds = planChanges(ROWS, SNAPSHOT, OPTIONS).changes.map(c => `${c.kind}:${'staffId' in c ? c.staffId : ''}`)
    expect(kinds).toContain('ASSIGN_MANAGER:sup_juan')
    expect(kinds).toContain('UNASSIGN_MANAGER:sup_hugo')
  })

  it('asigna al promotor designado y graba su número de empleado', () => {
    const changes = planChanges(ROWS, SNAPSHOT, OPTIONS).changes
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'ASSIGN_PROMOTER', staffId: 'promo', venueId: 'v1' }))
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'SET_EMPLOYEE_CODE', staffId: 'promo', to: 'ALAIN01' }))
  })

  it('NUNCA desasigna una cuenta de terminal', () => {
    const changes = planChanges(ROWS, SNAPSHOT, OPTIONS).changes
    expect(changes.some(c => 'staffId' in c && c.staffId === 'tpv')).toBe(false)
  })

  it('es idempotente: sobre el resultado ya aplicado no propone nada', () => {
    const applied: ProdSnapshot = {
      ...SNAPSHOT,
      // Ambas personas ya con su número de empleado: si falta una, SET_EMPLOYEE_CODE se vuelve a emitir
      // y la idempotencia no se estaría probando de verdad.
      staff: SNAPSHOT.staff.map(s =>
        s.id === 'promo' ? { ...s, employeeCode: 'ALAIN01' } : s.id === 'sup_juan' ? { ...s, employeeCode: 'JUAN01' } : s,
      ),
      assignments: [
        { staffId: 'sup_juan', venueId: 'v1', role: 'MANAGER', active: true },
        { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true },
        { staffId: 'tpv', venueId: 'v1', role: 'WAITER', active: true },
      ],
    }
    expect(planChanges(ROWS, applied, OPTIONS).changes).toEqual([])
  })

  it('reporta la tienda del Excel que no existe, sin inventarla', () => {
    const rows = [...ROWS, promoterRow('NUEVO01', 'Persona Nueva', '9999', 'JUAN01')]
    const result = planChanges(rows, SNAPSHOT, OPTIONS)
    expect(result.missingVenues.map(r => r.storeId)).toEqual(['9999'])
  })

  it('lista los venues huérfanos y solo los cierra con la bandera', () => {
    expect(planChanges(ROWS, SNAPSHOT, OPTIONS).orphanVenues.map(v => v.id)).toEqual(['v2'])
    expect(planChanges(ROWS, SNAPSHOT, OPTIONS).changes.some(c => c.kind === 'CLOSE_VENUE')).toBe(false)

    const conBaja = planChanges(ROWS, SNAPSHOT, { ...OPTIONS, bajaAusentes: true })
    expect(conBaja.changes).toContainEqual(expect.objectContaining({ kind: 'CLOSE_VENUE', venueId: 'v2' }))
    // "Cubre Descanso" no tiene ID de tienda: nunca se cierra.
    expect(conBaja.changes.some(c => c.kind === 'CLOSE_VENUE' && c.venueId === 'vx')).toBe(false)
  })

  it('una vacante conserva al promotor actual por default y lo libera con la bandera', () => {
    const conPromotor: ProdSnapshot = {
      ...SNAPSHOT,
      assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
    }
    const vacante = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('VacanteX', 'VacanteX', '2838', 'JUAN01', true)]

    expect(planChanges(vacante, conPromotor, OPTIONS).changes.some(c => c.kind === 'UNASSIGN_PROMOTER')).toBe(false)
    expect(planChanges(vacante, conPromotor, { ...OPTIONS, vacantes: 'libre' }).changes).toContainEqual(
      expect.objectContaining({ kind: 'UNASSIGN_PROMOTER', staffId: 'promo' }),
    )
  })

  it('reporta a la persona que no se pudo resolver en vez de adivinar', () => {
    const rows = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('X', 'Nadie Conocido Aqui', '2838', 'JUAN01')]
    const result = planChanges(rows, SNAPSHOT, OPTIONS)
    expect(result.unresolved).toContainEqual(expect.objectContaining({ reason: 'NOT_FOUND' }))
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/planChanges" --ci
```

- [ ] **Step 3: Escribir la implementación mínima**

```typescript
// scripts/lib/baitStructure/planChanges.ts
import { extractStoreId, matchStaff, MatchResult, ProdStaff } from './identity'
import { StructureRow } from './types'

export interface ProdSnapshot {
  venues: Array<{ id: string; name: string; status: string }>
  staff: ProdStaff[]
  assignments: Array<{ staffId: string; venueId: string; role: string; active: boolean }>
}

export interface PlanOptions {
  /** Cierra los venues con ID de tienda que ya no vienen en el Excel. Default false. */
  bajaAusentes: boolean
  /** 'conservar' (default) deja al promotor actual; 'libre' lo desasigna. */
  vacantes: 'conservar' | 'libre'
}

export type Change =
  | { kind: 'SET_EMPLOYEE_CODE'; staffId: string; staffName: string; from: string | null; to: string }
  | { kind: 'ASSIGN_MANAGER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'UNASSIGN_MANAGER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'ASSIGN_PROMOTER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'UNASSIGN_PROMOTER'; staffId: string; staffName: string; venueId: string; venueName: string }
  | { kind: 'CLOSE_VENUE'; venueId: string; venueName: string; from: string }

export interface PlanResult {
  changes: Change[]
  unresolved: Array<{ row: StructureRow; reason: 'AMBIGUOUS' | 'NOT_FOUND'; candidates?: string[] }>
  missingVenues: StructureRow[]
  orphanVenues: Array<{ id: string; name: string }>
}

export function planChanges(rows: StructureRow[], snapshot: ProdSnapshot, options: PlanOptions): PlanResult {
  const changes: Change[] = []
  const unresolved: PlanResult['unresolved'] = []
  const missingVenues: StructureRow[] = []

  const staffById = new Map(snapshot.staff.map(s => [s.id, s]))
  const nameOf = (id: string) => {
    const s = staffById.get(id)
    return s ? `${s.firstName} ${s.lastName}` : id
  }

  const venueByStoreId = new Map<string, { id: string; name: string; status: string }>()
  for (const venue of snapshot.venues) {
    const storeId = extractStoreId(venue.name)
    if (storeId) venueByStoreId.set(storeId, venue)
  }

  const activeOn = (venueId: string, role: string) => snapshot.assignments.filter(a => a.venueId === venueId && a.role === role && a.active)

  // Resolver cada fila a una persona una sola vez.
  const resolved = new Map<StructureRow, string>()
  for (const row of rows) {
    if (row.isVacante) continue
    const result: MatchResult = matchStaff(row, snapshot.staff)
    if (result.status === 'MATCHED') {
      resolved.set(row, result.staffId)
      const staff = staffById.get(result.staffId)!
      if (staff.employeeCode !== row.employeeCode) {
        changes.push({
          kind: 'SET_EMPLOYEE_CODE',
          staffId: staff.id,
          staffName: nameOf(staff.id),
          from: staff.employeeCode,
          to: row.employeeCode,
        })
      }
    } else {
      unresolved.push({ row, reason: result.status, candidates: result.status === 'AMBIGUOUS' ? result.candidates : undefined })
    }
  }

  const supervisorByCode = new Map<string, string>()
  for (const row of rows) {
    if (row.puesto === 'SUPERVISOR') {
      const staffId = resolved.get(row)
      if (staffId) supervisorByCode.set(row.employeeCode, staffId)
    }
  }

  const touchedVenueIds = new Set<string>()

  for (const row of rows) {
    if (!row.storeId) continue

    const venue = venueByStoreId.get(row.storeId)
    if (!venue) {
      missingVenues.push(row)
      continue
    }
    touchedVenueIds.add(venue.id)

    // --- supervisor de la tienda ---
    const supervisorId = row.supervisorCode ? supervisorByCode.get(row.supervisorCode) : undefined
    if (supervisorId) {
      const managers = activeOn(venue.id, 'MANAGER')
      if (!managers.some(m => m.staffId === supervisorId)) {
        changes.push({
          kind: 'ASSIGN_MANAGER',
          staffId: supervisorId,
          staffName: nameOf(supervisorId),
          venueId: venue.id,
          venueName: venue.name,
        })
      }
      for (const other of managers.filter(m => m.staffId !== supervisorId)) {
        changes.push({
          kind: 'UNASSIGN_MANAGER',
          staffId: other.staffId,
          staffName: nameOf(other.staffId),
          venueId: venue.id,
          venueName: venue.name,
        })
      }
    }

    // --- promotor de la tienda ---
    // Las cuentas de terminal (tpv-…) también son WAITER: quedan SIEMPRE fuera.
    const realPromoters = activeOn(venue.id, 'WAITER').filter(a => !staffById.get(a.staffId)?.isTerminalAccount)
    const designatedId = resolved.get(row)

    if (row.isVacante) {
      if (options.vacantes === 'libre') {
        for (const current of realPromoters) {
          changes.push({
            kind: 'UNASSIGN_PROMOTER',
            staffId: current.staffId,
            staffName: nameOf(current.staffId),
            venueId: venue.id,
            venueName: venue.name,
          })
        }
      }
      continue
    }

    if (!designatedId) continue

    if (!realPromoters.some(p => p.staffId === designatedId)) {
      changes.push({
        kind: 'ASSIGN_PROMOTER',
        staffId: designatedId,
        staffName: nameOf(designatedId),
        venueId: venue.id,
        venueName: venue.name,
      })
    }
    for (const other of realPromoters.filter(p => p.staffId !== designatedId)) {
      changes.push({
        kind: 'UNASSIGN_PROMOTER',
        staffId: other.staffId,
        staffName: nameOf(other.staffId),
        venueId: venue.id,
        venueName: venue.name,
      })
    }
  }

  // --- venues huérfanos: solo sucursales (con ID de tienda), nunca los operativos ---
  const orphanVenues = snapshot.venues
    .filter(v => extractStoreId(v.name) !== null && !touchedVenueIds.has(v.id))
    .map(v => ({ id: v.id, name: v.name }))

  if (options.bajaAusentes) {
    for (const venue of orphanVenues) {
      const current = snapshot.venues.find(v => v.id === venue.id)!
      if (current.status !== 'CLOSED') {
        changes.push({ kind: 'CLOSE_VENUE', venueId: venue.id, venueName: venue.name, from: current.status })
      }
    }
  }

  return { changes, unresolved, missingVenues, orphanVenues }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/planChanges" --ci
```

Esperado: PASS, 8 tests.

- [ ] **Step 5: Formato, lint y preparar commit (NO ejecutar el commit sin OK)**

```bash
cd avoqado-server && npm run format && npm run lint:fix
git add scripts/lib/baitStructure/planChanges.ts tests/unit/scripts/baitStructure/planChanges.test.ts
git commit -m "feat(scripts): planificar el diff de estructura BAIT de forma idempotente"
```

---

### Task 4: Runner — lectura de producción y dry-run

**Files:**

- Create: `avoqado-server/scripts/conciliar-estructura-bait.ts`

**Interfaces:**

- Consumes: `parseStructure` (Task 1), `ProdStaff` (Task 2), `planChanges`, `ProdSnapshot`, `PlanOptions`, `Change` (Task 3).
- Produces: el ejecutable. Task 5 le agrega `--apply`.

Sin `--apply` **no escribe nada**. Este task entrega solo la lectura y la impresión del diff.

- [ ] **Step 1: Escribir el runner en modo dry-run**

```typescript
// scripts/conciliar-estructura-bait.ts
/**
 * Concilia la estructura organizacional de PlayTelecom contra "Estructura BAIT.xlsx".
 *
 * Diseño: docs/superpowers/specs/2026-08-23-estructura-bait-conciliador-design.md
 * Asana:  https://app.asana.com/1/12709793723059/project/1213523434401320/task/1217743599033214
 *
 *   npx tsx scripts/conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id>            # dry-run
 *   npx tsx scripts/conciliar-estructura-bait.ts --file=<ruta.xlsx> --org-id=<id> --apply    # escribe
 *
 * Banderas (apagadas por defecto, esperan respuesta del cliente):
 *   --baja-ausentes      cierra los venues con ID de tienda que ya no vienen en el Excel
 *   --vacantes=libre     desasigna al promotor actual de una tienda marcada vacante
 */
import * as XLSX from 'xlsx'
import prisma from '../src/utils/prismaClient'
import { ProdStaff } from './lib/baitStructure/identity'
import { parseStructure } from './lib/baitStructure/parseStructure'
import { Change, PlanOptions, planChanges, ProdSnapshot } from './lib/baitStructure/planChanges'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]

const FILE = arg('file')
const ORG_ID = arg('org-id')
const APPLY = process.argv.includes('--apply')
const OPTIONS: PlanOptions = {
  bajaAusentes: process.argv.includes('--baja-ausentes'),
  vacantes: arg('vacantes') === 'libre' ? 'libre' : 'conservar',
}

const TERMINAL_EMAIL = /^tpv-.*@internal\.avoqado\.io$/i

async function readSnapshot(orgId: string): Promise<ProdSnapshot> {
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true, status: true },
  })

  const links = await prisma.staffVenue.findMany({
    where: { venue: { organizationId: orgId } },
    select: {
      staffId: true,
      venueId: true,
      role: true,
      active: true,
      staff: { select: { id: true, firstName: true, lastName: true, employeeCode: true, active: true, email: true } },
    },
  })

  const staff = new Map<string, ProdStaff>()
  for (const link of links) {
    if (!staff.has(link.staff.id)) {
      staff.set(link.staff.id, {
        id: link.staff.id,
        firstName: link.staff.firstName,
        lastName: link.staff.lastName,
        employeeCode: link.staff.employeeCode,
        active: link.staff.active,
        isTerminalAccount: TERMINAL_EMAIL.test(link.staff.email ?? ''),
      })
    }
  }

  return {
    venues: venues.map(v => ({ id: v.id, name: v.name, status: String(v.status) })),
    staff: [...staff.values()],
    assignments: links.map(l => ({ staffId: l.staffId, venueId: l.venueId, role: String(l.role), active: l.active })),
  }
}

function describe(change: Change): string {
  switch (change.kind) {
    case 'SET_EMPLOYEE_CODE':
      return `  # ${change.staffName}: número de empleado ${change.from ?? '∅'} → ${change.to}`
    case 'ASSIGN_MANAGER':
      return `  + ${change.venueName}: supervisor → ${change.staffName}`
    case 'UNASSIGN_MANAGER':
      return `  − ${change.venueName}: deja de ser supervisor ${change.staffName}`
    case 'ASSIGN_PROMOTER':
      return `  + ${change.venueName}: promotor → ${change.staffName}`
    case 'UNASSIGN_PROMOTER':
      return `  − ${change.venueName}: deja de ser promotor ${change.staffName}`
    case 'CLOSE_VENUE':
      return `  ⨯ ${change.venueName}: ${change.from} → CLOSED`
  }
}

async function main() {
  if (!FILE) throw new Error('Falta --file=<ruta al .xlsx>')
  if (!ORG_ID) throw new Error('Falta --org-id=<id de la organización>')

  console.log(`\n=== Conciliador de estructura BAIT (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)
  console.log(`Archivo: ${FILE}`)
  console.log(`Banderas: baja-ausentes=${OPTIONS.bajaAusentes} · vacantes=${OPTIONS.vacantes}\n`)

  const org = await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } })
  if (!org) throw new Error(`No encontré la organización ${ORG_ID}`)
  console.log(`Organización: ${org.name} (${org.id})\n`)

  const rows = parseStructure(XLSX.readFile(FILE))
  const snapshot = await readSnapshot(org.id)
  const plan = planChanges(rows, snapshot, OPTIONS)

  console.log(`Filas del Excel: ${rows.length} · Venues: ${snapshot.venues.length} · Personas: ${snapshot.staff.length}\n`)

  const grouped = new Map<Change['kind'], Change[]>()
  for (const change of plan.changes) grouped.set(change.kind, [...(grouped.get(change.kind) ?? []), change])

  for (const [kind, list] of grouped) {
    console.log(`— ${kind} (${list.length}) —`)
    for (const change of list) console.log(describe(change))
    console.log()
  }
  if (plan.changes.length === 0) console.log('Sin cambios: la estructura ya coincide con el archivo.\n')

  if (plan.unresolved.length) {
    console.log(`— No resueltas (${plan.unresolved.length}) — se reportan, NO se adivinan —`)
    for (const item of plan.unresolved) {
      console.log(
        `  ? ${item.row.fullName} [${item.row.employeeCode}] → ${item.reason}${item.candidates ? ` candidatos: ${item.candidates.join(', ')}` : ''}`,
      )
    }
    console.log()
  }

  if (plan.missingVenues.length) {
    console.log(`— Tiendas del Excel que no existen (${plan.missingVenues.length}) —`)
    for (const row of plan.missingVenues) console.log(`  ! ${row.storeId} ${row.formato ?? ''} ${row.storeName ?? ''}`)
    console.log()
  }

  if (plan.orphanVenues.length) {
    console.log(
      `— Sucursales sin fila en el Excel (${plan.orphanVenues.length})${OPTIONS.bajaAusentes ? '' : ' — solo informativo, usa --baja-ausentes para cerrarlas'} —`,
    )
    for (const venue of plan.orphanVenues) console.log(`  · ${venue.name}`)
    console.log()
  }

  console.log('=== Resumen ===')
  console.log(
    `Cambios propuestos: ${plan.changes.length} · Sin resolver: ${plan.unresolved.length} · Tiendas faltantes: ${plan.missingVenues.length} · Huérfanas: ${plan.orphanVenues.length}`,
  )
  console.log('\nDry-run: no se modificó nada. Corre con --apply para escribir.')
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Verificar que compila**

```bash
./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.build.json --noEmit
```

Esperado: 0 errores. Si `tsconfig.build.json` excluye `scripts/`, usar `npx tsc --noEmit scripts/conciliar-estructura-bait.ts` con los
mismos `paths` y reportarlo.

- [ ] **Step 3: Correr el dry-run contra producción (solo lectura)**

```bash
DATABASE_URL="<url de prod>" npx tsx scripts/conciliar-estructura-bait.ts \
  --file="/private/tmp/claude-501/-Users-amieva-Documents-Programming-Avoqado/2bd65286-b990-40ce-9278-4a8deeb7a4af/scratchpad/Estructura_BAIT.xlsx" \
  --org-id=cmietitbn000zpr2d8213qkzq
```

Contrastar contra las cifras ya medidas (2026-08-23): **8** `ASSIGN_MANAGER` hacia Juan Nájera, **25** `SET_EMPLOYEE_CODE`, **6** tiendas
faltantes, **18** huérfanas, **0** personas creadas. Una desviación en cualquiera de esos números es un defecto del conciliador, no del
archivo: hay que entenderla antes de seguir.

- [ ] **Step 4: Formato, lint y preparar commit (NO ejecutar el commit sin OK)**

```bash
cd avoqado-server && npm run format && npm run lint:fix
git add scripts/conciliar-estructura-bait.ts
git commit -m "feat(scripts): dry-run del conciliador de estructura BAIT"
```

---

### Task 5: Aplicación con auditoría y guardas

**Files:**

- Modify: `avoqado-server/scripts/conciliar-estructura-bait.ts`
- Test: `avoqado-server/tests/unit/scripts/baitStructure/planChanges.test.ts` (agregar el caso de guarda)

**Interfaces:**

- Consumes: todo lo anterior.
- Produces: `applyChanges(changes: Change[], actorStaffId: string): Promise<void>` dentro del runner.

Antes de desasignar a un promotor se cuentan sus SIMs en custodia y se avisa. La desasignación **no** mueve SIMs — la custodia es a nivel
organización y sigue a la persona — pero el operador tiene que verlo.

- [ ] **Step 1: Escribir el test de la guarda (lógica pura)**

```typescript
// agregar a tests/unit/scripts/baitStructure/planChanges.test.ts
it('marca las desasignaciones de promotor para revisión de SIMs', () => {
  const conPromotor: ProdSnapshot = {
    ...SNAPSHOT,
    assignments: [...SNAPSHOT.assignments, { staffId: 'promo', venueId: 'v1', role: 'WAITER', active: true }],
  }
  const otro = [supervisorRow('JUAN01', 'Juan Joel Nájera Ortiz'), promoterRow('OTRO01', 'Hugo González', '2838', 'JUAN01')]
  const salidas = planChanges(otro, conPromotor, OPTIONS).changes.filter(c => c.kind === 'UNASSIGN_PROMOTER')
  expect(salidas).toHaveLength(1)
  expect(salidas[0]).toMatchObject({ staffId: 'promo' })
})
```

- [ ] **Step 2: Correr el test y verificar que pasa (la lógica ya existe en Task 3)**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure/planChanges" --ci
```

- [ ] **Step 3: Agregar la guarda de SIMs y el `--apply` al runner**

Insertar antes de `main()`:

```typescript
const ACTIVITY_ACTION: Record<Change['kind'], string> = {
  SET_EMPLOYEE_CODE: 'STAFF_EMPLOYEE_CODE_SET',
  ASSIGN_MANAGER: 'STAFF_VENUE_ROLE_CHANGED',
  UNASSIGN_MANAGER: 'STAFF_VENUE_DEACTIVATED',
  ASSIGN_PROMOTER: 'STAFF_VENUE_ROLE_CHANGED',
  UNASSIGN_PROMOTER: 'STAFF_VENUE_DEACTIVATED',
  CLOSE_VENUE: 'VENUE_STATUS_CHANGED',
}

/** Cuenta las SIMs en custodia de quien va a salir de una tienda. No bloquea: informa. */
async function warnAboutCustody(changes: Change[]): Promise<void> {
  const leaving = [...new Set(changes.filter(c => c.kind === 'UNASSIGN_PROMOTER').map(c => (c as { staffId: string }).staffId))]
  if (!leaving.length) return

  console.log('— Revisión de custodia antes de desasignar —')
  for (const staffId of leaving) {
    const sims = await prisma.serializedItem.count({ where: { assignedPromoterId: staffId, custodyState: { not: 'SOLD' } } })
    const nombre = changes.find(c => 'staffId' in c && c.staffId === staffId && 'staffName' in c)
    console.log(`  · ${(nombre as { staffName?: string })?.staffName ?? staffId}: ${sims} SIM(s) en custodia (se quedan con la persona)`)
  }
  console.log()
}

async function applyChanges(changes: Change[], actorStaffId: string, organizationId: string): Promise<void> {
  for (const change of changes) {
    switch (change.kind) {
      case 'SET_EMPLOYEE_CODE':
        await prisma.staff.update({ where: { id: change.staffId }, data: { employeeCode: change.to } })
        break
      case 'ASSIGN_MANAGER':
      case 'ASSIGN_PROMOTER':
        await prisma.staffVenue.upsert({
          where: { staffId_venueId: { staffId: change.staffId, venueId: change.venueId } },
          update: { role: change.kind === 'ASSIGN_MANAGER' ? 'MANAGER' : 'WAITER', active: true },
          create: {
            staffId: change.staffId,
            venueId: change.venueId,
            role: change.kind === 'ASSIGN_MANAGER' ? 'MANAGER' : 'WAITER',
            active: true,
          },
        })
        break
      case 'UNASSIGN_MANAGER':
      case 'UNASSIGN_PROMOTER':
        // Baja SOLO en este venue. Nunca Staff.active ni un DELETE.
        await prisma.staffVenue.updateMany({
          where: { staffId: change.staffId, venueId: change.venueId },
          data: { active: false },
        })
        break
      case 'CLOSE_VENUE':
        await prisma.venue.update({ where: { id: change.venueId }, data: { status: 'CLOSED' } })
        break
    }

    await prisma.activityLog.create({
      data: {
        action: ACTIVITY_ACTION[change.kind],
        entity: change.kind === 'CLOSE_VENUE' ? 'Venue' : change.kind === 'SET_EMPLOYEE_CODE' ? 'Staff' : 'StaffVenue',
        entityId: change.kind === 'CLOSE_VENUE' ? change.venueId : change.staffId,
        staffId: actorStaffId,
        // ActivityLog.venueId y organizationId son ambos String? (verificado en schema.prisma).
        // SET_EMPLOYEE_CODE no tiene venue: se estampa la org para que el evento no quede huérfano.
        venueId: 'venueId' in change ? change.venueId : null,
        organizationId,
        data: { origen: 'conciliar-estructura-bait', ...change },
      },
    })
  }
}
```

Y reemplazar el cierre de `main()`:

```typescript
await warnAboutCustody(plan.changes)

if (!APPLY) {
  console.log('\nDry-run: no se modificó nada. Corre con --apply para escribir.')
  return
}

const actorId = arg('actor-staff-id')
if (!actorId) throw new Error('Falta --actor-staff-id=<id> — ActivityLog necesita saber quién ejecutó el cambio')

if (plan.unresolved.length) {
  throw new Error(`Hay ${plan.unresolved.length} renglones sin resolver. Resuélvelos antes de aplicar (o quítalos del archivo).`)
}

await applyChanges(plan.changes, actorId, org.id)
console.log(`\n✅ Aplicados ${plan.changes.length} cambios.`)
```

- [ ] **Step 4: Verificar que compila y que la suite del módulo sigue verde**

```bash
./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.build.json --noEmit
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "baitStructure" --ci
```

Esperado: 0 errores de tipos; 22 tests en verde.

- [ ] **Step 5: Segundo dry-run y entrega del diff al founder**

Volver a correr el comando del Task 4 y guardar la salida completa. **No ejecutar `--apply`**: la escritura en producción requiere OK
explícito del founder sobre ese diff.

- [ ] **Step 6: Formato, lint y preparar commit (NO ejecutar el commit sin OK)**

```bash
cd avoqado-server && npm run format && npm run lint:fix
git add scripts/conciliar-estructura-bait.ts tests/unit/scripts/baitStructure/planChanges.test.ts
git commit -m "feat(scripts): aplicar la estructura BAIT con auditoría y guarda de custodia"
```

---

## Autorrevisión del plan

**Cobertura de la spec:**

| Requisito de la spec                                      | Task                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| Capa 1 — poblar `Staff.employeeCode`                      | 3 (`SET_EMPLOYEE_CODE`), 5 (escritura)                 |
| Capa 1 — ID de tienda desde el nombre, sin migración      | 2 (`extractStoreId`)                                   |
| Capa 2 — lee el Excel, no una lista pegada                | 1                                                      |
| Capa 2 — cascada de emparejamiento, nunca adivina         | 2                                                      |
| Capa 2 — dry-run con el diff completo                     | 4                                                      |
| Capa 2 — idempotente                                      | 3 (test explícito)                                     |
| Capa 2 — las 5 operaciones de escritura                   | 3 (planeadas), 5 (aplicadas)                           |
| Capa 3 — banderas apagadas por defecto                    | 3 (`PlanOptions`), 4 (CLI)                             |
| Seguridad 1 — nunca `DELETE`                              | 5 (`updateMany active:false`)                          |
| Seguridad 2 — revisar SIMs antes de desasignar            | 5 (`warnAboutCustody`)                                 |
| Seguridad 3 — `ActivityLog` por mutación                  | 5                                                      |
| Seguridad 4 — alcance duro a la org                       | 4 (`readSnapshot` filtra por `organizationId`)         |
| Seguridad 5 — dry-run obligatorio                         | 4, 5                                                   |
| Seguridad 6 — no tocar ventas ni turnos                   | por construcción: ningún cambio toca `Order`/`Payment` |
| Verificación 1 — unitarias del emparejador                | 2, 3                                                   |
| Verificación 2 — dry-run contra prod con cifras esperadas | 4                                                      |
| Verificación 3 — reconsultar `getOrgManagers`             | pendiente tras `--apply`                               |

**Nota sobre la spec:** la bandera `--vacantes` quedó como `libre|conservar` con default `conservar`, no `libre|placeholder`. Crear cuentas
placeholder implicaría dar de alta `Staff` y consumir asientos del plan; queda fuera hasta que Isaac lo pida. Igual se retiró
`--alta-nuevas`: crear un venue exige clonar el molde (`VenueModule`, `VenuePaymentConfig`) como en `temp-cambaceo-migration.ts`, y es
trabajo propio que además está bloqueado en la pregunta 2. El dry-run las reporta.

**Consistencia de tipos:** `StructureRow` (Task 1) se consume igual en 2 y 3. `ProdStaff` incluye `isTerminalAccount` desde Task 2 y lo
puebla `readSnapshot` en Task 4. `Change` se define en Task 3 y se consume en 4 (`describe`) y 5 (`applyChanges`, `ACTIVITY_ACTION`) — las
seis variantes están cubiertas en los tres lugares.

**Sin marcadores de posición:** ningún paso dice "TBD", "manejar errores apropiadamente" ni "similar al Task N".
