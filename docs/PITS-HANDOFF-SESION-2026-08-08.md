# PITS H1A — handoff de catálogo maestro (sesión 2026-08-08)

> Estado de software: alcance H1A implementado detrás de gates default-off y verificado en localhost/base desechable. Server, dashboard H1A
> y superadmin están GREEN; el gate global conserva FAIL por siete E2E legacy del dashboard ajenos a H1A. Esto no autoriza el deploy global
> del dashboard ni equivale todavía a aceptación comercial de PITS.

## 1. Qué se construyó

H1A separa por primera vez el catálogo corporativo de los `Product` operativos de cada sucursal. El catálogo controla identidad, atributos,
obligatoriedad, distribución y evidencia; `Product` conserva su ID, categoría, menú, modificadores, receta, inventario y relaciones locales.

El alcance incluye:

- autoridad por organización: entitlement, módulo, configuración, roles y permisos;
- artículos, referencias, identificadores corporativos, IVA/IEPS/SAT, valores corporativos y tipos de negocio;
- perfiles de validación V1 y readiness de producto/platillo;
- importación XLSX exacta con worker aislado, preview, confirmación, idempotencia y errores durables;
- binding `CatalogItem` → `Product` por venue, override maker-checker y publicación/inversa;
- exportaciones master, por tipo de negocio, template de importación y errores;
- dashboard corporativo, cinco rutas de venue, control plane de superadmin y siete tools MCP;
- auditoría con actor humano/servicio, outbox, watchdog, recuperación y locks de autoridad;
- documentación de contrato y runbook de despliegue/rollback.

## 2. Qué no se construyó

H1A no debe venderse como el cierre completo de todos los renglones relacionados:

- `Regions` y `RegionalValues` salen con headers pero sin datos;
- identificadores regionales y precios regionales son H1B/H1C;
- la agrupación comercial final de múltiples EAN por SKU requiere el alcance específico posterior;
- la matriz exacta de atributos obligatorios de PITS y sus layouts reales no están recibidos ni archivados;
- no existe todavía un enlace público/clickable del deck web dentro de Git; marketing debe asignar dueño, URL y evidencia de publicación.

## 3. Autoridad y acceso

No hay acceso implícito por pertenecer a un venue ni por tener JWT histórico. La autoridad efectiva requiere:

1. entitlement H1 activo para la organización;
2. `OrganizationModule.MASTER_CATALOG` habilitado;
3. configuración de catálogo válida y no vencida;
4. `Staff.active=true` y membresía vigente en la organización;
5. rol `OWNER`/`ADMIN` para comandos corporativos, o el permiso exacto del venue para operaciones de sucursal;
6. no estar impersonando para mutaciones H1;
7. `mcp:write` adicional para cualquier tool MCP que escriba.

Entitlement, módulo, configuración y estado ENFORCED son decisiones separadas. Una sola no concede las otras.

## 4. Default-off y compatibilidad

La migración crea estructura, constraints, índices y triggers; no crea grants, módulos activos, configuraciones activas ni catálogos. Los
seeds tampoco conceden H1. Sin las tres autoridades efectivas:

- las rutas H1 fallan cerradas;
- la administración H1 no aparece en dashboard/MCP;
- los writers legacy no hacen lecturas H1;
- Product, menú, inventario, receta, orden y POS conservan el contrato anterior.

Los gates se adquieren dentro de la misma transacción que protege una mutación vendible. Activar/desactivar el módulo es la palanca de
rollback funcional; no se borran tablas ni se revierte la migración expand-only.

## 5. Flujo demostrable

La aceptación técnica de un canary debe mostrar, en una organización de prueba aislada:

1. acceso OFF: UI oculta, rutas denegadas y cero consultas H1 en flujos legacy;
2. grant explícito: se abre acceso corporativo sin poner ningún venue ENFORCED;
3. alta/import preview: ningún `Product` cambia;
4. confirm de import: catálogo y auditoría durable, sin publicación automática;
5. binding: se preservan Product ID, relaciones y configuración local;
6. publication preview/confirm: snapshot, decisiones y outbox exactos;
7. inverse publication: vuelve el managed snapshot anterior sin tocar campos locales;
8. disable: nuevas mutaciones H1 se detienen y Product sigue operativo.

## 6. Contratos de referencia

- [HTTP API](./api/master-catalog-h1a.md)
- [MCP](./mcp/master-catalog-h1a.md)
- [Exportaciones XLSX](./xlsx/catalog-master-v1.md)
- [Importación XLSX](./xlsx/catalog-master-import-v1.md)
- [Rollout y rollback](./PITS-H1A-ROLLOUT-RUNBOOK.md)
- [Plan ejecutable y matriz final](./superpowers/plans/2026-08-08-pits-h1a-catalog-core.md)
- [Design aprobado](./superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md)
- [Manifest de cambios/evidencia](./PITS-H1-CHANGE-MANIFEST.md)

## 7. Estado PITS de los renglones observables

| Renglón | Estado H1A                           | Evidencia                                                | Bloqueador contractual                           |
| ------- | ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------ |
| 43      | software parcial listo               | atributos corporativos, validación, actor, export master | región/precio regional H1B/H1C; layout real PITS |
| 44      | software parcial listo               | mismo catálogo + receta/porciones/prep/costo vivo        | matriz final de platillo PITS                    |
| 46      | software listo                       | binding y publicación por sucursal, preservación Product | selección de venues/oleadas aprobada por PITS    |
| 191     | enabler H1A listo                    | template/import preview-confirm/error workbook           | layouts de los demás catálogos estáticos         |
| 248     | software listo, aceptación pendiente | perfiles por tipo de negocio y export filtrado           | matriz PITS de campos obligatorios/versionada    |

No marcar un renglón como “aceptado” sólo porque la suite esté verde. PITS/LDM deben entregar y aprobar el layout, la matriz y el escenario
observable correspondiente.

## 8. Despliegue

El backend `develop` no llega automáticamente a staging: el staging de Render está suspendido y Fly auto-deploy está deshabilitado.
Dashboard `develop` sí puede alcanzar demo. El orden seguro es:

1. crear/reactivar backend manual aislado;
2. migrar expand-only con gates OFF;
3. probar default-off y legacy;
4. desplegar dashboard/superadmin;
5. conceder sólo a la organización canary;
6. observar preview antes de habilitar cualquier venue;
7. pasar `ADVISORY` y luego `ENFORCED` venue por venue;
8. deshabilitar módulo/config ante cualquier anomalía.

El comando y checklist completos viven en el runbook. Nunca usar producción como primer canary.

## 9. Handoff operativo

- Dueño backend/migración: plataforma Avoqado.
- Dueño dashboard/superadmin: plataforma Avoqado.
- Dueño de layout y matriz de obligatoriedad: PITS/LDM.
- Dueño de canary/ENFORCED: operación Avoqado con aprobación explícita de PITS.
- Dueño del deck web clickable: marketing/comercial; debe registrar URL y captura después de publicar.
- Evidencia técnica: manifest, reportes Task 1–11, gates Task 12–14 y full-testing Task 15.

Si una verificación está pendiente, escribir `PENDING` o `DEFERRED` con su comando exacto. No sustituir evidencia de base real con mocks ni
llamar “staging” a localhost.
