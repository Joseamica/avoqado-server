---
title: Conectar Avoqado con Claude o ChatGPT
description: Consulta y opera tu negocio (ventas, reservaciones, clientes, caja, personal, menú e inventario) desde Claude o ChatGPT con la cuenta y los permisos que ya tienes en Avoqado.
product: dashboard
category: configuracion
dashboardRoutes:
  - settings/role-permissions
roles:
  - OWNER
  - ADMIN
  - MANAGER
  - VIEWER
lastVerified: 2026-11-26
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - asignar-permisos-roles
keywords:
  - conectar con chatgpt
  - conectar con claude
  - conector de avoqado
  - claude no encuentra una sucursal
  - chatgpt dice que necesito otro plan
  - no me deja cambiar algo desde claude
---

## Antes de empezar

El conector de Avoqado permite que un asistente de IA, como Claude de Anthropic o ChatGPT de OpenAI, consulte la información de tu negocio y haga cambios que tú le pidas. Necesitas una cuenta activa de Avoqado. El asistente ve y hace **sólo lo que tu usuario ya puede ver y hacer** en cada sucursal: si en una sucursal eres administrador y en otra sólo consultas, el asistente respeta esa diferencia. También cuentan tu plan y si el módulo está activo: por ejemplo, reservaciones, lealtad y reportes avanzados requieren el plan Pro, y el control de inventario y recetas el plan Premium. Corregir las piezas de un producto se puede en todos los planes; registrar compras o merma por el asistente pide el control de inventario.

Cada conexión queda ligada a **una organización**. Si eres dueño de la organización, el asistente puede responder sobre todas sus sucursales juntas; si perteneces a dos organizaciones, eliges una al conectar y puedes conectar la otra por separado.

El conector cubre la operación diaria: ventas y reportes, órdenes, pagos y reembolsos registrados, menú y catálogo, inventario y compras, traslados entre sucursales, reservaciones y clases, clientes y lealtad, promociones, mesas, caja y turnos, personal y asistencia, comisiones y propinas, impresoras y reseñas. **No incluye** ejecutar cobros ni reembolsos, identificadores oficiales (RFC, CURP, NSS), facturación (CFDI), nómina ni compra de planes.

## Pasos

1. En Claude, abre **Customize > Connectors** y busca **Avoqado**. Si lo agregas manualmente, usa la dirección `https://api.avoqado.io/mcp/directory`.
2. Pulsa **Conectar**. Se abre la página de Avoqado: inicia sesión con tu correo y contraseña de Avoqado.
3. Si perteneces a varias organizaciones, elige con cuál quieres conectar.
4. Pulsa **Autorizar acceso**. Al volver a Claude, la conexión aparece activa.
5. Haz una pregunta, por ejemplo:
   - «¿Cómo van las ventas de hoy en todas mis sucursales?»
   - «¿Cuáles fueron los 5 productos más vendidos la semana pasada en Centro?»
   - «¿Qué productos se me están acabando?»
   - «¿Qué reservaciones tengo mañana?»
   - «¿Cuánto efectivo debería haber en la caja ahorita?»
   - «¿Quién no ha llegado a trabajar hoy?»
   - «Sube el precio del Café Latte a $55 en la sucursal Norte.»
6. Cuando pides un cambio que afecta a clientes o existencias (precio, disponibilidad de un producto, ajuste de inventario, receta, proveedor), el asistente primero te muestra **una vista previa** con el valor actual y el nuevo. El cambio sólo se aplica cuando confirmas. Crear una categoría, un producto o un insumo nuevo se aplica al momento.

En ChatGPT los pasos son equivalentes desde su sección de aplicaciones o conectores.

## Problemas frecuentes

- **«No encuentro una sucursal»:** la conexión sólo ve la organización que elegiste y las sucursales donde tu usuario tiene acceso. Revisa tus permisos en **Configuración > Roles y permisos** o desconecta y vuelve a conectar eligiendo la otra organización.
- **«Me dice que necesito otro plan»:** la función depende del plan del negocio o de un módulo apagado. El mensaje indica cuál.
- **«No me deja cambiar algo»:** tu rol en esa sucursal no tiene ese permiso. Pídeselo al dueño o administrador.
- **Ventas en cero:** las cifras se calculan por la zona horaria de cada sucursal y sólo cuentan pagos completados.

## Privacidad y desconexión

Avoqado guarda durante 90 días un registro técnico de las llamadas (qué herramienta, cuándo y si funcionó), sin los datos de la respuesta. El proveedor del asistente procesa tu conversación según sus propias condiciones. Puedes desconectar Avoqado en cualquier momento desde los conectores de tu asistente. Detalle completo en el [Aviso de privacidad, sección 14](/privacy).

## Cuándo pedir ayuda

Escríbenos a hola@avoqado.io con tu correo de Avoqado, la sucursal, la pregunta que hiciste y la respuesta que recibiste.

## In English

Avoqado's connector lets Claude or ChatGPT work with the daily operation of your business (sales and reports, orders, recorded payments, menu, inventory and purchasing, reservations, customers and loyalty, promotions, tables, cash and shifts, staff and attendance, printers and reviews) and make changes you request. Sign in with your Avoqado account (OAuth) at `https://api.avoqado.io/mcp/directory`; each connection is bound to one organization, and every tool enforces your role and permissions at each branch, your plan and module activation. Price, availability, stock, recipe and supplier changes show a preview and apply only after you confirm. Executing payments or refunds, government identifiers, tax invoicing, payroll and plan purchases are not included. Example prompts: "How are today's sales across all my branches?", "Top 5 products last week at Centro", "Which products are running low?", "What reservations do I have tomorrow?", "How much cash should be in the drawer?". Support: hola@avoqado.io. Privacy: https://avoqado.io/privacy (section 14).
