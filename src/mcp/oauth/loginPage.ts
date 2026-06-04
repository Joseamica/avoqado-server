export interface LoginPageParams {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scope?: string
  resource?: string
  clientName?: string
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const hidden = (name: string, value?: string) =>
  value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`

/** Self-contained consent page (decision D3). No external assets. */
export function renderLoginPage(p: LoginPageParams, opts: { error?: string } = {}): string {
  const app = p.clientName ? escapeHtml(p.clientName) : 'An application'
  const banner = opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Avoqado</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{background:#1e293b;padding:2rem;border-radius:14px;width:min(92vw,380px);box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:1.15rem;margin:0 0 .25rem} p.sub{color:#94a3b8;font-size:.9rem;margin:0 0 1.25rem}
  label{display:block;font-size:.8rem;color:#cbd5e1;margin:.75rem 0 .25rem}
  input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff}
  button{margin-top:1.25rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#10b981;color:#04231a;font-weight:600;cursor:pointer}
  .err{background:#7f1d1d;color:#fecaca;padding:.5rem .7rem;border-radius:8px;font-size:.85rem}
  .scope{margin-top:1rem;font-size:.78rem;color:#94a3b8}
</style></head>
<body><form class="card" method="post" action="/mcp-oauth/approve">
  <h1>Connect to Avoqado</h1>
  <p class="sub"><strong>${app}</strong> wants to read your venues' data on your behalf.</p>
  ${banner}
  <label>Email</label><input type="email" name="email" autocomplete="username" required autofocus>
  <label>Password</label><input type="password" name="password" autocomplete="current-password" required>
  ${hidden('client_id', p.clientId)}
  ${hidden('redirect_uri', p.redirectUri)}
  ${hidden('code_challenge', p.codeChallenge)}
  ${hidden('state', p.state)}
  ${hidden('scope', p.scope)}
  ${hidden('resource', p.resource)}
  <button type="submit">Authorize access</button>
  <p class="scope">Grants read-only access scoped to your role. You can disconnect anytime.</p>
</form></body></html>`
}
