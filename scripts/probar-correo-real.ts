/**
 * Manda UN correo REAL del resumen de retardo, para cerrar el único tramo que no se puede
 * probar con Resend apagado: que Resend lo acepte y llegue al buzón.
 *
 * 🔴 Sólo acepta un destinatario que se pasa a mano, y RECHAZA las direcciones sembradas de la
 * base local (`@owner.com`, `@admin.com`, `@manager.com`): son dominios reales que no son
 * nuestros — mandarles sería escribirle a desconocidos y rebotar, y los rebotes queman la
 * reputación del remitente (memoria `rebotes-de-correo-datos-semilla`).
 *
 *   RESEND_API_KEY=... npx ts-node --transpile-only -r tsconfig-paths/register \
 *     scripts/probar-correo-real.ts <correo-tuyo>
 */
import 'dotenv/config'
import { sendNotificationEmail } from '@/services/resend.service'

const DOMINIOS_PROHIBIDOS = ['owner.com', 'admin.com', 'manager.com', 'waiter.com', 'cashier.com']

async function main() {
  const destino = process.argv[2]
  if (!destino || !destino.includes('@')) {
    console.error('🔴 Falta el correo destino. Uso: scripts/probar-correo-real.ts <correo>')
    process.exit(1)
  }
  const dominio = destino.split('@')[1].toLowerCase()
  if (DOMINIOS_PROHIBIDOS.includes(dominio)) {
    console.error(`🔴 "${destino}" es una dirección SEMBRADA de la base local. No se manda: no es nuestra y rebota.`)
    process.exit(1)
  }
  if (!process.env.RESEND_API_KEY) {
    console.error('🔴 Sin RESEND_API_KEY no hay envío real. Este script existe justamente para eso.')
    process.exit(1)
  }

  // El mismo contenido que arma `mandarResumenPorCorreo` con 3 personas tarde.
  const personas = [
    { nombre: 'Ana Martínez', esperada: '09:00', minutosTarde: 40 },
    { nombre: 'Carlos Rodríguez', esperada: '09:00', minutosTarde: 40 },
    { nombre: 'María González', esperada: '09:00', minutosTarde: 38 },
  ]
  const titulo = `${personas.length} personas no han checado`
  const cuerpo = personas.map(p => `${p.nombre} — entraba a las ${p.esperada}, lleva ${p.minutosTarde} min`).join('\n')

  console.log(`📧 Mandando a ${destino}…`)
  const ok = await sendNotificationEmail(destino, titulo, titulo, cuerpo, undefined, 'Ver asistencia')
  console.log(ok ? '✅ Resend lo aceptó' : '❌ Resend NO lo aceptó (ver el log de arriba)')
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error('FALLÓ:', e)
  process.exit(1)
})
