---
title: Agregar el cliente a una venta ya cobrada en el POS Android
description: Desde Ventas, liga a una venta ya cobrada el cliente que faltó, buscándolo o creándolo, para que quede en su historial.
product: android
category: clientes
task: agregar-cliente-a-una-venta-cobrada
requiredPermissions:
  - customers:read
  - orders:attach-customer
versionMin: 2.25.14
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - agregar cliente a una venta cobrada
  - se me olvidó poner el cliente
  - asignar cliente después de cobrar
  - venta sin cliente
  - ligar cliente a la venta
---

## Antes de empezar

Es para una venta que ya se cobró sin cliente. *Agregar cliente* sólo sale a gerente, administrador o dueño con el permiso de ligar clientes a ventas, y sólo si la venta todavía no tiene cliente. Crear un cliente nuevo ahí mismo pide además el permiso de crear clientes.

## Pasos

1. En *Ventas*, toca la venta.
2. En la sección *Cliente*, toca *Agregar cliente*.
3. Busca al cliente por su nombre, teléfono o correo y tócalo. Si no existe y tienes permiso, créalo desde ahí.
4. En «Confirmar cliente», revisa «Agregar a …» y toca *Agregar cliente*.
5. Sale «Cliente asignado» y la venta ya muestra a su cliente.

## Problemas frecuentes

- Si la venta ya tiene cliente, la sección *Cliente* sólo lo muestra: desde aquí no se cambia.
- Si sale un aviso al confirmar, toca *Reintentar*.

## Sin internet

- Si dice «Necesitas conexión para asignar un cliente a esta venta», espera a que vuelva la conexión.
