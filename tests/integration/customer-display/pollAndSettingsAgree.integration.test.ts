// tests/integration/customer-display/pollAndSettingsAgree.integration.test.ts
import prisma from '@/utils/prismaClient'
import { POLL_DEPS_REALES, POLL_TERMINAL_SELECT, collectPollFingerprints } from '@/services/customer-display/posPollFingerprints'
import { readSettingsFingerprint } from '@/services/customer-display/settingsEnvelope.service'
import { resetVenuePlanSnapshotsForTests } from '@/services/customer-display/venuePlanSnapshot'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

/**
 * El poll y `/settings` calculan LA MISMA huella para el mismo estado —si no, la tablet refrescaría en cada poll— y las
 * dos cambian con lo que cambia el cuerpo de `/settings`.
 */
const suffix = `pas-${Date.now()}`
const DEVICE = `dev-${suffix}`
let orgId: string
let venueId: string
let terminalId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, slug: `v-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  await prisma.venueSettings.create({ data: { venueId } })
  terminalId = (
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Caja',
        type: 'POS_ANDROID',
        deviceUid: DEVICE,
        customerDisplayDesignVersion: 1,
        customerDisplayInstallationId: 'i',
      },
      select: { id: true },
    })
  ).id
})

beforeEach(() => resetVenuePlanSnapshotsForTests())

afterAll(async () => {
  if (!venueId) return // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const huellas = async () => {
  const fila = await prisma.terminal.findFirstOrThrow({
    where: { venueId, deviceUid: DEVICE, type: 'POS_ANDROID' },
    select: POLL_TERMINAL_SELECT,
  })
  // Plazo holgado: aquí se compara el VALOR de la huella, no el presupuesto (ése lo mide la Task 13).
  const delPoll = await collectPollFingerprints({ venueId, terminal: fila, hasRequest: false }, { ...POLL_DEPS_REALES, plazoMs: 30_000 })
  const deSettings = await readSettingsFingerprint(venueId, DEVICE)
  return { delPoll: delPoll.settings, deSettings: deSettings.fingerprint }
}

it('el mismo estado: la MISMA huella en el poll y en /settings', async () => {
  const { delPoll, deSettings } = await huellas()
  expect(delPoll).toMatch(/^[0-9a-f]{32}$/)
  expect(deSettings).toBe(delPoll)
})

it('cambiar un ajuste del negocio o de la terminal cambia las dos por igual', async () => {
  const antes = await huellas()
  await prisma.venueSettings.update({ where: { venueId }, data: { managerPinOverrideEnabled: true } })
  const trasNegocio = await huellas()
  expect(trasNegocio.delPoll).not.toBe(antes.delPoll)
  expect(trasNegocio.deSettings).toBe(trasNegocio.delPoll)
  await prisma.terminal.update({ where: { id: terminalId }, data: { config: { settings: { showTipScreen: false } } } })
  const trasTerminal = await huellas()
  expect(trasTerminal.delPoll).not.toBe(trasNegocio.delPoll)
  expect(trasTerminal.deSettings).toBe(trasTerminal.delPoll)
})

it('un latido (lastHeartbeat) NO cambia la huella: si la cambiara, la tablet refrescaría cada minuto', async () => {
  const antes = await huellas()
  await prisma.terminal.update({ where: { id: terminalId }, data: { lastHeartbeat: new Date() } })
  expect((await huellas()).delPoll).toBe(antes.delPoll)
})

/** El cuerpo REAL de `/settings` para este aparato (el controlador, sin HTTP). */
const cuerpo = async () => {
  let body: any
  const res: any = { status: () => res, json: (b: unknown) => ((body = b), res) }
  await getVenueTpvSettings({ params: { venueId }, headers: { 'x-device-id': DEVICE } } as any, res, (e: unknown) => {
    throw e
  })
  return body.data
}

it('el vaivén ACTIVE ↔ INACTIVE (lo mueve la vigilancia de latidos) NO cambia la huella', async () => {
  const antes = await huellas()
  await prisma.terminal.update({ where: { id: terminalId }, data: { status: 'ACTIVE' } })
  try {
    expect((await huellas()).delPoll).toBe(antes.delPoll)
  } finally {
    await prisma.terminal.update({ where: { id: terminalId }, data: { status: 'INACTIVE' } })
  }
})

// 🔴 Codex r1 #9, sus dos transiciones: el aparato deja de ser su propia fuente, y después cambia la fuente nueva.
it('🔴 la terminal pasa a MAINTENANCE: cuerpo y huella salen de OTRA (la primera activa) y un cambio en ésa mueve las dos', async () => {
  const otra = (
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Aaa primera',
        type: 'POS_ANDROID',
        deviceUid: `otra-${suffix}`,
        status: 'ACTIVE',
        config: { settings: { showTipScreen: true } },
      },
      select: { id: true },
    })
  ).id
  try {
    const antes = await huellas()
    await prisma.terminal.update({ where: { id: terminalId }, data: { status: 'MAINTENANCE' } })
    const enMantenimiento = await huellas()
    expect(enMantenimiento.delPoll).not.toBe(antes.delPoll)
    expect(enMantenimiento.deSettings).toBe(enMantenimiento.delPoll)
    expect((await cuerpo()).activeTerminalId).toBe(otra) // el cuerpo elige la MISMA fuente

    await prisma.terminal.update({ where: { id: otra }, data: { config: { settings: { showTipScreen: false } } } })
    const trasLaOtra = await huellas()
    expect(trasLaOtra.delPoll).not.toBe(enMantenimiento.delPoll)
    expect(trasLaOtra.deSettings).toBe(trasLaOtra.delPoll)
  } finally {
    await prisma.terminal.update({ where: { id: terminalId }, data: { status: 'INACTIVE' } })
    await prisma.terminal.deleteMany({ where: { id: otra } })
  }
})
