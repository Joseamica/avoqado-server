// tests/unit/services/dashboard/staffPay/fuentesVenta.parametros.test.ts — fase 3, B14-fix F4 (Codex participación r1 #4): el
// conector de Prisma rechaza una sentencia con más de 32,767 parámetros. Con los topes ADMITIDOS (500 sedes, 5,000 ventanas) los
// constructores REALES del reporte, el recibo, el barrido y las sumas no pueden acercarse a ese límite: los rangos viajan como
// arreglos (un parámetro cada uno), así que el número de parámetros no crece con sedes × ventanas. Construye el SQL con los
// constructores de producción sobre una base simulada (nada se ejecuta) y cuenta sus parámetros.
import { Prisma } from '@prisma/client'
import {
  AlcanceBarrido,
  comisionesBarribles,
  propinasBarribles,
  propinasSinDueno,
  sqlVentasDelPeriodo,
  totalesVentas,
} from '@/services/dashboard/staffPay/fuentesVenta'
import { Rangos, rangosConParticipacion, Ventana } from '@/services/dashboard/staffPay/rangos'
import { devolucionesPendientes } from '@/services/dashboard/staffPay/devolucionesPendientes'
import { consultasDelReporte } from '@/services/dashboard/staffPay/reporte.service'
import { consultaDePaginaDelRecibo } from '@/services/dashboard/staffPay/recibos.service'

/** El límite del conector nativo de Prisma (quaint, postgres): más parámetros y la consulta truena antes de llegar a la base. */
const LIMITE_PRISMA = 32_767
const CDMX = 'America/Mexico_City'
const TIJ = 'America/Tijuana'

/** La organización simulada: `n` sedes (la mitad en Tijuana) y `k` ventanas de octubre por sede, disjuntas. */
const mundo = { n: 0, k: 0 }
const sedeId = (i: number) => `v${String(i).padStart(3, '0')}`
const sedes = () => Array.from({ length: mundo.n }, (_, i) => ({ venueId: sedeId(i), tz: i % 2 ? TIJ : CDMX }))
/** La ventana j de cada sede: del 1+3j al 2+3j de octubre (10 caben en el mes). */
const ventanas = (): Ventana[] =>
  sedes().flatMap(s =>
    Array.from({ length: mundo.k }, (_, j) => ({
      venueId: s.venueId,
      desde: `2026-10-${String(1 + 3 * j).padStart(2, '0')}`,
      hasta: `2026-10-${String(2 + 3 * j).padStart(2, '0')}`,
    })),
  )
const alDia = (f: string) => new Date(`${f}T00:00:00.000Z`)

/** Toda consulta cruda que llega a la base simulada, como el `Prisma.Sql` que Prisma ejecutaría. */
const consultas: Prisma.Sql[] = []
const comoSql = (s: unknown, v: unknown[]): Prisma.Sql =>
  Array.isArray(s) && 'raw' in (s as object) ? Prisma.sql(s as unknown as TemplateStringsArray, ...v) : (s as Prisma.Sql)

/** La base simulada: la fábrica del mock sólo crea los `jest.fn()`; su comportamiento se pone en `simular()` (jest sube el mock). */
jest.mock('@/utils/prismaClient', () => {
  const fn = () => jest.fn()
  const base = {
    $queryRaw: fn(),
    $executeRaw: fn(),
    $executeRawUnsafe: fn(),
    venue: { findUniqueOrThrow: fn(), findUnique: fn(), findMany: fn() },
    organization: { findUniqueOrThrow: fn(), findUnique: fn() },
    servicePayPeriod: { findFirst: fn(), findMany: fn() },
    staffPayVenueWindow: { findMany: fn() },
    staff: { findFirst: fn() },
    staffPayStatement: { findUnique: fn() },
  }
  return { __esModule: true, default: base }
})
const mockBase = require('@/utils/prismaClient').default

function simular() {
  const org = { servicePayPeriodicity: 'MONTHLY', staffPayStartDate: alDia('2026-09-01') }
  mockBase.$queryRaw.mockImplementation(async (s: unknown, ...v: unknown[]) => {
    const sql = comoSql(s, v)
    consultas.push(sql)
    // `sedesConVentana`: las sedes con alguna ventana (todas).
    if (/SELECT DISTINCT "venueId" FROM "StaffPayVenueWindow"/.test(sql.sql)) return sedes().map(x => ({ venueId: x.venueId }))
    // `propinasSinDueno`: una fila de cuenta.
    if (/COUNT\(\*\)::int AS n, SUM\(b\.monto\) AS total/.test(sql.sql)) return [{ n: 0, total: null }]
    return []
  })
  mockBase.$executeRaw.mockResolvedValue(0)
  mockBase.$executeRawUnsafe.mockResolvedValue(0)
  mockBase.venue.findUniqueOrThrow.mockResolvedValue({ organizationId: 'org', timezone: CDMX, name: 'Sede', organization: org })
  mockBase.venue.findUnique.mockResolvedValue({ organizationId: 'org', timezone: CDMX, name: 'Sede' })
  mockBase.venue.findMany.mockImplementation(async (a: { where?: { id?: { in?: string[] } } }) => {
    const ids = a?.where?.id?.in
    return sedes()
      .filter(x => !ids || ids.includes(x.venueId))
      .map(x => ({ id: x.venueId, timezone: x.tz, name: x.venueId }))
  })
  mockBase.organization.findUniqueOrThrow.mockResolvedValue(org)
  mockBase.organization.findUnique.mockResolvedValue(org)
  mockBase.servicePayPeriod.findFirst.mockResolvedValue(null)
  mockBase.servicePayPeriod.findMany.mockResolvedValue([])
  mockBase.staffPayVenueWindow.findMany.mockImplementation(async () =>
    ventanas().map(w => ({ venueId: w.venueId, desde: alDia(w.desde), hasta: w.hasta ? alDia(w.hasta) : null })),
  )
  mockBase.staff.findFirst.mockResolvedValue({ firstName: 'Ana', lastName: 'QA' })
  mockBase.staffPayStatement.findUnique.mockResolvedValue(null)
}
beforeEach(simular)

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => sedes().map(s => s.venueId)),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds: [...new Set(venueIds)].sort(), parcial: false })),
}))

const alcance = (): AlcanceBarrido => ({
  organizationId: 'org',
  periodo: { id: null, start: '2026-10-01', end: '2026-10-31' },
  sedes: sedes(),
  startDate: '2026-09-01',
})
const rangos = (): Promise<Rangos> => rangosConParticipacion(mockBase as never, alcance(), { ventanas: ventanas() })
const parametros = (s: Prisma.Sql | null | undefined) => s?.values.length ?? 0
/** El mayor número de parámetros de las consultas crudas que mandó `fn`. */
async function mayorConsulta(fn: () => Promise<unknown>): Promise<number> {
  consultas.length = 0
  await fn()
  return Math.max(0, ...consultas.map(parametros))
}

/** Lo que cada constructor manda a la base con `n` sedes y `k` ventanas por sede. */
const CONSTRUCTORES: Record<string, () => Promise<number>> = {
  'ventas del periodo (reporte)': async () => parametros(sqlVentasDelPeriodo(alcance(), await rangos())),
  'ventas del periodo de una persona (recibo)': async () => parametros(sqlVentasDelPeriodo(alcance(), await rangos(), { staffId: 's1' })),
  'sumas de ventas (activar, GET /sedes, porSede)': async () => {
    const r = await rangos()
    return mayorConsulta(() => totalesVentas(mockBase as never, alcance(), { rangos: r }))
  },
  'barrido de comisiones (cierre)': async () => {
    const r = await rangos()
    return mayorConsulta(() => comisionesBarribles(mockBase as never, alcance(), r, { limite: 500 }))
  },
  'barrido de propinas (cierre)': async () => {
    const r = await rangos()
    return mayorConsulta(() => propinasBarribles(mockBase as never, alcance(), r, { limite: 500 }))
  },
  'propinas sin dueño (vista previa del cierre)': async () => {
    const r = await rangos()
    return mayorConsulta(() => propinasSinDueno(mockBase as never, alcance(), r))
  },
  'devoluciones pendientes (recibo, cierre, ajuste)': async () =>
    mayorConsulta(() =>
      devolucionesPendientes(mockBase as never, {
        organizationId: 'org',
        sedes: sedes().map(x => x.venueId),
        excluirPeriodo: { start: '2026-10-01', end: '2026-10-31' },
      }),
    ),
  'reporte abierto (cuenta y página)': async () => {
    const q = await consultasDelReporte({ userId: 'u', venueId: sedeId(0), fecha: '2026-10-15', offset: 0, limit: 50 })
    return Math.max(parametros(q?.cuenta), parametros(q?.pagina))
  },
  'página del recibo abierto': async () =>
    parametros(await consultaDePaginaDelRecibo({ userId: 'u', venueId: sedeId(0), staffId: 's1', fecha: '2026-10-15', limit: 50 })),
}

describe('B14-fix F4: ningún constructor pasa el límite de parámetros de Prisma con los topes admitidos', () => {
  const con = async (n: number, k: number, fn: () => Promise<number>) => {
    mundo.n = n
    mundo.k = k
    return fn()
  }

  for (const [nombre, fn] of Object.entries(CONSTRUCTORES)) {
    it(`${nombre}: 500 sedes × 4 ventanas y 300 × 10 caben; con 5,000 ventanas sale igual de chico que con 2,000`, async () => {
      const quinientasPorCuatro = await con(500, 4, fn)
      const trescientasPorDiez = await con(300, 10, fn)
      const quinientasPorDiez = await con(500, 10, fn) // 5,000 ventanas: el tope (`TOPE_VENTANAS`)
      expect(quinientasPorCuatro).toBeGreaterThan(0)
      expect(quinientasPorCuatro).toBeLessThan(LIMITE_PRISMA)
      expect(trescientasPorDiez).toBeLessThan(LIMITE_PRISMA)
      expect(quinientasPorDiez).toBeLessThan(LIMITE_PRISMA)
      // No crece con las ventanas: lo que dependa de las sedes (la valoración de cada una) sí, de las ventanas nada.
      expect(quinientasPorDiez).toBe(quinientasPorCuatro)
    })
  }
})
