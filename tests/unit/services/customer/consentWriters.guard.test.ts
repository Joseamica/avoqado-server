/**
 * 🔴 `Customer.marketingConsent` sólo se ESCRIBE en `consent.service.ts`.
 *
 * Es el único camino que produce evidencia legal (LFPDPPP): un `ConsentEvent` + `ActivityLog`
 * en la MISMA transacción (Task 3). Un escritor directo (`prisma.customer.update({ data: {
 * marketingConsent: ... } })` en cualquier otro archivo) deja el campo desincronizado del
 * ledger — el cache dice una cosa y no hay evento que la respalde, que es exactamente lo que
 * una auditoría o una solicitud de derecho ARCO no puede sostener.
 *
 * Esta prueba es ESTÁTICA a propósito (mismo patrón que
 * `tests/unit/observability/multipartContext.test.ts` y
 * `tests/unit/services/dashboard/attendance-shift-independence.test.ts`): lee el código fuente
 * y falla si alguien vuelve a escribir el campo por fuera. Una prueba de comportamiento no lo
 * cazaría — un escritor nuevo se cuela como "sólo una asignación más" que no cambia el
 * resultado feliz del caso que se esté probando.
 */
import fs from 'fs'
import path from 'path'

function* tsFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* tsFiles(p)
    else if (e.name.endsWith('.ts')) yield p
  }
}

/**
 * Rutas completas excluidas del barrido, cada una con su motivo — nunca por comodidad.
 *
 * - `consent.service.ts` es EL escritor legítimo (Task 3).
 * - `src/schemas/**` son declaraciones Zod de FORMA de entrada (qué shape acepta un endpoint),
 *   no escrituras a Prisma — igual que un `interface { marketingConsent?: boolean }`.
 * - `demoSeed.service.ts` siembra clientes SINTÉTICOS (`*.demo.com`) para la demo de
 *   exploración del producto — no son personas reales que puedan otorgar/revocar consentimiento.
 *   Enrutarlo por `grantMarketingConsent` (a) exigiría un `PrivacyNoticeVersion` para CADA venue
 *   demo (la mayoría no tiene uno hoy — el seed reventaría con `BadRequestError`), y (b)
 *   escribiría `ConsentEvent`/`ActivityLog` reales para un consentimiento que nadie otorgó,
 *   contaminando el ledger legal con eventos ficticios. Ver reporte de la Task 8: se deja
 *   declarado como concern para el founder, no se fuerza el enrutado.
 */
const ARCHIVOS_EXCLUIDOS = (relPath: string): string | null => {
  if (relPath.endsWith('consent.service.ts')) return 'escritor legítimo (Task 3)'
  if (relPath.startsWith(`schemas${path.sep}`)) return 'declaración Zod de forma de entrada, no escritura a Prisma'
  if (relPath.endsWith(`onboarding${path.sep}demoSeed.service.ts`)) return 'siembra de clientes sintéticos de demo — ver comentario arriba'
  return null
}

/**
 * Líneas concretas excluidas por CONTENIDO exacto (no por número de línea — un número de línea
 * se corre con cualquier edición de arriba y dejaría de proteger lo que de verdad se quería
 * excluir, o peor, empezaría a tapar una escritura real que cayó justo en ese número).
 *
 * - `kioskOutreach.service.ts`: filtro de relación anidado dentro de un `where:` multi-línea
 *   (`prisma.creditPackPurchase.findMany({ where: { ..., customer: { marketingConsent: true },
 *   ... } })`). Es una LECTURA — decide a quién avisar, no escribe nada — pero la palabra
 *   "where" vive unas líneas arriba, no en esta línea, así que el filtro por contenido de la
 *   línea (`grep -v where`) no la protege.
 */
const LINEAS_DE_LECTURA_ANIDADA = [/^\s*customer:\s*\{\s*marketingConsent:\s*true\s*\},?\s*$/]

describe('marketingConsent sólo se ESCRIBE en consent.service.ts', () => {
  it('ningún otro archivo de src/ asigna marketingConsent directamente', () => {
    const raiz = path.join(__dirname, '../../../../src')
    const violaciones: string[] = []

    for (const f of tsFiles(raiz)) {
      const relPath = path.relative(raiz, f)
      if (ARCHIVOS_EXCLUIDOS(relPath)) continue

      const src = fs.readFileSync(f, 'utf8')
      for (const [i, linea] of src.split('\n').entries()) {
        // escritura = "marketingConsent:" dentro de un data:{...} — heurística: la línea
        // asigna un valor (true/false/identificador), no lee ni declara un tipo.
        // ⚠️ Límite conocido y ACEPTADO (verificado a propósito en la Task 8): esto es por
        // LÍNEA — un `prisma.customer.update({ where: {...}, data: { marketingConsent: true
        // } })` escrito en una sola línea física se salvaría porque "where" aparece en esa
        // misma línea aunque no gobierne el `data:`. El estilo real del repo siempre parte
        // `data: {...}` en su propio bloque (visto en consent.service.ts y en todo el resto
        // del barrido), así que no se endureció más — pero un escritor que se escriba
        // deliberadamente compacto en una sola línea puede colarse.
        if (!/marketingConsent\s*:\s*(true|false|[a-zA-Z])/.test(linea)) continue
        if (/select|where|expect|\/\//.test(linea)) continue
        // `campo: z.boolean()...` es una declaración de esquema Zod (el valor arranca con el
        // builder `z.`), no una asignación — aparece también FUERA de src/schemas/ (p. ej. el
        // shape de entrada de una tool del MCP en src/mcp/tools/).
        if (/marketingConsent\s*:\s*z\./.test(linea)) continue
        if (LINEAS_DE_LECTURA_ANIDADA.some(re => re.test(linea))) continue

        violaciones.push(`${relPath}:${i + 1}`)
      }
    }

    expect(violaciones).toEqual([])
  })

  it('el guard SÍ falla si alguien agrega un escritor directo (sabotaje intencional)', () => {
    // No se sabotea el árbol real: se ejercita la misma heurística de línea que usa la prueba
    // de arriba, sobre un snippet que reproduce el escritor prohibido más obvio
    // (`prisma.customer.update({ data: { marketingConsent: true } })` fuera de consent.service).
    const lineaProhibida = '      data: { marketingConsent: true },'
    const esViolacion =
      /marketingConsent\s*:\s*(true|false|[a-zA-Z])/.test(lineaProhibida) &&
      !/select|where|expect|\/\//.test(lineaProhibida) &&
      !/marketingConsent\s*:\s*z\./.test(lineaProhibida) &&
      !LINEAS_DE_LECTURA_ANIDADA.some(re => re.test(lineaProhibida))

    expect(esViolacion).toBe(true)
  })
})
