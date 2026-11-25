---
title: Agregar un cliente a la venta de Cobrar en la terminal
description: En el carrito de Cobrar, liga a la venta un cliente que ya existe, cámbialo o quítalo antes de cobrar.
product: tpv
category: clientes
task: agregar-cliente-a-la-venta
requiredPermissions:
  - customers:read
versionMin: 2.14.0
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - agregar cliente a la venta
  - cliente en la terminal
  - ligar cliente
  - cambiar cliente
  - quitar cliente de la venta
---

## Antes de empezar

Es en *Cobrar*, con la venta armada. Buscar clientes pide el permiso de ver clientes (de fábrica, del mesero para arriba). Desde la terminal sólo se eligen clientes que ya existen: para dar de alta uno nuevo, hazlo en el panel o en el punto de venta.

## Pasos

1. En *Cobrar*, toca *Cobrar* abajo (dice el total) para abrir el carrito.
2. Arriba del carrito, toca *Agregar cliente*.
3. Elige uno de *Recientes* o escribe en «Buscar por nombre, teléfono o email» y tócalo: su nombre queda arriba del carrito.
4. Para cambiarlo, toca su nombre y elige otro; para quitarlo, toca su nombre y luego *Quitar*.

## Problemas frecuentes

- Si sale «Sin resultados para …», revisa cómo lo escribiste. Antes de darlo de alta en el panel, confirma que tu usuario tenga permiso de ver clientes: sin él, la lista sale vacía aunque el cliente exista, y se duplicaría.
- Si dice «Sin clientes recientes. Empieza a escribir para buscar.», escribe el nombre, teléfono o correo.

## Sin internet

- Si arriba del carrito dice «Necesita internet», no se puede elegir cliente hasta que vuelva la conexión.
