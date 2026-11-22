---
title: Prender y emparejar la máquina de efectivo en el POS Windows
description: Conecta la QuickPay Mini a esta PC del POS Windows con su IP, prueba la conexión y empareja la PC para cobrar en la máquina.
product: windows
category: maquina-de-efectivo
task: emparejar-la-maquina-de-efectivo
requiredPermissions:
  - cash-machine:configure
money: false
versionMin: 2.25.57
sourceRepo: avoqado-android
sourceRef: e7d51ad0634df24ba3522a7364884567fd82009d
keywords:
  - emparejar la máquina
  - prender la máquina de efectivo
  - conectar la máquina de efectivo
  - QuickPay
  - IP de la máquina
  - no sale efectivo en la máquina
  - cambiar de PC la máquina
  - desemparejar la máquina
---

## Antes de empezar

La máquina de efectivo sólo se conecta al POS Windows y viene en todos los planes. Tiene que estar prendida y en la misma red que la PC. Emparejar y desemparejar necesitan internet.

Sólo una PC registra los cobros de la máquina: emparejar ésta se la quita a la que la tenía.

## Pasos

1. Entra a la caja con un gerente, administrador o dueño. En *Más*, toca *Ajustes* y, en *Este aparato*, toca *Máquina de efectivo*.
2. Escribe la IP de la máquina (por ejemplo 192.168.1.50) y toca *Probar conexión*: debe decir «Conectada».
3. Toca *Emparejar esta PC con la máquina*. Sale «¡Máquina emparejada!» y arriba «Emparejada con» y la IP.
4. Desde ahí, en *Cobrar* sale la fila *Efectivo en la máquina*.
5. Para dejar de usarla en esta PC, toca *Desemparejar*: sale «Máquina desemparejada».

## Problemas frecuentes

- Si *Máquina de efectivo* sale en gris con «Pide a un gerente que entre con su PIN (cambio de usuario) para configurar la máquina», cambia de usuario a un gerente con su PIN.
- «No responde: revisa que esté prendida y en la misma red que esta PC»: revisa la máquina y la red, y vuelve a probar.
- **Cambiar de PC con cobros a medias no se puede.** En la PC nueva sale «Hay cobros de la máquina sin terminar: termínalos en el panel antes de emparejar otra PC». Un gerente los termina en el panel, en *Ventas* › *Cobros de la máquina en duda*, y luego se vuelve a emparejar.
- En la PC vieja, la IP y *Desemparejar* quedan bloqueados con «Hay cobros de la máquina sin subir o en duda: resuélvelos primero»: conéctala a internet para que suba lo suyo y que un gerente resuelva sus dudas en el panel.
- Si sale «Se dio de baja la PC anterior (…): desconéctala de la máquina», esa otra PC ya no registra cobros: que nadie cobre con ella en la máquina.
- «Esta PC perdió su credencial (¿se copió de otra PC?): vuelve a emparejarla»: toca *Emparejar esta PC con la máquina* otra vez.
- «Esta PC está emparejada con» otra sucursal: la máquina sólo cobra con la sesión en la sucursal donde se emparejó.

## Sin internet

Sin conexión sale «Se necesita internet para emparejar» o «Se necesita internet para desemparejar»: inténtalo cuando vuelva la conexión. Cobrar en la máquina ya emparejada sí funciona sin internet.
