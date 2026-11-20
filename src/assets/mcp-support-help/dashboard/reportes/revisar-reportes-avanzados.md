---
title: Revisar reportes avanzados
description: Consulta reportes por método de pago, impuestos, cancelaciones, categorías y cuentas por cobrar.
product: dashboard
category: reportes
featureCode: AVOQADO_REPORTS
dashboardRoutes:
  - reports/payment-methods
  - reports/taxes
  - reports/voids
  - reports/sales-by-category
  - reports/pay-later-aging
roles:
  - OWNER
  - ADMIN
  - MANAGER
  - VIEWER
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - revisar-reportes-ventas
  - ver-pagos
keywords:
  - reporte por método de pago
  - reporte de impuestos
  - reporte de cancelaciones
  - ventas por categoría
  - los impuestos no coinciden
  - las categorías salen vacías
---

## Antes de empezar

Los reportes avanzados responden preguntas más específicas que el resumen de ventas. Sirven para separar ventas por método de pago, impuestos, cancelaciones, categorías y cuentas por cobrar. Algunas entradas avanzadas pueden aparecer como próximamente en el Dashboard; cuando una pantalla aún no está disponible, usa el reporte general y filtros existentes como respaldo.

Antes de compartir datos, confirma sucursal, rango de fechas, zona horaria, moneda y si estás revisando ventas cobradas, ventas netas o cuentas pendientes.

## Pasos

1. Abre **Reportes > Resumen de ventas** para establecer el total base.
2. Usa **Métodos de pago** cuando necesites separar tarjeta, efectivo, links u otros medios disponibles.
3. Usa **Impuestos** para revisar cargos fiscales cuando el reporte esté habilitado.
4. Revisa **Cancelaciones** para investigar voids, anulaciones o ventas eliminadas.
5. Consulta **Ventas por categoría** para comparar grupos del menú.
6. Entra a **Cuentas por cobrar** para revisar saldos pay later, antigüedad y seguimiento.
7. Exporta solo después de validar que el periodo y filtros coinciden con la pregunta del negocio.

## Problemas frecuentes

Si un reporte avanzado aparece como próximamente, no tendrá botón directo activo hasta que exista la pantalla en Dashboard. Si cuentas por cobrar no aparece, revisa permiso `tpv-reports:pay-later-aging`. Si impuestos o métodos de pago no coinciden con ventas, compara contra pagos, reembolsos, descuentos y cancelaciones. Si categorías salen vacías, revisa configuración del menú.

## Cómo comparar reportes

No todos los reportes suman igual. Métodos de pago explican cómo se cobró; impuestos explican componentes fiscales; cancelaciones explican ajustes; categorías explican qué se vendió; cuentas por cobrar explica lo pendiente. Para conciliación, cruza reportes con **Ventas > Transacciones** y **Saldo disponible**.

Cuando prepares un cierre, documenta el rango exacto y quién generó el reporte. Esto ayuda a resolver diferencias después, especialmente cuando hay ventas de varios turnos o sucursales.

## Cuándo pedir ayuda

Contacta soporte si cuentas por cobrar no carga, si un reporte disponible exporta datos distintos a la pantalla o si una métrica no se explica con filtros. Incluye reporte, fecha, sucursal, filtros y captura del total comparado.
