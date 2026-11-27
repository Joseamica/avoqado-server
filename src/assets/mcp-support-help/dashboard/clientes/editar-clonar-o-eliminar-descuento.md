---
title: Crear desde un cupón, editar, clonar o eliminar un descuento
description: Crea un descuento sin salir del cupón, cambia uno con su asistente, haz una copia para armar otro parecido, o elimínalo desde Promociones › Descuentos.
product: dashboard
category: clientes
featureCode: PROMOTIONS
dashboardRoutes:
  - promotions/discounts
  - promotions/discounts/:discountId
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-26
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - configurar-promociones
  - generar-o-eliminar-cupones
keywords:
  - editar descuento
  - cambiar un descuento
  - clonar descuento
  - copiar descuento
  - eliminar descuento
  - borrar descuento
  - el descuento está mal
---

## Antes de empezar

Los descuentos vienen con las promociones del plan **Pro**. **Editar** pide el permiso de editar descuentos; **Clonar**, el de crearlos; **Eliminar**, el de eliminarlos. De fábrica, los tres los tienen el gerente, el administrador y el dueño.

Un cambio al descuento cambia lo que se cobra desde ese momento en todo lo que lo use, incluidos sus cupones. Si sólo quieres probar una variante, clónalo y cambia la copia.

## Pasos

1. Abre **Clientes > Promociones > Descuentos**.
2. Para cambiarlo, toca **⋯** en su renglón y luego **Editar**: se abre la página del descuento. Arriba toca **Editar**.
3. En **Editar Descuento** avanza con **Siguiente** por los cuatro pasos: **Información Básica**, **Alcance y Objetivos**, **Reglas y Tiempo** y **Opciones Avanzadas**. Cambia lo que necesites.
4. En el último paso toca **Guardar**. Sale «Descuento actualizado exitosamente».
5. Para hacer una copia, toca **⋯ > Clonar**. Sale «Descuento clonado exitosamente» y la copia aparece en la lista; ábrela para cambiarla.
6. Para eliminarlo, toca **⋯ > Eliminar** y confirma con **Eliminar**. Sale «Descuento eliminado exitosamente».

## Crear el descuento desde un cupón

Si al armar un cupón el descuento todavía no existe, en **Crear Cupón**, al final de la lista **Descuento Padre**, toca **Crear Descuento**. Llena **Nombre del Descuento**, el **Tipo de Descuento** (**Porcentaje** o **Monto Fijo** con su **Valor**, o **Cortesía**, que no lleva valor) y el **Alcance**, y toca **Crear Descuento**. Sale «Descuento creado exitosamente» y queda elegido como **Descuento Padre** del cupón. Este camino pide el permiso de crear cupones (para abrir **Crear Cupón**) y el de crear descuentos.

## Problemas frecuentes

- **Eliminar no se puede deshacer.** Si sólo quieres que deje de aplicar por un tiempo, edítalo y, en **Opciones Avanzadas**, apaga **Activo**.
- **Con Atrás regresas al paso anterior** sin perder lo que llevas; **Cancelar** cierra el asistente sin guardar.
- **«Ocurrió un error» al guardar:** revisa el mensaje que acompaña al aviso; si no es claro, pide que lo revise una persona del equipo de Avoqado.
- **No salen Editar, Clonar o Eliminar:** te falta el permiso correspondiente.
