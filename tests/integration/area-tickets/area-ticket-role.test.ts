import { FulfillmentMode, StaffRole, TerminalStatus, TerminalType } from '@prisma/client'

import { logAction } from '@/services/dashboard/activity-log.service'
import { setTerminalAreaRole } from '@/services/mobile/areaTicketRole.mobile.service'
import { getAreaTicketSettings } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * D3 (2-nov-2026) — el papel del aparato, contra Postgres real.
 *
 * Un aparato que se dio de alta solo pregunta su papel, lo guarda, deja de preguntar y queda con la bitácora de fuente
 * `pos`. Un área inactiva se rechaza sin tocar la terminal. Lo que un mock no prueba: que la columna nueva exista, que el
 * conteo de áreas sea el real y que la escritura quede acotada al negocio.
 */
describe('papel del aparato en los vales — contra Postgres real', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const deviceUid = `cremeria-${suffix}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let terminalId: string
  let activeAreaId: string
  let inactiveAreaId: string

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Papel del aparato ${suffix}`, email: `papel-${suffix}@example.com`, phone: '5555555555' },
    })
    organizationId = organization.id
    const venue = await prisma.venue.create({
      data: { organizationId, name: `Papel del aparato venue ${suffix}`, slug: `papel-aparato-${suffix}`, seatCapExempt: true },
    })
    venueId = venue.id
    const staff = await prisma.staff.create({
      data: { email: `papel-staff-${suffix}@example.com`, firstName: 'Ana', lastName: 'Admin' },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.ADMIN } })

    const active = await prisma.fulfillmentArea.create({
      data: { venueId, name: 'Cremería', fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
    })
    activeAreaId = active.id
    const inactive = await prisma.fulfillmentArea.create({
      data: { venueId, name: 'Rosticería cerrada', fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID, active: false },
    })
    inactiveAreaId = inactive.id
    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })

    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'PC de la cremería',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid,
        selfRegistered: true,
        firstSeenAt: new Date(),
      },
    })
    terminalId = terminal.id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  it('el aparato nuevo pregunta, elige emitir vales de Cremería y deja de preguntar', async () => {
    const before = await getAreaTicketSettings(venueId, deviceUid)
    expect(before.terminal.roleChoicePending).toBe(true)
    expect(before.areas).toEqual([{ id: activeAreaId, name: 'Cremería' }])
    expect(before.areasTotal).toBe(1)

    const after = await setTerminalAreaRole({
      venueId,
      terminalId,
      deviceUid,
      staffId,
      choice: { role: 'ISSUE', fulfillmentAreaId: activeAreaId },
    })

    expect(after.terminal.roleChoicePending).toBe(false)
    expect(after.terminal.canIssueAreaTickets).toBe(true)
    expect(after.terminal.canCheckoutAreaTickets).toBe(false)
    expect(after.terminal.defaultWorkspace).toBe('AREA_OPERATIONS')

    const row = await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId } })
    expect(row.fulfillmentAreaId).toBe(activeAreaId)
    expect(row.areaRoleChosenAt).toBeInstanceOf(Date)

    // La bitácora está simulada en toda la integración (`tests/__helpers__/integration-setup.ts`): se revisa la llamada.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AREA_TICKET_TERMINAL_UPDATED',
        staffId,
        venueId,
        entityId: terminalId,
        data: expect.objectContaining({
          source: 'pos',
          before: expect.objectContaining({ canIssueAreaTickets: false, fulfillmentAreaId: null }),
        }),
      }),
    )
  })

  it('un área inactiva se rechaza y la terminal no cambia', async () => {
    await expect(
      setTerminalAreaRole({ venueId, terminalId, deviceUid, staffId, choice: { role: 'ISSUE', fulfillmentAreaId: inactiveAreaId } }),
    ).rejects.toMatchObject({ statusCode: 400 })

    const row = await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId } })
    expect(row.fulfillmentAreaId).toBe(activeAreaId)
  })

  it('volver a caja quita el área y prende cobrar', async () => {
    const after = await setTerminalAreaRole({ venueId, terminalId, deviceUid, staffId, choice: { role: 'CHECKOUT' } })

    expect(after.terminal.canCheckoutAreaTickets).toBe(true)
    expect(after.terminal.canIssueAreaTickets).toBe(false)
    const row = await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId } })
    expect(row.fulfillmentAreaId).toBeNull()
  })
})
