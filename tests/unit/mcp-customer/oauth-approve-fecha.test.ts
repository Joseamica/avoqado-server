/**
 * 🔴 Codex ronda 9, P1: la autorización del MCP nacía con la hora del INSERT del código. Si la
 * contraseña cambiaba entre verificar la identidad y crear el código, toda la cadena quedaba
 * «posterior» al corte y seguía viva. Aquí se fija, por la RUTA real, que las tres puertas
 * (contraseña, sesión del dashboard y selector de organización) entregan la hora de la verificación.
 */
const createAuthCode = jest.fn()
const authenticateForMcp = jest.fn()
const sesionDelDashboard = jest.fn()
const verificarTokenDelSelector = jest.fn()
const listActiveOrganizations = jest.fn()
const tokenParaElSelector = jest.fn()

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/mcp/oauth/tokenStore', () => ({ createAuthCode: (...a: unknown[]) => createAuthCode(...a) }))
jest.mock('../../../src/mcp/oauth/credentials', () => ({
  authenticateForMcp: (...a: unknown[]) => authenticateForMcp(...a),
  McpLoginError: class extends Error {},
}))
jest.mock('../../../src/mcp/oauth/session', () => ({
  staffIdFromDashboardSession: jest.fn(),
  sesionDelDashboard: (...a: unknown[]) => sesionDelDashboard(...a),
}))
jest.mock('../../../src/mcp/oauth/orgPick', () => ({
  verifyOrgPickToken: jest.fn(),
  verificarTokenDelSelector: (...a: unknown[]) => verificarTokenDelSelector(...a),
  listActiveOrganizations: (...a: unknown[]) => listActiveOrganizations(...a),
  tokenParaElSelector: (...a: unknown[]) => tokenParaElSelector(...a),
}))
jest.mock('../../../src/mcp/oauth/clientsStore', () => ({ prismaClientsStore: {} }))

import express from 'express'
import request from 'supertest'
import { MCP_ISSUER_URL } from '../../../src/mcp/oauth/config'
import { mountCustomerMcpAuth } from '../../../src/mcp/oauth/router'

const app = express()
mountCustomerMcpAuth(app)

const OAUTH = { client_id: 'c1', redirect_uri: 'http://cb', code_challenge: 'cc' }
const aprobar = (campos: Record<string, string>) =>
  request(app).post('/mcp-oauth/approve').set('Origin', MCP_ISSUER_URL.origin).type('form').send({ ...OAUTH, ...campos })

const verificadaAntes = new Date('2026-09-20T10:00:00Z')

beforeEach(() => {
  jest.clearAllMocks()
  createAuthCode.mockResolvedValue({ code: 'codigo' })
  listActiveOrganizations.mockResolvedValue([{ id: 'o1', name: 'Org', role: 'OWNER' }])
})

it('contraseña: el código nace con la hora de ANTES de comprobar la contraseña, no con la del insert', async () => {
  let comprobadaEn = 0
  authenticateForMcp.mockImplementation(async () => {
    comprobadaEn = Date.now()
    await new Promise(r => setTimeout(r, 20))
    return 's1'
  })
  await aprobar({ email: 'a@b.c', password: 'x' })
  const { grantedAt } = createAuthCode.mock.calls[0][0]
  expect(grantedAt).toBeInstanceOf(Date)
  expect(grantedAt.getTime()).toBeLessThanOrEqual(comprobadaEn)
})

it('sesión del dashboard: el código hereda la hora de ESA sesión', async () => {
  sesionDelDashboard.mockResolvedValue({ staffId: 's1', verificadoEn: verificadaAntes })
  await aprobar({ sso: '1' })
  expect(createAuthCode.mock.calls[0][0].grantedAt).toEqual(verificadaAntes)
})

it('selector de organización: el código hereda la hora que trae el selector', async () => {
  verificarTokenDelSelector.mockResolvedValue({ staffId: 's1', verificadoEn: verificadaAntes })
  await aprobar({ orgPickToken: 'tok', org: 'o1' })
  expect(createAuthCode.mock.calls[0][0].grantedAt).toEqual(verificadaAntes)
})

it('cuenta con varias organizaciones: el selector que se emite lleva la hora de la verificación', async () => {
  sesionDelDashboard.mockResolvedValue({ staffId: 's1', verificadoEn: verificadaAntes })
  listActiveOrganizations.mockResolvedValue([
    { id: 'o1', name: 'A', role: 'OWNER' },
    { id: 'o2', name: 'B', role: 'OWNER' },
  ])
  tokenParaElSelector.mockReturnValue('tok')
  await aprobar({ sso: '1' })
  expect(tokenParaElSelector).toHaveBeenCalledWith(undefined, 's1', verificadaAntes)
  expect(createAuthCode).not.toHaveBeenCalled()
})
