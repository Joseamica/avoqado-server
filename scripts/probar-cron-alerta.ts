/**
 * ¿El cron dispara SOLO?
 *
 * Arranca ÚNICAMENTE el job de la alerta —no los 52 del servidor— y espera a que su propia
 * programación lo invoque. Comprueba lo que un disparo manual no puede: que `scheduleJob`, la
 * expresión cron y el `start()` estén bien cableados.
 *
 * 🔴 Sin RESEND_API_KEY, para que no salgan correos.
 *
 *   RESEND_API_KEY= npx ts-node --transpile-only -r tsconfig-paths/register scripts/probar-cron-alerta.ts
 */
import 'dotenv/config'
import { attendanceLateAlertJob } from '../src/jobs/attendance-late-alert.job'

async function main() {
  if (process.env.RESEND_API_KEY) {
    console.error('🔴 RESEND_API_KEY está puesta: esto mandaría correos REALES. Abortando.')
    process.exit(1)
  }

  const original = console.log
  let disparo = false

  attendanceLateAlertJob.start()
  console.log(`⏳ ${new Date().toLocaleTimeString('es-MX')} — job arrancado. Espero a que dispare SOLO…`)
  console.log('   (la programación es 4,14,24,34,44,54 de cada hora)')

  // Se detecta el disparo mirando el logger del propio job.
  const logger = (await import('../src/config/logger')).default
  const infoOriginal = logger.info.bind(logger)
  ;(logger as any).info = (msg: any, ...resto: any[]) => {
    if (typeof msg === 'string' && msg.includes('[attendance-late-alert]')) {
      disparo = true
      original(`\n✅ ${new Date().toLocaleTimeString('es-MX')} — EL CRON DISPARÓ SOLO: ${msg}`)
    }
    return infoOriginal(msg, ...resto)
  }

  // Espera hasta 11 minutos: el ciclo es de 10.
  const limite = Date.now() + 11 * 60 * 1000
  while (!disparo && Date.now() < limite) {
    await new Promise(r => setTimeout(r, 5000))
  }

  attendanceLateAlertJob.stop()
  if (disparo) {
    console.log('✅ Verificado: la programación funciona sin intervención.')
    process.exit(0)
  }
  console.error('❌ No disparó en 11 minutos — la programación NO está funcionando.')
  process.exit(1)
}

main().catch(e => {
  console.error('FALLÓ:', e)
  process.exit(1)
})
