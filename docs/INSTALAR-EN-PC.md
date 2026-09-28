# Instalar en una computadora, y usarlo desde el celular

Esta guía es para quien recibió el sistema y quiere administrar **su propio
negocio de préstamos** desde su computadora, entrando también desde el celular
cuando está en el local.

No hay que pagar nada ni contratar ningún servicio. Todo corre en tu máquina y
los datos no salen de ahí.

Leelo completo antes de empezar. Son unos cuarenta minutos la primera vez.

---

## Antes de empezar, entendé esto

**El sistema vive en una sola computadora.** Esa máquina guarda todo: tus
clientes, tus préstamos, tus saldos. El celular no guarda nada — solo se
asoma a la computadora por el WiFi.

De ahí salen tres consecuencias que conviene aceptar desde el principio:

1. **Si la computadora está apagada, no hay sistema.** Ni desde el celular ni
   desde ningún lado.
2. **Solo funciona dentro de tu WiFi.** En la calle, con datos móviles, no vas
   a poder entrar. Para eso hace falta un servidor en internet, que sí cuesta
   plata (está explicado en `DEPLOY.md`).
3. **Si esa computadora se muere, se muere tu contabilidad** — salvo que tengas
   backups. El paso 7 no es opcional.

---

## 1. Instalar Node.js

Entrá a **https://nodejs.org** y descargá la versión **LTS** para Windows.

Ejecutá el instalador y dale siguiente a todo. No hace falta cambiar nada.

Para confirmar que quedó, abrí **PowerShell** (botón de inicio, escribí
"powershell") y escribí:

```bash
node --version
```

Tiene que responder algo como `v24.x.x`. Si dice que no reconoce el comando,
cerrá PowerShell, abrilo de nuevo y probá otra vez.

---

## 2. Instalar PostgreSQL

Es la base de datos donde se guarda todo.

Entrá a **https://www.postgresql.org/download/windows/** y descargá el
instalador. Durante la instalación:

- Cuando pida una **contraseña para el usuario postgres**, poné una y
  **anotala en un papel**. La vas a necesitar en el paso 4 y no se puede
  recuperar.
- El puerto dejalo en **5432**.
- Cuando ofrezca "Stack Builder" al final, **cancelá**. No hace falta.

---

## 3. Bajar el sistema

En PowerShell:

```bash
cd $HOME\Documents
git clone https://github.com/quinterokevin406/contabilidad.git capital-control
cd capital-control
```

Si dice que `git` no existe, instalalo desde **https://git-scm.com/download/win**
y volvé a intentar.

---

## 4. Configurarlo

Copiá la plantilla de configuración:

```bash
copy .env.example .env
notepad .env
```

Se abre el Bloc de notas. Cambiá **estas líneas** y guardá:

```
DATABASE_URL="postgresql://postgres:TU_CONTRASEÑA_DE_POSTGRES@localhost:5432/capital_control"

AUTH_SECRET="pegá acá lo que genere el comando de abajo"

SEED_ADMIN_EMAIL="tucorreo@ejemplo.com"
SEED_ADMIN_PASSWORD="la contraseña con la que vas a entrar"
SEED_ORG_NAME="El Nombre De Tu Negocio"
SEED_ORG_SLUG="el-nombre-de-tu-negocio"

ALLOW_INSECURE_COOKIES="true"
```

Para el `AUTH_SECRET`, corré esto y pegá el resultado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Sobre `ALLOW_INSECURE_COOKIES`:** va en `"true"` porque estás en tu red de
casa o del local, sin certificado de seguridad. Sin eso, el navegador tira tu
sesión a la basura y el login no funciona nunca.

> Si algún día ponés este sistema en internet, **apagalo** (`"false"`) y usá
> HTTPS. En una red local está bien; expuesto a internet, cualquiera que mire
> el tráfico entra como vos.

El `SEED_ORG_NAME` es el nombre que va a salir impreso en cada recibo que le
des a un cliente. Poné el de verdad.

---

## 5. Preparar la base de datos

Los tres comandos, en orden:

```bash
npm ci
```

```bash
npm run db:deploy
```

```bash
npm run db:seed
```

El último tiene que terminar diciendo `Ingresá con: tucorreo@ejemplo.com`.

Si algo falla acá, el error casi siempre es la contraseña de PostgreSQL mal
escrita en el `.env`. Revisala.

---

## 6. Encenderlo

```bash
npm run build
```

Tarda uno o dos minutos. Después:

```bash
npm start
```

**Dejá esa ventana de PowerShell abierta.** Mientras esté abierta, el sistema
funciona; si la cerrás, se apaga.

Abrí el navegador en **http://localhost:3000** y entrá con el correo y la
contraseña que pusiste en el `.env`.

### Que arranque solo al prender la computadora

Para no tener que hacer esto todos los días, creá un acceso directo:

1. Botón derecho en el escritorio → **Nuevo → Acceso directo**
2. Pegá esto, cambiando la ruta por la tuya:
   `powershell -NoExit -Command "cd $HOME\Documents\capital-control; npm start"`
3. Ponele de nombre "Capital Control"
4. Copiá ese acceso directo, apretá `Windows + R`, escribí `shell:startup` y
   pegalo ahí

Desde la próxima vez que prendas la máquina, arranca solo.

---

## 7. El celular

**Primero, averiguá la dirección de la computadora.** En PowerShell:

```bash
ipconfig
```

Buscá la línea que dice **Dirección IPv4**. Va a ser algo como `192.168.1.8`.

Ahora, en el celular — **conectado al mismo WiFi que la computadora** — abrí
el navegador y entrá a:

```
http://192.168.1.8:3000
```

(con el número que te dio a vos)

Entrá con tu correo y contraseña. Después, en el menú del navegador, tocá
**"Agregar a pantalla de inicio"**. Te queda como una aplicación, con su ícono,
sin barra de direcciones.

**Si no carga:** casi siempre es el Firewall de Windows. La primera vez que
corras `npm start`, Windows pregunta si permitís el acceso a la red — hay que
decir que **sí**, y marcar "Redes privadas".

---

## 8. Los backups — esto no es opcional

Tu computadora tiene la única copia de los saldos de todos tus clientes. Si el
disco se muere, no hay forma de reconstruirlos.

Para sacar una copia:

```bash
npm run backup
```

Te deja un archivo en la carpeta `backups`.

**Programalo para que salga solo todas las noches:**

1. Buscá **"Programador de tareas"** en el menú de inicio
2. **Crear tarea básica** → nombre: "Backup Capital Control"
3. Cuándo: **Diariamente**, a una hora en que la máquina esté prendida
4. Acción: **Iniciar un programa**
   - Programa: `node`
   - Argumentos: `scripts/backup.mjs create`
   - Iniciar en: la carpeta del proyecto, por ejemplo
     `C:\Users\TuUsuario\Documents\capital-control`

**Y que salgan de esa computadora.** Un backup que vive en el mismo disco que la
base no te salva del problema del que te estás cuidando: si ese disco muere, se
lleva los dos.

Si tenés OneDrive, Google Drive o Dropbox (Windows ya trae OneDrive), lo más
simple es que el backup escriba directo ahí y se suba solo:

```bash
npm run backup -- --out "C:\Users\TuUsuario\OneDrive\CapitalControl-Backups"
```

Poné esa misma ruta en los argumentos de la tarea programada. El script te avisa
cada vez si el archivo quedó en el mismo disco o si llegó a una carpeta que
sincroniza, así que no tenés que acordarte de revisarlo.

Si no usás ninguno de esos, copiá la carpeta `backups` a un pendrive una vez por
semana. Es menos cómodo y sirve igual.

Detalle completo en [`BACKUP.md`](BACKUP.md).

---

## 9. Si perdés la contraseña

No hay correo de recuperación. Se arregla desde la computadora:

```bash
npm run user:password -- tucorreo@ejemplo.com
```

Te muestra una contraseña nueva **una sola vez**. Copiala.

---

## Por dónde empezar a usarlo

1. **Caja → Aporte / Retiro → Aporte**: registrá el capital con el que arrancás.
2. **Clientes**: cargá el primero.
3. **Préstamos**: creá el préstamo.
4. **Cobros**: te muestra qué vence cada día.

Un consejo: cargá **un préstamo real chiquito** y seguile el rastro por Caja y
por el Dashboard antes de meter toda tu cartera. Así verificás que los números
se comportan como esperás, con algo que ya conocés de memoria.

---

## Lo que el sistema no hace

No te dice si una tasa es legal. Registra la que vos le pongas y la muestra con
claridad, pero **la responsabilidad de que tu negocio cumpla la ley es tuya**.
No consulta nada por internet y nunca modifica un contrato ni un saldo por su
cuenta.

Tampoco tiene garantía. Es software libre, se entrega como está, y quien lo
corre es responsable de sus propios libros y de sus propios respaldos.
