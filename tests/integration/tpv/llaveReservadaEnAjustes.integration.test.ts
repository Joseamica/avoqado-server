/**
 * SDK propio (fase 3, bloque 2a, ronda 2 · R2-1): `inHouseSdkEnabled` es RESERVADA en TODO el JSON de ajustes. Cada escritor de
 * `Terminal.config.settings` / `Terminal.configOverrides` y de los ajustes de la organización la quita sin error: si llega (o ya
 * estaba guardada), no queda guardada, no se reparte y no regresa en la respuesta. La verdad sigue siendo la columna, que estos
 * escritores nunca tocan. Postgres real; series ficticias AVQD-99000006xx (otros archivos usan otros rangos).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/tpv/llaveReservadaEnAjustes.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import { Prisma, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  createTpv,
  resetTerminalToDefaults,
  updateTpv,
  updateTpvSettings,
  updateVenueTpvSettings,
} from '@/services/dashboard/tpv.dashboard.service'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const LLAVE = 'inHouseSdkEnabled'
const sufijo = randomUUID().slice(0, 8)
let orgId: string | undefined
let venueId: string | undefined
let consecutivo = 600
const nuevaSerie = () => `AVQD-99000${String(consecutivo++).padStart(5, '0')}` // AVQD-9900000600 … 699

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `llave-reservada-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba', slug: `llave-reservada-${sufijo}` } }))
    .id
})

afterEach(async () => {
  if (venueId) await prisma.terminal.deleteMany({ where: { venueId } })
  if (orgId) await prisma.organizationAttendanceConfig.deleteMany({ where: { organizationId: orgId } })
  if (venueId) await prisma.venueSettings.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

/** Una terminal PRENDIDA a mano (la columna en true) que ya trae la llave en su JSON y en sus excepciones (el eco viejo). */
async function terminalConEco() {
  const t = await prisma.terminal.create({
    data: {
      venueId: venueId!,
      name: 'Caja 1',
      type: TerminalType.TPV_ANDROID,
      brand: 'PAX',
      serialNumber: nuevaSerie(),
      config: { settings: { showTipScreen: true, [LLAVE]: true } } as Prisma.InputJsonValue,
      configOverrides: { showTipScreen: true, [LLAVE]: true } as Prisma.InputJsonValue,
    },
  })
  await prisma.terminal.update({ where: { id: t.id }, data: { inHouseSdkEnabled: true } })
  return t
}

async function guardado(id: string) {
  const fila = await prisma.terminal.findUniqueOrThrow({
    where: { id },
    select: { config: true, configOverrides: true, inHouseSdkEnabled: true },
  })
  return {
    settings: ((fila.config as Record<string, any> | null)?.settings ?? {}) as Record<string, unknown>,
    overrides: (fila.configOverrides ?? {}) as Record<string, unknown>,
    columna: fila.inHouseSdkEnabled,
  }
}

/** `conExcepciones`: sólo los escritores que REESCRIBEN `configOverrides` responden por él; los demás no lo tocan. */
async function sinLaLlaveYConLaColumnaIntacta(id: string, conExcepciones = true) {
  const g = await guardado(id)
  expect(g.settings).not.toHaveProperty(LLAVE)
  if (conExcepciones) expect(g.overrides).not.toHaveProperty(LLAVE)
  expect(g.columna).toBe(true)
  return g
}

async function ajustesDeLaOrganizacionConEco() {
  await prisma.organizationAttendanceConfig.create({
    data: { organizationId: orgId!, settings: { showReviewScreen: false, [LLAVE]: true } as Prisma.InputJsonValue },
  })
}

describe('los escritores del JSON de ajustes nunca guardan ni devuelven inHouseSdkEnabled', () => {
  it('updateTpvSettings (DASHBOARD, SUPERADMIN y POS móvil): llega en el cuerpo y ya estaba guardada', async () => {
    const t = await terminalConEco()

    const respuesta = await updateTpvSettings(t.id, { showTipScreen: false, [LLAVE]: true } as never, { venueId: venueId! })

    expect(respuesta).not.toHaveProperty(LLAVE)
    expect(respuesta.showTipScreen).toBe(false)
    const g = await sinLaLlaveYConLaColumnaIntacta(t.id)
    expect(g.settings.showTipScreen).toBe(false)
  })

  it('resetTerminalToDefaults: la organización y lo guardado la traen', async () => {
    await ajustesDeLaOrganizacionConEco()
    const t = await terminalConEco()

    const respuesta = await resetTerminalToDefaults(t.id, { venueId: venueId! })

    expect(respuesta).not.toHaveProperty(LLAVE)
    const g = await sinLaLlaveYConLaColumnaIntacta(t.id)
    expect(g.settings.showReviewScreen).toBe(false)
  })

  it('updateTpv (el JSON completo del formulario de la ficha; no reescribe configOverrides)', async () => {
    const t = await terminalConEco()

    const respuesta = await updateTpv(venueId!, t.id, { config: { settings: { showTipScreen: false, [LLAVE]: true } } } as never)

    expect((respuesta.config as Record<string, any>).settings).not.toHaveProperty(LLAVE)
    const g = await sinLaLlaveYConLaColumnaIntacta(t.id, false)
    expect(g.settings.showTipScreen).toBe(false)
  })

  it('createTpv (el alta con su config)', async () => {
    const creada = await createTpv(venueId!, { name: 'Caja nueva', config: { settings: { showTipScreen: false, [LLAVE]: true } } })

    expect((creada.config as Record<string, any>).settings).not.toHaveProperty(LLAVE)
    const g = await guardado(creada.id)
    expect(g.settings).not.toHaveProperty(LLAVE)
    expect(g.settings.showTipScreen).toBe(false)
    expect(g.columna).toBe(false)
  })

  it('updateVenueTpvSettings (la cascada del negocio): llega en el cuerpo y ya estaba en lo guardado y en las excepciones (que reparte; no reescribe configOverrides)', async () => {
    const t = await terminalConEco()

    const respuesta = await updateVenueTpvSettings(venueId!, { enableCashPayments: false, [LLAVE]: true } as never)

    expect(respuesta).not.toHaveProperty(LLAVE)
    const g = await sinLaLlaveYConLaColumnaIntacta(t.id, false)
    expect(g.settings.enableCashPayments).toBe(false)
  })

  it('upsertOrgTpvDefaults (los ajustes de la organización y su reparto): ni se guarda, ni se reparte, ni se devuelve', async () => {
    await ajustesDeLaOrganizacionConEco()
    const t = await terminalConEco()

    const respuesta = await organizationDashboardService.upsertOrgTpvDefaults(orgId!, { enableCardPayments: false, [LLAVE]: true })

    expect(respuesta.config).not.toHaveProperty(LLAVE)
    const org = await prisma.organizationAttendanceConfig.findUniqueOrThrow({ where: { organizationId: orgId! } })
    expect(org.settings).not.toHaveProperty(LLAVE)
    // El reparto: tampoco desde las excepciones viejas de la terminal.
    const g = await guardado(t.id)
    expect(g.settings).not.toHaveProperty(LLAVE)
    expect(g.settings.enableCardPayments).toBe(false)
    expect(g.columna).toBe(true)
  })

  it('getOrgTpvDefaults: una organización que ya la tenía guardada no la devuelve', async () => {
    await ajustesDeLaOrganizacionConEco()

    const ajustes = await organizationDashboardService.getOrgTpvDefaults(orgId!)

    expect(ajustes).not.toHaveProperty(LLAVE)
    expect(ajustes).toMatchObject({ showReviewScreen: false })
  })
})
