import prisma from '../../utils/prismaClient'
import { getCatalog, resolveScopeOrNull } from './chartOfAccounts.service'
import { getMappings } from './accountMapping.service'

/**
 * Diagnóstico de PREPARACIÓN FISCAL (onboarding) de un contribuyente (org, RFC).
 *
 * Responde "¿qué le falta a este local para empezar a operar la contabilidad fiscal?" — la fricción
 * real para encender el módulo en un negocio nuevo. Es SÓLO lectura: inspecciona lo que ya existe
 * (emisor, CSD, catálogo, configuración contable, empleados) y devuelve un checklist con estatus por
 * ítem + las CAPACIDADES que se desbloquean (facturar / timbrar nómina / contabilidad electrónica).
 * No muta nada. Gated PREMIUM (bundle con CFDI), igual que el resto de Capa B.
 */

export type CheckStatus = 'ok' | 'warn' | 'missing'

export interface ReadinessCheck {
  key: string
  label: string
  status: CheckStatus
  /** Qué hacer / por qué, en español llano para el operador. */
  detail: string
}

export interface FiscalReadinessResult {
  /** El local aún no tiene RFC/emisor fiscal → nada de Capa B puede existir todavía. */
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  legalName: string | null
  regimenFiscal: string | null
  checks: ReadinessCheck[]
  /** Lo que el contribuyente YA puede hacer con su configuración actual. */
  capabilities: {
    /** Timbrar CFDI de ingreso (factura): emisor + CSD ACTIVO. */
    puedeFacturar: boolean
    /** Timbrar recibos de nómina: puedeFacturar + ≥1 empleado activo con clave de entidad federativa. */
    puedeTimbrarNomina: boolean
    /** Generar contabilidad electrónica (catálogo + balanza): catálogo sembrado + todos los mapeos asignados. */
    contabilidadElectronicaLista: boolean
  }
  resumen: { ok: number; warn: number; missing: number }
}

/** Días que faltan para una fecha (negativo si ya pasó); null si la fecha es null. */
function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000)
}

/**
 * Ensambla el checklist a partir de los insumos ya resueltos (función PURA, testeable).
 * `now` se inyecta para que las pruebas de expiración del CSD sean deterministas.
 */
export function assembleReadiness(
  input: {
    rfc: string
    emisor: {
      legalName: string
      regimenFiscal: string
      lugarExpedicion: string
      providerKeyEnc: string | null
      csdStatus: 'NONE' | 'UPLOADED' | 'ACTIVE' | 'EXPIRED' | 'RESTRICTED'
      csdExpiresAt: Date | null
    } | null
    venueZipCode: string | null
    catalogSeeded: boolean
    mappingsTotal: number
    mappingsAssigned: number
    empleadosActivos: number
    empleadosSinClaveEntFed: number
  },
  now: Date,
): FiscalReadinessResult {
  const { emisor } = input
  const checks: ReadinessCheck[] = []

  // 1. RFC del contribuyente (si llegamos aquí, hay RFC).
  checks.push({ key: 'rfc', label: 'RFC del contribuyente', status: 'ok', detail: `RFC ${input.rfc} configurado.` })

  // 2. Emisor fiscal (identidad legal + PAC).
  if (!emisor) {
    checks.push({
      key: 'emisor',
      label: 'Emisor fiscal',
      status: 'missing',
      detail: 'Configura el emisor (razón social, régimen fiscal y lugar de expedición) en Facturación.',
    })
  } else {
    checks.push({
      key: 'emisor',
      label: 'Emisor fiscal',
      status: 'ok',
      detail: `${emisor.legalName} · régimen ${emisor.regimenFiscal} · lugar de expedición ${emisor.lugarExpedicion}.`,
    })
  }

  // 3. Sello digital (CSD) — necesario para timbrar (factura y nómina).
  const daysToCsdExpiry = emisor ? daysUntil(emisor.csdExpiresAt, now) : null
  if (!emisor || emisor.csdStatus === 'NONE' || !emisor.providerKeyEnc) {
    checks.push({
      key: 'csd',
      label: 'Sello digital (CSD)',
      status: 'missing',
      detail: 'Sube tu CSD (.cer + .key) en Facturación para poder timbrar facturas y nómina.',
    })
  } else if (emisor.csdStatus === 'UPLOADED') {
    checks.push({
      key: 'csd',
      label: 'Sello digital (CSD)',
      status: 'warn',
      detail: 'El CSD está cargado pero aún no activo; valídalo en Facturación antes de timbrar.',
    })
  } else if (emisor.csdStatus === 'EXPIRED') {
    checks.push({ key: 'csd', label: 'Sello digital (CSD)', status: 'missing', detail: 'Tu CSD venció; renuévalo para volver a timbrar.' })
  } else if (emisor.csdStatus === 'RESTRICTED') {
    checks.push({
      key: 'csd',
      label: 'Sello digital (CSD)',
      status: 'missing',
      detail: 'El SAT restringió tu CSD; regulariza tu situación fiscal para timbrar.',
    })
  } else if (daysToCsdExpiry !== null && daysToCsdExpiry <= 30) {
    checks.push({
      key: 'csd',
      label: 'Sello digital (CSD)',
      status: 'warn',
      detail: `Tu CSD activo vence en ${daysToCsdExpiry} día(s); ten listo el reemplazo.`,
    })
  } else {
    checks.push({ key: 'csd', label: 'Sello digital (CSD)', status: 'ok', detail: 'CSD activo: puedes timbrar.' })
  }

  // 4. Código postal del local (lugar de expedición / receptor de nómina).
  checks.push(
    input.venueZipCode
      ? { key: 'cp', label: 'Código postal del local', status: 'ok', detail: `CP ${input.venueZipCode}.` }
      : {
          key: 'cp',
          label: 'Código postal del local',
          status: 'warn',
          detail: 'Captura el código postal del local; sin él los recibos de nómina usan 00000.',
        },
  )

  // 5. Catálogo de cuentas.
  checks.push(
    input.catalogSeeded
      ? { key: 'catalogo', label: 'Catálogo de cuentas', status: 'ok', detail: 'Catálogo sembrado.' }
      : {
          key: 'catalogo',
          label: 'Catálogo de cuentas',
          status: 'missing',
          detail: 'Siembra el catálogo de cuentas (Contabilidad → Catálogo) para poder postear pólizas.',
        },
  )

  // 6. Configuración contable (mapeo movimiento → cuenta).
  const unassigned = input.mappingsTotal - input.mappingsAssigned
  if (!input.catalogSeeded) {
    checks.push({
      key: 'mapeos',
      label: 'Configuración contable',
      status: 'missing',
      detail: 'Siembra primero el catálogo; luego asigna las cuentas de cada movimiento.',
    })
  } else if (unassigned > 0) {
    checks.push({
      key: 'mapeos',
      label: 'Configuración contable',
      status: 'warn',
      detail: `${input.mappingsAssigned}/${input.mappingsTotal} movimientos con cuenta; faltan ${unassigned}. El posteo te dirá cuáles al correr.`,
    })
  } else {
    checks.push({
      key: 'mapeos',
      label: 'Configuración contable',
      status: 'ok',
      detail: `Los ${input.mappingsTotal} movimientos tienen cuenta asignada.`,
    })
  }

  // 7. Nómina (opcional) — empleados listos para timbrar.
  if (input.empleadosActivos === 0) {
    checks.push({ key: 'nomina', label: 'Nómina (empleados)', status: 'ok', detail: 'Sin empleados activos (la nómina es opcional).' })
  } else if (input.empleadosSinClaveEntFed > 0) {
    checks.push({
      key: 'nomina',
      label: 'Nómina (empleados)',
      status: 'warn',
      detail: `${input.empleadosSinClaveEntFed}/${input.empleadosActivos} empleado(s) sin clave de entidad federativa; sus recibos no se podrán timbrar.`,
    })
  } else {
    checks.push({
      key: 'nomina',
      label: 'Nómina (empleados)',
      status: 'ok',
      detail: `${input.empleadosActivos} empleado(s) activos con sus datos fiscales completos.`,
    })
  }

  const csdActivo = !!emisor && emisor.csdStatus === 'ACTIVE' && !!emisor.providerKeyEnc
  const capabilities = {
    puedeFacturar: csdActivo,
    puedeTimbrarNomina: csdActivo && input.empleadosActivos - input.empleadosSinClaveEntFed >= 1,
    contabilidadElectronicaLista: input.catalogSeeded && unassigned === 0,
  }

  const resumen = checks.reduce((acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }), { ok: 0, warn: 0, missing: 0 } as {
    ok: number
    warn: number
    missing: number
  })

  return {
    needsFiscalSetup: false,
    organizationId: null, // lo rellena el caller
    rfc: input.rfc,
    legalName: emisor?.legalName ?? null,
    regimenFiscal: emisor?.regimenFiscal ?? null,
    checks,
    capabilities,
    resumen,
  }
}

/**
 * Diagnóstico de preparación fiscal de un local (read). Si el local no tiene RFC todavía devuelve
 * `needsFiscalSetup: true`. No muta nada.
 */
export async function getFiscalReadiness(venueId: string): Promise<FiscalReadinessResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return {
      needsFiscalSetup: true,
      organizationId: null,
      rfc: null,
      legalName: null,
      regimenFiscal: null,
      checks: [],
      capabilities: { puedeFacturar: false, puedeTimbrarNomina: false, contabilidadElectronicaLista: false },
      resumen: { ok: 0, warn: 0, missing: 0 },
    }
  }

  const [emisor, venue, catalog, mappingsResult, empleadosActivos, empleadosSinClaveEntFed] = await Promise.all([
    prisma.fiscalEmisor.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'asc' },
      select: { legalName: true, regimenFiscal: true, lugarExpedicion: true, providerKeyEnc: true, csdStatus: true, csdExpiresAt: true },
    }),
    prisma.venue.findUnique({ where: { id: venueId }, select: { zipCode: true } }),
    getCatalog(venueId),
    getMappings(venueId),
    prisma.employee.count({ where: { organizationId: scope.organizationId, rfc: scope.rfc, activo: true } }),
    prisma.employee.count({ where: { organizationId: scope.organizationId, rfc: scope.rfc, activo: true, claveEntFed: null } }),
  ])

  const result = assembleReadiness(
    {
      rfc: scope.rfc,
      emisor,
      venueZipCode: venue?.zipCode ?? null,
      catalogSeeded: catalog.seeded,
      mappingsTotal: mappingsResult.mappings.length,
      mappingsAssigned: mappingsResult.mappings.filter(m => m.account).length,
      empleadosActivos,
      empleadosSinClaveEntFed,
    },
    new Date(),
  )
  result.organizationId = scope.organizationId
  return result
}
