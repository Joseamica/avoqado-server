/**
 * IVA por producto, bloque C3 · Tarea 8 (Codex C3-10), contra una base de pruebas propia: `cfdiVivoSql` (la definición de documento vivo para
 * SQL crudo) elige EXACTAMENTE las mismas filas que `CFDI_VIVO` (la de Prisma) en cada estado de un CFDI. Si una de las dos cambia sin la
 * otra, la lista de facturas y el MCP dirían «falta la factura del cliente» con un documento vivo (o al revés).
 */
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { CFDI_VIVO, cfdiVivoSql } from '@/services/fiscal/exclusionGlobal'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(database.pathname) ||
    isDisposableH1Url(database)
  )
)
  throw new Error('Dedicated test DB required')

describe('C3 · T8 — `cfdiVivoSql` = `CFDI_VIVO`', () => {
  const fixture = `cfdi-vivo-sql-${randomUUID()}`
  let venueId: string
  let fiscalEmisorId: string
  /** Cada estado que puede tener un CFDI, con si es vivo según la regla (para leer la prueba; la verdad es `CFDI_VIVO`). */
  const ESTADOS: Array<{ nombre: string; vivo: boolean; data: Partial<Prisma.CfdiUncheckedCreateInput> }> = [
    { nombre: 'borrador', vivo: true, data: { status: 'DRAFT' } },
    { nombre: 'timbrada', vivo: true, data: { status: 'STAMPED' } },
    { nombre: 'timbrando', vivo: true, data: { status: 'STAMPING' } },
    { nombre: 'rechazada-definitiva', vivo: false, data: { status: 'STAMP_FAILED', falloDefinitivo: true } },
    { nombre: 'fallida-en-recuperacion', vivo: true, data: { status: 'STAMP_FAILED', falloDefinitivo: false, enviadoAt: new Date() } },
    { nombre: 'validacion', vivo: false, data: { status: 'VALIDATION_FAILED' } },
    { nombre: 'cancelada-confirmada', vivo: false, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } },
    { nombre: 'cancelada-aceptada', vivo: false, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } },
    { nombre: 'cancelada-en-tramite', vivo: true, data: { status: 'CANCELLED', cancelStatus: 'REQUESTED' } },
    { nombre: 'cancelada-sin-estado', vivo: true, data: { status: 'CANCELLED', cancelStatus: null } },
    { nombre: 'cancelada-rechazada', vivo: true, data: { status: 'CANCELLED', cancelStatus: 'REJECTED' } },
    { nombre: 'timbrada-con-cancelacion-aceptada', vivo: true, data: { status: 'STAMPED', cancelStatus: 'ACCEPTED' } },
    { nombre: 'cancelacion-pedida', vivo: true, data: { status: 'CANCEL_REQUESTED', cancelStatus: 'REQUESTED' } },
  ]
  const ids = new Map<string, string>()

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: { venueId, rfc: 'AAA010101AAA', legalName: fixture, regimenFiscal: '601', lugarExpedicion: '01000', csdStatus: 'ACTIVE' },
      })
    ).id
    for (const e of ESTADOS) {
      const c = await prisma.cfdi.create({
        data: {
          venueId,
          fiscalEmisorId,
          flow: 'STAFF_B',
          receptorRfc: 'XAXX010101000',
          receptorNombre: 'PÚBLICO EN GENERAL',
          receptorRegimen: '616',
          receptorCp: '01000',
          usoCfdi: 'S01',
          formaPago: '04',
          metodoPago: 'PUE',
          subtotalCents: 10000,
          taxCents: 1600,
          totalCents: 11600,
          protocoloIva: 1, // `Cfdi_heredada_solo_terminada`: sin protocolo sólo existen las terminadas
          ...e.data,
        },
      })
      ids.set(e.nombre, c.id)
    }
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })

  it('🔴 en cada estado, el SQL crudo elige las mismas filas que el filtro de Prisma (y son las vivas de la regla)', async () => {
    const todos = [...ids.values()]
    const porPrisma = (await prisma.cfdi.findMany({ where: { id: { in: todos }, ...CFDI_VIVO }, select: { id: true } })).map(c => c.id)
    const porSql = (
      await prisma.$queryRaw<Array<{ id: string }>>`SELECT c.id FROM "Cfdi" c WHERE c.id = ANY(${todos}) AND ${cfdiVivoSql('c')}`
    ).map(c => c.id)
    const nombres = (xs: string[]) => ESTADOS.filter(e => xs.includes(ids.get(e.nombre)!)).map(e => e.nombre)
    expect(nombres(porSql)).toEqual(nombres(porPrisma))
    expect(nombres(porPrisma)).toEqual(ESTADOS.filter(e => e.vivo).map(e => e.nombre))
  })
})
