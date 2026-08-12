# PITS — Fundamentos confirmados y compatibilidad legacy

**Fecha:** 2026-08-10

**Estado:** Dirección aprobada; implementación pendiente de plan escrito

**Alcance:** Tramo previo a H1B/H1C mientras PITS responde las aclaraciones finales

## 1. Propósito

Este documento define el trabajo que puede avanzar sin adivinar respuestas de PITS ni cambiar el comportamiento de organizaciones que ya
operan en producción. Es una enmienda acotada al diseño
[`2026-08-08-pits-h1-master-catalog-design.md`](./2026-08-08-pits-h1-master-catalog-design.md); no reabre H1A completo ni autoriza H1B/H1C.

La regla rectora es:

> Ningún requisito corporativo de PITS se convierte en una obligación global de `Product`, de sus writers o de los venues legacy. Sólo una
> organización y un venue incorporados explícitamente al gobierno corporativo cambian de comportamiento.

El trabajo de este tramo debe seguir siendo útil si PITS modifica una política pendiente. Una respuesta posterior puede seleccionar un mapeo
o una política; no debe obligar a reemplazar otra máquina de estados, otro registro de asignaciones o una segunda infraestructura de jobs.

## 2. Evidencia autoritativa disponible

Las respuestas de PITS confirman por ahora:

- catálogo total declarado de aproximadamente 73,000 SKUs y entrega posterior de un archivo maestro;
- validación integral: cualquier fila inválida impide aplicar el archivo completo;
- objetivo expresado de no más de 30 minutos, todavía condicionado por volumen no definido;
- Corporativo selecciona explícitamente las sucursales donde se ofrece cada producto;
- cada sucursal PITS pertenece obligatoriamente a una sola región geográfica;
- precio de venta y costo de compra son regionales y obligatorios para cada SKU–región;
- una persona puede preparar y confirmar operaciones ordinarias; una reversión requiere autorización de Gerencia de Compras;
- cualquier código impreso se conserva como texto; un SKU puede tener varios códigos activos; el más reciente es principal; los anteriores
  siguen funcionando; un código no se reutiliza para otro producto;
- Administración de Compras será un perfil dedicado; tienda sólo consulta valores vigentes de su sucursal;
- XLSX y CSV son requeridos; el reporte solicitado tiene grano SKU–región–sucursal.

El archivo de Villa 1 analizado en lectura contiene 5,019 SKUs únicos y códigos cortos, alfanuméricos y con ceros iniciales. No demuestra el
layout de múltiples códigos ni confirma por sí solo el volumen corporativo de 73,000 filas.

Continúan sin autoridad suficiente:

- propiedad de la receta: local por sucursal versus receta corporativa estandarizada;
- costo manual corporativo versus costo calculado desde receta;
- IVA, IEPS, claves SAT y efecto sobre cobro;
- moneda y zona horaria;
- máximo y frecuencia de una carga, y alcance exacto del objetivo de 30 minutos;
- retiro condicionado por inventario entre sucursales;
- autorización de reversión dentro o fuera de Avoqado;
- acuse por dispositivo;
- columnas del archivo legacy y layout de múltiples códigos;
- si la unicidad organizacional de códigos incluye materias primas.

## 3. Enmiendas inmediatas a los documentos H1

Antes de escribir persistencia H1B/H1C, la especificación y sus planes deben dejar de presentar como contrato vigente las siguientes
suposiciones:

1. **EAN-13 obligatorio.** La baseline D9 que exige EAN-13 con checksum para Tienda queda revocada por la respuesta explícita “se captura
   cualquier código impreso”. El requisito sustituto exacto —por ejemplo, si todo producto nuevo requiere al menos un código impreso— queda
   pendiente de las respuestas sobre filas históricas sin código.
2. **Varias regiones por venue.** PITS exige exactamente una. El modelo futuro debe conservar una ruta de evolución sin imponer regiones a
   otros clientes, pero H1C no puede afirmar múltiples regiones activas como contrato PITS.
3. **Excepción local por venue.** PITS la prohíbe. El motor existente se conserva como capacidad general; no se publicita ni autoriza para
   PITS.
4. **Receta siempre local.** La afirmación queda marcada como pendiente por contradicción directa entre respuestas.
5. **Costo de platillo siempre calculado.** Queda pendiente por contradicción con la captura manual corporativa.
6. **Caps 5,000/10,000 como capacidad PITS final.** Siguen siendo límites válidos de los contratos V1 actuales, pero no prueban capacidad
   para el volumen solicitado ni pueden convertirse en SLA.
7. **OWNER/ADMIN como perfiles finales.** El rol y sus permisos definitivos esperan el contrato de Administración/Gerencia de Compras.

Ninguna migración publicada se edita. Cualquier cambio posterior usa una nueva migración y una nueva versión contractual cuando corresponda.

## 4. Contrato de compatibilidad legacy

### 4.1 Comportamiento funcional

Para un venue con `catalogGovernanceEnforcedAt = NULL` y sin rollout corporativo:

- `Product.sku` conserva alcance y unicidad por venue;
- `Product.gtin`, precio, costo, categoría, receta, inventario, disponibilidad y permisos mantienen su semántica actual;
- no se requieren región, marca, fabricante, subfamilia, fotografía, IEPS, receta corporativa ni perfiles PITS;
- no se crea `CatalogItem`, binding, región, identificador o publicación de manera implícita;
- no se cambia el cuerpo o la respuesta de los endpoints legacy;
- no se exige un rol de Administración de Compras;
- no aparece una configuración nueva que el venue deba completar para continuar trabajando.

La obligatoriedad PITS vive en `CatalogItem`, perfiles de validación y rollout, nunca en constraints globales nuevos sobre `Product`.

### 4.2 Compatibilidad operativa

La compatibilidad no se limita al JSON. El fence actual adquiere un lock de Venue antes del fast path por cutoff nulo. Este tramo debe:

- inventariar todos los writers de `Product` que toman el fence;
- probar que lecturas, checkout, stock, precio y órdenes normales no agregan queries o locks del catálogo;
- conservar pruebas reales por dashboard, mobile, TPV, POS sync, delivery, onboarding e import de menú;
- ejecutar el benchmark comparativo ya prometido por D5 con 50 writers concurrentes en 10 venues;
- bloquear el despliegue de cualquier extensión si el incremento supera p95 5 ms, p99 20 ms o 5% de degradación de throughput.

El benchmark mide la ruta `NEVER_ENABLED`; apagar un módulo después no corrige overhead introducido antes del gate.

## 5. Staging de gran volumen sin aplicación autoritativa

### 5.1 Reutilización obligatoria

No se crea un framework genérico paralelo. Se extienden los contratos existentes:

- `CatalogImportBatch` y `CatalogImportLine` para staging y hallazgos;
- `CatalogIdempotencyRecord` para operación, key, hashes, lease, heartbeat y recovery;
- servicios actuales de capacidad, preview, confirmación y recovery;
- jobs/watchdogs/outbox existentes cuando su semántica sea aplicable.

Una nueva tabla o máquina PREVIEWED→APPLYING→APPLIED sólo se acepta si el plan demuestra que el contrato existente no puede representarla.

### 5.2 Lo autorizado ahora

El objetivo técnico es validar al menos 100,000 filas principales sin cargar todo el archivo ni todos los hallazgos simultáneamente en
memoria:

- ingestión a staging por páginas/chunks;
- validación cooperativa y reanudable;
- progreso durable y conteos exactos o lower-bound explícito;
- errores tenant-scoped con descarga paginada;
- cancelación y expiración recuperables;
- idempotencia por organización, operación y key;
- cero mutaciones a `CatalogItem`, `CatalogVenueBinding` o `Product` mientras exista cualquier error;
- un archivo 100% válido queda listo para una futura decisión de apply, no aplicado por este tramo.

Los límites de bytes, celdas, hojas y hallazgos se fijan mediante perfilado del archivo maestro y protección de memoria/event loop. La cifra
de 100,000 filas es un objetivo de validación, no un compromiso de confirmación atómica ni de tiempo.

### 5.3 Lo explícitamente diferido

Este tramo no decide ni implementa:

- un solo COMMIT con 73,000 `CatalogItem` o hasta 1.3 millones de targets de venue;
- activación por puntero de versión;
- materialización de `Product` por chunks;
- relajación de atomicidad comercial;
- SLA de 30 minutos;
- elevación directa de `CATALOG_IMPORT_CONFIRM_WORK_UNIT_LIMIT` o `CATALOG_PUBLICATION_TARGET_CAP`.

El presupuesto V1 real de confirmación es de 12,000 unidades de trabajo; un CREATE consume 10 además de la base y referencias. No se
describe como “cap de 10,000 filas”.

## 6. CSV y artefactos en background

CSV está confirmado, pero el layout final no. Este tramo puede construir solamente primitives compartidos:

- escritura streaming con memoria acotada;
- quoting/escaping determinista;
- neutralización de celdas que comienzan con `=`, `+`, `-` o `@` y rechazo de controles/Unicode inválido;
- códigos/SKUs tratados como texto y ceros iniciales preservados;
- contrato versionado que declare encoding, BOM, delimitador, fin de línea, escala decimal y timezone;
- artefacto durable con estado, expiración, actor, organización, filtros/hash y autorización en cada descarga;
- generación fuera del request y recuperación idempotente.

Antes de congelar `csv-v1`, PITS debe aceptar sus parámetros y el particionado de XLSX. No se implementa todavía la query final
SKU–región–sucursal ni el historial exportable.

## 7. Decisiones de modelo que este tramo sólo documenta

### 7.1 Identificadores

La persistencia queda diferida hasta cerrar y versionar la baseline H1B. El modelo futuro debe soportar:

- código de presentación y normalización separados;
- múltiples códigos activos por `CatalogItem`;
- reserva permanente incluso después de retiro;
- principalidad explícita con una secuencia o instante durable, no inferida del orden accidental de una carga;
- aislamiento organizacional y resolución no ambigua;
- decisión explícita sobre colisión con `RawMaterial.sku/gtin`.

No se cambia `Product.sku`/`Product.gtin` legacy en este tramo.

### 7.2 Regiones

No se crean endpoints de topología sin materialización de precio/costo. La forma de evolución recomendada para el diseño posterior es:

- tabla de membresía relacional con `priority` conservada;
- `UNIQUE(venueId)` mientras la política desplegada permita una sola región;
- constraint/perfil PITS que exige exactamente una región sólo después de onboarding;
- ausencia de región válida para organizaciones legacy;
- sin historial de cambio de región en PITS v1 porque PITS declaró que una sucursal no cambia de región.

Relajar `UNIQUE(venueId)` en el futuro es aditivo; limpiar membresías múltiples después no lo sería.

### 7.3 Asignación a sucursales

No se crea una segunda relación. `CatalogVenueBinding` ya representa `(organizationId,catalogItemId,venueId)` con `productId` nullable y
estados previos a `LINKED`. El diseño posterior debe evaluar extenderlo con procedencia de asignación (`assignedById`, `assignedAt`,
`assignmentSource`) y usar un estado pendiente, sin duplicar la verdad de dónde se ofrece un SKU.

### 7.4 Excepciones locales

`CatalogVenueOverride` y `catalog-venue:request-override` permanecen en el producto genérico. Para PITS:

- política organizacional efectiva `FORBIDDEN`;
- tienda no recibe permiso ni endpoint operativo de solicitud;
- UI explica “Administrado por Corporativo; esta organización no permite excepciones” donde exista un punto de entrada;
- no se agrega un switch por venue ni se cambia el flujo Product de organizaciones no incorporadas;
- habilitar excepciones para otro cliente requiere contrato comercial y activación explícita, no un cambio global.

La forma exacta de la política se define en el plan; no se inventa una segunda compuerta paralela al `OrganizationModule`.

## 8. Seguridad, privacidad y fallos

- Todo batch, fila, artefacto y filtro repite `organizationId`; las lecturas child cross-tenant son 404 indistinguibles.
- Upload, staging y descarga revalidan actor y membresía live; un URL de artefacto no es autoridad.
- Archivos y valores por fila no se escriben en logs generales.
- Los errores distinguen input inválido, capacidad, dependencia, estado stale, autorización y fallo interno.
- Un worker muerto deja lease recuperable; no marca APPLIED por haber escrito algunos chunks.
- La expiración de un artefacto no elimina la evidencia durable de la operación.
- Ninguna preparación de este tramo habilita `ENFORCED`, crea grants o modifica datos de producción.

## 9. Verificación requerida

### 9.1 Contrato legacy

- Matriz real de writers con `NEVER_ENABLED` y comparación de resultado/error contra el contrato actual.
- Tests arquitectónicos para nuevos call sites y SQL directo.
- Benchmark p50/p95/p99/throughput con resultados archivados.
- Prueba de cero queries de catálogo en reads/checkout/stock/precio.

### 9.2 Staging

- 0, 1, 5,019, 73,000, 100,000 y 100,001 filas.
- Error temprano, medio y final: cero autoridad mutada.
- Reintento, cursor repetido, lease vencida, cancelación y caída de worker.
- Hallazgos superiores al tamaño de página y descarga completa sin duplicados.
- Event-loop budget y memoria máxima medidos, no inferidos.
- Integración PostgreSQL disposable para concurrencia y recovery; nunca contra producción.

### 9.3 CSV/background

- Golden bytes para UTF-8, BOM/delimitador/CRLF cuando se aprueben.
- Comillas, saltos, comas, Unicode, ceros iniciales, fórmulas y límites.
- Descarga autorizada/revocada, expiración, retry y cleanup.
- Un reporte superior al límite de XLSX permanece descargable en CSV sin bloquear el request.

### 9.4 Gates finales

- Suites focales primero, typecheck/build del proyecto, lint/format sobre inventario exacto y `full-testing` antes de declarar terminado.
- Cambios de dinero, permisos, migraciones y concurrencia siguen TDD obligatorio.
- Integraciones o benchmarks no ejecutados se reportan con comando exacto; no se convierten en claims verdes.

## 10. Rollout y compatibilidad cross-repo

Este tramo es server-first y no cambia contratos consumidos por TPV/Android/iOS/Desktop. El dashboard sólo cambia cuando exista un contrato
aprobado de estado/progreso/descarga; los clientes de piso no necesitan configurar Catálogo Maestro.

Orden posterior:

1. server additive schema/service behind current organization entitlement/module;
2. dashboard corporativo para jobs, errores y descargas;
3. clientes de piso únicamente cuando exista un delta/materialización aprobados;
4. canary en una organización/venue explícitos;
5. PITS después de carga seca, reconciliación y aprobación;
6. ningún venue existente entra automáticamente.

No se crea un switch por cada capability. Tier/entitlement, activación del módulo, rollout y permiso conservan sus responsabilidades. Las
políticas corporativas viven dentro del dominio del catálogo y sólo se vuelven configurables cuando existe una necesidad comercial real.

## 11. Alternativas descartadas

### Esperar todas las respuestas

Reduce decisiones parciales, pero desperdicia tiempo en compatibilidad, staging y seguridad que son independientes. Se descarta como
estrategia total.

### Implementar todas las variantes con flags

Multiplica combinaciones, configuración y pruebas; además obligaría a venues legacy a entender PITS. Se descarta.

### Crear frameworks nuevos para 100k, asignación o jobs

Duplicaría `CatalogImportBatch`, `CatalogIdempotencyRecord`, recovery, watchdogs y `CatalogVenueBinding`. Se descarta; toda extensión debe
partir de los contratos existentes.

### Elevar directamente los caps V1

No prueba memoria, locks, constraint triggers ni atomicidad y puede convertir un 413 seguro en una transacción peligrosa. Se descarta.

## 12. Criterio de salida del tramo

El tramo termina cuando:

- las contradicciones documentales están enmendadas sin fingir que las respuestas pendientes se cerraron;
- la compatibilidad funcional y operativa de venues legacy está probada;
- staging valida el volumen objetivo sin mutar autoridad;
- CSV/background tiene un contrato versionable y seguro, sin afirmar el reporte final;
- no existe una segunda máquina de estados ni una segunda relación de asignación;
- todos los gates ejecutados están registrados con salida real;
- las preguntas bloqueantes permanecen visibles para la siguiente especificación.

No termina con identificadores H1B, regiones/precios H1C, receta, fiscalidad, retiro, permisos definitivos ni aplicación de 73,000 SKUs.

## 13. Estrategia de ejecución posterior al plan

El trabajo se presta a subagentes después de aprobar el plan, con ownership no solapado:

- **Compatibilidad:** inventario de writers, contratos legacy y benchmark.
- **Staging:** extensión de capacidad/validación/recovery sin apply autoritativo.
- **CSV/background:** writer seguro, lifecycle del artefacto y tests golden.
- **Agente principal:** enmiendas de spec/plan, integración, adjudicación de findings, gates globales y commits por rutas explícitas.

Ningún subagente decide políticas pendientes ni edita migraciones publicadas. El plan debe fijar archivos, RED/GREEN, checkpoints y orden de
integración antes de delegar.
