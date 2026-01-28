require('dotenv').config();

const config = {
    // Server Configuration
    server: {
        port: parseInt(process.env.PORT) || 3030,
        host: '0.0.0.0',
        environment: process.env.NODE_ENV || 'development'
    },

    // DataDiverService Credentials - MANTENER CREDENCIALES ORIGINALES
    datadiverservice: {
        username: process.env.DATADIVERSERVICE_USER || 'GESTOR3@SEFILSA',
        password: process.env.DATADIVERSERVICE_PASS || 'SEFILSA.G3',
        baseUrl: 'https://datadiverservice.com',
        apiUrl: 'https://api.datadiverservice.com'
    },

    // Puppeteer Configuration
    puppeteer: {
        maxConcurrentPages: parseInt(process.env.MAX_CONCURRENT_PAGES) || 6, // Reduced from 10 to 6
        pagePoolSize: parseInt(process.env.PAGE_POOL_SIZE) || 4, // Reduced from 5 to 4
        queueTimeout: parseInt(process.env.QUEUE_TIMEOUT) || 45000,
        executablePath: process.platform === 'win32' ? undefined : '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--password-store=basic',
            '--use-mock-keychain'
        ]
    },

    // Session Management - OPTIMIZADO PARA ACTIVIDAD AUTOMÁTICA EFICIENTE
    session: {
        tokenRefreshInterval: parseInt(process.env.TOKEN_REFRESH_INTERVAL) || 480000, // 8 minutos (renovación preventiva)
        activityInterval: parseInt(process.env.ACTIVITY_INTERVAL) || 90000, // 1.5 minutos (actividad real constante)
        sessionCheckInterval: parseInt(process.env.SESSION_CHECK_INTERVAL) || 300000, // 5 minutos
        idleActivityInterval: parseInt(process.env.IDLE_ACTIVITY_INTERVAL) || 60000, // 1 minuto cuando idle
        proactiveLoginThreshold: parseInt(process.env.PROACTIVE_LOGIN_THRESHOLD) || 900000, // 15 minutos (más conservador)
        tokenExpiryTime: 50 * 60 * 1000, // 50 minutos (estándar)
        realQueryInterval: parseInt(process.env.REAL_QUERY_INTERVAL) || 180000, // 3 minutos (consultas reales)
        heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 45000, // 45 segundos (heartbeat frecuente)
        maxIdleTime: parseInt(process.env.MAX_IDLE_TIME) || 30000 // 30 segundos para considerar idle
    },

    // Cache Configuration
    cache: {
        familyTTL: 10 * 60 * 1000 // 10 minutos
    },

    // Logging Configuration
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        file: process.env.LOG_FILE || 'logs/scraper.log',
        maxSize: 5242880, // 5MB
        maxFiles: 5
    }
};

module.exports = config;