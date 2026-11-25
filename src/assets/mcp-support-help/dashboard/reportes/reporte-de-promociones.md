---
title: Reporte de promociones (cuánto vendieron tus combos y paquetes)
description: Revisa cuántas veces se vendió cada promoción, su precio de lista, el descuento otorgado y la venta neta en un periodo, y descárgalo en CSV.
product: dashboard
category: reportes
featureCode: PROMOTIONS
dashboardRoutes:
  - reports/promotions
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - revisar-reportes-ventas
  - configurar-promociones
keywords:
  - reporte de promociones
  - cuánto vendió el combo
  - ventas de paquetes
  - cuánto regalé en promociones
  - 2x1 vendidos
  - exportar promociones
---

## Antes de empezar

El reporte de promociones viene con las promociones del plan **Pro** y se abre desde **Reportes** (pide permiso para ver reportes). Cuenta los combos, paquetes y 2x1 que armaste en **Combos y paquetes**, dentro de la sección del menú (**Menú** o **Catálogo**, según tu giro).

Cada promoción cuenta como un renglón. Los productos que la integran aparecen por separado en **Ventas por artículo**, marcados con el nombre del combo: son dos vistas del mismo dinero, no se suman.

## Pasos

1. Abre **Reportes > Promociones**.
2. Arriba, elige el periodo en el selector de fechas.
3. Lee el resumen: **Veces vendida**, **Venta neta**, **Regalado en promociones** y **Promociones distintas**.
4. En **Cómo se movió en el tiempo** cambia entre **Total**, **Por día**, **Por semana** y **Por mes**.
5. En la tabla, cada **Promoción** trae su **Tipo** (Combo, Paquete o 2x1), **Veces vendida**, **Precio de lista**, **Descuento otorgado** y **Venta neta**, con el **Total** abajo.
6. Para llevártelo, toca **Exportar CSV**.

## Problemas frecuentes

- **«Sin promociones vendidas en este período»:** no se vendió ninguna promoción en esas fechas; amplía el periodo.
- **«… venta(s) quedaron marcadas para revisión…»:** la promoción estaba archivada o fuera de vigencia al registrarse, así que entraron a precio de lista. El renglón dice cuántas.
- **«No se pudo cargar el reporte de promociones»:** recarga la página. Si se repite, pide que lo revise una persona del equipo de Avoqado.
- **Los números no cuadran con Ventas por artículo:** ahí cada producto del combo sale por separado. No sumes los dos reportes.
- **Descuento otorgado** es la diferencia entre el **Precio de lista** y lo que se cobró por la promoción.
