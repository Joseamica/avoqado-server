---
title: Agregar un cliente a la venta en el POS Windows
description: Liga un cliente a la venta del carrito antes de cobrar, o cámbialo o quítalo, en el POS Windows.
product: windows
category: clientes
task: agregar-cliente-a-la-venta
requiredPermissions:
  - customers:read
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - agregar cliente a la venta
  - asignar cliente
  - ligar cliente
  - quitar cliente de la venta
  - cambiar cliente
---

## Antes de empezar

En *Cobrar*, con la venta en el carrito. Si la ventana está angosta, toca antes *Ver carrito*.

## Pasos

1. Arriba del carrito, toca *Agregar cliente*.
2. En *Buscar cliente*, escribe su nombre, teléfono o correo.
3. Toca al cliente: su nombre queda arriba del carrito.
4. Si no existe, toca *Crear* (necesitas el permiso de crear clientes), llena sus datos y toca *Guardar*: queda ligado a la venta.
5. Para cambiarlo o quitarlo, toca su nombre y elige *Cambiar cliente* o *Quitar cliente*.

## Problemas frecuentes

- *Crear* sólo aparece para gerente, administrador o dueño. Al crearlo, escribe su teléfono o su correo: sin uno de los dos no se crea.
- Si *Quitar cliente* dice «La venta ya se está cobrando con este cliente», ya no se puede quitar.

## Sin internet

- Si aparece «Sin conexión: buscando sólo entre los clientes guardados en la tablet», la lista sólo trae los clientes que esta computadora ya tenía.
