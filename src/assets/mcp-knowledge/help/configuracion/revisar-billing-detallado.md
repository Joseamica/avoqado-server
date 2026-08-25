---
title: Revisar billing detallado
description: Consulta historial de facturacion, metodos de pago y tokens del local.
product: dashboard
category: configuracion
featureCode: AVOQADO_SETTINGS
dashboardRoutes:
  - settings/billing/history
  - settings/billing/payment-methods
  - settings/billing/tokens
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - comprar-addons-suscripciones
  - asignar-permisos-roles
---

## Antes de empezar

Billing detallado esta pensado para revisar cargos, facturas, metodos de pago y consumo de tokens desde el contexto de una sucursal. Antes de hacer cambios, confirma si estas revisando una suscripcion del local, una compra puntual o tokens usados por funciones que consumen presupuesto de asistencia o analisis.

Este modulo suele requerir rol OWNER o ADMIN y permisos de billing. Si el equipo financiero no usa Dashboard, define quien descargara facturas, quien actualizara metodos de pago y quien aprobara compras adicionales.

## Pasos

1. Abre **Configuracion > Facturacion y add-ons > Historial**.
2. Usa filtros de fecha, estado o concepto para encontrar facturas y compras de tokens.
3. Descarga o reintenta un pago solo cuando confirmes que el cargo corresponde al local correcto.
4. Entra a **Metodos de pago** para revisar tarjetas o instrumentos disponibles.
5. Actualiza el metodo principal si hay pagos fallidos o cambios administrativos.
6. Abre **Tokens** para revisar saldo, consumo y compras relacionadas.
7. Cruza historial y tokens si necesitas explicar un cargo por analisis o asistencia.

## Problemas frecuentes

Si no ves billing, tu usuario no tiene permisos suficientes o el local no tiene billing habilitado. Si un cargo aparece duplicado, compara fecha, concepto y estado antes de escalar. Si un pago falla, revisa metodo principal y disponibilidad del banco. Si faltan tokens, revisa historial de compras y consumo antes de comprar mas.

## Buenas practicas de control

Mantiene billing limitado a pocos administradores. Cambios de metodo de pago afectan continuidad de add-ons, suscripciones y compras de tokens. Para conciliacion, guarda periodo, concepto, moneda y estado de cada cargo revisado.

Cuando compres tokens, revisa el saldo anterior y el saldo esperado despues de la compra. Si el consumo viene de una herramienta de analisis, valida tambien que la persona que la uso tenga permiso y que el trabajo realizado corresponda al local.

## Cuando pedir ayuda

Contacta soporte si una factura no descarga, si el metodo de pago no se puede actualizar, si un cargo exitoso no activa el servicio o si los tokens comprados no aparecen. Incluye venue, concepto, fecha, monto, moneda y captura del estado en billing.
