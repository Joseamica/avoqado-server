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
  const brand = `<div class="brand"><span class="dot"><svg viewBox="0 0 732.5 893.3" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#69E185" d="M712.7,486.2c-3.3-83.5-37.8-157.2-99.8-213.1c-27.9-28.7-63.2-57.2-104.9-84.8c16-81.7,12.9-116.7-31.4-155.5l-2.4-2.1l-3.1-0.9c-33-9.4-58.6-7.7-78.1,5.1c-29.8,19.5-39.9,60.9-45.2,117.3c-131.6,12.1-242.1,95.5-296.3,224.2c-56.5,134-37,280.8,49.8,374.1c3.4,3.5,10.3,10.6,157,98l1.1,0.7l1.2,0.5c36,13.2,72.6,19.8,108.8,19.8c39.2,0,78.1-7.7,115.4-23.2c63.9-26.5,121.9-75.8,163.3-138.7C692.8,639.9,715.7,561.3,712.7,486.2z M580.3,507.4c-0.3,58-40.2,116.3-118.7,173.3C374.3,744.2,279.3,710,228,651.3c-43.8-50-65.3-119.8-56.1-182c4.8-32.5,20.5-77.7,68-108.3c64.6-41.7,110-56.7,144.4-56.7c45.6,0,71.8,26.4,97.4,52.4c10.4,10.5,20.2,20.4,31.3,28.6C545.7,409.4,580.5,454.2,580.3,507.4z"/><path fill="#C9712F" d="M362.2,412c-26.8,0-53.6,17.9-75.5,50.5c-18.4,27.3-30.3,61.1-30.3,86c0,49.5,47.4,89.7,105.7,89.7S468,598,468,548.5c0-24.9-11.9-58.7-30.3-86C415.8,430,389,412,362.2,412z"/></svg></span><b>Avoqado</b></div>`
  const note = `<p class="note">Acceso de solo lectura, limitado a tu rol y tus locales. Puedes desconectarlo cuando quieras.</p>`
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
