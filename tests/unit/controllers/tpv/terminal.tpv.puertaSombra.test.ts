/**
 * D32 etapa 1 — la puerta pública GET /tpv/terminals/:serialNumber/config en MODO SOMBRA.
 *
 * El SERVIDOR anota en la línea «[Terminal Config] Successfully fetched config» si HABRÍA negado el pedido por no traer
 * la llave del aparato (X-TPV-Command-Token), sin negar nada: el código y el cuerpo de la respuesta son idénticos con y
 * sin llave, y la línea nunca lleva la llave ni su hash.
 * Promesa y diseño: docs/audit/2026-11-16-puerta-config-tpv/ (workspace).
 */
import type { NextFunction, Request, Response } from 'express'
import { createHash } from 'crypto'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'

jest.mock('@/lib/providerDeviceCompatibility', () => ({ isProviderCompatibleWithBrand: jest.fn().mockReturnValue(true) }))
jest.mock('@/services/superadmin/merchantAccount.service', () => ({ decryptCredentials: jest.fn() }))
jest.mock('@/services/superadmin/angelpayUserAccount.service', () => ({
  getAngelPayUserAccountForTerminal: jest.fn().mockResolvedValue(null),
  getAngelPayUserAccountsForTerminal: jest.fn().mockResolvedValue([]),
}))
jest.mock('@/services/organization-payment-config.service', () => ({ getEffectivePaymentConfig: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const LLAVE = 'c'.repeat(64)
const HASH = createHash('sha256').update(LLAVE).digest('hex')
const venueId = 'venue-d32'
const serialNumber = 'SN-PAX-D32'
const terminalBase = {
  id: 'term-d32',
  serialNumber,
  brand: 'PAX',
  model: 'A910S',
  status: 'ACTIVE',
  venueId,
  assignedMerchantIds: [],
  config: {},
  venue: { id: venueId, name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
}

function makeRes(): Response & { __status: number; __body: any } {
  const res: any = { __status: 0, __body: null }
  res.status = jest.fn((code: number) => ((res.__status = code), res))
  res.json = jest.fn((body: any) => ((res.__body = body), res))
  return res
}
const req = (headers?: Record<string, unknown>) => ({ params: { serialNumber }, ...(headers ? { headers } : {}) }) as unknown as Request

async function pedir(hash: string | null, headers?: Record<string, unknown>) {
  prismaMock.terminal.findFirst.mockResolvedValue({ ...terminalBase, commandTokenHash: hash })
  ;(logger.info as jest.Mock).mockClear()
  const res = makeRes()
  const next = jest.fn() as NextFunction
  await getTerminalConfig(req(headers), res, next)
  expect(next).not.toHaveBeenCalled()
  const linea = (logger.info as jest.Mock).mock.calls.find(([m]) => m === '[Terminal Config] Successfully fetched config')
  expect(linea).toBeDefined()
  return { res, campos: linea![1] }
}
// `accessObservedAt` es la hora de la consulta del plan: lo único que puede variar entre dos pedidos.
const sinHora = (b: any) => JSON.stringify({ ...b, data: { ...b.data, plan: b.data.plan && { ...b.data.plan, accessObservedAt: 'x' } } })

describe('D32 etapa 1 · /config en modo sombra', () => {
  beforeEach(() => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
  })

  it('la respuesta es idéntica con la llave, con otra llave y sin llave (200, mismo cuerpo)', async () => {
    const con = await pedir(HASH, { 'x-tpv-command-token': LLAVE })
    const otra = await pedir(HASH, { 'x-tpv-command-token': 'd'.repeat(64) })
    const sin = await pedir(HASH, {})
    const sinHeaders = await pedir(HASH) // pedidos armados sin `headers` (como las pruebas viejas) no truenan
    for (const r of [otra, sin, sinHeaders]) {
      expect(r.res.__status).toBe(con.res.__status)
      expect(sinHora(r.res.__body)).toBe(sinHora(con.res.__body))
    }
    expect(con.res.__status).toBe(200)
  })

  it('anota el veredicto, la versión y el procesador en la línea que ya existe', async () => {
    const { campos } = await pedir(HASH, {
      'x-tpv-command-token': LLAVE,
      'x-app-version-code': '131',
      'x-app-version-name': '2.20.0',
      'x-tpv-processor': 'BLUMON',
    })
    expect(campos).toMatchObject({
      serialNumber,
      puertaVeredicto: 'CON_LLAVE',
      puertaHabriaNegado: false,
      puertaLlaveSinAlta: false,
      appVersionCode: '131',
      appVersionName: '2.20.0',
      tpvProcessor: 'BLUMON',
      terminalBrand: 'PAX',
    })
  })

  it.each([
    ['otra llave', HASH, { 'x-tpv-command-token': 'd'.repeat(64) }, 'LLAVE_EQUIVOCADA', true, false],
    ['sin encabezado', HASH, {}, 'SIN_LLAVE', true, false],
    ['terminal sin alta', null, {}, 'SIN_ALTA', false, false],
    ['trae llave pero la terminal no tiene alta', null, { 'x-tpv-command-token': LLAVE }, 'SIN_ALTA', false, true],
  ])('%s → %s', async (_n, hash, headers, veredicto, habriaNegado, llaveSinAlta) => {
    const { res, campos } = await pedir(hash, headers)
    expect(res.__status).toBe(200)
    expect(campos).toMatchObject({ puertaVeredicto: veredicto, puertaHabriaNegado: habriaNegado, puertaLlaveSinAlta: llaveSinAlta })
  })

  it('nunca escribe la llave ni su hash en ningún log', async () => {
    await pedir(HASH, { 'x-tpv-command-token': LLAVE })
    const todo = JSON.stringify(
      ['info', 'warn', 'error', 'debug'].flatMap(n => ((logger as any)[n] as jest.Mock | undefined)?.mock?.calls ?? []),
    )
    expect(todo).not.toContain(LLAVE)
    expect(todo).not.toContain(HASH)
  })
})
