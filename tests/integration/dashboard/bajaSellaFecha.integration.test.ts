/**
 * D19 (hz:248b195b:D19), contra Postgres REAL: toda baja de una membresía (StaffVenue) sella su fecha UNA vez y reactivarla
 * la limpia, la escriba quien la escriba. Antes, el switch de Equipo del DASHBOARD (y `update_staff_member` del MCP, el botón
 * de la organización y «quitar sucursal») apagaban `active` sin `endDate`, y la persona desaparecía de la asistencia y la
 * nómina de los días que sí trabajó. La regla vive en la base (trigger `StaffVenue_sella_baja`).
 * Promesa: Avoqado/docs/audit/2026-11-21-baja-con-switch/promesa.md
 */
import { DateTime } from 'luxon'
import prisma from '@/utils/prismaClient'
import { removeTeamMember, updateTeamMember } from '@/services/dashboard/team.dashboard.service'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

let m: MundoComisiones
let svBea: string

beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('baja-sella')
  svBea = (await prisma.staffVenue.findFirstOrThrow({ where: { staffId: m.bea, venueId: m.venueId }, select: { id: true } })).id
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

const fila = () => prisma.staffVenue.findUniqueOrThrow({ where: { id: svBea }, select: { active: true, endDate: true, pin: true } })
/** La fecha sellada es la de la baja: entre justo antes y justo después de la llamada (1 s de holgura de reloj). */
const esAhora = (d: Date | null, antes: number) => {
  expect(d).not.toBeNull()
  expect(d!.getTime()).toBeGreaterThanOrEqual(antes - 1000)
  expect(d!.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
}

it('el switch de Equipo (updateTeamMember active:false) sella la fecha de la baja, y la respuesta la trae', async () => {
  const antes = Date.now()
  const respuesta = await updateTeamMember(m.venueId, svBea, { active: false })
  const f = await fila()
  expect(f.active).toBe(false)
  esAhora(f.endDate, antes)
  expect(respuesta.endDate?.getTime()).toBe(f.endDate!.getTime())
})

it('reactivar con el switch limpia la fecha', async () => {
  await updateTeamMember(m.venueId, svBea, { active: false })
  expect((await fila()).endDate).not.toBeNull()
  await updateTeamMember(m.venueId, svBea, { active: true })
  expect(await fila()).toMatchObject({ active: true, endDate: null })
})

it('una baja repetida («Desactivar» sobre alguien ya dado de baja) no mueve la fecha; corregirla sin tocar `active` sí se puede', async () => {
  await prisma.staffVenue.update({ where: { id: svBea }, data: { pin: '4321' } })
  await updateTeamMember(m.venueId, svBea, { active: false })
  const primera = (await fila()).endDate!
  await new Promise(r => setTimeout(r, 30))
  await removeTeamMember(m.venueId, svBea)
  const f = await fila()
  expect(f).toMatchObject({ active: false, pin: null })
  expect(f.endDate!.getTime()).toBe(primera.getTime())

  // El relleno de las bajas viejas (o una corrección) escribe la fecha sin tocar `active`: la base la respeta.
  const corregida = new Date('2026-10-06T17:28:59.000Z')
  await prisma.staffVenue.update({ where: { id: svBea }, data: { endDate: corregida } })
  expect((await fila()).endDate!.getTime()).toBe(corregida.getTime())
})

it('cualquier escritor: updateMany (botón de la organización), upsert (volver a asignar sucursal) y una fecha explícita', async () => {
  const antes = Date.now()
  await prisma.staffVenue.updateMany({ where: { staffId: m.bea, venueId: m.venueId }, data: { active: false } })
  esAhora((await fila()).endDate, antes)

  await prisma.staffVenue.upsert({
    where: { staffId_venueId: { staffId: m.bea, venueId: m.venueId } },
    update: { active: true, role: 'WAITER' },
    create: { staffId: m.bea, venueId: m.venueId, role: 'WAITER', active: true },
  })
  expect(await fila()).toMatchObject({ active: true, endDate: null })

  // Quien ya manda su propia fecha (seat cap, superadmin, CRM) la conserva.
  const propia = new Date('2026-11-01T12:00:00.000Z')
  await prisma.staffVenue.update({ where: { id: svBea }, data: { active: false, endDate: propia } })
  expect((await fila()).endDate!.getTime()).toBe(propia.getTime())
})

it('una baja nunca queda sin fecha: ni mandando `endDate: null` sobre una fila activa con fecha vieja (Codex r1 #5)', async () => {
  await prisma.staffVenue.update({ where: { id: svBea }, data: { endDate: new Date('2026-05-23T18:54:01.999Z') } }) // como la fila viva de prod
  const antes = Date.now()
  await prisma.staffVenue.update({ where: { id: svBea }, data: { active: false, endDate: null } })
  esAhora((await fila()).endDate, antes)
})

it('dentro de una transacción larga, la fecha es la de la baja y no la de cuando abrió la transacción (Codex r1 #6)', async () => {
  let antes = 0
  await prisma.$transaction(
    async tx => {
      await tx.staffVenue.findUniqueOrThrow({ where: { id: svBea } })
      await new Promise(r => setTimeout(r, 2500))
      antes = Date.now()
      await tx.staffVenue.update({ where: { id: svBea }, data: { active: false } })
    },
    { timeout: 10_000 },
  )
  esAhora((await fila()).endDate, antes)
})

it('la asistencia sigue mostrando los días que trabajó quien se dio de baja con el switch', async () => {
  const zona = 'America/Mexico_City'
  const hoy = DateTime.now().setZone(zona).startOf('day')
  const dia = hoy.minus({ days: 3 })
  await prisma.staffVenue.update({ where: { id: svBea }, data: { startDate: hoy.minus({ days: 10 }).toJSDate() } })
  const entrada = dia.set({ hour: 9 })
  await prisma.timeEntry.create({
    data: {
      staffId: m.bea,
      venueId: m.venueId,
      clockInTime: entrada.toJSDate(),
      clockOutTime: entrada.plus({ hours: 8 }).toJSDate(),
      totalHours: 8,
      status: 'CLOCKED_OUT',
    },
  })

  await updateTeamMember(m.venueId, svBea, { active: false })

  const { cells } = await buildAttendanceGrid(m.venueId, hoy.minus({ days: 5 }).toISODate()!, hoy.toISODate()!)
  const suDia = cells.find(c => c.staffId === m.bea && c.date === dia.toISODate())
  expect(suDia).toBeDefined()
  expect(suDia!.clockInTime).not.toBeNull()
})
