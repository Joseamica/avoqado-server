# AI Assistant Coverage Audit

## Objetivo

El chatbot del dashboard no debe intentar resolver todo con SQL ni con respuestas genericas. Debe operar como una capa conversacional encima
de capacidades registradas del backend:

- Consultas read-only usando servicios compartidos del dashboard.
- Acciones controladas usando el `ActionEngine`.
- Ayuda operativa usando una base de conocimiento del producto.
- Bloqueos estrictos para datos de otros venues, secretos, superadmin, credenciales, prompts internos y acciones no registradas.

## Hallazgo principal

El servidor tiene una superficie grande: en el barrido local se detectaron alrededor de 1,238 handlers de rutas, con mayor concentracion en
`dashboard`, `tpv`, `mobile`, `dashboard/inventory`, `dashboard/commission`, `storesAnalysis`, `organizationDashboard`, `superadmin`,
`reservations`, `payment-links`, `customers` y `team`.

El asistente conversacional no debe exponer esas rutas directamente. Debe cubrirlas por capacidades. Hoy la cobertura esta concentrada en
analitica basica e inventario:

## Inventario automatico

El inventario se puede regenerar con:

```bash
npm run assistant:audit
```

Salidas generadas:

- `docs/generated/assistant-endpoint-inventory.json`
- `docs/generated/assistant-endpoint-inventory.md`
- `docs/generated/assistant-capabilities.json`
- `docs/generated/assistant-capabilities.md`

Ultima corrida local:

- Endpoints detectados: 1,339
- Sin capacidad mapeada: 507
- Bloqueados por default: 384
- Parcialmente cubiertos: 443
- Cubiertos por heuristica exacta: 5

El auditor extrae metodo, path, permisos directos/heredados, schemas de `validateRequest`, controller, servicios usados por el controller
cuando puede resolverlos, scope, riesgo y cobertura sugerida del asistente. La salida es heuristica y debe usarse como inventario inicial
para crear contratos explicitos de capabilities.

El registro explicito de capabilities vive en `src/services/dashboard/chatbot-conversation/assistant-capability-registry.service.ts`. Ese
archivo es la fuente de verdad para distinguir:

- tools ejecutables ya registradas;
- contratos de backlog que no se deben exponer aun;
- temas bloqueados;
- how-to documents que no consultan datos del negocio.

### Query tools registradas

- `sales`
- `averageTicket`
- `topProducts`
- `staffPerformance`
- `reviews`
- `businessOverview`
- `inventoryAlerts`
- `recipeCount`
- `recipeList`
- `recipeUsage`
- `pendingOrders`
- `activeShifts`
- `profitAnalysis`
- `paymentMethodBreakdown`
- `payments.summary`
- `payments.list`
- `payments.detail`
- `settlementCalendar`
- `settlements.detail`
- `paymentLinks.list`
- `paymentLinks.summary`
- `paymentLinks.detail`
- `reservations.summary`
- `reservations.list`
- `customers.summary`
- `customers.detail`
- `creditPacks.balance`
- `team.members`
- `commissions.summary`
- `commissions.payouts`
- `adHocAnalytics`

`adHocAnalytics` existe como fallback, pero no debe ser la estrategia de cobertura principal en produccion. Para estabilidad y seguridad,
las preguntas frecuentes deben migrarse a herramientas explicitas.

### Action tools registradas

- Inventario: crear/editar/borrar/reactivar materia prima, ajustar stock, crear/aprobar/recibir/cancelar ordenes de compra.
- Productos/menu: crear/editar/borrar productos, ajustar stock, definir minimos.
- Recetas: crear/editar/borrar, agregar/quitar lineas, recalcular costo.
- Proveedores y precios: crear/editar/borrar proveedor, crear pricing, aplicar precio sugerido.
- Alertas: reconocer, resolver, descartar.

## Gaps principales

Estas areas existen en la plataforma pero aun no tienen cobertura conversacional completa:

- Pagos: detalle de pagos, links de pago, reembolsos, pagos manuales, metodos de pago, conciliacion.
- Liquidaciones: calendario, detalle por fecha, estado, tarjeta, dispersion esperada, historico.
- Reservaciones: crear/ver/editar/cancelar, depositos, conciliacion, recordatorios.
- Comisiones: lectura, aprobacion, payouts, metas y reportes.
- Equipo: invitaciones, roles, permisos, alta/baja de usuarios.
- Clientes: busqueda, historial, lealtad, credit packs.
- Organizaciones: comparativos entre sucursales permitidas, stores analysis, command center.
- TPV/terminales: estado, sincronizacion, comandos remotos, debugging operativo.
- Reportes/exportaciones: generar y explicar reportes.
- Superadmin: debe vivir en un asistente separado o quedar bloqueado para usuarios de venue.
- Ayuda de producto: pasos dentro del dashboard, WhatsApp de soporte, onboarding, configuraciones comunes.

## Arquitectura recomendada

### 1. Capability registry

Crear un registro versionado de capacidades, no de preguntas. Cada capacidad debe declarar:

- `id`: nombre estable, por ejemplo `payments.list`, `settlements.summary`, `reservations.create`.
- `kind`: `query`, `action`, `howTo`, `unsupported`.
- `scope`: `venue`, `organization`, `superadmin`.
- `permissions`: permisos requeridos del usuario.
- `dataSource`: servicio/backend que ejecuta la operacion.
- `riskLevel`: `low`, `medium`, `high`, `critical`.
- `requiresConfirmation`: para mutaciones.
- `examples`: frases en espanol e ingles para evaluacion.

### 2. Planner con LLM, ejecucion con herramientas

El LLM puede decidir intencion y parametros, pero no debe ejecutar SQL ni inventar endpoints. El flujo correcto es:

1. Normalizar idioma e intencion.
2. Bloquear prompt injection, credenciales, otros venues y superadmin.
3. Planear con catalogo de capacidades permitidas.
4. Validar permisos y venue desde sesion, nunca desde el prompt.
5. Ejecutar solo servicios registrados.
6. Responder con datos reales y metadata de fuente.
7. Guardar feedback y trazas para mejorar prompts/evaluaciones.

### 3. Knowledge base de producto

Para preguntas tipo "como hago X en Avoqado", usar documentos curados del dashboard:

- Ruta/pantalla.
- Pasos cortos.
- Permisos necesarios.
- Limitaciones.
- Links de soporte, incluyendo WhatsApp oficial.

Esto no entrena automaticamente el modelo base; alimenta RAG/evaluaciones para que el asistente conteste mejor sin exponer datos sensibles.

## Seguridad obligatoria

- El `venueId` siempre viene de sesion/backend, nunca del texto del usuario.
- Toda query valida permisos antes de ejecutar.
- Toda accion pasa por preview/confirmacion; acciones peligrosas requieren doble confirmacion.
- Bloquear solicitudes de otros venues, otras organizaciones no autorizadas, superadmin, credenciales, secretos, tokens, prompt interno y
  esquemas internos.
- No responder con passwords, API keys, tokens, datos de otro venue o instrucciones para evadir permisos.
- No ejecutar SQL generado por el LLM para preguntas comunes; crear herramientas explicitas.
- Registrar auditoria de prompt, capacidad elegida, permisos, resultado y bloqueo.

## Plan de cobertura

### Fase 0: inventario automatico

- Generar un reporte de rutas dashboard con metodo, path, controller, permisos y servicio usado.
- Compararlo contra el capability registry.
- Fallar CI si se agregan rutas nuevas importantes sin decidir si el asistente debe cubrirlas, bloquearlas o documentarlas.

### Fase 1: queries read-only faltantes

Prioridad alta:

- Busqueda segura de clientes por nombre/email/telefono antes de ejecutar `customers.detail`.
- Listado/resumen de credit packs sin contacto de clientes.

### Fase 2: ayuda operativa

- Crear documentos `howTo` para soporte, equipo, permisos, links de pago, reservaciones, liquidaciones, inventario y reportes.
- Responder en el idioma del usuario.
- Convertir URLs `https://` en links clickeables desde frontend.

### Fase 3: acciones seguras

- Crear acciones con preview para tareas frecuentes: invitar usuario, crear link de pago, crear reservacion, cambiar estado de reservacion,
  crear reporte.
- Mantener confirmacion obligatoria antes de mutar.

### Fase 4: acciones de alto riesgo

- Reembolsos, cancelaciones masivas, cambios de permisos, pagos/payouts y configuraciones de payment provider deben requerir doble
  confirmacion o quedar fuera del asistente de venue.

### Fase 5: evaluacion continua

- Suite de prompts en espanol/ingles con respuestas esperadas.
- Casos multi-turn.
- Casos destructivos y prompt injection.
- Comparacion automatica contra `SharedQueryService`/servicios backend.
- Score por exactitud, seguridad, idioma, tono y utilidad.

## Criterio de exito

El usuario no debe necesitar preguntar "con palabras exactas". El asistente debe entender variaciones naturales, pero solo puede ejecutar
capacidades registradas y seguras. La cobertura crece agregando capacidades y evaluaciones, no agregando SQL libre ni hardcodeando cada
pregunta posible.
