# Publicarlo en un link, gratis

Al terminar esto vas a tener una dirección propia — algo como
`https://tu-negocio.netlify.app` — que funciona desde el celular, desde la
computadora, en el local o en la calle. No hay que dejar ninguna máquina
prendida.

Son dos servicios gratuitos:

- **Supabase** guarda los datos. Es PostgreSQL de verdad, el mismo motor que
  corre en una instalación local.
- **Netlify** corre la aplicación y te da el link con candado (HTTPS).

Unos cuarenta minutos la primera vez. Necesitás una cuenta de GitHub, que ya
sirve para entrar a las dos.

---

## Antes de empezar

Dos cosas que conviene saber de entrada, para que no te sorprendan después.

**Los planes gratuitos tienen letra chica.** Supabase pausa un proyecto que
pasa una semana entero sin uso — se reactiva con un clic, pero si nadie entra
en vacaciones, el primero que vuelva se encuentra el sistema dormido. Y el plan
gratuito de Netlify dice "uso personal". Para que una persona pruebe la
herramienta nadie va a decir nada; si se convierte en su herramienta de trabajo
diaria, corresponde pagar un plan.

**Los datos quedan guardados en Supabase, no en Netlify.** Si algún día querés
mudarte a otro lado, te llevás la base y listo. No quedás atado.

---

## 1. Crear la base de datos

Entrá a **https://supabase.com** y creá una cuenta (podés entrar con GitHub).

**New project**, y completá:

- **Name**: el nombre que quieras
- **Database Password**: generá una y **guardala en un papel o en tu gestor de
  contraseñas**. No se puede recuperar después.
- **Region**: elegí **East US (North Virginia)**. Es el servidor más cercano a
  Colombia de los que ofrece, y eso se nota en lo rápido que carga cada
  pantalla.

Tarda un par de minutos en quedar listo.

### Copiar las dos direcciones de conexión

Cuando termine, buscá el botón **Connect**, arriba. Vas a necesitar **dos**
direcciones distintas, y la diferencia importa:

**La primera — Transaction pooler (puerto 6543).** Es la que usa la aplicación.
Copiala y agregale al final `?pgbouncer=true&connection_limit=1`, así:

```
postgresql://postgres.abcdefgh:TU_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

**La segunda — Session pooler (puerto 5432).** Es la que usás vos desde tu
computadora para crear las tablas. Es la misma dirección con otro puerto:

```
postgresql://postgres.abcdefgh:TU_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
```

> **Por qué dos.** La primera pasa por un repartidor de conexiones, que es lo
> que permite que cien visitas simultáneas no tumben la base. Ese repartidor no
> sabe crear tablas. La segunda va derecho a la base y solo se usa para eso.

En los dos casos reemplazá `TU_PASSWORD` por la contraseña del paso anterior.

---

## 2. Crear las tablas

Esto se hace **una sola vez**, desde tu computadora.

En la carpeta del proyecto, abrí el archivo `.env` y poné las dos direcciones:

```
DATABASE_URL="...puerto 6543 con ?pgbouncer=true&connection_limit=1..."
DIRECT_URL="...puerto 5432..."
```

Después, los dos comandos:

```bash
npm run db:deploy
```

```bash
npm run db:seed
```

El segundo tiene que terminar diciendo `Ingresá con: ...`. Si falla, el error
casi siempre es la contraseña mal copiada en la dirección.

> Antes de correrlos, revisá que en tu `.env` estén el nombre real del negocio
> (`SEED_ORG_NAME`), tu correo (`SEED_ADMIN_EMAIL`) y la contraseña con la que
> vas a entrar (`SEED_ADMIN_PASSWORD`). Ese nombre sale impreso en cada recibo.

---

## 3. Publicar la aplicación

Entrá a **https://netlify.com** y creá una cuenta con GitHub.

**Add new site → Import an existing project → GitHub**, y elegí el repositorio.

Netlify detecta Next.js solo. **No cambies nada** de lo que proponga: la
configuración ya está en el archivo `netlify.toml` del proyecto.

### Las variables de entorno

Antes de dar **Deploy**, abrí **Add environment variables** y cargá estas:

| Nombre | Valor |
|---|---|
| `DATABASE_URL` | la del puerto **6543**, con `?pgbouncer=true&connection_limit=1` |
| `AUTH_SECRET` | ver abajo |
| `AUTH_URL` | el link que te dé Netlify, con `https://` |
| `NODE_ENV` | `production` |

Para el `AUTH_SECRET`, generá uno nuevo —**no uses el de tu computadora**— con
este comando:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**No cargues** `DIRECT_URL`, ni `SEED_ADMIN_PASSWORD`, ni ninguna de las que
empiezan con `SEED_`. Esas son para tu computadora. El sitio publicado no crea
tablas ni carga datos iniciales: solo atiende a quien entra.

Dale **Deploy**. La primera vez tarda unos minutos.

### El `AUTH_URL` después del primer deploy

Netlify te asigna un link recién cuando termina el primer despliegue. Copiálo,
volvé a **Site configuration → Environment variables**, corregí `AUTH_URL` con
ese valor exacto, y lanzá un deploy nuevo desde **Deploys → Trigger deploy**.

Si `AUTH_URL` no coincide con el link real, el login falla sin decir por qué.

---

## 4. Entrar

Abrí el link en el navegador y entrá con el correo y la contraseña que pusiste
en `.env` al correr el seed.

**En el celular:** abrí el mismo link, entrá, y en el menú del navegador tocá
**"Agregar a pantalla de inicio"**. Queda como una aplicación, con su ícono y
sin barra de direcciones. Funciona con datos móviles, en cualquier lado.

Después de entrar, lo primero: **Configuración**, y revisá que el nombre del
negocio sea el correcto.

---

## 5. Los backups

Supabase hace sus propias copias, pero **dependen de su plan gratuito** y no
son tuyas. Las que sí son tuyas se sacan desde tu computadora, con el `.env`
apuntando a Supabase:

```bash
npm run backup
```

Si tenés OneDrive, Google Drive o Dropbox, mandalas directo ahí y se suben
solas:

```bash
npm run backup -- --out "C:\Users\TuUsuario\OneDrive\CapitalControl-Backups"
```

Hacelo una vez por semana como mínimo. Detalle completo en
[`BACKUP.md`](BACKUP.md).

---

## Si algo sale mal

**El sitio muestra un error al entrar.** En Netlify, **Logs → Functions**. Casi
siempre es una variable de entorno mal copiada.

**El login devuelve al login, sin error.** `AUTH_URL` no coincide con el link
real. Corregilo y volvé a desplegar.

**"Can't reach database server".** La `DATABASE_URL` está mal, o le falta
`?pgbouncer=true&connection_limit=1` al final.

**Las pantallas cargan vacías, sin error.** La `DATABASE_URL` apunta al puerto
equivocado. Tiene que ser la del **6543**.

**Todo andaba y de golpe no.** Fijate en Supabase si el proyecto quedó pausado
por inactividad. Se reactiva con un botón.

---

## Para actualizar el sistema

Cada vez que subas cambios a GitHub, Netlify publica solo.

Si la actualización trae cambios en la base, además hay que correr desde tu
computadora, con el `.env` apuntando a Supabase:

```bash
npm run backup
npm run db:deploy
```

El backup primero, siempre.
