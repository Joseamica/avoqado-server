/**
 * Disparo manual del job de alerta de retardo, para verificarlo contra la base local.
 *
 * 🔴 Córrelo SIN `RESEND_API_KEY` — si no, manda correos de verdad a los correos sembrados
 * en la base local, que además rebotan (memoria `rebotes-de-correo-datos-semilla`).
 *
 *   RESEND_API_KEY= npx ts-node -r tsconfig-paths/register scripts/probar-alerta.ts
 */
import 'dotenv/config'
import { AttendanceLateAlertJob } from '../src/jobs/attendance-late-alert.job'

async function main() {
  if (process.env.RESEND_API_KEY) {
    console.error('🔴 RESEND_API_KEY está puesta: esto mandaría correos REALES. Abortando.')
    process.exit(1)
  }
  const job = new AttendanceLateAlertJob()
  const r = await job.runNow()
  console.log('RESULTADO:', JSON.stringify(r))
  process.exit(0)
}

main().catch(e => {
  console.error('FALLÓ:', e)
  process.exit(1)
})
