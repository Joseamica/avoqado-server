---
title: Editar los datos de un cliente en el POS Android
description: Corrige el nombre, el teléfono o el correo de un cliente desde Clientes en el POS Android.
product: android
category: clientes
task: editar-cliente
requiredPermissions:
  - customers:read
  - customers:update
versionMin: 2.25.15
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - editar cliente
  - cambiar teléfono del cliente
  - corregir correo del cliente
  - modificar datos del cliente
---

## Antes de empezar

Editar clientes es de gerente para arriba. Si no tienes el permiso y el negocio usa el PIN de gerente, al tocar *Editar* se pide el PIN de un gerente. Si *Clientes* no sale en *Más*, lo escondieron en *Personalizar menú* de este aparato.

## Pasos

1. En *Más*, toca *Clientes*.
2. Busca al cliente en *Buscar* y tócalo.
3. Toca *Editar*.
4. Cambia su *Nombre*, *Apellido*, *Teléfono* o *Correo electrónico* y toca *Guardar*.

## Problemas frecuentes

- Si sale «No puedes editar clientes», pídele a un gerente que lo edite; el dueño puede darte el permiso o prender el PIN de gerente.
- Un dato que el cliente ya tenía no se puede borrar: sale «No se puede dejar vacío».
- El teléfono lleva de 10 a 15 dígitos; si no, sale «El teléfono debe tener de 10 a 15 dígitos».

## Sin internet

- Si aparece «Sin conexión: para editar al cliente necesitas internet.», el cambio no queda guardado para después: vuelve a tocar *Guardar* cuando regrese la red.
