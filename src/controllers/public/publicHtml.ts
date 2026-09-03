/**
 * Shared HTML shell for public, login-free customer-facing pages (one-click
 * unsubscribe, birthdate capture, and any future no-auth token page).
 *
 * Extracted verbatim from `unsubscribe.public.controller.ts` — CERO cambio de
 * comportamiento. Any page rendered by these two functions must never leak
 * customer data before an action is confirmed (see callers).
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Avoqado</title>
<style>
  body { margin:0; background:#ffffff; color:#000000; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:480px; margin:0 auto; padding:48px 24px; text-align:center; }
  img.logo { width:40px; height:40px; margin-bottom:24px; }
  h1 { font-size:20px; font-weight:700; margin:0 0 12px; }
  p { font-size:15px; line-height:1.5; color:#333; margin:0 0 20px; }
  .email { font-weight:600; color:#000; }
  button { background:#000; color:#fff; border:none; border-radius:6px; padding:14px 28px; font-size:15px; font-weight:600; cursor:pointer; }
  .muted { font-size:13px; color:#666; margin-top:28px; }
  a { color:#000; }
</style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="https://avoqado.io/isotipo.svg" alt="Avoqado">
    ${bodyHtml}
    <p class="muted">Avoqado · Servicios Tecnologicos Avo S.A. de C.V.</p>
  </div>
</body>
</html>`
}
