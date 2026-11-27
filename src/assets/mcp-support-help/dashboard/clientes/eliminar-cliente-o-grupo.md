---
title: Eliminar un cliente o un grupo de clientes
description: Quita a un cliente de tu lista desde Clientes o desde su ficha, o borra un grupo de clientes sin borrar a sus integrantes.
product: dashboard
category: clientes
featureCode: AVOQADO_CUSTOMERS
dashboardRoutes:
  - customers
  - customers/:customerId
  - customers/groups
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-26
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - gestionar-clientes
keywords:
  - eliminar cliente
  - borrar cliente
  - cliente duplicado
  - quitar cliente de la lista
  - eliminar grupo de clientes
  - borrar grupo
---

## Antes de empezar

Eliminar un cliente pide el permiso de eliminar clientes; eliminar un grupo, el de eliminar grupos y el de ver grupos (sin éste, la lista de grupos no carga). De fábrica, los dos los tienen el gerente, el administrador y el dueño. Sin el permiso, **Eliminar** no aparece.

Antes de eliminar a un cliente repetido, revisa cuál de los dos tiene el historial, los puntos o el saldo que quieres conservar: el cliente que elimines deja de aparecer en tu lista y desde el panel no se puede deshacer.

Eliminar un grupo no elimina a sus clientes: sólo los saca de ese grupo.

## Pasos

1. Para eliminar un cliente desde la lista, abre **Clientes > Todos los Clientes**, toca **⋯** en su renglón y toca **Eliminar**.
2. Si ya estás en su ficha, toca **Eliminar** arriba, junto a **Editar**.
3. En **Eliminar Cliente**, confirma con **Eliminar Cliente**. Sale «Cliente eliminado exitosamente».
4. Para eliminar un grupo, abre **Clientes > Grupos de Clientes**, toca **⋯** en su renglón y toca **Eliminar**.
5. En **Eliminar Grupo**, confirma con **Eliminar Grupo**. Sale «Grupo de clientes eliminado exitosamente».

## Problemas frecuentes

- **Me equivoqué de cliente:** desde el panel no se recupera. Pide que lo revise una persona del equipo de Avoqado.
- **Tengo dos fichas del mismo cliente:** hoy no hay un botón para juntarlas. Decide cuál conservas y elimina la otra.
- **El grupo tenía clientes:** siguen en tu lista, ya sin ese grupo. Si un descuento era sólo para ese grupo, revísalo en **Clientes > Promociones > Descuentos**.
- **No sale Eliminar:** te falta el permiso. Pídeselo a quien administra el negocio.
