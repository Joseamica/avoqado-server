/**
 * `lockShiftLifecycleForVenue` contra Postgres REAL.
 *
 * Por qué existe: el candado se escribía con `$queryRaw` sobre `pg_advisory_xact_lock(...)`, que
 * devuelve `void`, y Prisma no sabe deserializar una columna `void` ⇒ **toda apertura de caja o de
 * turno respondía 500** en un Postgres real («Failed to deserialize column of type 'void'»). Las
 * pruebas unitarias no lo veían porque mockean `$queryRaw` con `[]`, y el subsistema no tenía una
 * sola prueba de integración (P2.1 de la auditoría del 4-sep). Lo cazó `/full-testing` el 5-sep.
 *
 * Correr:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *   npx jest --selectProjects integration --runTestsByPath tests/integration/shared/shiftLifecycleLock.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { lockShiftLifecycleForVenue } from '@/services/shared/shiftLifecycleLock'

const VENUE = 'fulltest-venue-lock'
const KEY = `avoqado:shift-lifecycle:v1:${VENUE}`

describe('lockShiftLifecycleForVenue — Postgres real', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('P1 — tomar el candado dentro de una transacción NO revienta (era un 500 en toda apertura)', async () => {
    await expect(
      prisma.$transaction(async tx => {
        await lockShiftLifecycleForVenue(tx, VENUE)
        return 'ok'
      }),
    ).resolves.toBe('ok')
  })

  it('P1 — el candado de verdad se sostiene: otra sesión NO puede tomarlo mientras la transacción vive', async () => {
    let intentoAjeno: boolean | undefined
    await prisma.$transaction(async tx => {
      await lockShiftLifecycleForVenue(tx, VENUE)
      // Otra conexión del pool (fuera de esta transacción) intenta el MISMO candado sin esperar.
      const rows = await prisma.$queryRaw<Array<{ libre: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${KEY}, 0)) AS libre`
      intentoAjeno = rows[0]?.libre
    })
    expect(intentoAjeno).toBe(false)
  })

  it('REGRESIÓN — al terminar la transacción el candado se suelta solo', async () => {
    const rows = await prisma.$queryRaw<Array<{ libre: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${KEY}, 0)) AS libre`
    expect(rows[0]?.libre).toBe(true)
  })
})
