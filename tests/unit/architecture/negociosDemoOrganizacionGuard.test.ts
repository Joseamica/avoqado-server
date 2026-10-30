/**
 * El reinicio de los negocios demo borra y recrea el NEGOCIO, pero conserva su ORGANIZACIÓN (el usuario demo y su enlace
 * no cambian). Lo que vive sólo en la organización no cae con el negocio: si un prospecto pudiera escribirlo, el siguiente
 * lo heredaría (Codex r8, hallazgo 2: Pago al personal). Esta prueba obliga a decidir, para cada tabla de organización
 * (con `organizationId`, sin `venueId` ni `rfc`), por qué un demo no la escribe; la contabilidad por RFC la cubre
 * `negociosDemoContabilidadGuard`. Una tabla nueva sin clasificar truena aquí. Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md.
 */
import fs from 'fs'
import path from 'path'

const schema = fs.readFileSync(path.join(__dirname, '../../../prisma/schema.prisma'), 'utf8')

const CERRADO = 'su sección está cerrada en un demo (y el usuario demo sólo escribe dentro de su negocio)'
const DE_ORGANIZACION = 'lo escriben rutas de organización o de superadmin; el usuario demo sólo escribe dentro de su negocio'

/** Tabla de organización → por qué un prospecto en un demo no la escribe (o por qué se conserva a propósito). */
const POR_QUE_NO_LA_HEREDA: Record<string, string> = {
  StaffOrganization: 'la membresía del usuario demo: se conserva a propósito (mismo usuario, misma organización)',
  ActivityLog: 'bitácora: la del negocio queda con el id viejo y no se ve en el nuevo; la de organización ' + DE_ORGANIZACION,
  IdempotencyRequest: 'llaves de idempotencia del sistema: no se muestran ni cambian nada',
  McpToolCall: 'bitácora del MCP: un demo sólo consulta (soloNegociosDemo)',
  CommissionConfig: 'comisiones: ' + CERRADO,
  OrganizationPayoutConfig: 'comisiones: ' + CERRADO,
  OrganizationSalesGoalConfig: 'comisiones: ' + CERRADO,
  ServicePayPeriod: 'pago al personal: ' + CERRADO + '; su historial es nómina y nunca se borra',
  StaffPayLevel: 'pago al personal: ' + CERRADO,
  StaffPayLevelAssignment: 'pago al personal: ' + CERRADO,
  StaffPayTipWindow: 'pago al personal: ' + CERRADO,
  OrganizationAttendanceConfig: 'panel de organización: ' + DE_ORGANIZACION,
  OrganizationGoal: 'panel de organización: ' + DE_ORGANIZACION,
  Zone: 'panel de organización: ' + DE_ORGANIZACION,
  OrganizationEntitlement: 'módulos y derechos: ' + DE_ORGANIZACION,
  OrganizationModule: 'módulos y derechos: ' + DE_ORGANIZACION,
  TrainingModule: 'capacitación: ' + DE_ORGANIZACION,
  OrganizationPaymentConfig: 'cobros de la organización: ' + CERRADO,
  OrganizationPricingStructure: 'cobros de la organización: ' + CERRADO,
  PartnerAPIKey: 'llaves de socios: ' + DE_ORGANIZACION,
  Invoice: 'facturas de Avoqado a la organización: un demo no contrata plan',
  PlatformCfdi: 'facturas de Avoqado a la organización: un demo no contrata plan',
  HybridRedemption: 'facturación híbrida: ' + CERRADO,
  LaunchCampaignRedemption: 'campañas del alta: no parten de un negocio demo',
  OnboardingProgress: 'alta: cerrada al usuario demo',
  DocumentRequest: 'solicitud de documentos (KYC): ' + CERRADO,
  ShopifyStore: 'Shopify: ' + CERRADO,
  Invitation: 'invitar al equipo: ' + CERRADO,
  InterVenueTransfer: 'traspaso entre DOS sucursales: cada negocio demo vive solo en su organización',
  ItemCategory: 'categorías de artículos (inventario por número de serie): ' + CERRADO,
  SerializedItem: 'inventario por número de serie: ' + CERRADO,
  SimRegistrationRequest: 'registro de SIMs (PlayTelecom): ' + CERRADO,
  CashOutCommissionRate: 'Cash Out de promotores (PlayTelecom): ' + CERRADO,
  CashOutScheduleDay: 'Cash Out de promotores (PlayTelecom): ' + CERRADO,
  PromoterBankAccount: 'Cash Out de promotores (PlayTelecom): ' + CERRADO,
}
const PREFIJOS: Array<[string, string]> = [['Catalog', 'catálogo maestro: ' + CERRADO]]

const tablasDeOrganizacion = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
  .filter(
    ([, , cuerpo]) =>
      /^\s+(organizationId|orgId)\s+String/m.test(cuerpo) && !/^\s+venueId\s+String\s/m.test(cuerpo) && !/^\s+rfc\s+String/m.test(cuerpo),
  )
  .map(([, nombre]) => nombre)

it('encuentra las tablas de organización (si esto baja mucho, la búsqueda se rompió)', () => {
  expect(tablasDeOrganizacion.length).toBeGreaterThan(40)
})

it('🔴 cada tabla de organización dice por qué un demo no la deja para el siguiente prospecto', () => {
  const sinClasificar = tablasDeOrganizacion.filter(t => !(t in POR_QUE_NO_LA_HEREDA) && !PREFIJOS.some(([p]) => t.startsWith(p)))
  expect(sinClasificar).toEqual([])
})

it('ninguna razón sobra (la tabla sigue existiendo)', () => {
  expect(Object.keys(POR_QUE_NO_LA_HEREDA).filter(t => !tablasDeOrganizacion.includes(t))).toEqual([])
})
