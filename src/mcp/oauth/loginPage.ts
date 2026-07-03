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
  .card{background:#fff;padding:2rem;border-radius:18px;width:min(94vw,400px);box-shadow:0 12px 40px rgba(15,23,42,.10);border:1px solid #e2e8f0;position:relative;z-index:1}
  .brand{display:flex;align-items:center;gap:.55rem;margin-bottom:1.25rem}
  .brand .dot{width:2rem;height:2rem;display:grid;place-items:center}
  .brand .dot svg{width:100%;height:100%;display:block}
  .brand b{font-weight:700;font-size:1.05rem;color:#0f172a}
  h1{font-size:1.2rem;margin:0 0 .35rem;font-weight:700}
  p.sub{color:#64748b;font-size:.9rem;margin:0 0 1.25rem;line-height:1.45}
  p.sub strong{color:#0f172a}
  label{display:block;font-size:.8rem;font-weight:500;color:#334155;margin:.85rem 0 .3rem}
  input[type=email],input[type=password]{width:100%;padding:.65rem .75rem;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;font-size:.95rem;outline:none;transition:border .15s,box-shadow .15s}
  input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  button{margin-top:1.4rem;width:100%;padding:.75rem;border:0;border-radius:10px;background:#0f172a;color:#fff;font-weight:600;font-size:.95rem;cursor:pointer;transition:background .15s}
  button:hover{background:#1e293b}
  .err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:.6rem .75rem;border-radius:10px;font-size:.85rem;margin-bottom:.25rem}
  .who{display:flex;align-items:center;gap:.65rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:.7rem .85rem;margin:.25rem 0}
  .who .av{width:2.1rem;height:2.1rem;border-radius:999px;background:#dbeafe;color:#1d4ed8;display:grid;place-items:center;font-weight:700;flex:0 0 auto}
  .who .em{font-size:.9rem;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .note{margin-top:1rem;font-size:.78rem;color:#64748b;line-height:1.45}
  .alt{display:block;text-align:center;margin-top:.9rem;font-size:.8rem;color:#2563eb;text-decoration:none}
  .alt:hover{text-decoration:underline}
  .org{display:flex;align-items:center;gap:.6rem;border:1px solid #e2e8f0;border-radius:12px;padding:.7rem .85rem;margin:.45rem 0;cursor:pointer;transition:border .15s}
  .org:hover{border-color:#2563eb}
  .org input{accent-color:#2563eb;flex:0 0 auto}
  .org .nm{font-size:.92rem;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .org .rl{margin-left:auto;font-size:.7rem;color:#64748b;background:#f1f5f9;border-radius:999px;padding:.15rem .5rem;flex:0 0 auto}
  .sparkles{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
  .sparkles span{position:absolute;display:block;opacity:.35;filter:drop-shadow(0 0 6px rgba(37,99,235,.55));animation:mcp-twinkle 3s ease-in-out infinite}
  @keyframes mcp-twinkle{0%,100%{opacity:.35;transform:scale(.6) rotate(-15deg)}50%{opacity:1;transform:scale(1.15) rotate(12deg)}}
  @media (prefers-reduced-motion: reduce){.sparkles span{animation:none;opacity:.65}}
`

// Twinkling "chispitas" scattered across the page (mirrors the Home banner's CornerSparkles), CSS-only.
const SPARKLE_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%"><path d="M12 2 L13.6 10.4 L22 12 L13.6 13.6 L12 22 L10.4 13.6 L2 12 L10.4 10.4 Z"/></svg>'
const SPARKLE_SPECS: Array<{ pos: string; size: number; delay: number; color: string }> = [
  { pos: 'top:7%;left:11%', size: 34, delay: 0, color: '#3b82f6' },
  { pos: 'top:21%;left:6%', size: 22, delay: 0.8, color: '#a78bfa' },
  { pos: 'top:6%;left:47%', size: 24, delay: 1.4, color: '#2563eb' },
  { pos: 'top:13%;right:13%', size: 32, delay: 0.5, color: '#3b82f6' },
  { pos: 'top:30%;right:8%', size: 20, delay: 1.9, color: '#a78bfa' },
  { pos: 'top:45%;left:8%', size: 28, delay: 1.1, color: '#60a5fa' },
  { pos: 'top:62%;left:14%', size: 20, delay: 2.3, color: '#3b82f6' },
  { pos: 'top:48%;right:10%', size: 30, delay: 0.3, color: '#2563eb' },
  { pos: 'top:66%;right:7%', size: 22, delay: 1.6, color: '#a78bfa' },
  { pos: 'bottom:11%;left:19%', size: 32, delay: 0.9, color: '#60a5fa' },
  { pos: 'bottom:9%;right:21%', size: 24, delay: 2.0, color: '#3b82f6' },
  { pos: 'bottom:22%;left:49%', size: 20, delay: 1.3, color: '#a78bfa' },
  { pos: 'top:38%;left:30%', size: 18, delay: 2.5, color: '#2563eb' },
  { pos: 'bottom:30%;right:30%', size: 18, delay: 0.6, color: '#60a5fa' },
]
const SPARKLES = `<div class="sparkles" aria-hidden="true">${SPARKLE_SPECS.map(
  s => `<span style="${s.pos};width:${s.size}px;height:${s.size}px;color:${s.color};animation-delay:${s.delay}s">${SPARKLE_SVG}</span>`,
).join('')}</div>`

/**
 * Self-contained consent page (decision D3), Avoqado-dashboard look. Two modes:
 *  - password (default): email + password.
 *  - session (SSO): "Conectar como <email>" with a single button (no password), shown when the
 *    visitor already has an active dashboard session in this browser. `switchAccountUrl` links
 *    back to the password form.
 */
export function renderLoginPage(
  p: LoginPageParams,
  opts: {
    error?: string
    session?: { email: string }
    switchAccountUrl?: string
    /** Step-2 consent: the staff belongs to several orgs — pick which ONE this connection binds to. */
    orgPick?: { orgs: Array<{ id: string; name: string; role: string }>; token: string }
  } = {},
): string {
  const app = p.clientName ? escapeHtml(p.clientName) : 'Una aplicación'
  const banner = `<p class="err" id="mcp-err"${opts.error ? '' : ' style="display:none"'}>${opts.error ? escapeHtml(opts.error) : ''}</p>`
  const brand = `<div class="brand"><span class="dot"><svg viewBox="0 0 113 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><image width="113" height="128" href="data:image/png;base64,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"/></svg></span><b>Avoqado</b></div>`
  const note = `<p class="note">Esta conexión puede <strong>leer y realizar acciones</strong> sobre los datos de tu organización — ver reportes, clientes y pagos, y ejecutar acciones como registrar pagos, reembolsos o invitar staff — <strong>limitada a tu rol y tus locales</strong>. Las acciones de alto impacto piden confirmación. Puedes desconectarla cuando quieras.</p>`
  const intro = `<p class="sub"><strong>${app}</strong> quiere acceder a los datos de tus locales en tu nombre.</p>`

  const body = opts.orgPick
    ? `
  <h1>Elige la organización</h1>
  <p class="sub">Tu cuenta pertenece a varias organizaciones. <strong>${app}</strong> quedará conectado a <strong>una</strong> — elige cuál:</p>
  ${banner}
  ${opts.orgPick.orgs
    .map(
      (o, i) =>
        `<label class="org"><input type="radio" name="org" value="${escapeHtml(o.id)}"${i === 0 ? ' checked' : ''}><span class="nm">${escapeHtml(o.name)}</span><span class="rl">${escapeHtml(o.role.toLowerCase())}</span></label>`,
    )
    .join('')}
  ${hidden('orgPickToken', opts.orgPick.token)}
  ${oauthHidden(p)}
  <button type="submit">Conectar</button>
  <p class="note">Para usar otra organización después, desconecta el conector y vuelve a conectarlo.</p>`
    : opts.session
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
<body>${SPARKLES}<form class="card" method="post" action="/mcp-oauth/approve">
  ${brand}${body}
</form>
<script>
(function(){var form=document.querySelector('form');if(!form)return;var errBox=document.getElementById('mcp-err');function showError(m){if(errBox){errBox.textContent=m;errBox.style.display='block';}}function navigate(u,self){if(!self){try{if(window.top&&window.top!==window){window.top.location.href=u;return;}}catch(e){}}window.location.href=u;}form.addEventListener('submit',function(e){e.preventDefault();var btn=form.querySelector('button[type=submit]');if(btn)btn.disabled=true;fetch('/mcp-oauth/approve',{method:'POST',headers:{'X-Mcp-Submit':'fetch'},body:new URLSearchParams(new FormData(form))}).then(function(r){return r.json();}).then(function(d){if(d&&d.redirect){navigate(d.redirect,d.self===true);return;}showError((d&&d.error)||'No se pudo conectar. Intenta de nuevo.');if(btn)btn.disabled=false;}).catch(function(){showError('No se pudo conectar. Intenta de nuevo.');if(btn)btn.disabled=false;});});})();
</script>
</body></html>`
}
