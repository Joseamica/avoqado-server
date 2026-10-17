/**
 * Paridad de llaves JS/SQL contra Postgres real: sin TEST_DATABASE_URL el setup falla.
 * Sólo SELECT de literales; cada zona se fija en la MISMA conexión que consulta.
 */
import prisma from '@/utils/prismaClient'
import { venueMonthKey, venueDayKey, venueIsoWeekKey, venueWeekLabel } from '@/utils/venueDateKeys'
import { monthBucketSql, dayBucketSql, isoWeekKeySql, weekLabelSql } from '@/services/dashboard/sale-verification.org.sql'

const TZ = 'America/Mexico_City'
// Prisma envía Date como timestamptz; la columna productiva guarda UTC sin zona.
const COLUMNA_SIMULADA = `($1::timestamptz AT TIME ZONE 'UTC')`
const INSTANTES = [
  '2026-01-01T06:00:00Z',
  '2026-01-01T18:00:00Z',
  '2026-01-11T23:00:00Z',
  '2026-01-12T05:59:00Z',
  '2026-03-30T00:00:00Z',
  '2026-08-04T18:00:00Z',
  '2026-12-31T23:59:00Z',
  '2027-01-03T18:00:00Z',
  '2027-01-04T07:00:00Z',
  '2027-01-04T18:00:00Z',
  '2027-12-31T18:00:00Z',
  '2028-01-01T18:00:00Z',
]

describe.each(['America/Mexico_City', 'UTC'])('paridad JS/Postgres con sesión %s', zona => {
  const llavesSql = (d: Date) =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zona}'`)
      const [row] = await tx.$queryRawUnsafe<Array<{ mes: string; dia: string; semana: string; etiqueta: string }>>(
        `SELECT ${monthBucketSql(COLUMNA_SIMULADA, TZ)} AS mes,
                ${dayBucketSql(COLUMNA_SIMULADA, TZ)} AS dia,
                ${isoWeekKeySql(COLUMNA_SIMULADA, TZ)} AS semana,
                ${weekLabelSql(COLUMNA_SIMULADA, TZ)} AS etiqueta`,
        d,
      )
      return row
    })

  it.each(INSTANTES)('%s coincide en mes, día, semana ISO y etiqueta', async iso => {
    const d = new Date(iso)

    const row = await llavesSql(d)

    expect(row).toEqual({
      mes: venueMonthKey(d, TZ),
      dia: venueDayKey(d, TZ),
      semana: venueIsoWeekKey(d, TZ),
      etiqueta: venueWeekLabel(d, TZ),
    })
  })

  it('el 4-ene-2027 pertenece a 2027-W01 en ambos lados', async () => {
    const d = new Date('2027-01-04T18:00:00Z')

    const row = await llavesSql(d)

    expect(row.semana).toBe('2027-W01')
    expect(venueIsoWeekKey(d, TZ)).toBe('2027-W01')
  })
})
