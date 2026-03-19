# DataDiverService Scraper

Servicio que consulta datos de clientes en DataDiverService vía API directa con autenticación JWT automática.

## Cómo funciona

1. **Login inicial** — Puppeteer abre Chrome en segundo plano, ingresa las credenciales y captura el Bearer token JWT. Dura ~5 horas.
2. **Consultas** — Cada cédula se consulta vía HTTP directo a la API (sin browser). Se lanzan los endpoints en paralelo. Tiempo de respuesta: 500ms - 2s.
3. **Keep-alive** — El token se renueva automáticamente antes de expirar. No requiere intervención manual.

## Requisitos

- Docker + Docker Compose

## Despliegue

```bash
# 1. Crear archivo de configuración
cp .env.example .env

# 2. Editar credenciales en .env
nano .env

# 3. Construir y levantar
docker-compose up --build -d

# 4. Ver logs
docker-compose logs -f
```

## Configuración (.env)

```env
# Credenciales DataDiverService (OBLIGATORIO)
DATADIVERSERVICE_USER=tu_usuario
DATADIVERSERVICE_PASS=tu_password

# Servidor
PORT=3030
NODE_ENV=production

# Sesión (opcionales, valores por defecto recomendados)
TOKEN_REFRESH_INTERVAL=480000    # Cada cuánto verifica el token (ms) — default: 8 min
HEARTBEAT_INTERVAL=45000         # Intervalo de heartbeat (ms) — default: 45s
RESULT_CACHE_TTL=900000          # Tiempo de cache de resultados (ms) — default: 15 min

# Logging
LOG_LEVEL=info
LOG_FILE=logs/scraper.log
```

## Endpoints

### Consulta de datos

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/title/:dni` | Consulta datos de una cédula (formato original) |
| GET | `/client/:dni` | Consulta datos de una cédula (formato estructurado) |

### Monitoreo

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/ping` | Health check simple |
| GET | `/sessions` | Estadísticas generales del sistema |
| GET | `/system-status` | Estado detallado (token, cache, memoria) |
| GET | `/health-check` | Estado de la sesión JWT |
| GET | `/resources` | Uso de recursos del servidor |

### Gestión

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/refresh-token` | Renovar token manualmente |
| GET | `/shutdown` | Cierre controlado del servicio |

### Familia (diagnóstico)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/test-family/:dni` | Prueba detallada de datos de familia |
| GET | `/diagnose-family/:dni` | Diagnóstico de problemas de familia |
| GET | `/debug-family-endpoints/:dni` | Debug de todos los endpoints de familia |
| GET | `/family-cache-stats` | Estadísticas del cache de familia |
| POST | `/clear-family-cache` | Limpiar cache de familia |
| POST | `/force-retry-family/:dni` | Forzar reintento para una cédula |

## Comandos útiles

```bash
# Verificar que está corriendo
curl http://localhost:3030/ping

# Ver estado del sistema y token
curl http://localhost:3030/sessions

# Renovar token manualmente
curl -X POST http://localhost:3030/refresh-token

# Consultar una cédula
curl http://localhost:3030/client/1234567890
```

## Troubleshooting

**El servicio arranca pero no devuelve datos**
→ Verificar credenciales en `.env` y que DataDiverService esté accesible.

**Token expira constantemente**
→ Revisar conectividad de red. El keep-alive renueva automáticamente cada ~5 horas.

**Ver logs detallados**
```bash
docker-compose logs -f
# o dentro del contenedor:
docker exec -it <container_id> tail -f logs/scraper.log
```
