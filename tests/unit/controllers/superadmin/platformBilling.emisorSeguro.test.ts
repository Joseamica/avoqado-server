/**
 * 🔒 Los cuatro endpoints del emisor de la PLATAFORMA (superadmin › Facturación › Configurar emisor) nunca responden la llave de
 * Facturapi de Avoqado.
 *
 * Important 1 de la revisión final de C1 (8-oct-2026): `upsertEmisor` (PUT /emisor), `provisionEmisor` (POST /emisor/provision) y
 * `uploadCsd` (POST /emisor/csd) respondían `data: <fila entera de PlatformEmisor>`, con `providerKeyEnc` (la llave viva, cifrada)
 * dentro. `provisionEmisor` la devolvía justo después de cifrarla. Sólo `getEmisor` la quitaba. Hermano del bloque «I1 —» de
 * `tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (el `FiscalEmisor` de cada negocio).
 */
jest.mock('@/services/superadmin/platform-billing/platformEmisor.service', () => {
  const actual = jest.requireActual('@/services/superadmin/platform-billing/platformEmisor.service')
  return {
    ...actual,
    getActivePlatformEmisor: jest.fn(),
    upsertPlatformEmisorLegal: jest.fn(),
    provisionPlatformEmisor: jest.fn(),
    setPlatformEmisorProviderManual: jest.fn(),
    uploadPlatformEmisorCsd: jest.fn(),
  }
})

import type { NextFunction, Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import * as emisorService from '@/services/superadmin/platform-billing/platformEmisor.service'
import { getEmisor, provisionEmisor, upsertEmisor, uploadCsd } from '@/controllers/superadmin/platformBilling.controller'

const LLAVE_CIFRADA = 'CIFRADO-LLAVE-VIVA-DE-AVOQADO'

// La fila tal como la devuelve Prisma (`update`/`create`/`findFirst` sin `select`): con la llave cifrada.
const filaEntera = {
  id: 'pe1',
  rfc: 'AVO2101019X1',
  legalName: 'Avoqado SA de CV',
  regimenFiscal: '601',
  lugarExpedicion: '06600',
  provider: 'FACTURAPI',
  providerOrgId: 'org_avoqado',
  providerKeyEnc: LLAVE_CIFRADA,
  csdStatus: 'ACTIVE',
  csdExpiresAt: new Date('2030-01-01T00:00:00Z'),
  csdLastCheckedAt: new Date('2026-10-01T00:00:00Z'),
  serie: 'A',
  defaultUsoCfdi: 'G03',
  isActive: true,
  createdById: 'staff-ops-1',
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-10-08T00:00:00Z'),
}

// Lo que el superadmin lee del emisor (medido en avoqado-superadmin `origin/main`, `src/features/billing/types.ts` y
// `EmisorSetupPage.tsx`: `providerOrgId` para «provisionado», `keyConfigured` para «llave guardada», `csdStatus`/`csdExpiresAt`).
const camposDelSuperadmin = [
  'id',
  'rfc',
  'legalName',
  'regimenFiscal',
  'lugarExpedicion',
  'provider',
  'providerOrgId',
  'keyConfigured',
  'csdStatus',
  'csdExpiresAt',
  'csdLastCheckedAt',
  'serie',
  'defaultUsoCfdi',
  'isActive',
  'createdAt',
  'updatedAt',
]

function mkRes() {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock }
}

function mkReq(body: Record<string, unknown> = {}): Request {
  return { params: {}, query: {}, body, authContext: { userId: 'staff-ops-1' } } as unknown as Request
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.activityLog.create as jest.Mock).mockResolvedValue({ id: 'log1' })
  ;(emisorService.getActivePlatformEmisor as jest.Mock).mockResolvedValue({ ...filaEntera })
  ;(emisorService.upsertPlatformEmisorLegal as jest.Mock).mockResolvedValue({ ...filaEntera })
  ;(emisorService.provisionPlatformEmisor as jest.Mock).mockResolvedValue({ ...filaEntera })
  ;(emisorService.setPlatformEmisorProviderManual as jest.Mock).mockResolvedValue({ ...filaEntera })
  ;(emisorService.uploadPlatformEmisorCsd as jest.Mock).mockResolvedValue({ ...filaEntera })
})

describe('superadmin › emisor de la plataforma: la respuesta nunca lleva la llave de Facturapi', () => {
  it.each([
    ['control — getEmisor (GET /emisor; ya la quitaba)', getEmisor, {}],
    [
      'upsertEmisor (PUT /emisor)',
      upsertEmisor,
      { rfc: 'AVO2101019X1', legalName: 'Avoqado SA de CV', regimenFiscal: '601', lugarExpedicion: '06600' },
    ],
    ['provisionEmisor (POST /emisor/provision, alta automática en Facturapi)', provisionEmisor, {}],
    [
      'provisionEmisor (POST /emisor/provision, llave pegada a mano)',
      provisionEmisor,
      { providerOrgId: 'org_avoqado', liveKey: 'sk_live_x' },
    ],
    ['uploadCsd (POST /emisor/csd)', uploadCsd, { cerBase64: 'Q0VS', keyBase64: 'S0VZ', csdPassword: 'secreto' }],
  ])('%s', async (_nombre, handler, body) => {
    const res = mkRes()
    const next = jest.fn() as unknown as NextFunction

    await handler(mkReq(body), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo.success).toBe(true)
    // Ausencia: ni la llave cifrada ni ningún otro campo `*Enc`, ni su valor en ninguna parte del cuerpo.
    expect(cuerpo.data).not.toHaveProperty('providerKeyEnc')
    expect(Object.keys(cuerpo.data).filter((campo: string) => /Enc$/.test(campo))).toEqual([])
    expect(JSON.stringify(cuerpo)).not.toContain(LLAVE_CIFRADA)
    expect(JSON.stringify(cuerpo)).not.toContain('sk_live_x')
    // Presencia: todo lo que el superadmin lee, con su valor.
    for (const campo of camposDelSuperadmin) expect(cuerpo.data).toHaveProperty(campo)
    expect(cuerpo.data.keyConfigured).toBe(true)
    expect(cuerpo.data.providerOrgId).toBe('org_avoqado')
    expect(cuerpo.data.csdStatus).toBe('ACTIVE')
    expect(cuerpo.data.csdExpiresAt).toEqual(filaEntera.csdExpiresAt)
  })

  it('los cuatro responden EXACTAMENTE la misma forma (no pueden divergir)', async () => {
    const cuerpos: unknown[] = []
    for (const [handler, body] of [
      [getEmisor, {}],
      [upsertEmisor, { rfc: 'AVO2101019X1' }],
      [provisionEmisor, {}],
      [uploadCsd, { cerBase64: 'Q0VS', keyBase64: 'S0VZ', csdPassword: 'secreto' }],
    ] as const) {
      const res = mkRes()
      await handler(mkReq(body), res, jest.fn() as unknown as NextFunction)
      cuerpos.push(res.json.mock.calls[0][0])
    }
    for (const cuerpo of cuerpos.slice(1)) expect(cuerpo).toEqual(cuerpos[0])
  })

  it('`keyConfigured: false` y sin llave cuando el emisor aún no la tiene (GET y PUT)', async () => {
    const sinLlave = { ...filaEntera, providerOrgId: null, providerKeyEnc: null }
    ;(emisorService.getActivePlatformEmisor as jest.Mock).mockResolvedValue(sinLlave)
    ;(emisorService.upsertPlatformEmisorLegal as jest.Mock).mockResolvedValue(sinLlave)
    for (const handler of [getEmisor, upsertEmisor]) {
      const res = mkRes()
      await handler(mkReq({ rfc: 'AVO2101019X1' }), res, jest.fn() as unknown as NextFunction)
      const { data } = res.json.mock.calls[0][0]
      expect(data.keyConfigured).toBe(false)
      expect(data).not.toHaveProperty('providerKeyEnc')
    }
  })

  it('control — la bitácora (ActivityLog) de conectar el emisor tampoco lleva la llave', async () => {
    const res = mkRes()
    await provisionEmisor(mkReq({ providerOrgId: 'org_avoqado', liveKey: 'sk_live_x' }), res, jest.fn() as unknown as NextFunction)
    const bitacora = JSON.stringify((prisma.activityLog.create as jest.Mock).mock.calls)
    expect(bitacora).not.toContain(LLAVE_CIFRADA)
    expect(bitacora).not.toContain('sk_live_x')
    expect(bitacora).not.toContain('providerKeyEnc')
  })
})
