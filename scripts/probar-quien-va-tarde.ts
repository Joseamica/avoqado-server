/**
 * Comprueba `quienVaTarde` — la función que comparten el job y la herramienta `who_is_late_now`
 * del MCP. Sólo LEE.
 *
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/probar-quien-va-tarde.ts <venueId>
 */
import 'dotenv/config'
import { quienVaTarde } from '../src/services/dashboard/attendanceLiveAlert'

async function main() {
  const venueId = process.argv[2] || 'cmpe64yq2001f9k92m0lbhmf4'
  const r = await quienVaTarde(venueId, new Date())
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}

main().catch(e => {
  console.error('FALLÓ:', e)
  process.exit(1)
})
