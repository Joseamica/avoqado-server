// tests/integration/dashboard/tpvSettings.concurrency.integration.test.ts
/**
 * S1 de F1 (Codex F1 r1 #2), contra PostgreSQL REAL: dos guardados de ajustes de LLAVES DISTINTAS sobre la misma terminal,
 * a la vez, conservan los DOS cambios.
 *
 * La barrera retiene la fila con el MISMO `FOR UPDATE` y deja que los dos guardados lleguen a esperar. Sin el candado del
 * servicio, los dos LEEN antes de que la barrera suelte (una lectura simple no espera) y se quedan esperando en su UPDATE
 * con lo que leyeron: el segundo en escribir pisa al primero y la prueba cae. Con el candado, esperan ANTES de leer.
 *
 * Y la prueba CRUZADA (Codex r2): la cascada del negocio contra el guardado de UNA terminal, llaves distintas, en los dos
 * órdenes de llegada. Cada orden atrapa a un lado sin candado: el que llega segundo y no esperó para leer pisa al primero.
 *
 * Run with (sólo contra una base DESECHABLE, nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' npx jest --selectProjects=integration --runInBand \
 *     --runTestsByPath tests/integration/dashboard/tpvSettings.concurrency.integration.test.ts --ci
 */
import { Prisma } from '@prisma/client'

import { updateTpvSettings, updateVenueTpvSettings } from '@/services/dashboard/tpv.dashboard.service'
import prisma from '@/utils/prismaClient'
import { retenerTerminal } from '../customer-display/barrera'

const suffix = `s1-${Date.now()}`
let orgId: string
let venueId: string
let terminalId: string
let otraId: string // la segunda terminal del negocio: la cascada bloquea las dos

const ajustes = async (id: string = terminalId) => {
  const fila = await prisma.terminal.findUniqueOrThrow({ where: { id }, select: { config: true } })
  return ((fila.config as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
}

/** Cuántas sesiones de ESTA base esperan un candado (las dos operaciones, sin importar quién bloquea a quién). */
async function esperarQueEsperen(cuantas: number) {
  for (let i = 0; i < 400; i++) {
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (n >= cuantas) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`No llegaron ${cuantas} sesiones a esperar el candado en 10 s`)
}

/**
 * El default de la ORGANIZACIÓN, por el MISMO registro que lee `getOrgDefaultsForTerminal` (`OrganizationAttendanceConfig.settings`).
 * Con `enableBarcodeScanner: true` ahí, un guardado de la terminal que lo trae en `true` no lo vuelve excepción propia.
 */
async function fijarDefaultDeLaOrganizacion(settings: Record<string, unknown>) {
  if (!orgId) throw new Error('Sin organización de prueba: no se siembra nada')
  await prisma.organizationAttendanceConfig.upsert({
    where: { organizationId: orgId },
    update: { settings: settings as Prisma.InputJsonValue },
    create: { organizationId: orgId, settings: settings as Prisma.InputJsonValue },
  })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Venue ${suffix}`, slug: `venue-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  terminalId = (await prisma.terminal.create({ data: { venueId, name: `Caja ${suffix}`, type: 'POS_ANDROID' }, select: { id: true } })).id
  otraId = (await prisma.terminal.create({ data: { venueId, name: `Barra ${suffix}`, type: 'POS_ANDROID' }, select: { id: true } })).id
})

afterAll(async () => {
  if (!venueId || !orgId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.venueSettings.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organizationAttendanceConfig.deleteMany({ where: { organizationId: orgId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('🔴 dos guardados a la vez, de llaves distintas, conservan los DOS cambios', async () => {
  await updateTpvSettings(terminalId, { showTipScreen: true, showReviewScreen: true }, { venueId })
  const { soltar, transaccion } = await retenerTerminal(terminalId)
  const propina = updateTpvSettings(terminalId, { showTipScreen: false }, { venueId })
  const estrellas = updateTpvSettings(terminalId, { showReviewScreen: false }, { venueId })
  await esperarQueEsperen(2)
  soltar()
  await transaccion
  await Promise.all([propina, estrellas])
  expect(await ajustes()).toMatchObject({ showTipScreen: false, showReviewScreen: false })
})

it('una terminal de otro negocio da el mismo 404 de siempre y no escribe', async () => {
  const antes = await ajustes()
  await expect(updateTpvSettings(terminalId, { showTipScreen: true }, { venueId: 'otro-venue' })).rejects.toMatchObject({ statusCode: 404 })
  expect(await ajustes()).toEqual(antes)
})

it.each([
  ['primero la terminal, después el negocio (atrapa una cascada sin candado)', 'terminal'],
  ['primero el negocio, después la terminal (atrapa un guardado de terminal sin candado)', 'negocio'],
] as const)(
  '🔴 la cascada del negocio y el guardado de UNA terminal, a la vez y con llaves distintas, conservan los DOS: %s',
  async (_n, primero) => {
    // 🔴 Ruling del controlador (Codex r3, 14-oct): `enableBarcodeScanner` NO está en DEFAULT_TPV_SETTINGS. Si la
    // preparación lo pone por `updateTpvSettings`, nace un override POR TERMINAL que la cascada conserva (`...overrides`) y
    // la prueba falla AUN con candados. Por eso: primero se fija el default de la ORGANIZACIÓN `enableBarcodeScanner: true`
    // (por el mismo mecanismo que lee `getOrgDefaultsForTerminal`), y la preparación de la terminal sólo pone `showTipScreen`.
    // Comprobación obligatoria: con candados pasa en los dos órdenes; quitando el candado de cualquier lado, falla.
    await fijarDefaultDeLaOrganizacion({ enableBarcodeScanner: true })
    // Cada orden arranca del MISMO punto, con la alternativa equivalente del ruling: escáner encendido en la terminal y sin
    // excepciones propias. Sin esto, el segundo caso hereda `enableBarcodeScanner: false` (y su excepción) del primero, la
    // cascada ya no tiene nada que «perder» y un guardado de terminal sin candado pasaría igual (medido con el sabotaje).
    await prisma.terminal.update({
      where: { id: terminalId },
      data: { config: { settings: { enableBarcodeScanner: true } }, configOverrides: Prisma.JsonNull },
    })
    await updateTpvSettings(terminalId, { showTipScreen: true }, { venueId })
    // Punto de partida comprobado: los dos valores «viejos» y NINGUNA excepción por terminal (la cascada conserva las excepciones).
    expect(await ajustes()).toMatchObject({ showTipScreen: true, enableBarcodeScanner: true })
    expect(
      (await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, select: { configOverrides: true } })).configOverrides,
    ).toBeNull()

    const { soltar, transaccion } = await retenerTerminal(terminalId)
    const deLaTerminal = () => updateTpvSettings(terminalId, { showTipScreen: false }, { venueId })
    const delNegocio = () => updateVenueTpvSettings(venueId, { enableBarcodeScanner: false })
    // El orden de llegada a la fila decide quién pisaría a quién: se fuerza, uno a la vez, para que cada caso atrape a un lado.
    const a = primero === 'terminal' ? deLaTerminal() : delNegocio()
    await esperarQueEsperen(1)
    const b = primero === 'terminal' ? delNegocio() : deLaTerminal()
    await esperarQueEsperen(2)
    soltar()
    await transaccion
    await Promise.all([a, b])
    expect(await ajustes()).toMatchObject({ showTipScreen: false, enableBarcodeScanner: false })
    // La cascada bloqueó y escribió también la OTRA terminal del negocio (la que nadie retenía).
    expect(await ajustes(otraId)).toMatchObject({ enableBarcodeScanner: false })
  },
)
