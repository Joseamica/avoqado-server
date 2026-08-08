# PITS H1 — Catálogo maestro corporativo, códigos y precios regionales

**Fecha:** 2026-08-08
**Estado:** Revisión técnica cerrada — pendiente aprobación formal del usuario y respuestas de PITS para rollout/aceptación contractual
**Empaquetado comercial:** ENTERPRISE/custom; PITS recibe grant explícito incluido
**Rollout operativo:** módulo organizacional MASTER_CATALOG, apagado por defecto y con gates separados para H1A/H1B/H1C
**Estimación de referencia:** el programa vigente dice 3 semanas / 30 días-persona; debe reestimarse después de recibir layouts y volumen
**Repositorios:** avoqado-server, avoqado-web-dashboard, avoqado-android, avoqado-ios, avoqado-tpv y avoqado-desktop
**Regla de ejecución:** este documento no autoriza implementación ni operaciones Git; primero debe existir y aprobarse el plan de trabajo

## 1. Problema

La matriz contestada a PITS declara como disponibles ocho capacidades que todavía no están
completas:

| Fila Excel | Compromiso |
|---|---|
| 43 | Alta completa de producto, actor/fecha, obligatoriedad y catálogo maestro descargable |
| 44 | Alta completa de platillo, incluyendo sus atributos de alimentos |
| 45 | Un SKU agrupador con múltiples códigos de barras |
| 47 | Precios de venta por región y reporte regional |
| 68 | Ajuste manual y masivo de precios por SKU y tienda |
| 69 | Vista y filtro de SKU con cambios de precio para usuarios de tienda |
| 71 | Layout masivo de códigos asociados, con validación y errores por renglón |
| 248 | Campos obligatorios según el tipo de negocio |

H1 también necesita dos cortes habilitadores que pertenecen a otras filas de la matriz:

- Fila 46: asignación de productos a tiendas, sólo en la parte necesaria para master → venue.
- Fila 191: importación Excel, sólo en la parte necesaria para cargar el catálogo maestro.

Se documentan como habilitadores y no se marcarán esas filas completas por inferencia. Su esfuerzo
se estima separado y la demo no se declara lista sin un layout real aprobado por PITS.

El modelo actual no es corporativo. Product pertenece a un solo venue, tiene un SKU y un GTIN,
y Product.price es el precio operativo que cobran y cachean todos los POS. No existe una identidad
organizacional, un registro único de códigos de venta por venue, una lista de precios regional ni
un historial durable de cambios masivos.

Reemplazar Product sería peligroso: sus IDs están enlazados con órdenes, inventario, recetas,
modificadores, reservas, clases, payment links, órdenes de compra y caches offline. Resolver el
catálogo y los precios con joins en cada lectura también introduciría latencia y diferencias entre
operación online y offline.

H1 debe entregar gobierno corporativo real sin convertirlo en una dependencia del hot path.

## 2. Evidencia y contexto operativo

Las fuentes contractuales y de trabajo son:

- /Users/amieva/Documents/Programming/Avoqado-HQ/customer-calls/Matriz-Requerimientos-Avoqado-PITS-CONTESTADA.xlsx.
- docs/PITS-INVENTARIO-MATRIZ.md.
- docs/PITS-PROGRAMA-COMPLETO.md.
- docs/PITS-HANDOFF.md.
- El macroproceso To Be externo en /Users/amieva/Library/Containers/com.apple.mail/Data/Library/Mail Downloads/0C2610A7-F248-4AF0-A5D6-6D031A79F71C/Macroprocesos To Be.pdf.

El macroproceso coloca Alta de producto y Asignación de precios/promociones/descuentos antes de
la operación de restaurantes, cafeterías y tiendas. Esto sustenta una identidad corporativa que
después se asigna a sucursales, no treinta y una altas independientes.

El PDF y la respuesta al correo deben archivarse en el repositorio documental de PITS antes de
cerrar H1. Mientras sólo existan en Mail, son evidencia externa no reproducible por CI.

La inspección read-only de producción al 2026-08-08 encontró 730 productos activos, siete
organizaciones con productos y cero Zone configuradas. Hay SKU repetidos entre venues de una
misma organización y no hay GTIN compartidos entre venues. Estos datos prohíben inferir identidad
corporativa a partir de los valores actuales o imponer unicidad organizacional mediante backfill.

Todos los clientes operativos esperan un Product resuelto por venue:

- Android cachea el catálogo completo por venue y cobra Product.price.
- iOS persiste productos y precio en SQLite.
- TPV persiste ProductEntity.price en Room y opera cache-first.
- Desktop persiste el catálogo por venue en JSON.
- Los cuatro conservan el último precio exitoso para operación offline.

Por ello, Product.id y Product.price siguen siendo las autoridades operativas.

## 3. Objetivos

1. Crear una identidad corporativa estable para productos vendibles y platillos.
2. Asignarla explícitamente a Product existentes o nuevos por sucursal.
3. Mantener Product como proyección materializada y fuente de ejecución.
4. Administrar múltiples códigos por artículo y hacerlos escaneables offline.
5. Configurar precios corporativos, regionales y excepcionales por venue.
6. Importar catálogo, códigos y precios con validación completa antes de escribir.
7. Publicar cambios con diff, confirmación, idempotencia, concurrencia y auditoría.
8. Mostrar a la tienda qué SKU cambiaron y cuándo.
9. Mantener comportamiento anterior para toda organización sin MASTER_CATALOG.
10. Exportar catálogo maestro, códigos asociados, precios/costos regionales y cambios de precio.
11. Impedir que un artículo PITS gobernado quede vendible mientras esté incompleto.
12. Documentar cada ruta, símbolo, decisión, riesgo y prueba modificada.

## 4. Fuera de alcance

- Sustituir, reidentificar, reparentar o recrear Product.
- Unificar Product, RawMaterial, SerializedItem o ProductOption.
- Propagar stock, recetas, modifier groups, disponibilidad, print routing o metadatos POS.
- Convertir presentación comercial en conversión caja a pieza. Esa aritmética es otro dominio.
- Calcular IEPS o cambiar totales cobrados. H1 sólo guarda metadatos declarativos.
- Recalcular órdenes, ventas, costos o precios históricos.
- Reutilizar el importador de menú en modo replace.
- Vincular por fuzzy matching o por nombre.
- Activar la capacidad para venues existentes durante deploy.
- Exigir que clientes antiguos entiendan campos nuevos.
- Programar precios o códigos futuros hasta que PITS confirme esa necesidad. H1 no expone
  effectiveFrom/effectiveUntil ni ejecuta un scheduler.

Materias primas quedan fuera del primer catálogo vendible. Si PITS confirma que deben gobernarse
corporativamente, se diseñará OrgMaterial más VenueRawMaterialBinding como agregado separado. No
se creará un binding polimórfico Product/RawMaterial.

## 5. Alternativas consideradas

### A. Extender Product y copiarlo a sucursales

Ventaja: menor implementación inicial.

Se descarta porque mantiene duplicación, no crea identidad corporativa, deriva con facilidad y
convierte cada cambio en una propagación sin procedencia confiable.

### B. Reemplazar Product o resolver master/precio en cada lectura

Ventaja: modelo conceptual centralizado.

Se descarta porque rompe IDs y contratos, agrega joins al POS, cambia comportamiento offline y
afecta versiones antiguas todavía instaladas.

### C. Catálogo corporativo con proyección materializada

Es la decisión aprobada. El master conserva identidad y propuestas; un binding explícito conserva
el Product local; una publicación confirmada materializa los valores operativos.

## 6. Decisiones de arquitectura

### D1. H1 es un hito comercial y tres entregas técnicas

- H1A — Identidad y gobierno: filas 43, 44 y 248.
- H1B — Códigos agrupadores e importación: filas 45 y 71.
- H1C — Precios regionales, cambios masivos e historial: filas 47, 68 y 69.

H1A define la columna vertebral. H1B y H1C pueden planearse en paralelo después de estabilizar los
contratos de H1A, pero ninguna fase se declara comercialmente completa por separado.

Los habilitadores de filas 46/191 se estiman como workstreams propios. La cifra histórica de 30
días-persona no se hereda automáticamente al diseño ampliado.

### D2. Entitlement organizacional separado del comportamiento legacy

MASTER_CATALOG es una capacidad ENTERPRISE/custom con grant explícito para PITS. No reutiliza el
Feature gate venue-scoped ni sus herencias de tier, demo o grandfathering. H1 agrega
OrganizationEntitlement, único por `(organizationId, featureCode)`, con status ACTIVE/REVOKED,
source CONTRACT/CUSTOM, startsAt/endsAt, grantedById, reason y timestamps.

El acceso comercial y el rollout no se mezclan:

1. OrganizationEntitlement responde si la organización tiene derecho comercial explícito.
2. Module/OrganizationModule controla rollout operativo.

Module agrega scope BOTH, ORGANIZATION_ONLY o VENUE_ONLY con default BOTH para módulos existentes.
MASTER_CATALOG usa ORGANIZATION_ONLY; los endpoints genéricos rechazan crear VenueModule para ese
code. `resolveMasterCatalogAccess()` es el único
resolver de administración/mutaciones HTTP/MCP/job y exige entitlement ACTIVE/vigente,
OrganizationModule activo y config versionada válida. Config ausente, schemaVersion desconocida o
lectura fallida resulta default false para mutaciones nuevas. Lookup/proyección operativa ya
publicada usa registryRequired y tenant auth, no este entitlement. Su config inicial es:

~~~json
{
  "schemaVersion": 1,
  "catalogCoreEnabled": false,
  "identifiersEnabled": false,
  "regionalPricingEnabled": false,
  "governanceMode": "OFF"
}
~~~

governanceMode avanza OFF → ADVISORY → ENFORCED. Ninguna transición ocurre por deploy.

En OFF/ADVISORY el gate sólo protege rutas y herramientas nuevas del catálogo. Nunca se agrega a:

- lectura y edición no relacionada con códigos de Product preexistente.
- Lectura actual de menú.
- Creación de órdenes.
- Escaneo legacy por SKU/GTIN.
- Inventario, recetas o cierre de venta.

ENFORCED agrega únicamente la puerta de alta/activación PITS descrita en D7. Es una decisión manual
posterior al canary, no conducta de deploy ni una validación global de Product.

Si la resolución comercial o de rollout falla, las mutaciones nuevas fallan cerradas. Las rutas
actuales siguen funcionando y no consultan el catálogo maestro.

El dashboard oculta toda navegación nueva cuando la capacidad está apagada. No se ejecutan
imports, publicaciones, validaciones corporativas ni jobs para esa organización.

Apagar el entitlement o el módulo detiene administración y nuevas publicaciones, pero no retira
proyecciones ya publicadas. Product, precio e identificadores operativos continúan leyéndose hasta
una publicación inversa explícita; así dos dispositivos no divergen por el orden de refresh.

“OFF” tiene dos estados distintos en pruebas y operación: NEVER_ENABLED significa organización y
venue que jamás pasaron rollout, con conducta legacy byte-compatible; PAUSED_AFTER_IDENTIFIERS
significa venue con registryRequired, donde lookup, cache y sincronización/unicidad del registro
continúan por seguridad aunque se pause la administración corporativa.

### D3. Product continúa como fuente operativa

CatalogItem es la identidad corporativa. Product conserva:

- ID operativo.
- price efectivo.
- categoryId local.
- active y ventanas de disponibilidad.
- Inventory/Recipe.
- modifier groups.
- printStationId.
- originSystem, externalId y datos de sincronización POS.

Las APIs /dashboard, /mobile y /tpv continúan devolviendo Product y su price escalar. El catálogo
maestro nunca es requerido para cobrar.

Desvincular o desactivar CatalogItem no elimina Product. Una baja corporativa puede proponer
desactivación futura, pero requiere una publicación explícita y no se incluye hasta confirmar la
política de PITS sobre remanentes.

### D4. Modelo corporativo explícito, no EAV

Los campos consultables y reportables son first-class. JSON se limita a snapshots de auditoría,
diffs y valores de override que dependen del campo.

#### CatalogItem

Campos conceptuales:

- id.
- organizationId.
- sku corporativo.
- kind: RETAIL_PRODUCT o PREPARED_DISH.
- businessTypes mediante CatalogItemBusinessType, para filtrado explícito por giro.
- name, description e imageUrl.
- brandId y manufacturerId.
- familyId; CatalogFamily usa parentId para subfamilia.
- presentationLabel.
- unit.
- taxRate Decimal, satProductKey, satUnitKey y objetoImp.
- productType, con una tabla versionada de mapeo al enum ProductType operativo.
- IEPS declarativo: mode, rate, quota y quotaUnit.
- status: ACTIVE o RETIRED; filas incompletas viven sólo en staging, no como CatalogItem DRAFT.
- revision entero monotónico.
- createdById, updatedById, createdAt y updatedAt.

La llave técnica es id. El SKU es único únicamente dentro del nuevo catálogo de la organización.
No se impone esa restricción a Product existentes y nunca se usa un SKU actual como vínculo
automático.

CatalogItem.sku es la única autoridad mutable del SKU corporativo. El CatalogIdentifier de tipo
CORPORATE_SKU es una proyección no editable que existe para reservar el normalizedCode junto con
los demás códigos. Crear/cambiar SKU pasa por un solo comando transaccional que actualiza ambos;
ningún endpoint puede editar esa proyección directamente. Un constraint trigger diferible valida
al commit que cada CatalogItem tenga exactamente una proyección CORPORATE_SKU, que ambos valores
normalizados sean iguales y que su status refleje ACTIVE/RETIRED del artículo; así ni SQL directo
puede dejarla ausente o divergente y un SKU retirado continúa reservado.

#### Catálogos normalizados

- CatalogBrand.
- CatalogManufacturer.
- CatalogFamily con jerarquía padre/hijo.
- CatalogItemBusinessType con UNIQUE (catalogItemId, businessType).

Los nombres se normalizan para detectar duplicados, pero conservan el valor de presentación. No
se reutiliza MenuCategory: ésta sigue siendo navegación y configuración operativa por venue.
La asociación de giro debe pertenecer a la misma organización y no se infiere de los venues ya
vinculados.

#### IEPS

El modelo permite NONE, RATE, QUOTA o BOTH, con Decimal para tasa/cuota. H1 no lee IEPS durante
checkout ni cambia el cálculo fiscal. taxRate, satProductKey, satUnitKey y objetoImp sí pueden
proponerse al Product mediante publicación confirmada, porque la fila 43 los exige en el alta y
export; su efecto de facturación sigue sujeto a las reglas fiscales existentes y a H5.

### D5. Identificadores corporativos y proyección operativa

CatalogIdentifier conserva:

- catalogItemId y organizationId.
- code original y normalizedCode.
- type: CORPORATE_SKU, EAN13, EAN8, UPCA, GTIN14 o INTERNAL.
- status: ACTIVE o RETIRED.
- createdById y timestamps.

Invariantes:

1. Un artículo tiene exactamente una proyección CORPORATE_SKU, igual a CatalogItem.sku y con status
   espejo de CatalogItem; RETIRED conserva la reserva.
2. Puede tener múltiples códigos.
3. Un normalizedCode no apunta a dos CatalogItem dentro de la organización.
4. Un código retirado no se reasigna silenciosamente a otro artículo.
5. Los formatos estándar validan longitud y checksum.
6. INTERNAL permite códigos no GS1 cuando PITS los confirme.
7. H1B no ofrece vigencias futuras: activar o retirar requiere publicación explícita.

La base impone UNIQUE (organizationId, normalizedCode) en CatalogIdentifier incluso para códigos
retirados, además de un único CORPORATE_SKU por CatalogItem. Retirar conserva historial y no libera
el código corporativo para otro artículo.

La normalización es única y versionada: trim de whitespace periférico, Unicode NFKC y uppercase
locale-neutral para valores alfanuméricos; los GS1 deben ser sólo dígitos. No se eliminan guiones,
espacios internos ni ceros iniciales. Las columnas de código del XLSX se leen como texto; una celda
numérica se rechaza porque Excel pudo haber perdido ceros a la izquierda.

#### Registro operativo único por venue

H1B no agrega una tercera fuente que compita con Product.sku y Product.gtin. Agrega
ProductIdentifier como registro autoritativo de todos los códigos resolubles en un venue:

- identifierId estable, organizationId, venueId, productId, code y normalizedCode.
- format: SKU, EAN13, EAN8, UPCA, GTIN14 o INTERNAL.
- mirrorsSku y mirrorsGtin para reflejar independientemente los campos legacy.
- catalogIdentifierId nullable cuando procede del master.
- active, revision, createdById y timestamps.

Una fila puede reflejar a la vez SKU, GTIN y un alias corporativo del mismo Product; por eso la
procedencia se expresa con columnas independientes, no con un enum exclusivo. La restricción real
es un índice parcial UNIQUE (venueId, normalizedCode) WHERE active, además de índices por productId
y catalogIdentifierId. Un código jamás se resuelve mediante findFirst entre varias tablas.

ProductIdentifier inactivo es un tombstone histórico con identifierId estable. Un código local
retirado puede reutilizarse para otro Product —igual que hoy— creando otro identifierId activo; el
delta retira el anterior y agrega el nuevo. Un código reservado por CatalogIdentifier activo o
retirado no puede reutilizarse localmente dentro de la organización.

Product.sku y Product.gtin permanecen locales y no se sobrescriben con el SKU corporativo en H1.
El SKU y los códigos corporativos se materializan como ProductIdentifier. Clientes antiguos siguen
escaneando los campos legacy; clientes H1B combinan la proyección adicional en su cache local.

#### Bootstrap y writers

La migración crea tablas e índices sin backfill. Antes de habilitar aliases en un venue PITS, un
preflight controlado expande Product.sku y Product.gtin al registro, detecta colisiones cruzadas
(SKU contra GTIN, mayúsculas y aliases) y exige resolución humana.

El bit de cutover usado por runtime vive como
`Venue.productIdentifierRegistryRequired Boolean @default(false)` —abreviado `registryRequired` en
este documento— y `Venue.productIdentifiersBootstrappedAt` guarda el instante. El writer los lee en
el mismo lookup tenant/venue que ya necesita; NEVER_ENABLED no agrega un join a tablas H1. El
detalle de preparación/readiness permanece en CatalogVenueRollout. Ambos valores de Venue son
monotónicos y sólo el comando fenced de bootstrap puede cambiarlos.

Todo Product create y todo update que toca SKU/GTIN obtiene advisory xact locks con llaves de
namespace explícito y orden fijo organización → venue, incluso en venues nunca habilitados; no se
usan en lecturas, checkout, precio, stock ni otros updates. Para evitar serializar venues no
relacionados, el protocolo es: writer Product toma shared(org) → shared(venue); bootstrap toma
shared(org) → exclusive(venue); crear/cambiar/retirar CatalogIdentifier o publicar
ProductIdentifier toma exclusive(org) → exclusive(venues por ID). El helper relee
`registryRequired` bajo el fence y decide el path: si es
false ejecuta exactamente la validación y escritura legacy, sin consultar CatalogIdentifier ni
aplicar reservas corporativas; si es true valida reservas y sincroniza el registro. Un conflicto
entre código local y código corporativo creado antes del cutover queda visible en preflight y
bloquea el rollout, pero no cambia anticipadamente el CRUD legacy. Crear/cambiar CatalogIdentifier
toma el lock org y los venues afectados en ID order.
Confirmar bootstrap toma el mismo fence, marca BOOTSTRAPPING, vuelve a escanear Products dentro del
lock, crea el registro y cambia atómicamente `registryRequired=false→true`,
`identifiersBootstrappedAt` y registryState READY.
Así un writer anterior termina antes del scan y uno posterior espera y ya sincroniza el registro.

Cuando registryRequired es true, todos los writers —dashboard, mobile, TPV quick-add, import menu,
sync POS, delivery ingestion, wizard y onboarding— reservan/sincronizan SKU/GTIN en la misma
transacción. Una colisión devuelve 409 CODE_ALREADY_ASSIGNED antes de modificar Product. Un cambio
de campo retira su espejo anterior sólo si esa fila no conserva procedencia corporativa.

El plan comienza con un inventario generado por `rg` de todo `product.create/update/upsert` y SQL
directo que toque SKU/GTIN, incluidos seeds/setup. Todos los paths runtime llaman un único helper
que recibe Prisma.TransactionClient y el venue fence; delivery ingestion lo ejecuta dentro de la
transacción de la orden. Un test/lint arquitectónico prohíbe nuevos writes directos a esos campos
fuera del helper. Seeds de desarrollo sólo operan con registryRequired false y el bootstrap los
incorpora después; no existe bypass de producción.

`registryRequired` es monotónico y no vuelve a false. Lookup/sync dependen de ese boolean, nunca de
un estado PAUSED ni del entitlement. Apagar grant/módulo sólo detiene publicar/retirar aliases
corporativos. El fence compartido es el único costo nuevo permitido en NEVER_ENABLED y sólo afecta alta
o cambio de SKU/GTIN. Antes de desplegar —no sólo antes de habilitar PITS— un benchmark comparativo
debe demostrar incremento p95 ≤ 5 ms, p99 ≤ 20 ms y degradación de throughput ≤ 5 % con 50 writers
concurrentes distribuidos entre 10 venues; reads, checkout, stock y cambios de precio deben mostrar
cero queries/locks nuevos. Si no cumple, el helper no se despliega hasta sustituir el mecanismo de
fence; activar o no activar el bootstrap no corrige ese overhead.

CatalogVenueRollout conserva tres estados por venue:

- registryState: NOT_STARTED, PREFLIGHT_FAILED, READY_TO_BOOTSTRAP, BOOTSTRAPPING o READY;
  `Venue.productIdentifierRegistryRequired`/`productIdentifiersBootstrappedAt` registran el cutover
  monotónico operativo.
- aliasPublicationState: DISABLED, CLIENTS_NOT_READY, READY_TO_ENABLE, ENABLED o PAUSED.
- governanceState: NOT_STARTED, CLIENTS_NOT_READY, READY_TO_ENFORCE, ENFORCED o PAUSED.

CatalogClientObservation registra venueId, deviceId opaco, family DASHBOARD/ANDROID/IOS/TPV/DESKTOP,
appVersion, capabilities, lastSeenAt y source. Cada venue declara familias required o N/A, versión
mínima y antigüedad máxima de observación (30 días por default). Ausente/stale significa no-ready.
Un override manual exige OWNER, motivo, expiración y ActivityLog; nunca es permanente por default.
Una publicación de aliases exige registryRequired y aliasPublicationState ENABLED. El gate efectivo
de altas es `org.governanceMode == ENFORCED && venue.governanceState == ENFORCED`, con
`governanceEnforcedAt` propio por venue; el modo org es sólo un techo global y jamás bloquea por sí
solo. El entitlement organizacional tampoco habilita ninguna conducta.

#### Contrato de lectura aditivo

Los endpoints legacy de Product no agregan joins ni cambian su envelope. Cada familia de cliente
recibe un endpoint incremental adicional; los clientes H1B lo mezclan por productId con el catálogo
venue-resolved después de cargar Product. Un cliente viejo nunca lo llama.

CatalogVenueRollout mantiene `identifierRevision` monotónico. Cada ProductIdentifier conserva su
última revision y nunca se borra físicamente: el retiro viaja como `active:false`. El cliente pide
cambios `afterRevision`, la primera página fija `toRevision` y todas las páginas siguientes usan
ese mismo límite. Sólo después de recibirlas/validarlas todas aplica el delta en una transacción
local y avanza su revision. Orden total: revision, identifierId; el cursor conserva ambas claves y
identifierId es el desempate estable incluso cuando varias filas comparten revision.

Cada transacción que modifica uno o más códigos incrementa identifierRevision una vez y asigna ese
valor a todas sus filas dentro del mismo commit. El cursor opaco incluye toRevision + última clave;
`afterRevision` mayor al actual responde 409 INVALID_IDENTIFIER_REVISION y obliga snapshot desde 0,
sin borrar cache hasta completar ese snapshot.

La lectura de proyecciones activas y el lookup online continúan aunque el entitlement se apague;
sólo se detienen mutaciones. Para un venue con registryRequired, el lookup por código consulta
ProductIdentifier. Para cualquier otro venue usa la ruta SKU/GTIN legacy sin cambio. Un código
retirado desaparece en el siguiente refresh exitoso; un terminal offline puede conservar su último
cache hasta reconectar y nunca se bloquea una venta por no poder refrescar.

### D6. Binding explícito, nunca inferido

CatalogVenueBinding conserva:

- catalogItemId.
- venueId.
- productId nullable mientras una asignación está pendiente.
- status: PENDING, LINKED, CONFLICT o UNLINKED.
- lastPublishedCatalogRevision.
- lastPublishedManagedSnapshot y hashes versionados por fieldMask.
- productUpdatedAtObserved sólo como diagnóstico.
- createdById y timestamps.

Restricciones:

- Un CatalogItem tiene máximo un binding por venue.
- Un Product se vincula como máximo a un CatalogItem.
- El venue y el CatalogItem deben pertenecer a la misma organización.
- SKU/GTIN sólo producen candidatos exactos en el preview.
- Crear o vincular requiere confirmación humana.
- Un Product nuevo requiere categoryId, SKU local y price inicial; el SKU corporativo sólo se
  sugiere y debe confirmarse, no se copia silenciosamente.

Tenant isolation también vive en FKs, no sólo en `if` de servicio. CatalogItem, CatalogPriceRegion
y Venue exponen claves únicas compuestas `(id,organizationId)`; Product expone `(id,venueId)`.
Bindings, precios, regiones, membresías, identifiers, batches y líneas repiten organizationId y
usan FKs compuestas. CatalogVenueBinding referencia `(catalogItemId,organizationId)`,
`(venueId,organizationId)` y `(productId,venueId)`; ProductIdentifier referencia
`(productId,venueId)`. Una combinación cross-tenant no puede insertarse ni con SQL directo.

La relación vive en la tabla de binding; no se cambia el ID ni el dueño del Product.

### D7. Overrides y cambios legacy

La propiedad de cada campo queda congelada antes del plan; ningún hash ni conflicto usa campos
fuera de esta tabla:

| Clase | Campos | Regla |
|---|---|---|
| Sólo master/reportable | SKU corporativo, marca, fabricante, familia/subfamilia, presentación e IEPS declarativo | Se exportan desde CatalogItem y nunca pisan columnas operativas por inferencia |
| Publicables con confirmación | name, description, imageUrl, Product.type, cost, taxRate, satProductKey, satUnitKey, objetoImp y unit | El preview muestra before/after; conflicto requiere decisión explícita |
| Precio H1C | CatalogItemPrice SALE_PRICE | Sólo H1C escribe Product.price/PricingPolicy.currentPrice |
| Siempre locales | Product.id, venueId, categoryId, active, disponibilidad, inventoryMethod, stock, Recipe, modifiers, print/display, tags, externalId/originSystem y metadatos POS | Nunca entran al managed hash ni se propagan |

CatalogItemPrice PURCHASE_COST organizacional puede proponer Product.cost para mercancía de
reventa. En un platillo con Recipe/PricingPolicy calculado se reporta el costo local por porción y
la propuesta de costo queda INVALID; nunca se sobrescribe PricingPolicy.calculatedCost.

Product.updatedAt puede cambiar por cualquier writer y sólo se guarda para diagnóstico. La
concurrencia se decide por línea: fieldMask ordenado + hashVersion + valores actuales únicamente de
los campos objetivo. Un batch sólo de precio no se invalida por cambiar nombre, stock, modifier o
disponibilidad. El snapshot administrado completo se conserva para diagnóstico de drift, no como
gate global.

La serialización hash v1 usa claves ordenadas, Decimal como string de escala fija, `null` literal,
enum/boolean canónicos y strings UTF-8 NFC exactos; SHA-256 incluye fieldMask y hashVersion. Sólo el
server calcula/revalida el hash.

CatalogVenueOverride conserva:

- bindingId.
- field.
- localValue de auditoría.
- reason.
- status: DETECTED, REQUESTED, APPROVED, REJECTED o SUPERSEDED.
- requestedById, decidedById y timestamps.

El dashboard corporativo crea overrides explícitos con motivo. En governanceMode OFF o ADVISORY,
los writers antiguos —dashboard legacy, mobile, TPV quick-add, menu import o POS sync— no se
bloquean por completitud; sus cambios sólo pueden aparecer como conflicto en el siguiente preview.
La única excepción, activada separadamente por registryRequired, es el 409 de unicidad cruzada al
cambiar SKU/GTIN descrito en D5. Un venue sin ese rollout conserva exactamente sus 4xx legacy.

Cada publicación compara:

1. Snapshot de la última publicación.
2. Product actual.
3. Valor corporativo propuesto.

Si Product actual difiere del último snapshot en un campo administrado, la línea queda CONFLICT y
no se sobrescribe hasta que Corporativo elija conservarlo como excepción o publicar el valor
master. Esto hace compatible un cliente viejo sin modificar todos los writers en H1A.

#### Integridad de altas PITS

Respecto de completitud, OFF deja todo igual y ADVISORY sólo muestra faltantes; registryRequired
puede seguir aplicando su unicidad independiente. ENFORCED es un techo organizacional, manual y
auditado; sólo afecta un venue cuando su governanceState también es ENFORCED. Ninguna de las dos
transiciones ocurre por deploy ni se propaga a otra organización/venue.

Desde `governanceEnforcedAt` de ese venue, sólo se crea un Product vendible mediante una publicación
de CatalogItem completa. Los endpoints legacy de create y TPV quick-add responden 422
CATALOG_GOVERNANCE_REQUIRED antes de escribir; import/sync devuelve error por renglón. Activar un
Product inactivo también exige binding y validación completos. Products creados antes de esa fecha
por venue quedan grandfathered y no se desactivan, borran ni ocultan automáticamente.

Product agrega createdById nullable de forma expand-only; filas antiguas permanecen null. Todos
los writers autenticados lo llenan y los writers de sistema registran una identidad de servicio en
ActivityLog. CatalogItem siempre requiere createdById. Así actor/fecha están disponibles para
cualquier alta gobernada sin inventar autoría en el backfill.

Para RETAIL_PRODUCT, completitud se evalúa contra los campos corporativos requeridos. Para
PREPARED_DISH hay dos niveles: la ficha master exige identidad/fiscalidad; cada binding sólo puede
publicarse si el Product local tiene Recipe, porciones mayores a cero, prepTime, líneas válidas y
costo por porción calculable. La receta nunca se copia entre venues; el export de platillos une
CatalogItem + binding + Recipe local y muestra porciones, preparación y costo por porción.

La cifra autoritativa se fija así: el preview ejecuta en modo read-only el calculador vigente de
recetas contra líneas, unidades y costos actuales. Si el resultado a escala 4 no coincide con
Recipe.totalCost, la línea queda RECIPE_COST_STALE y no publica. En Venue.currency:

~~~text
costPerPortion = round(Recipe.totalCost / portionYield, 4, HALF_UP)
~~~

RecipeLine.costPerServing y PricingPolicy.calculatedCost son diagnósticos, no fuentes alternativas.
Recipe.prepTime es el tiempo contractual; Product.prepTime no hace fallback. Recipe.updatedAt y el
hash de sus líneas se capturan como dependencia local separada para invalidar el preview sin
convertir Recipe en campo administrado por el master.

### D8. Precio efectivo materializado

H1 no reutiliza Zone: hoy es geografía, Venue sólo admite un zoneId y producción no tiene zones.
El dominio de precios crea:

- CatalogPriceRegion: organizationId, nombre normalizado, active, actor y timestamps.
- CatalogPriceRegionVenue: priceRegionId, venueId y priority.

Un venue puede pertenecer a varias regiones de precio. La membresía exige el mismo organizationId,
es única por región/venue y también UNIQUE (venueId, priority). El número menor tiene precedencia;
por ello nunca existen dos regiones igualmente prioritarias para el mismo venue.

La organización conserva pricingTopologyRevision monotónica. Crear, editar, desactivar una región
o cambiar membresía/priority usa preview-confirm: incrementa esa revision, expande todos los
Products afectados y rematerializa precio/costo en la misma publicación. No existe una mutación de
topología “sólo configuración” que deje Product.price stale. El preview captura esa revision. Una
mutación topológica cuyo fan-out exceda el cap atómico se rechaza completa: H1 no la divide ni
activa una revisión entre particiones. Sólo puede continuar tras elevar el cap con benchmark
aprobado o reducir explícitamente el alcance antes de generar otro preview.

CatalogItemPrice admite tres scopes:

1. Organización: default del artículo.
2. CatalogPriceRegion: regla regional.
3. Venue: excepción local explícita.

H1A crea las reglas ORGANIZATION necesarias para la ficha/alta; H1C habilita PRICE_REGION, VENUE,
cambio masivo, publicación e historial.

Campos:

- catalogItemId.
- valueType: SALE_PRICE o PURCHASE_COST.
- scope: ORGANIZATION, PRICE_REGION o VENUE.
- priceRegionId nullable.
- venueId nullable.
- amount Decimal(10,2), nunca Float.
- currency ISO-4217 uppercase.
- revision, createdById, updatedById y timestamps.

Un CHECK exige exactamente la FK que corresponde al scope. Índices parciales garantizan una regla
por `(catalogItemId,valueType,currency)` en organización, por
`(catalogItemId,valueType,priceRegionId,currency)` en región y por
`(catalogItemId,valueType,venueId,currency)` en venue; los NULL de PostgreSQL no sustituyen
unicidad. H1C sólo aplica cambios inmediatos y no expone fechas ni scheduler.

El input monetario acepta `0.00` a `99999999.99`, exige máximo dos decimales y rechaza exceso en vez
de redondearlo. APIs nuevas/hash lo representan como string de escala 2; Product conserva su wire
legacy. En Recipe, los costos siguen Decimal(10,4) y la única operación de redondeo es la fórmula
HALF_UP documentada en D7.

Precedencia:

~~~text
precio de venue
  > primera región coincidente por priority que tenga regla
  > precio corporativo
  > mantener Product.price actual si no hay propuesta
~~~

La resolución elige reglas cuya currency sea Venue.currency; H1 no convierte FX. Esto soporta una
organización multi-moneda con defaults separados. Para crear Product debe existir una regla
resoluble de su moneda; para un Product existente sin propuesta se conserva Product.price. Una
regla explícitamente dirigida a targets de otra moneda invalida el lote completo antes de writes.

La resolución sucede durante preview/publicación, no durante lectura POS. Al confirmar SALE_PRICE:

- Product.price recibe el valor final.
- PricingPolicy.currentPrice se actualiza en la misma transacción cuando existe.
- pricingStrategy, calculatedCost y suggestedPrice no cambian.
- órdenes históricas permanecen intactas.

PURCHASE_COST materializa Product.cost sólo para mercancía de reventa compatible; nunca sustituye
costos de Recipe, StockBatch o RawMaterial. La contradicción de la fila 47 queda aislada: el modelo
y los exports distinguen explícitamente precio de venta y costo de compra, pero PITS debe confirmar
cuál de ambos —o ambos— constituye la salida contractual antes de aceptar H1C.

### D9. Reglas por tipo de negocio sólo dentro del opt-in

CatalogValidationProfile se define por organización y business type/rol operativo. Conserva
una lista tipada de campos requeridos y una versión.

Baseline contractual PITS no relajable mientras no exista una enmienda escrita:

- Todo CatalogItem: SKU corporativo, fotografía, nombre, descripción, marca, fabricante, familia,
  subfamilia, presentación, unidad, kind/Product.type, CatalogItemPrice SALE_PRICE y PURCHASE_COST
  organizacionales, currency, IVA, IEPS explícito incluso NONE, satProductKey, satUnitKey,
  objetoImp, actor, fecha y al menos un CatalogItemBusinessType.
- Tienda: además al menos un CatalogIdentifier ACTIVE de tipo EAN13 con checksum válido; SKU,
  INTERNAL, EAN8, UPC o GTIN14 no satisfacen esa obligación.
- Restaurante/cafetería/platillo: además al menos un código ACTIVE y, por cada binding, Recipe,
  portionYield > 0, Recipe.prepTime > 0, al menos una línea válida y costo por porción calculable.
- Para cerrar H1C/fila 43 regional, cada binding debe resolver SALE_PRICE y el costo contractual a
  través de una regla PRICE_REGION explícita de su CatalogPriceRegion; un default ORGANIZATION no
  llena la columna Región. Este requisito queda ADVISORY hasta que PITS defina regiones/reporte.

CatalogValidationProfile puede añadir requisitos por giro, nunca retirar este baseline. Una
relajación exige respuesta PITS archivada, nueva versión contractual del perfil y aprobación
explícita antes de ENFORCED.

Estas reglas se ejecutan en alta, import y publicación del catálogo maestro. OFF/ADVISORY nunca
alteran CreateProductSchema, mobile Product CRUD o TPV quick-add. ENFORCED aplica únicamente la
puerta PITS descrita en D7 y sólo después de aprobar la matriz por giro.

Las respuestas de PITS reemplazarán los defaults antes de cerrar H1A y antes de activar ENFORCED;
no bloquean crear el agregado, importador, perfiles versionados ni el rollout apagado.

### D10. Trazabilidad de ficha y export

La plantilla y los exports usan columnas versionadas; cada campo tiene una sola procedencia:

| Requisito | Storage | Validación/import | Proyección operativa | Columna de export |
|---|---|---|---|---|
| SKU corporativo | CatalogItem.sku + CatalogIdentifier CORPORATE_SKU | Texto, único org-scoped | ProductIdentifier; no pisa Product.sku | corporate_sku |
| Nombre/descripción/foto | CatalogItem | Perfil, longitudes y URL segura | Product.name/description/imageUrl con confirmación | name, description, image_url |
| Marca/fabricante | CatalogBrand/CatalogManufacturer | Referencia normalizada | No se inyecta en Product | brand, manufacturer |
| Familia/subfamilia | CatalogFamily padre/hijo | Misma organización y jerarquía válida | No cambia MenuCategory | family, subfamily |
| Presentación | CatalogItem.presentationLabel | Texto declarativo | Sin conversión de unidades | presentation |
| Costo de compra | CatalogItemPrice PURCHASE_COST | Decimal >= 0 y moneda compatible | Product.cost sólo retail | purchase_cost, cost_currency, cost_scope |
| Precio de venta | CatalogItemPrice SALE_PRICE | Decimal >= 0 y moneda compatible | Product.price + PricingPolicy.currentPrice | sale_price, price_currency, price_scope |
| IVA/SAT/objetoImp | taxRate, satProductKey, satUnitKey, objetoImp | Catálogos/formato existentes | Campos homónimos de Product | iva_rate, sat_product_key, sat_unit_key, objeto_imp |
| IEPS | mode/rate/quota/quotaUnit | Consistencia tipada; declarativo en H1 | Sin cálculo de checkout | ieps_mode, ieps_rate, ieps_quota, ieps_quota_unit |
| Unidad | CatalogItem.unit | Enum y perfil por giro | Product.unit con confirmación | unit |
| Códigos | CatalogIdentifier | Texto, normalización, checksum y duplicados | ProductIdentifier aliases | identifier_code, identifier_type, identifier_status |
| Región | CatalogPriceRegion y membresías | Tenant, priority y moneda | Sólo materializa precio/costo final | price_region, region_priority |
| Tipo | kind + productType | Mapeo versionado permitido | Product.type con confirmación | item_kind, product_type |
| Actor/fecha | createdById/timestamps + ActivityLog | Actor del auth context | Product.createdById en alta gobernada | created_by, created_at, updated_by, updated_at |
| Receta/porciones/preparación | Recipe/PricingPolicy local vía binding | Requerido por venue para PREPARED_DISH | Nunca se copia | venue, recipe_status, portions, prep_time, cost_per_portion |

El catálogo maestro, el reporte de códigos asociados, el reporte regional y el export filtrado por
giro se generan desde esta matriz, no desde columnas ad hoc. Los códigos se escriben como texto en
XLSX y se neutralizan fórmulas en toda exportación.

### D11. Contratos versionados de export

Todos los archivos son XLSX `v1`, incluyen una hoja `Metadata` de filas `key:text,value:text` para
schemaVersion, organizationId, generatedAt UTC, timezone `America/Mexico_City`, filtros y
profileVersion. IDs/códigos son texto;
dinero es celda decimal con 2 posiciones, costo de receta con 4; timestamps son RFC3339 UTC. Un
nombre con `?` es nullable y se exporta vacío. Las relaciones uno-a-muchos viven en hojas separadas,
nunca en un producto cartesiano. El orden es por las claves de grano declaradas.

1. `catalog-master-v1.xlsx`
   - `Items`, una fila por `corporate_sku`: `corporate_sku:text`, `item_kind:enum`, `name:text`,
     `description:text`, `image_url:text`, `brand:text`, `manufacturer:text`, `family:text`,
     `subfamily:text`, `presentation:text`, `unit:enum`, `product_type:enum`,
     `iva_rate:decimal(5,4)`, `sat_product_key:text`, `sat_unit_key:text`, `objeto_imp:text`,
     `ieps_mode:enum`, `ieps_rate?:decimal(7,4)`, `ieps_quota?:decimal(10,4)`,
     `ieps_quota_unit?:text`, `status:enum`, `created_by:text`, `created_at:timestamp`,
     `updated_by:text`, `updated_at:timestamp`.
   - `OrganizationValues`, una fila por `(corporate_sku,value_type,currency)`: `corporate_sku:text`,
     `value_type:enum`, `amount:decimal(10,2)`, `currency:text`, `revision:integer`.
   - `BusinessTypes`, una fila por `(corporate_sku,business_type)`: `corporate_sku:text`,
     `business_type:enum`.
   - `VenueBindings`, una fila por `(corporate_sku,venue_id)`: `corporate_sku:text`,
     `venue_id:text`, `venue_name:text`, `product_id?:text`, `local_sku?:text`, `binding_status:enum`,
     `category_id?:text`, `last_published_revision?:integer`.
   - `PreparedDishDetails`, una fila por `(corporate_sku,venue_id)`: `corporate_sku:text`,
     `venue_id:text`, `product_id?:text`, `recipe_id?:text`, `portion_yield?:integer`,
     `prep_time_minutes?:integer`, `total_recipe_cost?:decimal(10,4)`,
     `cost_per_portion?:decimal(10,4)`, `currency?:text`, `recipe_status:enum`. Status es
     MISSING_RECIPE, INVALID_PORTION_YIELD, MISSING_PREP_TIME, EMPTY_LINES, COST_STALE o COMPLETE;
     los campos de receta sólo son obligatorios para COMPLETE.
   - `Identifiers`, una fila por `(corporate_sku,code)`, con el mismo schema que
     `associated-identifiers-v1.xlsx/Identifiers`.
   - `Regions`, una fila por `(price_region_id,venue_id)`, con el mismo schema que
     `regional-values-v1.xlsx/Regions`.
   - `RegionalValues`, una fila por `(corporate_sku,value_type,venue_id)`, con el mismo schema que
     `regional-values-v1.xlsx/ResolvedVenueValues`.
2. `associated-identifiers-v1.xlsx`
   - `Identifiers`, una fila por `(corporate_sku,code)`: `corporate_sku:text`,
     `code:text`, `format:enum`, `status:enum`, `created_by:text`, `created_at:timestamp`.
   - `VenueProjection`, una fila por `(venue_id,code)`: `venue_id:text`,
     `product_id:text`, `local_sku:text`, `code:text`, `format:enum`, `active:boolean`,
     `revision:integer`.
3. `regional-values-v1.xlsx`
   - `Regions`, una fila por `(price_region_id,venue_id)`: `price_region_id:text`,
     `price_region_name:text`, `venue_id:text`, `venue_name:text`, `priority:integer`,
     `active:boolean`.
   - `Rules`, una fila por `(corporate_sku,value_type,scope,scope_id,currency)`: `corporate_sku:text`,
     `value_type:enum`, `scope:enum`, `scope_id?:text`, `scope_name?:text`,
     `amount:decimal(10,2)`, `currency:text`, `revision:integer`.
   - `ResolvedVenueValues`, una fila por `(corporate_sku,value_type,venue_id)`:
     `corporate_sku:text`, `value_type:enum`, `venue_id:text`, `source_scope:enum`,
     `source_region_id?:text`, `source_region_name?:text`, `region_priority?:integer`,
     `amount:decimal(10,2)`, `currency:text`.
4. `price-changes-v1.xlsx`
   - `Current`, una fila por `(venue_id,product_id)`: `venue_id:text`, `product_id:text`,
     `local_sku:text`, `product_name:text`, `old_price:decimal(10,2)`,
     `current_price:decimal(10,2)`, `difference:decimal(10,2)`, `source_scope:enum`,
     `batch_id:text`, `change_kind:enum`, `applied_by:text`, `applied_at:timestamp`.
   - `History`, una fila por `publication_line_id`: las columnas de `Current` más
     `publication_line_id:text`, `line_status:enum`, `before_price:decimal(10,2)`,
     `after_price:decimal(10,2)`, `superseded_by?:text`, `reverses_line_id?:text`.
5. `catalog-by-business-type-v1.xlsx` reutiliza `Items`, `OrganizationValues`, `BusinessTypes`,
   `VenueBindings`, `PreparedDishDetails`, `Identifiers`, `Regions` y `RegionalValues`, todos
   filtrados al conjunto de artículos del businessType solicitado. Agrega `RequiredFields`, una
   fila por `(profile_version,business_type,field)`: `profile_version:integer`,
   `business_type:enum`, `field:text`, `required:boolean`, `source:CONTRACT|PROFILE`.
6. `import-errors-v1.xlsx` contiene `Errors`, una fila por `(source_sheet,source_row,column)`:
   `source_sheet:text`, `source_row:integer`, `column:text`, `error_code:enum`, `message:text`,
   `rejected_value?:text` escapado/truncado y `suggestion?:text`.

`Current` define “vigente” como la última línea APPLIED por Product/venue cuyo after coincide con
Product.price y que no fue superseded por otra línea. Una publicación posterior sustituye la fila;
una publicación inversa se vuelve la vigente con `change_kind=REVERSION`. Si un writer legacy
cambia el precio después, la línea queda DIVERGED, sale de `Current` y permanece en `History`.

## 7. Flujos

### F1. Habilitación

1. Superadmin asigna el grant y habilita catalogCoreEnabled sólo para la organización PITS.
2. No se hace backfill ni matching durante deploy.
3. Dashboard muestra Organización > Catálogo maestro.
4. OWNER/ADMIN configura familias, marcas, fabricantes, perfiles y regiones de precio.
5. governanceMode inicia ADVISORY; cualquier Product preexistente sigue desvinculado y operativo.
6. H1B ejecuta preflight/fenced bootstrap y canary antes de registryRequired + aliases ENABLED.
7. identifiersEnabled/regionalPricingEnabled y ENFORCED avanzan por separado, con auditoría.

### F2. Alta/importación del master

1. Usuario descarga una plantilla XLSX versionada; CSV puede ofrecerse como formato adicional pero
   no sustituye el layout contractual.
2. Sube el archivo.
3. El servidor crea un CatalogImportBatch y valida el archivo completo.
4. Cada CatalogImportLine conserva fila, valores normalizados, errores y propuesta.
5. Fórmulas, MIME falso, archivos excesivos, duplicados y códigos inválidos se rechazan.
6. Si una fila tiene error, ninguna fila modifica CatalogItem.
7. El usuario descarga el reporte, corrige y vuelve a subir.
8. Un preview totalmente válido recibe hash, revisión e idempotency key.
9. La pantalla presenta una sola acción final “Aplicar”; no hay apply por fila ni por hoja.
10. Confirmar con el mismo hash aplica el import de forma transaccional.
11. Repetir la misma key y payload devuelve el resultado original.

El preview sí puede guardar staging, errores y auditoría del intento; cero escritura significa
cero cambios a CatalogItem, Product, ProductIdentifier o precios.

El layout de catálogo (fila 191 habilitadora) y el layout de códigos asociados (fila 71) son
schemas distintos sobre el mismo pipeline seguro. Ninguno reutiliza el importador legacy de menú
ni su modo replace. El de códigos exige CORPORATE_SKU padre, código como texto, tipo, checksum,
duplicado intraarchivo/base y reporte descargable de errores antes de la única confirmación.

La fila 68 usa un tercer contrato, `price-adjustments-v1.xlsx`, sin reutilizar columnas ambiguas
del catálogo. Incluye `Metadata` con el schema común y una hoja `Adjustments`, de grano
`(corporate_sku,value_type,target_scope,target_id,currency)`, con columnas:
`corporate_sku:text`, `value_type:SALE_PRICE|PURCHASE_COST`,
`target_scope:ORGANIZATION|PRICE_REGION|VENUE`, `target_id?:text` —vacío sólo para ORGANIZATION—,
`new_amount:decimal(10,2)`, `currency:text`, `expected_rule_revision?:integer` y `note?:text`.
SKU y IDs se leen como texto; amount acepta 0.00..99999999.99 con máximo dos decimales y nunca se
redondea silenciosamente. Se rechazan fórmulas, scope/target ajeno o inactivo, SKU inexistente,
binding faltante, moneda incompatible y claves duplicadas dentro del archivo. Un error produce
`import-errors-v1.xlsx` y cero cambios. Un archivo válido expande todos los Products objetivo en el
mismo preview, hash, cap, confirmación y publicación atómica de F4.

El ajuste manual de un SKU/tienda en dashboard construye exactamente el mismo comando normalizado
con `target_scope=VENUE` y un solo renglón; no tiene un writer rápido alterno. Por ello la prueba de
fila 68 compara manual y XLSX y exige el mismo before/after, auditoría, idempotencia y semántica de
error.

### F3. Asignación a venues

1. Usuario selecciona artículos y venues.
2. El sistema muestra todos los candidatos exactos por SKU/GTIN; una ambigüedad es conflicto y
   nunca se resuelve con findFirst.
3. Usuario elige link, create o skip por renglón.
4. Create requiere SKU local, categoría local y precio inicial/resuelto.
5. Preview muestra Product, binding, códigos y campos que cambiarían.
6. Confirmación crea bindings idempotentes.
7. Nunca se copian stock, receta, modifiers, disponibilidad o externalId.

### F4. Publicación

El preview expande primero cada fila/regla a targets inmutables
`(catalogItemId, venueId, productId)`. El límite se mide en Product writes, no en filas del XLSX:
10,000 targets por publicación como default configurable. Un lote mayor devuelve 413 y propone
particiones explícitas sólo cuando cada partición sea una operación comercial independiente;
topología regional y cualquier comando que prometa atomicidad de alcance completo se rechazan sin
particionar. Nunca aplica una parte escondida. La transacción usa operaciones bulk,
CatalogPublicationLine por target, un ActivityLog resumen y outbox coalescido por venue.

CatalogPublicationOutbox conserva batchId, venueId, venueSequence, eventKind, payloadVersion,
payload, dedupeKey único, status PENDING/DELIVERED/DEAD_LETTER, attempts, nextAttemptAt, lastError
seguro y timestamps. Se crea dentro del commit de Product. `eventId = outbox.id` permanece estable
en todos los retries; un lock/secuencia por venue conserva orden. El worker usa dedupeKey, backoff y
sweeper con entrega **at-least-once**: una caída después de emitir y antes de marcar DELIVERED puede
repetir el evento. Consumidores H1 deduplican por eventId o ignoran venueSequence ya aplicada; los
eventos siguen siendo hints idempotentes para refetch del Product materializado. Nunca se promete
exactly-once sobre RabbitMQ/Socket.

Los writes heterogéneos no se implementan como 10,000 `prisma.update` secuenciales. Se cargan en
una tabla temporal o CTE `VALUES` en chunks parametrizados de máximo 500 y se aplican con
`UPDATE ... FROM`/bulk insert dentro de una sola transacción. Default operativo: lock_timeout 5 s,
statement_timeout 60 s y transaction timeout 90 s. Antes del canary, benchmark prod-like debe
demostrar p95 preview < 5 s y apply < 15 s para 6,200 targets; si no, se reduce el cap/configura el
batch antes de habilitar, nunca se oculta una aplicación parcial.

Cada línea queda:

- NO_CHANGE.
- READY.
- MISSING_BINDING.
- LOCAL_DIVERGENCE.
- APPROVED_OVERRIDE.
- INVALID.
- STALE.

CatalogPublicationBatch usa PREVIEWED → APPLYING → APPLIED, con EXPIRED, SUPERSEDED y FAILED como
terminales. APPLYING conserva attemptId, leaseExpiresAt y heartbeatAt. Confirmar:

1. Reserva `(organizationId, operation, idempotencyKey)` con CAS y requestHash versionado; sólo un
   caller cambia PREVIEWED a APPLYING. El concurrente relee y recibe IN_PROGRESS o el resultado.
2. Si el batch escribe ProductIdentifier, adquiere primero exclusive(org) → exclusive(venues por
   ID) según D5; un batch sólo de campos/precios no toma ese fence de códigos. Dentro de la
   transacción bloquea después, por ID estable, entitlement/module/membresía del actor,
   CatalogItem/precios/regiones, bindings, Product y PricingPolicy de todos los targets.
3. Ya bajo esos locks, relee y revalida entitlement/rol activos, tenant, targets, revisions,
   pricingTopologyRevision, currency y canonicalTargetHash.
4. Si una línea quedó stale/conflict no autorizado, revierte la transacción y responde 409 sin
   Product writes.
5. Actualiza todos los targets válidos y binding revision/snapshot en una transacción.
6. Persiste líneas before/after, auditoría organizacional y outbox en esa misma transacción.
7. Marca APPLIED en el mismo commit con CAS `(state=APPLYING,attemptId)`. El ejecutor mantiene un
   advisory lock exclusivo por batch durante el intento y renueva el lease entre fases; la
   transacción Product queda además acotada por el timeout declarado.
8. Un crash en APPLYING se consulta como IN_PROGRESS. El watchdog sólo actúa con lease expirado,
   adquiere el mismo batch lock y relee estado/attemptId: si APPLIED no hace nada; si sigue APPLYING
   usa CAS `(state,attemptId,leaseExpiresAt)` para FAILED. Si el intento vivo alcanzara el CAS
   después, falla y su transacción Product revierte, por lo que watchdog y commit no pueden ganar
   ambos.
9. Después del commit, el worker idempotente reproduce los serializers vigentes de
   product_price_changed, menu_item_updated y menu_updated; agrupa por venue cuando el contrato lo
   permite y conserva product/category IDs y reason. El serializer fija
   `priceChangePercent=null` cuando oldPrice=0; nunca emite Infinity/NaN.

Una publicación es all-or-nothing dentro del cap. No se reenvía automáticamente el comando HTTP
ante timeout. GET por idempotency key recupera PREVIEWED, IN_PROGRESS, APPLIED o FAILED; un FAILED
requiere nuevo preview/key y nunca reusa un snapshot posiblemente stale.

### F5. Reversión

No existe rollback destructivo. El historial permite generar una nueva publicación inversa:

- obtiene los valores anteriores;
- vuelve a comparar contra Product actual;
- muestra conflictos;
- requiere confirmación;
- genera su propio actor, fecha y ActivityLog.

### F6. Vista de tienda

Usuarios con scope de venue ven:

- SKU/producto.
- precio anterior y nuevo.
- fuente corporativa, región de precio o override.
- fecha aplicada en servidor.
- actor de publicación cuando su permiso lo permite.
- estado de excepción.

La pantalla y su export de “cambios de precio” se alimentan de CatalogPublicationLine, no de
ActivityLog libre ni de comparar el precio actual contra un valor que puede haber cambiado. Filtra
por rango, SKU/código, tienda, región, actor y source; exporta precio anterior/nuevo, diferencia,
batch y fecha de aplicación.

APPLIED significa aplicado de forma atómica en el servidor, no observado por cada dispositivo. Un
POS offline cobra el último Product.price válido hasta su siguiente refresh exitoso; un refresh
fallido conserva cache y nunca bloquea checkout. PITS confirmará si requiere acuse por dispositivo;
ese estado sería aditivo y separado, no parte del commit H1C.

## 8. Dashboard

La administración principal vive en avoqado-web-dashboard, a nivel Organization:

~~~text
Organización
└── Catálogo maestro
    ├── Productos y platillos
    ├── Códigos de barras
    ├── Regiones y precios
    ├── Asignación a tiendas
    ├── Importaciones
    ├── Publicaciones pendientes
    └── Historial y auditoría
~~~

Superadmin habilita el grant y los gates core/identifiers/regionalPricing, ve el estado de
CatalogVenueRollout y avanza governanceMode. PITS administra contenido desde su organization
scope; ningún POS configura el catálogo.

En páginas actuales de venue sólo se agrega, para un Product vinculado y usuario autorizado:

- procedencia corporativa;
- revisión publicada;
- campos con override;
- acceso a solicitar/revisar una excepción.

Sin entitlement no hay menú, componentes, queries ni llamadas nuevas. Los hooks fallan cerrados
para esta capacidad; un estado de plan/entitlement desconocido nunca revela controles de publish.

La UI incluye español, inglés y francés, teclado, focus visible, tablas paginadas y mensajes
accionables por fila.

El importador corporativo se rotula y enruta aparte del importador legacy de menú; ningún usuario
puede confundir “reemplazar menú” con “publicar catálogo maestro”. H1 corrige además dos brechas
compatibles del dashboard actual: createProduct debe enviar el GTIN que ya captura la forma y la
búsqueda de productos debe incluir SKU/GTIN. Los aliases sólo se buscan en la nueva vista y en
venues con aliases ENABLED; no se agregan joins a la lista legacy.

Readiness incluye ProductWizardDialog, createProduct.tsx, edición SKU/GTIN e import legacy. Todas
traducen 409/422 con acción hacia Catálogo maestro, cero retry; el import muestra
CODE_ALREADY_ASSIGNED por renglón y no lo degrada a error genérico.

## 9. Permisos

La autorización corporativa no reutiliza checkPermission ni un x-venue-id: ese middleware evalúa
StaffVenue y no puede autorizar acciones organizacionales. H1 crea un resolver/middleware dedicado
que deriva organizationId de la ruta/auth context y exige en cada request `Staff.active=true`,
`StaffOrganization.isActive=true`, `leftAt=null` y el OrgRole aplicable. Tokens de membresías
revocadas dejan de autorizar de inmediato.

Defaults implementables con el modelo actual:

| Rol | Permisos |
|---|---|
| OWNER organizacional | Configurar gates/perfiles/regiones, leer, crear, actualizar, importar, publicar, revertir y auditar |
| ADMIN organizacional | Leer, crear, actualizar, importar, publicar, revertir y auditar; no cambia entitlement/gates |
| VIEWER organizacional | Lectura y auditoría; ninguna mutación |
| MEMBER organizacional | Sin acceso corporativo por default |
| Staff de venue | Sólo vista de cambios/solicitud de override mediante permisos de venue |

Las dos capacidades venue-scoped nuevas son `catalog-venue:read` y
`catalog-venue:request-override`; se agregan a la fuente autoritativa del server y se espejan
exactamente en dashboard. No autorizan import ni publish corporativo.

PITS debe confirmar si publicar y aprobar requieren personas distintas. H1 no simula un aprobador
designado con el modelo actual. Si se exige maker-checker, antes de activarlo se diseña un permiso
organizacional explícito y una asignación de aprobadores; OWNER/ADMIN no se reinterpretan en
silencio.

La organización se deriva del auth context, nunca del body. Todo binding verifica que venue,
Product y CatalogItem pertenezcan al mismo tenant. Un ID cross-tenant responde 404.

SUPERADMIN sólo administra OrganizationEntitlement/Module por rutas dedicadas y con Staff activo;
no obtiene mutación implícita sobre contenido corporativo. Las acciones venue-scoped además exigen
StaffVenue activo. Una sesión de impersonation es read-only para H1 y no puede importar, publicar,
revertir, aprobar ni cambiar rollout.

MCP usa el mismo resolver de OrgRole para acciones corporativas y los mismos permisos de venue para
las vistas locales. No existen bypasses ni strings de permiso sólo declarados en el cliente.

## 10. Contratos y clientes

### Backend

Las rutas nuevas viven bajo organization scope. Los endpoints actuales conservan status, envelope,
campos requeridos y semántica.

Los payloads legacy de Product no reciben la relación identifiers y no agregan joins. price sigue
siendo escalar y de dos decimales; no se devuelve un objeto effectivePrice en lugar del valor
actual. Cada familia `/dashboard`, `/mobile` y `/tpv` obtiene una ruta aditiva de proyección
`product-identifiers`; las tres rutas nuevas comparten el envelope exacto definido abajo. Un server
viejo/404 o una falla de refresh no elimina el cache previo del cliente.

Rutas de lectura propuestas:

- `GET /dashboard/venues/:venueId/product-identifiers`.
- `GET /mobile/venues/:venueId/product-identifiers`.
- `GET /tpv/venues/:venueId/product-identifiers`.

Se agregan sin sustituir el lookup de barcode existente; éste delega al registro sólo en venues
con registryRequired y conserva su status/envelope legacy.

Las tres rutas aceptan `afterRevision`, `cursor` y `pageSize` (máximo 500) y responden exactamente:

~~~json
{
  "success": true,
  "data": {
    "venueId": "venue-id",
    "fromRevision": 17,
    "toRevision": 23,
    "normalizationVersion": 1,
    "items": [
      {
        "identifierId": "identifier-id",
        "productId": "product-id",
        "code": "00012345",
        "normalizedCode": "00012345",
        "format": "INTERNAL",
        "active": true,
        "revision": 19
      }
    ],
    "nextCursor": null
  }
}
~~~

`200` con `items:[]` es una respuesta autoritativa y puede avanzar revision. `404`, timeout, 5xx o
error de decode no vacían aliases ni avanzan revision. El catálogo Product y el delta de aliases
son caches independientes: Product/precio puede refrescar aunque aliases conserve el último estado
bueno. Todo item del delta se persiste por identifierId aunque su productId todavía no exista en el
cache Product; queda excluido temporalmente del lookup, sin bloquear checkout, y se vuelve
resoluble automáticamente cuando aparezca el Product. Nunca se descarta antes de avanzar revision.

Las tres rutas nuevas usan intencionalmente este mismo envelope, no una variante por namespace.
identifierId es la llave estable de tombstone/reuso y normalizedCode es la llave de match. Los
cuatro clientes implementan normalizationVersion 1 con los mismos golden vectors y sólo normalizan
contra ProductIdentifier. En NEVER_ENABLED o sin snapshot autoritativo, SKU/GTIN/barcode directos
conservan exactamente la comparación legacy de cada cliente; en registryRequired sus mirrors ya
viajan como ProductIdentifier normalizados. `code` sólo es presentación. Una versión desconocida
conserva cache y marca el venue no-ready, nunca intenta un match aproximado.

### Android

- ProductsRepository descarga todas las páginas del delta después del catálogo y lo aplica
  transaccionalmente por identifierId en una cache independiente; un alias sin Product se conserva
  pero no se ofrece al lookup. Sólo un `200` completo puede vaciar/retirar, mientras
  404/timeout/5xx/decode conserva aliases y revision previos.
- CartViewModel.resolveScannedBarcode normaliza v1 para aliases; sin proyección conserva la
  comparación legacy de SKU/barcode/GTIN.
- Se prueba round-trip de cache viejo/nuevo y arranque frío sin red.
- Articles/create, `pos/presentation/product/CreateProductView` y el flujo de barcode desconocido
  muestran CODE_ALREADY_ASSIGNED o CATALOG_GOVERNANCE_REQUIRED como conflicto accionable, dirigen
  al catálogo corporativo y nunca reintentan automáticamente.

### iOS

- La migración GRDB agrega una tabla de aliases por productId y corrige el round-trip de GTIN/barcode
  que hoy se pierde tras un arranque totalmente offline.
- Product.CodingKeys/init conserva compatibilidad y findByBarcode normaliza v1 sólo para aliases;
  sin proyección compara los campos legacy exactamente como antes.
- La migración preserva precio, SKU y filas existentes; 404/falla conserva el último cache bueno.
- POS/Articles create/edit y barcode desconocido traducen 409/422 al mismo mensaje accionable y no
  reintentan el write.

### TPV

- ProductIdentifierEntity/DAO se agrega sin reemplazar ProductEntity ni su price.
- MenuViewModel.onBarcodeScanned y CheckoutViewModel.findProductByBarcode consultan la misma fuente
  local primero, normalizan v1 sólo para aliases y conservan el match legacy directo cuando no hay
  proyección; usan red sólo como fallback.
- Una consulta Room transaccional resuelve alias → ProductEntity completo; obtener sólo productId
  no se considera éxito. Ambos scanners usan ese mismo repository tras un cold start.
- Ordering conserva ProductDto/domain; Mesas conserva MenuCatalogDto/MenuProduct; Kiosk y quick-add
  mantienen sus contratos. Cada grafo recibe una regresión separada de precio/catálogo.
- La migración Room es no destructiva y cubre arranque frío offline.
- Quick-add traduce 409/422, no reintenta y explica que el alta debe hacerse en Catálogo maestro.

### Desktop

- CatalogCache conserva Product y aliases como caches serializables independientes; aliases
  huérfanos sobreviven hasta que llegue su Product.
- CheckoutScreen.onScanSubmit normaliza v1 sólo contra aliases y conserva su semántica legacy para
  campos directos cuando la proyección está ausente.
- JSON cache antiguo y nuevo decodifican sin cambiar price ni IDs.
- Catálogo create/edit y barcode desconocido traducen 409/422 de forma accionable y sin retry.

Android e iOS cambian juntos cuando la conducta visible es equivalente. Ordering, Mesas y Kiosk no
necesitan aliases si no escanean, pero sí pruebas de que el endpoint y Product.price no cambiaron.
PITS no publica aliases para un venue hasta que CatalogVenueRollout confirme las versiones mínimas;
un cliente viejo puede seguir vendiendo por SKU/GTIN durante todo el rollout.

ENFORCED permanece apagado hasta que governanceState confirme que todas las familias requeridas
entienden el 422. Esa puerta sólo afecta nuevas altas/activaciones: checkout y Products
grandfathered continúan aun si aparece un cliente viejo después.

## 11. MCP

Customer MCP se mantiene en sync con UI/API. Las herramientas mínimas son:

- list_catalog_items.
- get_catalog_item.
- preview_catalog_import.
- confirm_catalog_import.
- preview_catalog_publication.
- confirm_catalog_publication.
- list_catalog_price_changes.
- request_catalog_override.

Mutaciones peligrosas requieren:

- scope organizacional/venues derivado del token;
- `mcp:write` de forma incondicional, sin depender de MCP_ENFORCE_WRITE_SCOPE;
- rol organizacional o permiso de venue exacto;
- preview previo;
- preview token y hash;
- confirm: true;
- idempotency key;
- ActivityLog.

MCP no acepta “publica esto” sin preview y nunca infiere links por nombre. Los datos estructurados
pueden entrar como filas; archivos XLSX usan el mismo pipeline de import del dashboard.

McpScope agrega orgRole y organización explícita. Cada tool vuelve a comprobar Staff,
StaffOrganization/StaffVenue activos y llama al mismo `resolveMasterCatalogAccess()` que HTTP. Un
token legacy sin scopes no puede escribir H1 aunque otros tools conserven compatibilidad observe-only.

## 12. Concurrencia e idempotencia

CatalogItem.revision es monotónica. El preview captura:

- revisiones de CatalogItem.
- binding revision/snapshot.
- fieldMask + canonicalTargetHash por línea; snapshot completo/Product.updatedAt sólo diagnóstico.
- precio fuente y Product.price.
- pricingTopologyRevision y currency del target.
- entitlement/permission policy version.
- lista expandida e inmutable de targets.

Confirm revalida todos. Cualquier cambio relevante produce 409 STALE_PREVIEW antes de tocar
Product.

La idempotency key es única por organización y operación. Se reserva antes de aplicar con una
constraint y CAS; un P2002 concurrente relee la fila en vez de ejecutar. Se almacena requestHash:

- misma key + mismo hash: devuelve el resultado anterior;
- misma key + hash distinto: 409;
- PREVIEWED: puede adquirir APPLYING una sola vez;
- APPLYING: GET devuelve IN_PROGRESS y POST nunca reejecuta;
- APPLIED: devuelve el resultado y nunca aplica de nuevo;
- FAILED/EXPIRED/SUPERSEDED: exige preview y key nuevos.

Las filas se bloquean en orden estable para evitar deadlocks. Una falla operativa no puede quedar
oculta por rollback del mismo batch: el control APPLYING/attempt/lease existe antes de la
transacción de Product; el mismo batch lock y los CAS mutuamente excluyentes determinan si ganó
APPLIED o FAILED. ActivityLog y outbox se escriben dentro de la transacción de Product; sockets y
trabajos externos ocurren después.

## 13. Errores y seguridad

| Status | Significado |
|---|---|
| 400 | Campos/archivo inválidos y errores por renglón |
| 202 | Confirmación ya APPLYING; consultar batch/idempotency key |
| 403 | Entitlement o permiso ausente |
| 404 | Recurso inexistente o fuera del tenant |
| 409 | Preview stale, conflicto o key reutilizada con otro contenido |
| 422 | Gobierno ENFORCED impide alta/activación legacy incompleta |
| 413 | Archivo/lote excede límites |

Los errores nuevos conservan el envelope global vigente `{message, code, details}`. Los contratos
que deben reconocer todos los writers/clientes son:

- 409 `CODE_ALREADY_ASSIGNED`, no retryable, con details `{field, existingProductId}` limitado al
  mismo venue.
- 409 `CATALOG_CLIENTS_NOT_READY`, no retryable, sin revelar dispositivos ajenos.
- 422 `CATALOG_GOVERNANCE_REQUIRED`, no retryable, con details
  `{action:"OPEN_MASTER_CATALOG"}`.
- 409 `STALE_PREVIEW` e `IDEMPOTENCY_KEY_REUSED`, recuperables sólo mediante GET/nuevo preview,
  nunca reenviando confirm a ciegas.

Controles:

- límites de bytes, hojas, filas, columnas y longitud de celda;
- validación por magic bytes/MIME;
- rechazo o tratamiento explícito de fórmulas;
- prevención de zip bombs;
- checksum GS1;
- neutralización de =, +, -, @ y controles al exportar;
- paginación/caps en vistas org-wide;
- cap configurable de targets expandidos y timeout transaccional declarado;
- Decimal para dinero;
- no registrar archivos, códigos completos ni precios por fila en logs;
- no exponer existencia cross-tenant.

Un error de una fila bloquea la aplicación completa. El usuario obtiene un archivo de errores;
no recibe un éxito parcial ambiguo.

## 14. Auditoría y observabilidad

Cada alta, link, import confirmado, publicación, override y reversión conserva:

- organizationId y venueId cuando aplica.
- actor y aprobador cuando aplica.
- entidad y revisión.
- valores before/after.
- motivo.
- batchId e idempotency key segura.
- timestamps.

ActivityLog agrega organizationId nullable/index, actorType HUMAN|SERVICE nullable y
servicePrincipalId nullable. Para no romper el helper legacy que aún escribe actorType null, el
CHECK sólo valida combinaciones cuando actorType está presente: HUMAN exige staffId y
servicePrincipalId null; SERVICE exige servicePrincipalId y staffId null. Null significa
LEGACY_UNCLASSIFIED y se permite hasta que un proyecto separado migre todos sus callers; no se
inventa autoría mediante backfill. Las queries organizacionales filtran por organizationId y, para
logs legacy, por sus venues; una acción corporate con venueId null ya no desaparece.

El writer H1 recibe Prisma.TransactionClient, requiere actor y nunca usa el helper global
fire-and-forget ni absorbe errores. Cada publicación masiva crea un ActivityLog resumen con batch,
actor, conteos y hash; CatalogPublicationLine conserva el before/after por target y hereda actor del
batch. Esto evita duplicar 10,000 snapshots en dos tablas sin perder auditabilidad. Una falla de
cualquiera de ambas escrituras revierte la publicación. Approver sólo existe si maker-checker fue
realmente autorizado.

Métricas:

- duración de preview/apply;
- filas totales, válidas, inválidas y en conflicto;
- stale previews;
- publicaciones aplicadas/fallidas;
- outbox pendiente y reintentos;
- latencia/paginación del catálogo;
- activaciones por organización.

Logs incluyen batchId, organizationId y conteos, nunca el payload completo. BetterStack monitorea
el canary y alerta por lotes atorados o outbox sin procesar.

## 15. Despliegue y rollback

Orden:

1. Migraciones expand-only, índices, partial uniques y constraints; cero backfill automático.
2. Backend con MASTER_CATALOG apagado.
3. Dashboard con navegación escondida.
4. Clientes H1B capaces de consumir la proyección opcional sin cambiar Product.
5. Dry-run H1A/H1C con archivos representativos y governance ADVISORY.
6. Grant y catalogCoreEnabled sólo para PITS.
7. Preflight de códigos, resolución de colisiones y bootstrap confirmado en un venue PITS.
8. Canary registryRequired + aliases ENABLED y regional pricing en ese venue.
9. Expansión venue por venue mediante CatalogVenueRollout.
10. ENFORCED sólo después de matriz por giro aprobada y prueba de todas las altas PITS.

Desactivar el entitlement:

- detiene nuevas operaciones corporativas;
- no borra master, bindings o historial;
- no cambia Product;
- no revierte precios de forma silenciosa;
- no retira aliases operativos ya publicados;
- deja POS e inventario funcionando con el último Product materializado.

Una corrección de datos usa publicación inversa. Una migración nunca se revierte destructivamente
en producción.

## 16. Estrategia de pruebas

Dinero, permisos, códigos, migraciones y tenant isolation se implementan con TDD.

### Server

- NEVER_ENABLED mantiene byte-compatible status/envelopes/validaciones y semántica de writers
  legacy; no consulta catálogo, identifiers ni entitlement. La única operación nueva es el fence
  advisory compartido en alta/cambio SKU/GTIN, sujeto al SLO comparativo de D5; no existe override
  por VenueModule.
- Tier PREMIUM, demo/grandfathered y VenueFeature no conceden MASTER_CATALOG; sólo
  OrganizationEntitlement explícito + Module ORGANIZATION_ONLY + OrganizationModule/config válida.
- Config ausente/desconocida y VenueModule MASTER_CATALOG fallan cerrados sin afectar rutas legacy.
- PAUSED_AFTER_IDENTIFIERS conserva lookup/sync y posible 409 de unicidad, pero bloquea toda
  mutación corporativa.
- Apagar grant/módulo conserva lectura/lookup de ProductIdentifier ya publicado y rechaza mutación.
- Resolver OrgRole y permisos venue-scoped fallan cerrados; cross-tenant devuelve 404.
- Staff/StaffOrganization/StaffVenue revocado y impersonation no pueden mutar; superadmin sólo
  configura entitlement/module por su ruta dedicada.
- FKs compuestas rechazan binding/identifier/región/precio cross-tenant incluso por SQL directo.
- Golden errors 409/422 conservan `{message,code,details}`, se marcan no retryable y no filtran
  Product/device cross-tenant.
- CatalogItem SKU es org-scoped sólo en master y cada alta gobernada conserva actor/fecha.
- Cambiar CatalogItem.sku actualiza su proyección CORPORATE_SKU en un único comando; ésta no tiene
  endpoint mutable independiente.
- El constraint trigger diferible rechaza por SQL directo un CatalogItem sin CORPORATE_SKU, con
  valor normalizado divergente o con status que no refleje ACTIVE/RETIRED al commit.
- OFF/ADVISORY no bloquean por completitud ninguna vía legacy; registryRequired aún prueba su 409
  independiente. ENFORCED cubre dashboard, mobile, TPV quick-add, menu import, POS sync y
  activación, sin afectar products grandfathered.
- Org ENFORCED + venue no ENFORCED no produce 422; governanceEnforcedAt/grandfathering se evalúa
  por venue.
- Perfil PREPARED_DISH exige Recipe/porciones/prep/costo por binding sin copiar la receta.
- Migración expand-only acepta Product duplicados actuales y crea cero filas de registro.
- Preflight detecta colisiones SKU↔GTIN, case/normalización y códigos de otro Product.
- Test con barrera demuestra que writer antes del bootstrap queda incluido y writer posterior
  espera el venue fence y sincroniza; registryRequired nunca revierte.
- UNIQUE venue-scoped soporta concurrencia; ningún lookup usa findFirst ambiguo. Retirar un código
  local permite reutilizarlo en otro Product mediante otro identifierId, mientras un código
  corporativo ACTIVE o RETIRED continúa reservado y se rechaza.
- El protocolo shared/exclusive permite writers simultáneos de venues distintos, bloquea el venue
  durante bootstrap y bloquea la organización sólo durante mutación/publicación de códigos.
- Todos los writers de un venue con registryRequired sincronizan SKU/GTIN en la transacción; los demás
  mantienen path legacy.
- Lint/architecture test inventaría delivery/wizard/onboarding/import/sync y falla ante un writer
  SKU/GTIN directo fuera del helper.
- Checksum/normalización/retiro/unicidad; cero inicial preservado y celda numérica XLSX rechazada.
- CatalogVenueRollout bloquea aliases antes de readiness y permite canary por venue.
- Observaciones required/N/A, versión mínima, expiración y override auditado gobiernan readiness;
  ausencia/stale queda no-ready.
- Delta wire fija toRevision, pagina por `(revision,identifierId)` sin saltar empates en el límite,
  conserva tombstones y no avanza ante 404/timeout/5xx/decode.
- Si el delta llega antes que Product, guarda el alias por identifierId, avanza revision y lo vuelve
  resoluble cuando Product aparece después, sin snapshot reset.
- Import con cualquier error produce cero cambios operativos y una sola confirmación final.
- `price-adjustments-v1.xlsx` y ajuste manual de un SKU/venue generan el mismo comando/preview;
  fórmula, duplicado, moneda, revisión o target inválido dejan cero Product/rule writes.
- Matching exacto sólo sugiere; binding no cambia Product.id ni vincula sin confirmación.
- canonicalTargetHash por fieldMask ignora campos ajenos y detecta sólo divergencia objetivo.
- Test con barrera cambia Product entre preview y lock; confirm bloquea, relee ya bajo lock y
  retorna STALE sin sobrescribir.
- Override aprobado/rechazado y publicación inversa conservan before/after.
- Decimal, partial unique indexes y precedencia org/región-priority/venue.
- Cambiar región/membresía/priority exige preview-confirm, incrementa topologyRevision y
  rematerializa todos los targets afectados.
- Una topología con fan-out sobre el cap se rechaza completa; ninguna partición deja precios bajo
  dos revisiones topológicas activas.
- Organización multi-moneda resuelve default por Venue.currency; input >2 decimales/rango se
  rechaza y hash usa string scale 2.
- Currency distinta a cualquier target produce cero writes; no existe conversión FX.
- SALE_PRICE actualiza Product.price/PricingPolicy.currentPrice; PURCHASE_COST sólo Product.cost
  compatible; costo de receta nunca se pisa.
- Target expansion, cap de 10,000, bulk writes y rollback total ante una línea fallida.
- Carrera de dos confirms: un APPLYING, cero re-POST, GET recuperable y APPLIED una sola vez;
  watchdog e intento vivo compiten por batch lock + attemptId/lease CAS y nunca producen
  FAILED después de un commit ni commit después de FAILED.
- ActivityLog organizationId/actor/query y resumen transaccional; el CHECK acepta callers legacy
  null sin aceptar combinaciones HUMAN/SERVICE inválidas. PublicationLine conserva detalle por
  target y cualquier falla de auditoría H1 revierte.
- Outbox co-committed/retry reproduce golden payloads de product_price_changed,
  menu_item_updated y menu_updated.
- Retry conserva eventId/venueSequence y orden; un crash emit-before-ack se deduplica en consumidor
  o converge por refetch at-least-once. oldPrice=0 emite priceChangePercent null, nunca Infinity/NaN.
- MCP aplica el mismo OrgRole/preview/confirm/idempotency.
- MCP sin `mcp:write`, membresía activa u orgRole nunca muta aunque el flag global esté apagado.
- Migración se prueba con Products enlazados a órdenes, inventario, recetas, modifiers y caches.

### Dashboard

- Grant OFF/unknown no muestra navegación ni dispara queries; rol insuficiente falla cerrado.
- Superadmin configura gates/readiness y PITS administra sólo dentro de organization scope.
- Tablas paginadas, conflictos/overrides y actual → nuevo preservan cero.
- Errores por renglón descargables; códigos import/export permanecen texto.
- Confirm queda deshabilitado con errores/stale y sólo existe una acción final.
- Importador master/identifiers es inequívocamente distinto del importador legacy de menú.
- createProduct legacy envía GTIN y su lista busca SKU/GTIN; aliases viven en la vista corporativa.
- ProductWizardDialog/create/edit/import legacy traducen 409/422, no retry y error por renglón.
- Reportes maestro/códigos/regional/cambios/giro tienen columnas versionadas.
- i18n es/en/fr, teclado, focus y lector de pantalla.

### Clientes

- Android: cache JSON sin/con proyección, round-trip, arranque frío y
  CartViewModel.resolveScannedBarcode; Product 200 + projection fallida conserva aliases.
- iOS: migración GRDB, Product.CodingKeys/init, GTIN/barcode preservados, cold restart y
  findByBarcode.
- TPV: migración Room no destructiva, DAO único y ambos scanners; regresiones separadas de
  Ordering, Mesas, Kiosk y quick-add; alias resuelve ProductEntity completo tras cold start.
- Desktop: JSON viejo/nuevo, CatalogCache y CheckoutScreen.onScanSubmit.
- En los cuatro: 404/falla conserva cache, código retirado desaparece tras refresh exitoso, precio
  exactamente cero se conserva y un cliente viejo sigue operando por SKU/GTIN.
- Golden vectors NFKC/trim/uppercase/ceros producen el mismo normalizedCode en server, Kotlin,
  Swift y Desktop; versión desconocida no hace matching.
- Golden de NEVER_ENABLED demuestra que cada cliente conserva su comparación legacy de
  SKU/GTIN/barcode; normalizationVersion 1 sólo cambia el match contra aliases/mirrors READY.
- Alias recibido antes que Product persiste independiente en los cuatro clientes y empieza a
  resolver cuando llega Product, aun después de haber avanzado revision.
- En las cuatro altas: 409/422 muestra conflicto/catálogo corporativo, no retry; checkout y
  grandfathered permanecen operativos.
- Publicación offline mantiene precio viejo; reconnect lo sustituye atómicamente; socket duplicado
  o ausente converge por refresh sin bloquear venta.

### Contratos y rendimiento

- Golden fixtures separados para envelopes Product legacy y proyección en `/dashboard`, `/mobile`
  y `/tpv`; consumo en los clientes.
- price escalar compatible con Android/TPV Double, TPV Mesas BigDecimal, iOS flexible y Desktop
  JsonPrimitive.
- catálogo org-wide paginado y sin cargar recipe/modifier graph.
- Benchmark NEVER_ENABLED de alta/cambio SKU/GTIN cumple p95/p99/throughput de D5 bajo contención;
  lectura, checkout, stock y precio conservan cero lock/query H1.
- preview/publicación de 200 source rows y de 6,200/10,000 targets expandidos dentro del cap.
- Pruebas mayores y timeout se ajustan cuando PITS entregue layout/volumen real.

## 17. Documentación y comentarios obligatorios

Antes de tocar código se crea docs/PITS-H1-CHANGE-MANIFEST.md. Cada fila registra:

- repo y ruta;
- símbolo/bloque;
- dueño de la tarea;
- estado;
- comportamiento anterior;
- comportamiento nuevo;
- por qué cambia;
- contrato/riesgo protegido;
- prueba;
- dependencia y orden de deploy.

Se actualizan:

- este spec;
- el plan de implementación;
- docs/SCHEMA_MAP.md;
- CHANGELOG.md de cada repo;
- PITS-HANDOFF y handoff de sesión;
- documentación API/MCP;
- diccionario de columnas y plantillas;
- guía administrativa;
- runbook de canary y demo.
- presentación comercial de PITS, one-pagers afectados y sus PDFs regenerados.

Regla de comentarios:

1. Cada modelo/campo nuevo explica su invariante y por qué es aditivo.
2. Cada función o bloque modificado explica la razón de compatibilidad, dinero, tenant boundary,
   concurrencia o idempotencia.
3. Un comentario describe por qué, no repite la sintaxis.
4. Migraciones SQL incluyen comentarios de constraints y rollout.
5. Tests documentan la regresión de producción que protegen.
6. JSON y formatos que no admiten comentarios se documentan en el manifest y en el source
   adyacente que los consume; no se invalida el formato.
7. Todo archivo tocado debe aparecer en el manifest antes de considerarse completo.

No se usa `git add -A` ni `git add .`. No se hace commit, push, reset, stash, checkout o clean sin
autorización explícita del usuario. Las rutas se manejan de forma explícita porque el worktree es
compartido.

## 18. Criterios de aceptación

Cada compromiso se cierra con un escenario observable, no con la afirmación circular de “está
implementado”:

| Fila | Escenario obligatorio | Salida observable/export | Prueba de aceptación |
|---|---|---|---|
| 43 | Alta RETAIL_PRODUCT con todos los campos de D10; omitir cada campo requerido en ENFORCED | Ficha con actor/fecha y catálogo maestro XLSX versionado | Cada omisión bloquea antes de CatalogItem/Product; alta válida publica sin cambiar Product.id |
| 44 | Alta PREPARED_DISH y asignación a dos venues, uno con Recipe completa y otro incompleto | Export por venue con receta, porciones, prepTime y costo por porción | Sólo el binding completo publica; no se copia Recipe ni se pisa calculatedCost |
| 45 | Un SKU corporativo con varios EAN/UPC/internal y colisión contra SKU/GTIN de otro Product | Alerta determinista y reporte de códigos asociados por SKU/código corto | Código único resuelve el mismo Product online/offline; colisión produce cero writes |
| 47 | Dos regiones superpuestas con priority y una excepción venue; precio/costo en moneda correcta/incorrecta | Reporte regional separa sale_price de purchase_cost y muestra scope/tiendas | Precedencia determinista; moneda incompatible revierte todo; aceptación contractual espera selección escrita de PITS |
| 68 | Cambio manual de un SKU/tienda y layout masivo de múltiples SKU/tiendas | Preview actual → nuevo y batch/export before/after | Product.price y PricingPolicy.currentPrice cambian atómicamente; un error deja cero writes |
| 69 | Usuario con `catalog-venue:read` consulta su tienda tras publicar → republicar → revertir → edición legacy | Pantalla `Vigentes`, historial, filtros y export por rango/SKU/código/batch | Sólo la última línea coincidente aparece vigente; reversión se etiqueta y divergencia legacy queda sólo en historial; no ve otra tienda |
| 71 | XLSX de códigos con EAN-13 válido, checksum malo, duplicado y celda numérica | Archivo de errores por renglón antes de aplicar y una sola acción final | Con error: cero CatalogIdentifier/ProductIdentifier; corregido: una confirmación idempotente |
| 248 | Perfiles distintos; artículo tienda, artículo restaurante, uno compartido y uno sin clasificación | Catálogo descargable filtrado por giro y versión de perfil | Cada filtro incluye/excluye correctamente, compartido aparece en ambos y el no clasificado se rechaza; perfiles sólo añaden al baseline |
| 46 habilitadora | Asignar master a Product existente y crear proyección nueva en tienda | Preview link/create/skip con conflictos | Confirmación humana obligatoria; no reidentifica ni reparenta Product |
| 191 habilitadora | Cargar layout real del catálogo PITS | Reporte completo de staging/errores y batch aplicado | Un error en cualquier hoja produce cero cambios operativos; no usa import replace legacy |

Además, H1 requiere en conjunto:

1. Organizaciones/venues NEVER_ENABLED —incluidos todos los no PITS— conservan conducta, status,
   envelopes y validaciones en POS, CRUD, menú, inventario, recetas y permisos. El único overhead
   admitido es el fence compartido de alta/cambio SKU/GTIN dentro del presupuesto p95/p99/throughput
   de D5; lectura, checkout, stock y precio no reciben queries ni locks nuevos.
2. Todos los Products preexistentes conservan ID, venue, stock, receta, modifiers y vínculos.
3. El bootstrap fenced detecta toda colisión cruzada antes de registryRequired.
4. SKU/GTIN legacy y aliases publicados se escanean offline en Android, iOS, TPV y Desktop;
   PAUSED_AFTER_IDENTIFIERS conserva lecturas/sync/409 operativo y sólo impide mutaciones
   corporativas.
5. APPLIED es atómico en servidor; un POS offline conserva el último precio bueno y converge al
   refrescar, sin stopper.
6. Un conflicto concurrente retorna 409/cero cambios parciales y dos confirms producen un solo
   efecto recuperable por idempotency key.
7. Cada alta/publicación conserva actor, fecha, managed before/after, batch y ActivityLog
   organizacional dentro de la transacción.
8. Un lote de hasta 10,000 targets se aplica completo o no se aplica; uno mayor se rechaza antes de
   escribir. Sólo operaciones comerciales independientes pueden partirse en nuevos previews; una
   mutación de topología o alcance atómico jamás se divide.
9. Todos los archivos/bloques tocados están en el manifest, sus razones están comentadas y la
   presentación/one-pagers/PDFs quedaron actualizados.
10. La demo usa layouts, volumen, perfiles y columnas de reporte entregados o aprobados por PITS;
    sin ellos puede existir software apagado/canary, pero no aceptación contractual final.

## 19. Decisiones pendientes de PITS

El correo enviado el 2026-08-08 solicita:

1. Productos/platillos/materias primas incluidos.
2. Campos corporativos vs. locales.
3. Política de excepciones.
4. Significado y membresía de región.
5. Precios regionales, excepciones y fecha efectiva.
6. Doble autorización.
7. Reporte de precio, costo o ambos.
8. Tipos y unicidad de códigos.
9. Significado de presentación e IEPS.
10. Campos obligatorios por giro.
11. Roles y visibilidad.
12. Layouts, archivos y volumen.

La implementación expand-only puede avanzar apagada con las decisiones seguras de este documento:
catálogo vendible primero, Product materializado, registro único de códigos, regiones de precio
many-to-many, cambios inmediatos y OrgRole OWNER/ADMIN. Las respuestas no deben reinterpretar datos
existentes ni activar automáticamente PITS.

Sí son puertas de aceptación/rollout:

- Materias primas requieren un diseño separado; no se agregan por configuración a este agregado.
- La matriz de campos por giro y layouts reales bloquea ENFORCED y el cierre de H1A/H1B.
- La elección precio/costo/ambos y columnas del reporte bloquea la aceptación de fila 47/H1C.
- Un maker-checker obligatorio requiere ampliar autorización organizacional antes de activarse.
- Vigencias futuras o semántica de presentación como conversión requieren otro diseño.

Hasta recibir respuesta, los defaults siguen ADVISORY, la fila 47 se demuestra con columnas
separadas y ninguna afirmación comercial se marca completa. La respuesta del correo y los layouts
se archivan como evidencia versionada antes de la aceptación final.

## 20. Puerta hacia implementación

Después de la aprobación de este spec:

1. Ejecutar la skill writing-plans.
2. Generar un plan por H1A/H1B/H1C con TDD, rutas exactas y checkpoints.
3. Decidir explícitamente ejecución inline o subagent-driven.
4. Crear el change manifest antes de la primera edición de código.
5. Verificar capacidad de máquina antes de suites completas, sin omitir pruebas obligatorias.
6. Implementar expand-first y mantener el entitlement apagado.

Hasta completar esos pasos, no se modifica schema, servicios, dashboard, clientes ni MCP.

## Apéndice A. Consulta read-only reproducible

Los conteos de la sección 2 se levantaron el 2026-08-08 en una transacción read-only. “Producto
activo” significa `active = true AND deletedAt IS NULL`. La conexión se proporciona por entorno y
no se documentan credenciales:

~~~sql
BEGIN TRANSACTION READ ONLY;

SELECT COUNT(*) AS organizations FROM "Organization";
SELECT COUNT(*) AS venues FROM "Venue";

SELECT COUNT(*) AS active_products
FROM "Product"
WHERE active = true AND "deletedAt" IS NULL;

SELECT COUNT(DISTINCT v."organizationId") AS organizations_with_active_products
FROM "Product" p
JOIN "Venue" v ON v.id = p."venueId"
WHERE p.active = true AND p."deletedAt" IS NULL;

SELECT COUNT(*) AS zones FROM "Zone";
SELECT COUNT(*) AS venues_with_zone FROM "Venue" WHERE "zoneId" IS NOT NULL;

WITH active_products AS (
  SELECT v."organizationId", p."venueId", p.sku, p.gtin
  FROM "Product" p
  JOIN "Venue" v ON v.id = p."venueId"
  WHERE p.active = true AND p."deletedAt" IS NULL
)
SELECT COUNT(*) AS repeated_sku_groups_across_venues
FROM (
  SELECT "organizationId", sku
  FROM active_products
  GROUP BY "organizationId", sku
  HAVING COUNT(DISTINCT "venueId") > 1
) repeated_skus;

WITH active_products AS (
  SELECT v."organizationId", p."venueId", p.gtin
  FROM "Product" p
  JOIN "Venue" v ON v.id = p."venueId"
  WHERE p.active = true AND p."deletedAt" IS NULL AND p.gtin IS NOT NULL
)
SELECT COUNT(*) AS repeated_gtin_groups_across_venues
FROM (
  SELECT "organizationId", gtin
  FROM active_products
  GROUP BY "organizationId", gtin
  HAVING COUNT(DISTINCT "venueId") > 1
) repeated_gtins;

ROLLBACK;
~~~
