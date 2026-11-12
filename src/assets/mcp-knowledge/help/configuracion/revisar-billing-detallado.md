---
title: Revisar billing detallado
description: Consulta tus facturas y los métodos de pago del local.
product: dashboard
category: configuracion
featureCode: AVOQADO_SETTINGS
dashboardRoutes:
  - settings/billing/history
  - settings/billing/payment-methods
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

Billing detallado está pensado para revisar cargos, facturas y métodos de pago desde el contexto de una sucursal. Antes de hacer cambios, confirma si estás revisando la suscripción del local, un add-on o una compra puntual.

Este módulo suele requerir rol OWNER o ADMIN y permisos de billing. Si el equipo financiero no usa Dashboard, define quién descargará facturas, quién actualizará métodos de pago y quién aprobará compras adicionales.

## Pasos

1. Abre **Configuración > Plan** y entra a la pestaña **Facturas**.
2. Usa la búsqueda por concepto y los filtros de estado y fecha para encontrar el cargo que buscas.
3. Descarga la factura, o reintenta un pago fallido, sólo cuando confirmes que el cargo corresponde al local correcto.
4. Entra a la pestaña **Métodos de pago** para revisar las tarjetas guardadas.
5. Si hay pagos fallidos o cambios administrativos, agrega la tarjeta nueva y márcala como predeterminada.
6. Regresa a **Facturas** y reintenta el pago pendiente con el método nuevo.

## Problemas frecuentes

Si no ves billing, tu usuario no tiene permisos suficientes o el local no tiene billing habilitado. Si un cargo aparece duplicado, compara fecha, concepto y estado antes de escalar. Si un pago falla, revisa el método predeterminado y la disponibilidad del banco.

## Buenas prácticas de control

Mantén billing limitado a pocos administradores. Los cambios de método de pago afectan la continuidad del plan, los add-ons y las suscripciones. Para conciliación, guarda periodo, concepto, moneda y estado de cada cargo revisado.

Antes de borrar una tarjeta, confirma que no es la predeterminada y que ya hay otra activa: sin un método válido, el siguiente cobro del plan puede fallar.

## Cuándo pedir ayuda

Contacta soporte si una factura no descarga, si el método de pago no se puede actualizar o si un cargo exitoso no activa el servicio. Incluye venue, concepto, fecha, monto, moneda y captura del estado en billing.
