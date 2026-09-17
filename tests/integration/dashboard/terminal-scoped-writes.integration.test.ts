/**
 * Escrituras de terminales acotadas a su negocio, contra PostgreSQL REAL.
 *
 * 🔴 Auditoría de Codex del spec «pantalla del cliente», 4ª ronda (2026-09-17), C2 y C3. Las pruebas unitarias simulan
 * `$transaction` con `Promise.all`, así que no demuestran que la base deshaga nada, ni que el `where` con filtro de
 * relación funcione de verdad. Aquí se prueba contra Postgres:
 * - una terminal que se mudó entre la lectura y la escritura se omite: su configuración no cambia, y el resto se guarda;
 * - si una escritura falla EN LA BASE, se deshace el lote entero, incluido el horario del negocio;
 * - `venue: { organizationId }` acota de verdad `update` y `updateMany`, y `{ id, venueId }` acota `delete`.
 *
 * «Se mudó a media operación» se simula devolviendo, en la lectura inicial, una terminal que en la base ya es de otro
 * negocio: es exactamente lo que ve el servicio cuando el traslado confirma entre su lectura y su escritura.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/dashboard/terminal-scoped-writes.integration.test.ts
 */

import { Prisma } from '@prisma/client'

import { NotFoundError } from '@/errors/AppError'
import { updateTerminal as superadminUpdateTerminal } from '@/services/dashboard/terminals.superadmin.service'
import { deleteTpv, updateVenueTpvSettings } from '@/services/dashboard/tpv.dashboard.service'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'
import prisma from '@/utils/prismaClient'

const suffix = `tsw-${Date.now()}`

let orgX: string
let orgY: string
let venueA: string
let venueB: string
let t1: string // en A, sin ajustes propios
let t3: string // en A, con un ajuste propio
let t2: string // en B: la que «se mudó»

const settingsOf = async (id: string) => {
  const row = await prisma.terminal.findUnique({ where: { id }, select: { config: true, name: true } })
  return ((row?.config as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
}

const readRow = (id: string) =>
  prisma.terminal.findUniqueOrThrow({ where: { id }, select: { id: true, config: true, configOverrides: true } })

beforeAll(async () => {
  const mkOrg = (name: string) =>
    prisma.organization.create({
      data: { name: `${name} ${suffix}`, email: `${name.toLowerCase()}-${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  orgX = (await mkOrg('OrgX')).id
  orgY = (await mkOrg('OrgY')).id

  const mkVenue = (organizationId: string, slug: string) =>
    prisma.venue.create({
      data: { organizationId, name: `${slug} ${suffix}`, slug: `${slug}-${suffix}`, timezone: 'America/Mexico_City', status: 'ACTIVE' },
      select: { id: true },
    })
  venueA = (await mkVenue(orgX, 'negocio-a')).id
  venueB = (await mkVenue(orgY, 'negocio-b')).id

  const mkTerminal = (venueId: string, name: string, configOverrides?: Prisma.InputJsonValue) =>
    prisma.terminal.create({
      data: {
        venueId,
        name: `${name} ${suffix}`,
        type: 'TPV_ANDROID',
        config: { settings: { showTipScreen: true, showReviewScreen: true } },
        ...(configOverrides ? { configOverrides } : {}),
      },
      select: { id: true },
    })
  t1 = (await mkTerminal(venueA, 'Caja A1')).id
  t3 = (await mkTerminal(venueA, 'Caja A3', { notaDePrueba: 'propia' })).id
  t2 = (await mkTerminal(venueB, 'Caja B2')).id
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  const venueIds = [venueA, venueB].filter(Boolean)
  await prisma.terminal.deleteMany({ where: { id: { in: [t1, t2, t3].filter(Boolean) } } })
  await prisma.venueSettings.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  await prisma.organizationAttendanceConfig.deleteMany({ where: { organizationId: { in: [orgX, orgY].filter(Boolean) } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgX, orgY].filter(Boolean) } } })
})

describe('ajustes por negocio (updateVenueTpvSettings)', () => {
  it('una terminal que se mudó a media operación se omite; el resto y el horario del negocio sí se guardan', async () => {
    const lectura = [await readRow(t1), await readRow(t2)] // t2 ya es del negocio B
    jest.spyOn(prisma.terminal, 'findMany').mockResolvedValueOnce(lectura as never)

    await updateVenueTpvSettings(venueA, { showTipScreen: false, expectedCheckInTime: '07:45' } as never)

    expect((await settingsOf(t1)).showTipScreen).toBe(false)
    expect((await settingsOf(t2)).showTipScreen).toBe(true)
    const horario = await prisma.venueSettings.findUnique({ where: { venueId: venueA }, select: { expectedCheckInTime: true } })
    expect(horario?.expectedCheckInTime).toBe('07:45')
  })

  it('si una escritura falla en la base, se deshace todo: el horario del negocio y la terminal que ya se había escrito', async () => {
    // Orden del lote: [horario, t3, t1]. t3 tiene su propio valor de `notaDePrueba`, así que su escritura es válida;
    // t1 hereda el valor del negocio, que lleva un carácter nulo (U+0000) que Postgres rechaza en jsonb. Si la base no deshiciera el
    // lote, quedarían guardados el horario nuevo y la escritura de t3.
    const lectura = [await readRow(t3), await readRow(t1)]
    jest.spyOn(prisma.terminal, 'findMany').mockResolvedValueOnce(lectura as never)
    const t3Antes = await settingsOf(t3)

    await expect(
      updateVenueTpvSettings(venueA, { showReviewScreen: false, expectedCheckInTime: '06:15', notaDePrueba: 'a\u0000b' } as never),
    ).rejects.toThrow(/22P05|unsupported Unicode escape/) // lo rechaza POSTGRES al ejecutar, no una validación previa

    const horario = await prisma.venueSettings.findUnique({ where: { venueId: venueA }, select: { expectedCheckInTime: true } })
    expect(horario?.expectedCheckInTime).toBe('07:45')
    expect(await settingsOf(t3)).toEqual(t3Antes)
    expect((await settingsOf(t1)).showReviewScreen).toBe(true)
  })
})

describe('cascada de la organización (upsertOrgTpvDefaults)', () => {
  it('una terminal que pasó a otra organización se omite y no cuenta; el filtro de relación funciona en la base', async () => {
    const lectura = [await readRow(t1), await readRow(t2)] // t2 es de la organización Y
    jest.spyOn(prisma.terminal, 'findMany').mockResolvedValueOnce(lectura as never)

    const result = await organizationDashboardService.upsertOrgTpvDefaults(orgX, { enableBarcodeScanner: false })

    expect(result.terminalsUpdated).toBe(1)
    expect((await settingsOf(t1)).enableBarcodeScanner).toBe(false)
    expect((await settingsOf(t2)).enableBarcodeScanner).toBeUndefined()
    const config = await prisma.organizationAttendanceConfig.findUnique({ where: { organizationId: orgX }, select: { settings: true } })
    expect((config?.settings as Record<string, unknown>).enableBarcodeScanner).toBe(false)
  })
})

describe('operaciones sobre UNA terminal', () => {
  it('borrar desde el negocio A no borra una terminal que ya es del negocio B', async () => {
    const t2Row = await prisma.terminal.findUniqueOrThrow({ where: { id: t2 } })
    jest.spyOn(prisma.terminal, 'findFirst').mockResolvedValueOnce(t2Row as never)

    await expect(deleteTpv(venueA, t2)).rejects.toBeInstanceOf(NotFoundError)

    expect(await prisma.terminal.findUnique({ where: { id: t2 }, select: { id: true } })).not.toBeNull()
  })

  it('la organización X no puede editar una terminal que ya es de la organización Y', async () => {
    await expect(superadminUpdateTerminal(t2, { name: 'Robada' }, undefined, { organizationId: orgX })).rejects.toBeInstanceOf(
      NotFoundError,
    )

    const row = await prisma.terminal.findUniqueOrThrow({ where: { id: t2 }, select: { name: true } })
    expect(row.name).toBe(`Caja B2 ${suffix}`)
  })

  it('con la organización correcta, la misma edición sí se guarda', async () => {
    await superadminUpdateTerminal(t2, { name: `Caja B2 ${suffix} bis` }, undefined, { organizationId: orgY })

    const row = await prisma.terminal.findUniqueOrThrow({ where: { id: t2 }, select: { name: true } })
    expect(row.name).toBe(`Caja B2 ${suffix} bis`)
  })
})
