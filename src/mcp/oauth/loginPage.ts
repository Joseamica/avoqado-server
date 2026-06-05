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

const oauthHidden = (p: LoginPageParams) =>
  hidden('client_id', p.clientId) +
  hidden('redirect_uri', p.redirectUri) +
  hidden('code_challenge', p.codeChallenge) +
  hidden('state', p.state) +
  hidden('scope', p.scope) +
  hidden('resource', p.resource)

// Avoqado-dashboard look: light card, blue primary, rounded. Self-contained (no external assets).
const STYLE = `
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f1f5f9;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem}
  .card{background:#fff;padding:2rem;border-radius:18px;width:min(94vw,400px);box-shadow:0 12px 40px rgba(15,23,42,.10);border:1px solid #e2e8f0}
  .brand{display:flex;align-items:center;gap:.55rem;margin-bottom:1.25rem}
  .brand .dot{width:1.7rem;height:1.7rem;border-radius:9px;background:#2563eb;display:grid;place-items:center;color:#fff;font-weight:700;font-size:1rem}
  .brand b{font-weight:700;font-size:1.05rem;color:#0f172a}
  h1{font-size:1.2rem;margin:0 0 .35rem;font-weight:700}
  p.sub{color:#64748b;font-size:.9rem;margin:0 0 1.25rem;line-height:1.45}
  p.sub strong{color:#0f172a}
  label{display:block;font-size:.8rem;font-weight:500;color:#334155;margin:.85rem 0 .3rem}
  input[type=email],input[type=password]{width:100%;padding:.65rem .75rem;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;font-size:.95rem;outline:none;transition:border .15s,box-shadow .15s}
  input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  button{margin-top:1.4rem;width:100%;padding:.75rem;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:600;font-size:.95rem;cursor:pointer;transition:background .15s}
  button:hover{background:#1d4ed8}
  .err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:.6rem .75rem;border-radius:10px;font-size:.85rem;margin-bottom:.25rem}
  .who{display:flex;align-items:center;gap:.65rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:.7rem .85rem;margin:.25rem 0}
  .who .av{width:2.1rem;height:2.1rem;border-radius:999px;background:#dbeafe;color:#1d4ed8;display:grid;place-items:center;font-weight:700;flex:0 0 auto}
  .who .em{font-size:.9rem;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .note{margin-top:1rem;font-size:.78rem;color:#64748b;line-height:1.45}
  .alt{display:block;text-align:center;margin-top:.9rem;font-size:.8rem;color:#2563eb;text-decoration:none}
  .alt:hover{text-decoration:underline}
`

/**
 * Self-contained consent page (decision D3), Avoqado-dashboard look. Two modes:
 *  - password (default): email + password.
 *  - session (SSO): "Conectar como <email>" with a single button (no password), shown when the
 *    visitor already has an active dashboard session in this browser. `switchAccountUrl` links
 *    back to the password form.
 */
export function renderLoginPage(
  p: LoginPageParams,
  opts: { error?: string; session?: { email: string }; switchAccountUrl?: string } = {},
): string {
  const app = p.clientName ? escapeHtml(p.clientName) : 'Una aplicación'
  const banner = opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''
  const brand = `<div class="brand"><span class="dot">A</span><b>Avoqado</b></div>`
  const note = `<p class="note">Acceso de solo lectura, limitado a tu rol y tus locales. Puedes desconectarlo cuando quieras.</p>`
  const intro = `<p class="sub"><strong>${app}</strong> quiere acceder a los datos de tus locales en tu nombre.</p>`

  const body = opts.session
    ? `
  <h1>Conectar a Avoqado</h1>
  ${intro}
  ${banner}
  <div class="who"><span class="av">${escapeHtml((opts.session.email[0] || 'A').toUpperCase())}</span><span class="em">${escapeHtml(opts.session.email)}</span></div>
  <input type="hidden" name="sso" value="1">
  ${oauthHidden(p)}
  <button type="submit">Conectar como ${escapeHtml(opts.session.email)}</button>
  ${opts.switchAccountUrl ? `<a class="alt" href="${escapeHtml(opts.switchAccountUrl)}">Usar otra cuenta</a>` : ''}
  ${note}`
    : `
  <h1>Conecta tu IA a Avoqado</h1>
  ${intro}
  ${banner}
  <label>Correo</label><input type="email" name="email" autocomplete="username" required autofocus>
  <label>Contraseña</label><input type="password" name="password" autocomplete="current-password" required>
  ${oauthHidden(p)}
  <button type="submit">Autorizar acceso</button>
  ${note}`

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar a Avoqado</title>
<style>${STYLE}</style></head>
<body><form class="card" method="post" action="/mcp-oauth/approve">
  ${brand}${body}
</form></body></html>`
}
