# Tenis · Reservas de clases + agenda del profesor

Un solo proyecto (Node.js + Express + Postgres) con dos páginas que comparten la misma base de datos:

| Página | Ruta | Para quién |
|---|---|---|
| Reservar clase (día, hora y duración) | `/` | Alumnos |
| Agenda de clases del día | `/profesor` | Tú (protegida con PIN) |

La tabla `reservas` se crea sola la primera vez que arranca el servidor.

## Subirlo a Railway

1. En Railway: **New Project → Provision PostgreSQL** (tu base de datos).
2. Sube esta carpeta a un repositorio de GitHub.
3. En el mismo proyecto: **New → GitHub Repo** y elige el repositorio. Railway detecta Node y ejecuta `npm start`.
4. En el servicio web → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referencia a tu Postgres; cambia `Postgres` si tu servicio se llama distinto)
   - `PROFESOR_PIN` = el PIN que usarás para entrar a `/profesor`
   - Opcionales: `HORA_APERTURA` (7), `HORA_CIERRE` (20), `TZ_NEGOCIO` (America/El_Salvador)
5. En **Settings → Networking → Generate Domain**. Listo:
   - Alumnos: `https://tu-dominio.up.railway.app/`
   - Profesor: `https://tu-dominio.up.railway.app/profesor`

## Probarlo en tu computadora (VS Code)

```bash
npm install
cp .env.example .env     # en Windows: copy .env.example .env
# edita .env: pega la DATABASE_PUBLIC_URL de Railway y elige tu PIN
npm start
```

Abre http://localhost:3000 y http://localhost:3000/profesor.

## Cómo funciona

- Las clases empiezan en :00 o :30 y duran 30, 60, 90 o 120 min (se cambia en `server.js`, constante `DURACIONES`).
- El servidor impide que dos clases se solapen, aunque dos personas reserven al mismo tiempo.
- No se pueden reservar horas que ya pasaron (usa la zona horaria `TZ_NEGOCIO`).
- En `/profesor` ves las clases del día, navegas entre días, llamas o escribes por WhatsApp al alumno y puedes cancelar una clase (la hora vuelve a quedar libre).
- Los alumnos solo ven qué horas están ocupadas, nunca los datos de otros alumnos.

## Tabla en Postgres

```sql
reservas(id, nombre, telefono, fecha, hora_inicio, duracion_min, notas, estado, creado_en)
-- estado: 'activa' | 'cancelada'
```
