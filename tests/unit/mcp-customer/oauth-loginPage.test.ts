import { renderLoginPage, escapeHtml } from '../../../src/mcp/oauth/loginPage'

it('escapes every interpolated value to prevent XSS via oauth params', () => {
  expect(escapeHtml(`"><script>alert(1)</script>`)).not.toContain('<script>')
})

it('embeds the oauth params as hidden fields and posts to the approve route', () => {
  const html = renderLoginPage({
    clientId: 'c1',
    redirectUri: 'https://claude.ai/cb',
    codeChallenge: 'cc',
    state: 's"x',
    scope: 'mcp:read',
    resource: 'https://api.avoqado.io/mcp',
    clientName: 'Claude',
  })
  expect(html).toContain('action="/mcp-oauth/approve"')
  expect(html).toContain('name="client_id" value="c1"')
  expect(html).toContain('name="code_challenge" value="cc"')
  expect(html).toContain('s&quot;x') // state escaped
  expect(html).not.toContain('s"x')
})

it('shows an error banner when provided', () => {
  expect(renderLoginPage({ clientId: 'c1', redirectUri: 'x', codeChallenge: 'cc' }, { error: 'Bad password' })).toContain('Bad password')
})

it('identifica el catálogo de publicación antes del consentimiento', () => {
  const { MCP_DIRECTORY_RESOURCE_URL } = require('@/mcp/oauth/config')
  const html = renderLoginPage({
    clientId: 'c',
    redirectUri: 'http://cb',
    codeChallenge: 'challenge',
    resource: MCP_DIRECTORY_RESOURCE_URL.href,
  })
  expect(html).toContain('Catálogo de publicación')
  expect(html).toContain('No incluye cobros, reembolsos ni nómina')
})
