/**
 * D17 (REAL PostgreSQL, 16-nov-2026): el correo de ventas cuenta el día del NEGOCIO, completo.
 *
 * Antes salía a las 22:02 con «hoy» leído en la zona del PROCESO: en producción (UTC) un negocio de CDMX recibía de las 18:00
 * del día anterior a las 17:59, sin la noche. Decisión del founder: sale a las 07:02 de CDMX con el día completo de AYER, como
 * Square y Toast. Aquí corre el job de verdad (consultas reales, plantilla real) con el reloj en el 17-nov 07:02 de CDMX; sólo el
 * transporte del correo es un doble, así que no sale nada.
 *
 * Se corre con el proceso en UTC, como producción (avq-verify fija `TZ=UTC` en los dos lados):
 *   TZ=UTC TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern nightly-sales-dia-del-negocio
 */

import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { NightlySalesSummaryJob } from '@/jobs/nightly-sales-summary.job'
import { limpiarVenue, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const AHORA = new Date('2026-11-17T13:02:00.000Z') // 17-nov 07:02 CDMX: la corrida de la mañana
const suffix = `d17-${Date.now()}`

let orgId: string
let venueId: string
let staffId: string

/** Un cobro de `pesos` cuya cuenta y pago ocurrieron en `cuando`. */
async function venta(pesos: number, cuando: string) {
  const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents: pesos * 100 })
  await prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(cuando), completedAt: new Date(cuando) } })
  await prisma.payment.update({ where: { id: pago.id }, data: { createdAt: new Date(cuando) } })
}

/** Sólo el reloj de pared: los `setTimeout` del job, de Prisma y las promesas siguen siendo reales. */
function fijarReloj(now: Date) {
  jest.useFakeTimers({
    now,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })
}

const transporte = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)
const plantilla = jest.spyOn(emailService, 'sendSalesSummaryEmail')

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `D17 Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `d17-${suffix}`, slug: `d17-${suffix}`, timezone: TZ, status: 'ACTIVE' },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({
      data: { email: `duena-${suffix}@example.test`, firstName: 'Dueña', lastName: 'D17' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
  await prisma.notificationPreference.create({ data: { staffId, venueId, type: 'DAILY_SALES_SUMMARY', enabled: true } })

  // El 16 (el día que reporta la corrida de las 07:02 del 17).
  await venta(100, '2026-11-17T03:00:00.000Z') // 21:00 CDMX del 16: el correo viejo de las 22:02 la dejaba fuera
  await venta(20, '2026-11-17T05:30:00.000Z') // 23:30 CDMX del 16
  // Fuera del 16.
  await venta(7, '2026-11-17T06:30:00.000Z') // 00:30 CDMX del 17: es de hoy, sale en el correo de mañana
  await venta(40, '2026-11-16T02:00:00.000Z') // 20:00 CDMX del 15: la ventana vieja (en UTC) la contaba como del 16
  await venta(5, '2026-11-15T23:00:00.000Z') // 17:00 CDMX del 15
  // El mismo día de la semana pasada (lunes 9).
  await venta(9, '2026-11-10T04:00:00.000Z') // 22:00 CDMX del 9
})

afterAll(async () => {
  jest.useRealTimers()
  transporte.mockRestore()
  plantilla.mockRestore()
  if (venueId) {
    await prisma.venueTransaction.deleteMany({ where: { venueId } }).catch(() => undefined)
    await limpiarVenue(venueId)
    await prisma.notificationPreference.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('D17 · el correo de las 07:02 cuenta el día anterior completo del negocio', () => {
  let datos: any
  let correo: { subject: string; html: string }

  beforeAll(async () => {
    fijarReloj(AHORA)
    try {
      const resultado = await new NightlySalesSummaryJob().runNow(venueId)
      expect(resultado).toMatchObject({ venuesProcessed: 1, emailsSent: 1, errors: 0 })
    } finally {
      jest.useRealTimers()
    }
    expect(plantilla).toHaveBeenCalledTimes(1)
    datos = plantilla.mock.calls[0][1]
    correo = transporte.mock.calls[0][0] as { subject: string; html: string }
  })

  it('🔴 las 21:00 y las 23:30 del 16 entran; las 00:30 del 17 y la tarde del 15 no', () => {
    expect(datos.metrics.netSales).toBeCloseTo(120, 2)
    expect(datos.metrics.transactionCount).toBe(2)
  })

  it('«Origen del pedido» usa la misma ventana: suma lo mismo que el total', () => {
    const fuentes = datos.orderSources as Array<{ orders: number; netSales: number }>
    expect(fuentes.reduce((s, f) => s + f.orders, 0)).toBe(2)
    expect(Math.round(fuentes.reduce((s, f) => s + f.netSales, 0) * 100)).toBe(12000)
  })

  it('el día anterior es el 15 completo de CDMX y la semana pasada el 9 completo', () => {
    expect(datos.previousPeriod).toMatchObject({ transactionCount: 2 })
    expect(datos.previousPeriod.netSales).toBeCloseTo(45, 2)
    expect(datos.lastWeekMetrics).toMatchObject({ transactionCount: 1 })
    expect(datos.lastWeekMetrics.netSales).toBeCloseTo(9, 2)
  })

  it('🔴 el asunto y el título dicen el 16, con el formato de fecha que ya usaba el correo', () => {
    const el16 = new Date('2026-11-16T18:00:00.000Z').toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      timeZone: TZ,
    })
    const el16Mayuscula = el16.charAt(0).toUpperCase() + el16.slice(1)
    expect(correo.subject).toBe(`${el16Mayuscula} - Resumen de ventas - d17-${suffix}`)
    expect(correo.html).toContain(`>${el16Mayuscula}, d17-${suffix}</h1>`)
    expect(correo.html).toContain('vs el mismo día de la semana pasada')
  })
})
