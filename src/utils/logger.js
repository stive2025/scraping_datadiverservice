const winston = require('winston');
const config = require('../config');

// Mapa para rastrear usuarios por DNI - cada DNI único tendrá su propio número de usuario
const userMap = new Map();
let globalUserCounter = 0;
let lastTimestamp = '';

const getUserNumber = (dni) => {
    if (!userMap.has(dni)) {
        globalUserCounter++;
        userMap.set(dni, globalUserCounter);
    }
    return userMap.get(dni);
};

// Función para limpiar usuarios antiguos (opcional, para evitar memory leaks)
const cleanOldUsers = () => {
    if (userMap.size > 100) { // Mantener solo los últimos 100 usuarios
        const entries = Array.from(userMap.entries());
        const toKeep = entries.slice(-50); // Mantener los últimos 50
        userMap.clear();
        toKeep.forEach(([dni, userNum]) => userMap.set(dni, userNum));
    }
};

// Colores personalizados para diferentes tipos de mensajes
const colors = {
    error: '\x1b[31m',    // Rojo
    warn: '\x1b[33m',     // Amarillo
    info: '\x1b[36m',     // Cian
    success: '\x1b[32m',  // Verde
    debug: '\x1b[35m',    // Magenta
    reset: '\x1b[0m',     // Reset
    bright: '\x1b[1m',    // Negrita
    dim: '\x1b[2m'        // Tenue
};

// Función para formatear tiempo transcurrido
const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
};

// Función para obtener timestamp formateado en zona horaria de Ecuador
const getTimestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString('es-EC', { 
        timeZone: 'America/Guayaquil',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
};

// Función para mostrar timestamp siempre
const getTimestampAlways = () => {
    const current = getTimestamp();
    return `[${current}] `;
};

// Logger principal para archivos (completo)
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

// Logger profesional para consola - FORMATO LIMPIO Y MINIMALISTA
const consoleLogger = {
    // Mensajes del sistema - SOLO LO ESENCIAL
    system: (message, details = {}) => {
        const timestamp = getTimestampAlways();
        console.log(`${timestamp}SISTEMA ${message}`);
    },

    // Autenticación y tokens - SOLO LO ESENCIAL
    auth: (message, details = {}) => {
        const timestamp = getTimestampAlways();
        console.log(`${timestamp}AUTH ${message}`);
    },

    // Inicio de consulta - MINIMALISTA
    queryStart: (dni) => {
        const timestamp = getTimestampAlways();
        const userNumber = getUserNumber(dni);
        console.log(`${timestamp}CONSULTA User ${userNumber} DNI: ${dni}`);
    },

    // Solo mostrar cuando se capturan datos específicos
    dataCapture: (dni, dataType, success = true) => {
        if (success) {
            const timestamp = getTimestampAlways();
            const userNumber = getUserNumber(dni);
            
            console.log(`${timestamp}User ${userNumber} ${dataTypes[dataType] || dataType}`);
        }
    },

    // Resultado final con JSON completo - FORMATO CHROME
    queryComplete: (dni, responseTime, success = true, data = null) => {
        const timestamp = getTimestampAlways();
        const userNumber = getUserNumber(dni);
        
        if (success && data) {
            console.log(`${timestamp}User ${userNumber} Consulta completada (${formatDuration(responseTime)})`);
            console.log(`${timestamp}User ${userNumber} Resultado JSON:`);
            
            // Mostrar el JSON formateado como en Chrome
            try {
                const jsonOutput = JSON.stringify(data, null, 2);
                // Dividir en líneas y agregar timestamp a cada línea
                const lines = jsonOutput.split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        console.log(`${timestamp}${line}`);
                    }
                });
            } catch (error) {
                console.log(`${timestamp}User ${userNumber} Error formateando JSON: ${error.message}`);
            }
            
            console.log(`${timestamp}User ${userNumber} ===== FIN CONSULTA =====`);
        } else if (success) {
            console.log(`${timestamp}User ${userNumber} Consulta completada (${formatDuration(responseTime)})`);
        } else {
            console.log(`${timestamp}User ${userNumber} Error en consulta (${formatDuration(responseTime)})`);
        }
    },

    // Errores - SOLO SI SON IMPORTANTES
    error: (message, details = {}) => {
        const timestamp = getTimestampAlways();
        const userNumber = details.dni ? getUserNumber(details.dni) : null;
        const userInfo = userNumber ? ` User ${userNumber}` : '';
        console.log(`${timestamp}ERROR${userInfo} ${message}`);
    },

    // Advertencias - SOLO SI SON IMPORTANTES
    warn: (message, details = {}) => {
        const timestamp = getTimestampAlways();
        const userNumber = details.dni ? getUserNumber(details.dni) : null;
        const userInfo = userNumber ? ` User ${userNumber}` : '';
        console.log(`${timestamp}AVISO${userInfo} ${message}`);
    },

    // Keep-alive - MINIMALISTA
    keepAlive: (message, details = {}) => {
        const timestamp = getTimestampAlways();
        console.log(`${timestamp}KEEP-ALIVE ${message}`);
    },

    // Estadísticas - MINIMALISTA
    stats: (message, details = {}) => {
        const timestamp = getTimestampAlways();
        let line = `${timestamp}STATS ${message}`;
        
        if (details.successRate) {
            line += ` Exito: ${details.successRate}`;
        }
        if (details.avgTime) {
            line += ` Promedio: ${details.avgTime}`;
        }
        if (details.total) {
            line += ` Total: ${details.total}`;
        }
        
        console.log(line);
    },

    // Separador - MINIMALISTA
    separator: (title = '') => {
        if (title) {
            const timestamp = getTimestampAlways();
            console.log(`${timestamp}${title}`);
        }
    },

    // Métodos que NO muestran nada (para silenciar logs innecesarios)
    loadingProgress: () => {}, // Silenciado
    
    // Método genérico - MINIMALISTA
    info: (message, details = {}) => {
        if (message.includes('Servidor') && message.includes('iniciado')) {
            consoleLogger.system(message, details);
        } else if (message.includes('Token capturado')) {
            consoleLogger.auth(message, details);
        } else if (message.includes('Keep-alive')) {
            consoleLogger.keepAlive(message, details);
        }
        // Todo lo demás se silencia
    },

    // Métodos legacy para compatibilidad - SILENCIADOS O MINIMALISTAS
    query: (message, details = {}) => {
        if (message.includes('Nueva consulta iniciada')) {
            consoleLogger.queryStart(details.dni);
        } else if (message.includes('completada exitosamente')) {
            consoleLogger.queryComplete(details.dni, details.responseTime, true);
        } else if (message.includes('error') || message.includes('Error')) {
            consoleLogger.queryComplete(details.dni, details.responseTime, false);
        }
    },

    dataProgress: (message, details = {}) => {
        if (details.dataType) {
            
            consoleLogger.dataCapture(details.dni, dataTypeMap[details.dataType] || 'unknown', true);
        }
    }
};

module.exports = { logger, consoleLogger, getUserNumber, cleanOldUsers };