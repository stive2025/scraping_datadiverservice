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
        password: process.env.DATADIVERSERVICE_PASS || 'gestor32026',
        baseUrl: 'https://datadiverservice.com',
        apiUrl: 'https://api.datadiverservice.com'
    },

    // Puppeteer Configuration
    puppeteer: {
        maxConcurrentPages: parseInt(process.env.MAX_CONCURRENT_PAGES) || 2, // Máximo de páginas activas simultáneas
        pagePoolSize: parseInt(process.env.PAGE_POOL_SIZE) || 2,             // Páginas pre-creadas en el pool
        queueTimeout: parseInt(process.env.QUEUE_TIMEOUT) || 90000,
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
            '--use-mock-keychain',
            // Límites de memoria para cada proceso renderer de Chromium.
            // Reduce el riesgo de OOM en el contenedor de 2 GB.
            '--js-flags=--max-old-space-size=256',
            '--renderer-process-limit=4',
            '--aggressive-cache-discard'
        ]
    },

    // Session Management
    session: {
        tokenRefreshInterval: parseInt(process.env.TOKEN_REFRESH_INTERVAL) || 480000,  // 8 minutos
        heartbeatInterval:    parseInt(process.env.HEARTBEAT_INTERVAL)    || 45000,    // 45 segundos (solo fetch, sin browser)
        tokenExpiryTime:      50 * 60 * 1000                                           // 50 minutos (duración real del token)
    },

    // Cache Configuration
    cache: {
        familyTTL: 10 * 60 * 1000,                                                        // 10 minutos para datos de familia
        resultTTL: parseInt(process.env.RESULT_CACHE_TTL) || 15 * 60 * 1000               // 15 minutos para resultados completos
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