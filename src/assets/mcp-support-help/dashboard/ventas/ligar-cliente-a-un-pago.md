---
title: Ligar un cliente a un pago ya cobrado
description: Desde el detalle de un pago en Ventas › Transacciones, agrega el cliente que faltó a una venta ya cobrada, buscándolo o creándolo.
product: dashboard
category: ventas
featureCode: AVOQADO_PAYMENTS
dashboardRoutes:
  - payments
  - payments/:paymentId
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 813c8e8e8711e8afa7cea2a20e5bcf2954f4492a
relatedArticles:
  - ver-pagos
  - gestionar-clientes
keywords:
  - agregar cliente a un pago
  - ligar cliente a la venta
  - se me olvidó poner el cliente
  - asignar cliente a una venta cobrada
  - quitar cliente del pago
  - no me deja eliminar el cliente
  - no sale eliminar de la transacción
  - cliente equivocado en la venta
---

## Antes de empezar

El cliente se liga a la venta (la orden) de ese pago. Si el pago no tiene una venta detrás, no se le puede agregar cliente: sale «Este pago no tiene orden asociada — no se puede agregar cliente».

Ligar un cliente a una venta ya cobrada lo hace un gerente, administrador o dueño con el permiso de ligar clientes a ventas. Quien hizo el último cobro de esa venta también puede ligarlo durante los 15 minutos siguientes, si conserva su permiso de cobrar. Guardarlo pide además el permiso de editar órdenes. Buscar clientes pide permiso para ver clientes; crear uno nuevo, el de crear clientes.

Una venta cobrada que ya tiene cliente no se le cambia ni se le quita desde aquí: el cliente que quedó se queda.

## Pasos

1. Abre **Ventas > Transacciones** y toca el pago.
2. Arriba del detalle, junto a **Enviar Recibo Digital**, toca el botón **⋯** y luego **Añadir cliente**.
3. En **Buscar clientes**, escribe su nombre, teléfono o correo y tócalo en la lista.
4. Toca **Añadir cliente** para guardarlo.
5. Si no existe, toca **Crear nuevo cliente**, llena **Nombre**, **Apellidos**, **Correo electrónico** o **Teléfono** (con código de país, de 10 a 15 dígitos) y toca **Guardar**: queda ligado al pago.

## Problemas frecuentes

- **«No se pudo asociar al cliente»:** lee el mensaje que trae debajo. Si dice que no tienes permiso, pídeselo a quien administra el negocio.
- **«Tu directorio está vacío»** o **«No se encontraron clientes»:** todavía no hay clientes con ese dato; usa **Crear nuevo cliente**.
- **Si el pago ya tiene cliente**, en **⋯** sale **Editar cliente** en lugar de **Añadir cliente**: eso corrige la ficha del cliente (pide el permiso de editar clientes) y se ve en todas sus ventas, no liga a otro.
- **Eliminar de la transacción** está dentro de **Editar cliente** (o al tocar su nombre en **Pagado por**) y quita a ese cliente de **Pagado por** en el pago. Sólo sale en una venta que todavía no se cobra completa y si tienes el permiso de editar órdenes.
- **En lugar de Eliminar de la transacción sale un aviso:** «Esta venta ya se cobró: su cliente se queda y no se puede quitar.» (el cliente de una venta cobrada se queda, también para un gerente), «Esta venta está cancelada: ya no se le cambia el cliente.» o «Para quitar el cliente de la venta necesitas el permiso de editar órdenes.» (pídeselo a quien administra el negocio). Si dice «No se pudo revisar si se puede quitar el cliente.», cierra y vuelve a abrir el pago.
- **«Esta venta ya tiene un cliente asignado y no se puede reemplazar.»:** a una venta ya cobrada no se le cambia el cliente. Si sale al tocar **Eliminar de la transacción**, la venta se terminó de cobrar mientras la tenías abierta: el botón se quita de esa ficha.
- **«Esta venta no admite asignar un cliente.»:** ese pago no permite ligarle un cliente.
- **El botón Añadir cliente está apagado** hasta que tocas un cliente de la lista.
