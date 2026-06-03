import express, { type Request, type Response, type Express } from 'express'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { authenticateForMcp, McpLoginError } from './credentials'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'
import { createAuthCode } from './tokenStore'
import { renderLoginPage } from './loginPage'
import { provider } from './provider'
import { MCP_ISSUER_URL, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'

/** POST /mcp-oauth/approve — consent form target. Mirror of the /authorize params + email/password. */
function approveHandler() {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))
  router.post('/mcp-oauth/approve', async (req: Request, res: Response) => {
    const { email, password, client_id, redirect_uri, code_challenge, state, scope, resource } = req.body ?? {}
    const reRender = (error: string) =>
      res
        .status(401)
        .send(renderLoginPage({ clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge, state, scope, resource }, { error }))

    if (!client_id || !redirect_uri || !code_challenge) return res.status(400).send('Missing OAuth parameters')

    let staffId: string
    try {
      staffId = await authenticateForMcp(String(email ?? ''), String(password ?? ''))
    } catch (e) {
      return reRender(e instanceof McpLoginError ? e.message : 'Login failed')
    }

    let activeOrg: string
    try {
      activeOrg = await getPrimaryOrganizationId(staffId)
    } catch {
      return reRender('Your account has no active organization.')
    }

    const scopes = scope ? String(scope).split(' ').filter(Boolean) : []
    const { code } = await createAuthCode({
      clientId: client_id,
      staffId,
      activeOrg,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      scopes,
      resource: resource || undefined,
    })

    const target = new URL(redirect_uri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', String(state))
    return res.redirect(302, target.href)
  })
  return router
}

/** Mount the full customer-MCP OAuth surface at the app root. Call ONCE in app.ts. */
export function mountCustomerMcpAuth(app: Express): void {
  // SDK: /authorize, /token, /register (DCR), /revoke, and .well-known metadata.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: MCP_ISSUER_URL,
      scopesSupported: MCP_SCOPES_SUPPORTED,
      resourceName: 'Avoqado',
      resourceServerUrl: MCP_RESOURCE_URL,
    }),
  )
  // Our consent-form target.
  app.use(approveHandler())
}
