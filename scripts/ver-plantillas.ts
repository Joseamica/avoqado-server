/**
 * Genera a disco el HTML REAL de la plantilla del correo, para MIRARLA (la del recibo en pantalla se quitó: D21, 31-oct-2026).
 *
 * 🔴 Existe por la lección del 29-ago: mandé un correo con la plantilla legacy morada porque
 * reusé la función de la casa sin ver nunca lo que producía. Comprobar la tubería no es
 * comprobar el resultado.
 *
 * El correo se captura interceptando `fetch` — así se obtiene el HTML EXACTO que saldría, sin
 * mandar nada a nadie.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/ver-plantillas.ts
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'

const SALIDA = '/tmp/plantillas-avoqado'

async function correo(): Promise<void> {
  // Una llave falsa basta: `new Resend(...)` no valida, y el envío nunca sale porque
  // interceptamos `fetch` antes.
  process.env.RESEND_API_KEY = 're_falsa_solo_para_render'

  let capturado: string | null = null
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    try {
      const cuerpo = JSON.parse(init?.body ?? '{}')
      if (cuerpo.html) capturado = cuerpo.html
    } catch {
      /* no era JSON */
    }
    // Se corta aquí: NADA sale a la red.
    return new Response(JSON.stringify({ id: 'render-local' }), { status: 200 })
  }) as any

  const { sendNotificationEmail } = await import('@/services/resend.service')
  await sendNotificationEmail(
    'ejemplo@avoqado.io',
    '3 personas no han checado',
    '3 personas no han checado',
    'Ana Martínez — entraba a las 09:00, lleva 40 min\nCarlos Rodríguez — entraba a las 09:00, lleva 40 min\nMaría González — entraba a las 09:00, lleva 38 min',
    'https://dashboard.avoqado.io/venues/demo/asistencia',
    'Ver asistencia',
  )
  globalThis.fetch = fetchOriginal

  if (!capturado) throw new Error('no se capturó el HTML del correo')
  fs.writeFileSync(path.join(SALIDA, 'correo-aviso-retardo.html'), capturado)
  console.log('✅ correo    → ' + path.join(SALIDA, 'correo-aviso-retardo.html'))
}

async function main() {
  fs.mkdirSync(SALIDA, { recursive: true })
  await correo()
  process.exit(0)
}

main().catch(e => {
  console.error('FALLÓ:', e)
  process.exit(1)
})
