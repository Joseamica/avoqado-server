/**
 * Paridad JS ↔ Postgres para las llaves de fecha.
 *
 * A partir del 2026-08-04 las agregaciones de ventas org agrupan en SQL, pero varias
 * partes del sistema (el MCP, tests, fallbacks) siguen calculando llaves en JS con
 * `venueDateKeys`. Si las dos implementaciones se separan, los números dejan de cuadrar
 * SIN que nada falle visiblemente — el peor tipo de bug.
 *
 * Los instantes de abajo están elegidos por peligrosos, no al azar: cambios de año, de
 * mes, medianoche de México, domingos, y el 4-ene-2027 (donde el código viejo se
 * equivocaba de semana).
 *
 * Requiere Postgres. Sólo hace SELECT de formato — no lee ni escribe datos de negocio.
 *
 * 🔴 Abre su PROPIA conexión en vez de usar `@/utils/prismaClient`, por DOS razones:
 *   1. Ese singleton está mockeado globalmente en `tests/__helpers__/setup.ts`, y un mock
 *      no puede probar que Postgres y JS coinciden — lo único que este archivo prueba.
 *   2. Ese mismo setup (línea 20) pisa `DATABASE_URL` con `postgresql://test:test@…/test`,
 *      una base que no existe en las máquinas de desarrollo. Aquí se lee la URL real del
 *      `.env` y se pasa explícitamente.
 *
 * Si no hay Postgres alcanzable, la suite se SALTA con aviso en vez de fallar: es una
 * comprobación que depende del entorno, y sumarla a las 32 suites que ya fallan por falta
 * de base sólo escondería regresiones reales.
 */
import { PrismaClient } from '@prisma/client'
import { config as loadEnv } from 'dotenv'
import { venueMonthKey, venueDayKey, venueIsoWeekKey, venueWeekLabel } from '@/utils/venueDateKeys'
import { monthBucketSql, dayBucketSql, isoWeekKeySql, weekLabelSql } from '@/services/dashboard/sale-verification.org.sql'

const TZ = 'America/Mexico_City'

/** URL real del `.env`, sin tocar `process.env` (que el setup ya pisó). */
function realDatabaseUrl(): string | undefined {
  const parsed = loadEnv({ path: '.env', processEnv: {} as NodeJS.ProcessEnv })
  return parsed.parsed?.DATABASE_URL
}

const databaseUrl = realDatabaseUrl()
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null

/**
 * Simula la columna real `SaleVerification."createdAt"`.
 *
 * 🔴 No basta con `$1::timestamp`. Prisma manda un `Date` de JS como `timestamp WITH time
 * zone`, y la sesión de Postgres está en `America/Mexico_City`, así que `::timestamp` lo
 * convertiría a hora de México — cuando la columna real guarda UTC en crudo. Sin esto, el
 * test fallaba justo en los instantes de medianoche y acusaba al SQL de producción de un
 * error que era del test.
 *
 * `AT TIME ZONE 'UTC'` sobre el timestamptz da la hora de pared UTC como timestamp naïve:
 * exactamente lo que la columna contiene.
 */
const COLUMNA_SIMULADA = `($1::timestamptz AT TIME ZONE 'UTC')`

const INSTANTES = [
  '2026-01-01T06:00:00Z', // 1-ene, medianoche en México
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
  '2028-01-01T18:00:00Z', // sábado: pertenece a 2027-W52
]

/** Postgres alcanzable: se decide una vez, antes de correr los casos. */
let postgresDisponible = false

beforeAll(async () => {
  if (!prisma) return
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    postgresDisponible = true
  } catch {
    console.warn('[paridad] sin Postgres alcanzable — la comprobación se salta (no es una regresión)')
  }
})

afterAll(async () => {
  await prisma?.$disconnect()
})

describe('paridad de llaves de fecha JS ↔ Postgres', () => {
  it.each(INSTANTES)('%s da la misma llave en JS y en Postgres', async iso => {
    if (!postgresDisponible) return
    const d = new Date(iso)

    const rows = await prisma!.$queryRawUnsafe<Array<{ mes: string; dia: string; semana: string; etiqueta: string }>>(
      `SELECT ${monthBucketSql(COLUMNA_SIMULADA, TZ)} AS mes,
              ${dayBucketSql(COLUMNA_SIMULADA, TZ)} AS dia,
              ${isoWeekKeySql(COLUMNA_SIMULADA, TZ)} AS semana,
              ${weekLabelSql(COLUMNA_SIMULADA, TZ)} AS etiqueta`,
      d,
    )

    expect(rows[0].mes).toBe(venueMonthKey(d, TZ))
    expect(rows[0].dia).toBe(venueDayKey(d, TZ))
    expect(rows[0].semana).toBe(venueIsoWeekKey(d, TZ))
    expect(rows[0].etiqueta).toBe(venueWeekLabel(d, TZ))
  })

  it('el 4-ene-2027 es W01 en AMBOS lados (el bug que se desactiva)', async () => {
    if (!postgresDisponible) return
    const d = new Date('2027-01-04T18:00:00Z')
    const rows = await prisma!.$queryRawUnsafe<Array<{ semana: string }>>(`SELECT ${isoWeekKeySql(COLUMNA_SIMULADA, TZ)} AS semana`, d)
    expect(rows[0].semana).toBe('2027-W01')
    expect(venueIsoWeekKey(d, TZ)).toBe('2027-W01')
  })
})
