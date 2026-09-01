import { Prisma } from '@prisma/client'

/**
 * Bind de fecha para `$queryRaw` comparable contra columnas `timestamp without
 * time zone` que guardan UTC real (todas las de este schema).
 *
 * Verificado contra findMany en el borde exacto (2026-09-01): un bind `Date` de
 * Prisma llega a Postgres como `timestamptz`. Comparado directo — o casteado con
 * `::timestamp` — se convierte usando la zona de la SESIÓN (America/Mexico_City
 * en este servidor) y el filtro queda corrido 6 horas. `AT TIME ZONE 'UTC'`
 * convierte el instante a timestamp EN UTC, que es exactamente lo que la columna
 * guarda y lo que un findMany de Prisma compara.
 *
 *   WHERE o."createdAt" >= ${utcTs(fromDate)}   -- ✅ mismo resultado que findMany
 *   WHERE o."createdAt" >= ${fromDate}          -- ❌ corrido 6 horas
 *   WHERE o."createdAt" >= ${fromDate}::timestamp -- ❌ corrido 6 horas
 */
export const utcTs = (d: Date) => Prisma.sql`(${d} AT TIME ZONE 'UTC')`
