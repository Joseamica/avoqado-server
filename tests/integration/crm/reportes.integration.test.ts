/**
 * The CRM's reports and «Clientes» against a real Postgres (plan task 9, rulings 39 and 41). The unit tests mock
 * `$queryRaw`, so they cannot prove what only the database answers: that the month and week buckets fall on Mexico
 * City's calendar (a sale at 21:00 on the last day of the month belongs to that month), that the seller's scope holds in
 * SQL, and that a hidden organization leaves «Clientes» through the real relation.
 *
 * Every fixture lives in 2020 — a year no other suite writes in — so the counts are this file's alone even when other
 * suites share the database.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/reportes.integration.test.ts --ci
 */
// The integration setup replaces `logAction` with an empty mock for every suite (`tests/__helpers__/integration-setup.ts`).
// Hiding an organization must leave a REAL audit row — with its actor and its organization, the columns the audit screens
// filter by — so this file writes through the real one, as `venueActivityLog.service.test.ts` does in unit.
jest.unmock('@/services/dashboard/activity-log.service')

import type { Prisma } from '@prisma/client'
import type { CrmAccess } from '@/services/crm/access.service'
import { listLostReasons, listStages } from '@/services/crm/accounts.service'
import { hideClient, listClients, unhideClient } from '@/services/crm/clients.service'
import { getReports } from '@/services/crm/reports.service'
import prisma from '@/utils/prismaClient'

const suffix = `crmrep${Date.now()}`
const YEAR_2020 = { desde: '2020-01-01', hasta: '2020-12-31' }
const NOW = new Date('2020-12-31T18:00:00.000Z')

const staffIds: string[] = []
const accountIds: string[] = []
const organizationIds: string[] = []

const access = (staffId: string, over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId,
  isSuperadmin: false,
  ver: 'propios',
  editar: 'propios',
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  cerrar: false,
  bajas: false,
  plantillas: false,
  preparar: false,
  mandar: false,
  verCampanas: false,
  equipo: false,
  configurar: false,
  ...over,
})

async function person(name: string) {
  const staff = await prisma.staff.create({
    data: { email: `${name.toLowerCase()}-${suffix}@test.mx`, firstName: name, lastName: 'Reportes', active: true },
  })
  staffIds.push(staff.id)
  return staff
}

describe('CRM reports and «Clientes» against Postgres', () => {
  let seller: { id: string }
  let other: { id: string }
  let wonStageId: string
  let lostStageId: string
  let reason: { id: string; name: string }

  /** An account of this file, outside the pipeline's present (every date in 2020). */
  async function account(data: Partial<Prisma.CrmAccountUncheckedCreateInput>) {
    const created = await prisma.crmAccount.create({ data: { name: `Negocio ${suffix}`, source: 'MANUAL', stageId: wonStageId, ...data } })
    accountIds.push(created.id)
    return created
  }

  beforeAll(async () => {
    seller = await person('Luis')
    other = await person('Ana')
    const stages = await listStages()
    wonStageId = stages.find(stage => stage.kind === 'GANADA')!.id
    lostStageId = stages.find(stage => stage.kind === 'PERDIDA')!.id
    reason = (await listLostReasons())[0]

    // 21:00 on 29-feb-2020 in Mexico City is already 1-mar in UTC: it is February's.
    await account({ ownerStaffId: seller.id, wonAt: new Date('2020-03-01T03:00:00.000Z') })
    const march = await account({ ownerStaffId: seller.id, wonAt: new Date('2020-03-15T18:00:00.000Z') })
    // A colleague's: a «propios» seller never counts it.
    const others = await account({ ownerStaffId: other.id, wonAt: new Date('2020-03-10T18:00:00.000Z') })
    // Archived: out of the reports for everyone.
    await account({
      ownerStaffId: seller.id,
      wonAt: new Date('2020-03-12T18:00:00.000Z'),
      archivedAt: new Date('2020-04-01T18:00:00.000Z'),
    })
    // 23:59 on 31-mar in Mexico City (already April in UTC): March's.
    await account({
      ownerStaffId: seller.id,
      stageId: lostStageId,
      lostReasonId: reason.id,
      lostAt: new Date('2020-04-01T05:59:00.000Z'),
    })

    await prisma.crmActivity.createMany({
      data: [
        // 23:30 on Sunday 1-mar in Mexico City: the week that started on Monday 24-feb.
        {
          accountId: march.id,
          type: 'LLAMADA',
          title: 'Llamar',
          dueAt: NOW,
          doneAt: new Date('2020-03-02T05:30:00.000Z'),
          doneById: seller.id,
        },
        // 00:30 on Monday 2-mar in Mexico City: a new week.
        {
          accountId: march.id,
          type: 'LLAMADA',
          title: 'Llamar',
          dueAt: NOW,
          doneAt: new Date('2020-03-02T06:30:00.000Z'),
          doneById: seller.id,
        },
        { accountId: others.id, type: 'DEMO', title: 'Demo', dueAt: NOW, doneAt: new Date('2020-03-03T18:00:00.000Z'), doneById: other.id },
      ],
    })
  })

  afterAll(async () => {
    // Keyed by the ids this file created, never a `where` that could be undefined. Deleting the accounts cascades to
    // their activities; deleting the organizations, to their hidden mark.
    if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
    if (staffIds.length) {
      await prisma.activityLog.deleteMany({ where: { staffId: { in: staffIds } } })
      await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
    }
    if (organizationIds.length) {
      // `ActivityLog.organization` is RESTRICT: the hide/unhide rows go before their organization.
      await prisma.activityLog.deleteMany({ where: { organizationId: { in: organizationIds } } })
      await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
    }
  })

  it('las_cubetas_de_mes_y_semana_caen_en_el_calendario_de_ciudad_de_mexico', async () => {
    const report = await getReports(access(seller.id), YEAR_2020, NOW)

    expect(report.ganados.porMes).toEqual([
      { mes: '2020-02', total: 1 },
      { mes: '2020-03', total: 1 },
    ])
    expect(report.ganados.total).toBe(2)
    expect(report.ganados.porDueno).toEqual([{ owner: { id: seller.id, name: 'Luis Reportes' }, total: 2 }])
    expect(report.perdidos.porMes).toEqual([{ mes: '2020-03', total: 1 }])
    expect(report.perdidos.porMotivo).toEqual([{ motivo: { id: reason.id, name: reason.name }, total: 1 }])
    expect(report.actividades).toEqual([
      { persona: { id: seller.id, name: 'Luis Reportes' }, semana: '2020-02-24', total: 1 },
      { persona: { id: seller.id, name: 'Luis Reportes' }, semana: '2020-03-02', total: 1 },
    ])
  })

  it('con_todos_cuenta_lo_de_los_companeros_y_nunca_lo_archivado', async () => {
    const report = await getReports(access(seller.id, { ver: 'todos' }), YEAR_2020, NOW)

    expect(report.ganados.porMes).toEqual([
      { mes: '2020-02', total: 1 },
      { mes: '2020-03', total: 2 },
    ])
    expect(report.actividades).toEqual(
      expect.arrayContaining([{ persona: { id: other.id, name: 'Ana Reportes' }, semana: '2020-03-02', total: 1 }]),
    )
  })

  it('una_organizacion_oculta_sale_de_clientes_y_regresa', async () => {
    const organization = await prisma.organization.create({
      data: { name: `Grupo de pruebas ${suffix}`, email: `grupo-${suffix}@test.mx`, phone: '5555555555' },
    })
    organizationIds.push(organization.id)
    // A «Ganado» link makes it a client, with or without money.
    await account({ ownerStaffId: seller.id, organizationId: organization.id })
    // Ocultar y ver los ocultos es de «Configurar el CRM» (L7).
    const admin = access(seller.id, { configurar: true })

    const before = await listClients(access(seller.id), { q: suffix })
    expect(before.total).toBe(1)
    expect(before.rows[0]).toMatchObject({ id: organization.id, yaCobro: false, cuentaAjena: false })

    await hideClient(admin, organization.id)
    await hideClient(admin, organization.id)
    expect(await listClients(access(seller.id), { q: suffix })).toMatchObject({ total: 0, rows: [] })
    const hidden = await listClients(admin, { q: suffix, ocultos: true })
    expect(hidden.rows.map(row => row.id)).toEqual([organization.id])
    expect(
      await prisma.activityLog.count({ where: { action: 'CRM_CLIENT_HIDDEN', organizationId: organization.id, staffId: seller.id } }),
    ).toBe(1)

    await unhideClient(admin, organization.id)
    await unhideClient(admin, organization.id)
    expect((await listClients(access(seller.id), { q: suffix })).total).toBe(1)
    // Twice, but one change: one row, with who did it and on which organization.
    expect(
      await prisma.activityLog.count({ where: { action: 'CRM_CLIENT_UNHIDDEN', organizationId: organization.id, staffId: seller.id } }),
    ).toBe(1)
  })
})
