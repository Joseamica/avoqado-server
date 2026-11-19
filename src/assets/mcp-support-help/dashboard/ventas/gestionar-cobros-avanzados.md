---
title: Gestionar cobros avanzados
description: Revisa tus cuentas de cobro y sus reglas, terminal virtual y disputas.
product: dashboard
category: ventas
featureCode: AVOQADO_PAYMENTS
dashboardRoutes:
  - payments/routing-rules
  - virtual-terminal
  - disputes
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-11-18
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - ver-pagos
  - crear-liga-pago
  - comprar-addons-suscripciones
keywords:
  - terminal virtual
  - disputas
  - contracargo
  - cuentas merchant
  - configuración de pagos
  - reglas de cobro
  - el cliente desconoce un cargo
---

## Antes de empezar

Cobros avanzados cubre pantallas sensibles: reglas de cobro, terminal virtual y disputas. Las cuentas de cobro (cuentas merchant) de tu negocio las da de alta y las configura el equipo de Avoqado: **Config. de pagos** y **Cuentas merchant** son pantallas de ese equipo y no aparecen en tu panel. Si no las ves, no está roto.

Antes de cambiar cualquier configuración, identifica si el objetivo es activar cobros, revisar una cuenta procesadora, cobrar manualmente o responder una disputa. Cada caso requiere información distinta.

## Pasos

1. Abre **Ventas > Transacciones** para confirmar el estado actual de cobros.
2. Abre **Ventas > Reglas de cobro** (la pantalla dice **Reglas de cuentas de cobro**) para ver tus cuentas de cobro y decidir cuándo aparece cada una en la terminal: por **Horario**, **Ubicación**, **Monto del ticket**, **Tope de monto procesado** o **Quién cobra**. Es del plan Premium.
3. Si la pantalla dice «Este negocio aún no tiene cuentas de cobro configuradas. Contacta a soporte para agregarlas.», o te falta una cuenta, pídesela a soporte.
4. **Terminal Virtual** todavía dice **Muy pronto**: aún no se cobra con ella desde el panel.
5. **Disputas** también dice **Muy pronto**: si un cliente desconoce un cargo o hay un contracargo, pide ayuda a soporte.
6. Documenta cualquier cambio con fecha, usuario y motivo.

## Problemas frecuentes

Si una ruta te redirige o no aparece en el menú, revisa rol, permisos, KYC y si la función está activa para el local. Si una cuenta de cobro aparece incompleta, no la des por buena sin validar con soporte. Con una regla, si ninguna cuenta la cumple, la terminal muestra todas con un aviso: una regla nunca bloquea una venta. Si una disputa no tiene evidencia suficiente, recopila recibo, orden, fecha, monto y comprobante de entrega o consumo antes de responder.

## Qué datos tener listos

Para revisar una cuenta de cobro con soporte, prepara sucursal, proveedor, moneda, estado KYC y método de liquidación esperado. Para un cobro manual, valida si el local está autorizado a hacer cobros manuales. Para disputas, prepara información que demuestre que el cargo fue válido, sin compartir datos sensibles completos del cliente.

Las pantallas de cobros avanzados tienen mayor riesgo operativo que un reporte. Una regla mal puesta puede esconder en la terminal la cuenta que sí debía usarse o afectar conciliación, así que cualquier ajuste debe tener aprobación interna.

## Cuándo pedir ayuda

Escala a soporte si una cuenta de cobro está bloqueada o falta, si **Reglas de cobro** muestra errores al guardar, si necesitas cobrar con terminal virtual o si una disputa requiere respuesta formal. Incluye sucursal, pantalla, proveedor, monto, fecha y captura del estado.
