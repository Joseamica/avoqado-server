import express, { type Request, type Response, type Express, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { authenticateForMcp, McpLoginError } from './credentials'
import { resolveActiveOrganizationId } from '@/services/staffOrganization.service'
import { createAuthCode } from './tokenStore'
import { renderLoginPage } from './loginPage'
import { provider } from './provider'
import { prismaClientsStore } from './clientsStore'
import { MCP_ISSUER_URL, MCP_RESOURCE_URL, MCP_SCOPES_SUPPORTED } from './config'
import { staffIdFromDashboardSession } from './session'
import { issueOrgPickToken, verifyOrgPickToken, listActiveOrganizations } from './orgPick'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * GET /authorize SSO pre-route. Mounted BEFORE the SDK's mcpAuthRouter: if the visitor already has
 * an active dashboard session (and the client + redirect are valid), render the one-click
 * "Connect as X" page. Otherwise next() → the SDK renders the email/password page.
 */
function ssoAuthorizeHandler() {
  const router = express.Router()
  router.use(cookieParser())
  router.get('/authorize', async (req: Request, res: Response, next: NextFunction) => {
    if (req.query.prompt === 'login') return next() // user picked "use another account"
    const staffId = staffIdFromDashboardSession(req)
    if (!staffId) return next()

    const clientId = req.query.client_id ? String(req.query.client_id) : ''
    const redirectUri = req.query.redirect_uri ? String(req.query.redirect_uri) : ''
    const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : ''
    if (!clientId || !redirectUri || !codeChallenge) return next() // let the SDK validate/reject

    const client = await prismaClientsStore.getClient(clientId)
    if (!client || !(client.redirect_uris ?? []).includes(redirectUri)) return next() // unknown client / redirect

    const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { email: true } })
    if (!staff) return next()

    const scope = req.query.scope ? String(req.query.scope) : undefined
    const state = req.query.state ? String(req.query.state) : undefined
    const resource = req.query.resource ? String(req.query.resource) : undefined

    // "Use another account" → same authorize URL, but force the password page.
    const switchAccountUrl =
      '/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(scope ? { scope } : {}),
        ...(state ? { state } : {}),
        ...(resource ? { resource } : {}),
        prompt: 'login',
      }).toString()

    logger.info(`[MCP OAuth] SSO consent shown for ${staff.email}`, { mcpOAuth: true, staffId, clientId })
    res.setHeader('Cache-Control', 'no-store')
    return res
      .status(200)
      .send(
        renderLoginPage(
          { clientId, clientName: client.client_name, redirectUri, codeChallenge, state, scope, resource },
          { session: { email: staff.email }, switchAccountUrl },
        ),
      )
  })
  return router
}

/** POST /mcp-oauth/approve — consent form target. Mirrors the /authorize params; email/password OR sso. */
function approveHandler() {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))
  router.use(cookieParser()) // read the session cookie for the SSO path
  // Step-2 consent: GET org picker (multi-org accounts land here after authenticating).
  router.get('/mcp-oauth/pick-org', async (req: Request, res: Response) => {
    const q = (k: string) => (req.query[k] ? String(req.query[k]) : undefined)
    const token = q('token')
    const clientId = q('client_id') ?? ''
    const redirectUri = q('redirect_uri') ?? ''
    const backToLogin = () =>
      res.redirect(
        302,
        '/authorize?' +
          new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: q('code_challenge') ?? '',
            code_challenge_method: 'S256',
            ...(q('scope') ? { scope: q('scope')! } : {}),
            ...(q('state') ? { state: q('state')! } : {}),
            ...(q('resource') ? { resource: q('resource')! } : {}),
            prompt: 'login',
          }).toString(),
      )

    const staffId = token ? verifyOrgPickToken(token) : null
    if (!staffId) return backToLogin() // expired/tampered → re-authenticate
    const client = await prismaClientsStore.getClient(clientId)
    if (!client || !(client.redirect_uris ?? []).includes(redirectUri)) return backToLogin()
    const orgs = await listActiveOrganizations(staffId)
    if (orgs.length < 2) return backToLogin() // nothing to pick — normal flow handles it

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(
      renderLoginPage(
        {
          clientId,
          clientName: client.client_name,
          redirectUri,
          codeChallenge: q('code_challenge') ?? '',
          state: q('state'),
          scope: q('scope'),
          resource: q('resource'),
        },
        { orgPick: { orgs, token: token! } },
      ),
    )
  })

  router.post('/mcp-oauth/approve', async (req: Request, res: Response) => {
    const { email, password, client_id, redirect_uri, code_challenge, state, scope, resource, sso, org, orgPickToken } = req.body ?? {}
    // The login page submits via fetch so it works inside sandboxed iframes that block native form
    // posts (no 'allow-forms'). Fetch requests get JSON {redirect}/{error}; native posts get 302/HTML.
    const isFetch = req.get('X-Mcp-Submit') === 'fetch'
    const reRender = (error: string) =>
      isFetch
        ? res.status(401).json({ error })
        : res
            .status(401)
            .send(
              renderLoginPage(
                { clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge, state, scope, resource },
                { error },
              ),
            )

    if (!client_id || !redirect_uri || !code_challenge) {
      return isFetch ? res.status(400).json({ error: 'Missing OAuth parameters' }) : res.status(400).send('Missing OAuth parameters')
    }

    let staffId: string
    if (typeof orgPickToken === 'string' && orgPickToken) {
      // Step-2 (org picker) submit: identity carried by the short-lived signed token, never re-typed credentials.
      const sid = verifyOrgPickToken(orgPickToken)
      if (!sid) {
        logger.warn('[MCP OAuth] org-pick token invalid/expired', { mcpOAuth: true, clientId: String(client_id) })
        return reRender('La selección de organización expiró. Vuelve a iniciar sesión.')
      }
      staffId = sid
    } else if (sso === '1') {
      // One-click connect: trust ONLY a freshly re-verified session cookie, never the form flag alone.
      const sid = staffIdFromDashboardSession(req)
      if (!sid) {
        logger.warn('[MCP OAuth] SSO approve without a valid session cookie', { mcpOAuth: true, clientId: String(client_id) })
        return reRender('Tu sesión expiró. Inicia sesión con tu correo y contraseña.')
      }
      staffId = sid
    } else {
      try {
        staffId = await authenticateForMcp(String(email ?? ''), String(password ?? ''))
      } catch (e) {
        const reason = e instanceof McpLoginError ? e.message : 'Login failed'
        logger.warn(`[MCP OAuth] login failed for "${email}": ${reason}`, { mcpOAuth: true, email: String(email ?? ''), reason })
        if (!(e instanceof McpLoginError)) logger.error('[MCP OAuth] unexpected login error', { error: (e as Error).message })
        return reRender(reason)
      }
    }

    let activeOrg: string
    if (typeof orgPickToken === 'string' && orgPickToken && typeof org === 'string' && org) {
      // Step-2: validate the chosen org against the staff's REAL active memberships (server-side).
      const orgs = await listActiveOrganizations(staffId)
      const chosen = orgs.find(o => o.id === org)
      if (!chosen) {
        logger.warn('[MCP OAuth] org pick rejected — not a membership', { mcpOAuth: true, staffId, org: String(org) })
        return reRender('Esa organización no pertenece a tu cuenta.')
      }
      activeOrg = chosen.id
    } else {
      const orgs = await listActiveOrganizations(staffId)
      if (orgs.length > 1) {
        // Multi-org account → second consent step: pick which org this connection binds to.
        const pickUrl =
          '/mcp-oauth/pick-org?' +
          new URLSearchParams({
            token: issueOrgPickToken(staffId),
            client_id: String(client_id),
            redirect_uri: String(redirect_uri),
            code_challenge: String(code_challenge),
            ...(scope ? { scope: String(scope) } : {}),
            ...(state ? { state: String(state) } : {}),
            ...(resource ? { resource: String(resource) } : {}),
          }).toString()
        logger.info(`[MCP OAuth] multi-org staff ${staffId} → org picker (${orgs.length} orgs)`, { mcpOAuth: true, staffId })
        // self:true → the page script navigates the iframe itself (not window.top) to the picker.
        return isFetch ? res.json({ redirect: pickUrl, self: true }) : res.redirect(302, pickUrl)
      }
      if (orgs.length === 1) {
        activeOrg = orgs[0].id
      } else {
        try {
          activeOrg = await resolveActiveOrganizationId(staffId) // venue-level fallback (e.g. Mindform owner)
        } catch (e) {
          logger.warn(`[MCP OAuth] no active organization for staff ${staffId}`, { mcpOAuth: true, staffId, error: (e as Error).message })
          return reRender('Tu cuenta no tiene una organización ni local activo.')
        }
      }
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

    logger.info(`[MCP OAuth] authorized staff ${staffId} for org ${activeOrg}${sso === '1' ? ' (SSO)' : ''}`, {
      mcpOAuth: true,
      staffId,
      activeOrg,
      clientId: String(client_id),
      sso: sso === '1',
    })

    const target = new URL(redirect_uri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', String(state))
    return isFetch ? res.json({ redirect: target.href }) : res.redirect(302, target.href)
  })
  return router
}

/** Mount the full customer-MCP OAuth surface at the app root. Call ONCE in app.ts. */
export function mountCustomerMcpAuth(app: Express): void {
  // One-click connect when a dashboard session already exists (MUST run before the SDK's /authorize).
  app.use(ssoAuthorizeHandler())
  // SDK: /authorize (password page via provider.authorize), /token, /register (DCR), /revoke, metadata.
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
