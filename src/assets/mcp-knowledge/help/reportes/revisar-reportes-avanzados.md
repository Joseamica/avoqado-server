---
title: Revisar reportes avanzados
description: Consulta reportes por metodo de pago, impuestos, cancelaciones, categorias y cuentas por cobrar.
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
---

## Antes de empezar

Los reportes avanzados responden preguntas mas especificas que el resumen de ventas. Sirven para separar ventas por metodo de pago, impuestos, cancelaciones, categorias y cuentas por cobrar. Algunas entradas avanzadas pueden aparecer como proximamente en el Dashboard; cuando una pantalla aun no esta disponible, usa el reporte general y filtros existentes como respaldo.

Antes de compartir datos, confirma sucursal, rango de fechas, zona horaria, moneda y si estas revisando ventas cobradas, ventas netas o cuentas pendientes.

## Pasos

1. Abre **Reportes > Resumen de ventas** para establecer el total base.
2. Usa **Metodos de pago** cuando necesites separar tarjeta, efectivo, links u otros medios disponibles.
3. Usa **Impuestos** para revisar cargos fiscales cuando el reporte este habilitado.
4. Revisa **Cancelaciones** para investigar voids, anulaciones o ventas eliminadas.
5. Consulta **Ventas por categoria** para comparar grupos del menu.
6. Entra a **Cuentas por cobrar** para revisar saldos pay later, antiguedad y seguimiento.
7. Exporta solo despues de validar que el periodo y filtros coinciden con la pregunta del negocio.

## Problemas frecuentes

Si un reporte avanzado aparece como proximamente, no tendra boton directo activo hasta que exista la pantalla en Dashboard. Si cuentas por cobrar no aparece, revisa permiso `tpv-reports:pay-later-aging`. Si impuestos o metodos de pago no coinciden con ventas, compara contra pagos, reembolsos, descuentos y cancelaciones. Si categorias salen vacias, revisa configuracion del menu.

## Como comparar reportes

No todos los reportes suman igual. Metodos de pago explican como se cobro; impuestos explican componentes fiscales; cancelaciones explican ajustes; categorias explican que se vendio; cuentas por cobrar explica lo pendiente. Para conciliacion, cruza reportes con **Ventas > Transacciones** y **Saldo disponible**.

Cuando prepares un cierre, documenta el rango exacto y quien genero el reporte. Esto ayuda a resolver diferencias despues, especialmente cuando hay ventas de varios turnos o sucursales.

## Cuando pedir ayuda

Contacta soporte si cuentas por cobrar no carga, si un reporte disponible exporta datos distintos a la pantalla o si una metrica no se explica con filtros. Incluye reporte, fecha, sucursal, filtros y captura del total comparado.
