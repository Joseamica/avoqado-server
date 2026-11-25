---
title: Generar cupones en masa o eliminar un cupón
description: Crea muchos códigos de cupón de una vez ligados a un descuento, cópialos o descárgalos, y elimina un cupón que ya no quieres que se use.
product: dashboard
category: clientes
featureCode: PROMOTIONS
dashboardRoutes:
  - promotions/coupons
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - configurar-promociones
  - editar-clonar-o-eliminar-descuento
keywords:
  - generar cupones
  - muchos cupones
  - cupones únicos
  - códigos de descuento en masa
  - descargar cupones
  - eliminar cupón
  - borrar cupón
---

## Antes de empezar

Los cupones vienen con las promociones del plan **Pro**. **Generar en Masa** pide el permiso de crear cupones; **Eliminar**, el de eliminarlos. De fábrica, los dos los tienen el gerente, el administrador y el dueño.

Cada cupón va ligado a un descuento que ya existe (el **Descuento Padre**): el cupón es el código y el descuento dice cuánto se rebaja. Si todavía no tienes el descuento, créalo primero en **Promociones > Descuentos**. Para crear un solo cupón usa **Crear Cupón**.

## Pasos

1. Abre **Promociones > Códigos de Cupón** y toca **Generar en Masa**.
2. Elige el **Descuento Padre**. Si quieres, escribe un **Prefijo del Código** (por ejemplo, PROMO).
3. Escribe el **Número de Códigos** (de 1 a 1000) y la **Longitud del Código** (de 4 a 20). Si quieres, pon los **Usos Máximos por Código**, los **Usos Máximos por Cliente** y las fechas **Válido Desde** y **Válido Hasta**.
4. Toca **Generar Códigos**. Sale «Se generaron exitosamente … códigos de cupón».
5. En **Códigos Generados**, toca **Copiar Todos** o **Descargar CSV** para repartirlos.
6. Para eliminar un cupón, en la lista toca **⋯** en su renglón, luego **Eliminar**, y confirma con **Eliminar**. Sale «Cupón eliminado exitosamente».

## Problemas frecuentes

- **«Genera al menos 1 código»** o **«Máximo 1000 códigos a la vez»:** ajusta el número de códigos.
- **«La longitud del código debe ser al menos 4»** o **«… debe ser 20 o menos»:** ajusta la longitud.
- **Los códigos generados quedan en la lista de Códigos de Cupón**, cada uno con su estado. **Copiar Todos** y **Descargar CSV** salen sólo al terminar de generarlos.
- **Eliminar no se puede deshacer.** Si sólo quieres pausarlo y tienes permiso de editar cupones, ábrelo con **⋯ > Editar**, apaga **Activo** y toca **Guardar Cambios** en lugar de eliminarlo.
- **El cupón no aplica al cobrar:** revisa que el cupón y su descuento estén activos, que estén dentro de su vigencia y que no hayan llegado a sus usos máximos.
- **No sale Generar en Masa o Eliminar:** te falta el permiso, o tu plan no incluye promociones.
