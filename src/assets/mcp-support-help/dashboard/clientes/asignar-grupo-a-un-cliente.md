---
title: Asignar un grupo al cliente o crearlo desde su formulario
description: Al dar de alta o editar un cliente, elige su grupo o crea uno nuevo ahí mismo sin salir del formulario.
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
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - gestionar-clientes
  - eliminar-cliente-o-grupo
keywords:
  - asignar grupo a un cliente
  - crear grupo desde el cliente
  - grupo de cliente
  - meter un cliente a un grupo
  - cliente vip
  - segmento de clientes
---

## Antes de empezar

El campo **Grupo de Cliente** está en el formulario con el que das de alta (**Nuevo Cliente**) o editas (**Editar**) a un cliente. Dar de alta pide el permiso de crear clientes; editar, el de editarlos.

Para que la lista traiga los grupos necesitas permiso para ver grupos, y crear uno nuevo desde ahí pide el permiso de crear grupos; de fábrica los dos los tienen el gerente, el administrador y el dueño. Un cliente va en un solo grupo a la vez.

Los grupos sirven, por ejemplo, para que un descuento aplique sólo a ese grupo de clientes.

## Pasos

1. En **Clientes > Todos los Clientes**, toca **Nuevo Cliente**, o toca **⋯ > Editar** en el renglón del cliente.
2. En **Grupo de Cliente**, abre la lista y elige el grupo. Para dejarlo sin grupo, elige **Sin Grupo**.
3. Si el grupo no existe, al final de la lista toca **Nuevo Grupo de Clientes**.
4. Escribe el **Nombre del Grupo**, si quieres la **Descripción**, elige el **Color** y toca **Crear Grupo**. Sale «Grupo de clientes creado exitosamente» y el grupo queda elegido en el formulario.
5. Termina el formulario y toca **Crear Cliente** (o **Guardar Cambios** si lo editabas) para que el cliente quede en ese grupo.

## Problemas frecuentes

- **El botón Crear Grupo está apagado:** escribe el nombre del grupo.
- **Creé el grupo pero el cliente no quedó en él:** falta guardar el formulario del cliente. El grupo ya existe: búscalo en la lista y guarda.
- **Si al crear el grupo sale un error**, no lo crees otra vez sin revisar: puede que ya exista. Búscalo en **Clientes > Grupos de Clientes**.
- **Para meter o sacar varios clientes de un grupo a la vez**, edita el grupo en **Clientes > Grupos de Clientes**.
