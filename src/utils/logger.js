const winston = require('winston');
const config = require('../config');

// ─── Mapa de usuarios ────────────────────────────────────────────────────────
const userMap = new Map();
let globalUserCounter = 0;

const getUserNumber = (dni) => {
    if (!userMap.has(dni)) {
        globalUserCounter++;
        userMap.set(dni, globalUserCounter);
        if (userMap.size > 200) {
            const oldest = userMap.keys().next().value;
            userMap.delete(oldest);
        }
    }
    return userMap.get(dni);
};

// ─── Colores ANSI ────────────────────────────────────────────────────────────
const C = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    cyan:    '\x1b[36m',
    white:   '\x1b[37m',
    gray:    '\x1b[90m',
    bgRed:   '\x1b[41m',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const pad = (str, len) => str.toString().padEnd(len);

const formatDuration = (ms) => {
    if (ms <= 0)    return 'cache';
    if (ms < 1000)  return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
};

const getTimestamp = () => {
    return new Date().toLocaleTimeString('es-EC', {
        timeZone: 'America/Guayaquil',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
};

// Prefijos con color fijo para cada categoría
const PREFIX = {
    SISTEMA:    `${C.cyan}${C.bold}SISTEMA  ${C.reset}`,
    AUTH:       `${C.yellow}${C.bold}AUTH     ${C.reset}`,
    CONSULTA:   `${C.blue}${C.bold}CONSULTA ${C.reset}`,
    OK:         `${C.green}${C.bold}✓        ${C.reset}`,
    ERROR:      `${C.red}${C.bold}✗        ${C.reset}`,
    KEEPALIVE:  `${C.gray}KEEP-ALIVE${C.reset}`,
    STATS:      `${C.cyan}${C.bold}STATS    ${C.reset}`,
    WARN:       `${C.yellow}AVISO    ${C.reset}`,
};

const ts = () => `${C.dim}[${getTimestamp()}]${C.reset} `;

// ─── Logger a archivos (Winston — JSON completo) ──────────────────────────────
const logger = winston.createLogger({
    level: config.logging.level,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'datadiverservice-scraper' },
    transports: [
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: config.logging.maxSize,
            maxFiles: config.logging.maxFiles
        }),
        new winston.transports.File({
            filename: config.logging.file,
            maxsize: config.logging.maxSize,
            maxFiles: config.logging.maxFiles
        })
    ]
});

// ─── Logger de consola (producción — limpio y con color) ─────────────────────
const consoleLogger = {

    system: (message) => {
        console.log(`${ts()}${PREFIX.SISTEMA}${message}`);
    },

    auth: (message, details = {}) => {
        const extra = details.timeLeft ? ` ${C.dim}(${details.timeLeft})${C.reset}` : '';
        console.log(`${ts()}${PREFIX.AUTH}${message}${extra}`);
    },

    queryStart: (dni) => {
        const user = getUserNumber(dni);
        console.log(`${ts()}${PREFIX.CONSULTA}${C.bold}User ${pad(user, 3)}${C.reset}${C.dim} DNI: ${dni}${C.reset}`);
    },

    queryComplete: (dni, responseTime, success = true) => {
        const user = getUserNumber(dni);
        const duration = formatDuration(responseTime);
        const fromCache = responseTime <= 0;

        if (success) {
            const cacheTag = fromCache ? ` ${C.cyan}[CACHE]${C.reset}` : '';
            console.log(`${ts()}${PREFIX.OK}${C.bold}User ${pad(user, 3)}${C.reset}completado en ${C.green}${duration}${C.reset}${cacheTag}`);
        } else {
            console.log(`${ts()}${PREFIX.ERROR}${C.bold}User ${pad(user, 3)}${C.reset}${C.red}Error en consulta${C.reset} (${duration})`);
        }
    },

    // Silenciado en producción — demasiado ruido mostrar cada sub-endpoint
    dataCapture: () => {},

    loadingProgress: () => {},

    keepAlive: (message, details = {}) => {
        const extra = details.timeLeft ? ` ${C.dim}(${details.timeLeft})${C.reset}` : '';
        console.log(`${ts()}${PREFIX.KEEPALIVE} ${message}${extra}`);
    },

    stats: (message, details = {}) => {
        const parts = [];
        if (details.successRate) parts.push(`Éxito: ${C.green}${details.successRate}${C.reset}`);
        if (details.avgTime)     parts.push(`Promedio: ${C.yellow}${details.avgTime}${C.reset}`);
        if (details.total)       parts.push(`Total: ${C.bold}${details.total}${C.reset}`);
        if (details.perHour)     parts.push(`${C.dim}${details.perHour}/h${C.reset}`);
        if (details.cacheHits !== undefined) parts.push(`Cache hits: ${C.cyan}${details.cacheHits}${C.reset}`);
        if (details.cacheSize !== undefined) parts.push(`Cache DNIs: ${C.cyan}${details.cacheSize}${C.reset}`);
        if (details.memRss   !== undefined)  parts.push(`RAM: ${C.yellow}${details.memRss}MB${C.reset}${C.dim} (heap ${details.memHeap}MB)${C.reset}`);
        if (details.pages    !== undefined)  parts.push(`Chrome: ${C.yellow}${details.pages} páginas${C.reset}`);
        console.log(`${ts()}${PREFIX.STATS}${parts.join('  ')}`);
    },

    error: (message, details = {}) => {
        const user = details.dni ? ` User ${getUserNumber(details.dni)}` : '';
        const extra = details.error ? ` ${C.dim}→ ${details.error}${C.reset}` : '';
        console.log(`${ts()}${PREFIX.ERROR}${C.red}${message}${user}${C.reset}${extra}`);
    },

    warn: (message, details = {}) => {
        const user = details.dni ? ` User ${getUserNumber(details.dni)}` : '';
        console.log(`${ts()}${PREFIX.WARN}${message}${user}`);
    },

    separator: (title = '') => {
        if (title) {
            console.log(`${ts()}${C.bold}${C.cyan}━━━ ${title} ━━━${C.reset}`);
        }
    },

    // Compatibilidad con llamadas legacy
    info: (message) => {
        if (message.includes('Token capturado')) {
            consoleLogger.auth(message);
        } else if (message.includes('Keep-alive')) {
            consoleLogger.keepAlive(message);
        }
    },

    query: (message, details = {}) => {
        if (message.includes('completada')) {
            consoleLogger.queryComplete(details.dni, details.responseTime, true);
        } else if (message.includes('error') || message.includes('Error')) {
            consoleLogger.queryComplete(details.dni, details.responseTime, false);
        }
    },

    dataProgress: () => {}
};

module.exports = { logger, consoleLogger, getUserNumber };
