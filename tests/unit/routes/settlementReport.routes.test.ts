/**
 * Candados de las rutas de Reportes de Transacciones y Dispersiones: mismos que "Saldo disponible"
 * (settlements:read + ADVANCED_REPORTS), validación en español y 400 por fecha inexistente.
 *
 * Las compuertas son las REALES (checkPermission, checkFeatureAccess, validateRequest, esquemas); sólo se
 * simulan prisma, la autenticación (inyecta authContext) y el controlador. Además se verifica sobre el
 * router real de dashboard.routes.ts que las tres rutas llevan esa cadena.
 */
import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    // Con una fila menor que OWNER, el resolutor pregunta en UNA consulta si es dueña de la org del venue (P2-6).
    staffOrganization: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
    venueRolePermission: { findUnique: jest.fn() },
    capabilityGrant: { findFirst: jest.fn().mockResolvedValue(null), groupBy: jest.fn().mockResolvedValue([]) },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/controllers/dashboard/settlementReport.dashboard.controller', () => ({
  countSettlementReport: (_req: any, res: any) => res.json({ ok: 'count' }),
  settlementReportTerminalOptions: (_req: any, res: any) => res.json({ ok: 'terminals' }),
  exportSettlementReport: (req: any, res: any) => res.json({ ok: 'export', query: req.query }),
}))

import prisma from '@/utils/prismaClient'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/dashboard/settlementReport.dashboard.controller'
import {
  settlementReportCountSchema,
  settlementReportExportSchema,
  settlementReportTerminalOptionsSchema,
} from '@/schemas/dashboard/settlementReport.schema'
import dashboardRouter from '@/routes/dashboard.routes'

const p = prisma as any
const VENUE = 'cmabcdefghijklmnopqrstuvw' // cuid v1 de 25 caracteres

function createApp() {
  const app = express()
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE, orgId: 'org_1', role: 'WAITER' }
    next()
  })
  const gates = [checkPermission('settlements:read'), checkFeatureAccess('ADVANCED_REPORTS')]
  const base = '/venues/:venueId/settlement-reports'
  app.get(`${base}/count`, ...gates, validateRequest(settlementReportCountSchema), ctrl.countSettlementReport)
  app.get(
    `${base}/terminal-options`,
    ...gates,
    validateRequest(settlementReportTerminalOptionsSchema),
    ctrl.settlementReportTerminalOptions,
  )
  app.get(`${base}/export`, ...gates, validateRequest(settlementReportExportSchema), ctrl.exportSettlementReport)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message }))
  return app
}

const URL_COUNT = `/venues/${VENUE}/settlement-reports/count`
const OK = 'startDate=2026-08-01&endDate=2026-08-31&dateBasis=charge'

let server: Server
beforeAll(() => {
  server = createApp().listen(0)
})
afterAll(done => {
  server.close(done)
})

function conRol(role: string | null) {
  p.staff.findUnique.mockResolvedValue({ active: true })
  p.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
  p.staffVenue.findUnique.mockResolvedValue(role ? { role, active: true, permissionSetId: null, permissionSet: null } : null)
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org_1', seatCapExempt: false, status: 'ACTIVE' })
  p.staffOrganization.findUnique.mockResolvedValue(null)
  p.venueRolePermission.findUnique.mockResolvedValue(null)
}

beforeEach(() => {
  jest.clearAllMocks()
  conRol('OWNER')
  p.venueFeature.findFirst.mockResolvedValue(null)
  p.venueFeature.findMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])
})

describe('settlement-reports — candados reales', () => {
  it('sin settlements:read (WAITER) => 403 y no llega al controlador', async () => {
    conRol('WAITER')
    const res = await request(server).get(`${URL_COUNT}?${OK}`)
    expect(res.status).toBe(403)
    expect(res.body.required).toBe('settlements:read')
  })

  it('venue sin ADVANCED_REPORTS (Gratis) => 403 del candado de funciones', async () => {
    p.venueFeature.findMany.mockResolvedValue([])
    const res = await request(server).get(`${URL_COUNT}?${OK}`)
    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('ADVANCED_REPORTS')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('venue con concesión explícita de ADVANCED_REPORTS => pasa', async () => {
    p.venueFeature.findMany.mockResolvedValue([])
    p.venueFeature.findFirst.mockResolvedValue({ active: true, feature: { code: 'ADVANCED_REPORTS' } })
    const res = await request(server).get(`${URL_COUNT}?${OK}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: 'count' })
  })

  it('venue exento (seatCapExempt) => pasa', async () => {
    p.venueFeature.findMany.mockResolvedValue([])
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org_1', seatCapExempt: true, status: 'ACTIVE' })
    const res = await request(server).get(`${URL_COUNT}?${OK}`)
    expect(res.status).toBe(200)
  })
})

describe('settlement-reports — validación en español', () => {
  it('fecha inexistente => 400 «La fecha 2026-02-31 no existe.»', async () => {
    const res = await request(server).get(`${URL_COUNT}?startDate=2026-02-31&endDate=2026-03-01&dateBasis=charge`)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('La fecha 2026-02-31 no existe.')
  })

  it('parámetro repetido (llega como arreglo) => 400 en español, no «Expected string»', async () => {
    const res = await request(server).get(`${URL_COUNT}?startDate=2026-08-01&startDate=2026-08-02&endDate=2026-08-31&dateBasis=charge`)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('El parámetro debe ser texto.')
    expect(JSON.stringify(res.body)).not.toContain('Expected string')
  })

  it('export: filtros llegan al controlador como arreglo', async () => {
    const res = await request(server).get(
      `/venues/${VENUE}/settlement-reports/export?${OK}&report=transactions&format=csv&columns=folio,total&cardTypes=DEBIT,NONE`,
    )
    expect(res.status).toBe(200)
    expect(res.body.query).toMatchObject({ columns: ['folio', 'total'], cardTypes: ['DEBIT', 'NONE'] })
  })

  it('export: formato inválido => 400 en español', async () => {
    const res = await request(server).get(`/venues/${VENUE}/settlement-reports/export?${OK}&report=transactions&format=pdf`)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('El formato debe ser Excel o CSV.')
  })

  it('terminal-options: límite fuera de rango => 400 en español', async () => {
    const res = await request(server).get(`/venues/${VENUE}/settlement-reports/terminal-options?limit=500`)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('El límite máximo es 100.')
  })
})

describe('cableado en dashboard.routes.ts (router real)', () => {
  const rutas = ['count', 'terminal-options', 'export']
  it.each(rutas)('%s lleva authenticate → settlements:read → ADVANCED_REPORTS → validateRequest → controlador', ruta => {
    const layer = (dashboardRouter as any).stack.find((l: any) => l.route?.path === `/venues/:venueId/settlement-reports/${ruta}`)
    expect(layer).toBeDefined()
    const handles = layer.route.stack.map((s: any) => s.handle)
    expect(handles).toHaveLength(5)
    expect(handles[1].requiredPermission).toBe('settlements:read')
    expect(layer.route.methods.get).toBe(true)
  })
})
