const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');

// User-Agent unificado para todo el servicio
const CHROME_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class BrowserService {
    constructor() {
        this.browser = null;
        this.pagePool = [];
        this.activePages = 0;
        this.pageQueue = [];
    }

    /**
     * Inicializa el navegador con configuración stealth básica.
     */
    async initialize() {
        try {
            logger.info('Iniciando navegador Chromium', {
                executablePath: config.puppeteer.executablePath,
                headless: true
            });

            this.browser = await puppeteer.launch({
                headless: 'new',
                executablePath: config.puppeteer.executablePath,
                args: config.puppeteer.args
            });

            consoleLogger.system('Navegador Chromium iniciado correctamente');

            this.browser.on('disconnected', async () => {
                logger.error('El navegador se cerró inesperadamente. Reiniciando...');
                this.pagePool = [];
                await this.initialize();
            });

            await this.warmUpPagePool();

        } catch (err) {
            logger.error('Error lanzando el navegador', { error: err.message, stack: err.stack });
            setTimeout(() => this.initialize(), 5000);
        }
    }

    /**
     * Pre-crea páginas para el pool.
     */
    async warmUpPagePool() {
        try {
            for (let i = 0; i < config.puppeteer.pagePoolSize; i++) {
                const page = await this.createOptimizedPage();
                this.pagePool.push(page);
                logger.debug('Página pre-creada', { pageNumber: i + 1, total: config.puppeteer.pagePoolSize });
            }
            consoleLogger.system('Pool de páginas listo', { poolSize: config.puppeteer.pagePoolSize });
        } catch (err) {
            logger.error('Error creando pool', { error: err.message });
        }
    }

    /**
     * Crea una página con configuración stealth básica.
     * Añadimos User-Agent real, viewport realista y ocultamos navigator.webdriver
     */
    async createOptimizedPage() {
        const page = await this.browser.newPage();

        // User-Agent unificado Chrome/124
        await page.setUserAgent(CHROME_USER_AGENT);

        // Viewport realista
        await page.setViewport({ width: 1366, height: 768 });

        // El stealth plugin ya oculta webdriver y muchas otras señales.
        // Añadimos encima los detalles que el plugin no cubre por defecto.
        await page.evaluateOnNewDocument(() => {
            // window.chrome: ausente en headless puro — los bots lo detectan
            if (!window.chrome) {
                window.chrome = {
                    runtime: {},
                    loadTimes: function() {},
                    csi: function() {},
                    app: {}
                };
            }

            // Plugins realistas (objetos Plugin, no números)
            const makePlugin = (name, filename, desc) => ({
                name, filename, description: desc,
                length: 0, item: () => null, namedItem: () => null
            });
            const pluginList = [
                makePlugin('Chrome PDF Plugin',  'internal-pdf-viewer',          'Portable Document Format'),
                makePlugin('Chrome PDF Viewer',  'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
                makePlugin('Native Client',      'internal-nacl-plugin',         '')
            ];
            pluginList.item      = (i) => pluginList[i] || null;
            pluginList.namedItem = (n) => pluginList.find(p => p.name === n) || null;
            pluginList.refresh   = () => {};
            Object.defineProperty(navigator, 'plugins', { get: () => pluginList });

            // Idiomas del navegador
            Object.defineProperty(navigator, 'languages', {
                get: () => ['es-EC', 'es', 'en-US', 'en']
            });

            // Hardware concurrency realista
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });

            // deviceMemory (GB)
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        });

        await page.setDefaultNavigationTimeout(25000);
        await page.setDefaultTimeout(25000);
        await page.setCacheEnabled(true);

        // Solo bloquear imágenes y media — CSS y JS son necesarios para Angular
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (['image', 'media', 'font'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        return page;
    }

    /**
     * Obtiene una página del pool.
     */
    async getPageFromPool() {
        if (this.pagePool.length > 0) {
            logger.debug('Usando página del pool', { availablePages: this.pagePool.length });
            return this.pagePool.pop();
        }
        logger.debug('Pool vacío, creando página nueva');
        return await this.createOptimizedPage();
    }

    /**
     * Devuelve una página al pool limpiando sus listeners.
     */
    async returnPageToPool(page) {
        try {
            page.removeAllListeners('response');
            page.removeAllListeners('request');

            if (this.pagePool.length < config.puppeteer.pagePoolSize) {
                await page.goto('about:blank');

                // Restaurar request interception
                page.on('request', (request) => {
                    const resourceType = request.resourceType();
                    if (['image', 'media', 'font'].includes(resourceType)) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });

                this.pagePool.push(page);
                logger.debug('Página devuelta al pool', { availablePages: this.pagePool.length });
            } else {
                await page.close();
                logger.debug('Pool lleno, cerrando página');
            }
        } catch (err) {
            logger.error('Error devolviendo página al pool', { error: err.message });
            try { await page.close(); } catch (e) {}
        }
    }

    /**
     * Refresca el pool de páginas.
     */
    async refreshPagePool() {
        logger.info('Refrescando pool de páginas', { currentPoolSize: this.pagePool.length });
        const oldPages = [...this.pagePool];
        this.pagePool = [];

        for (const page of oldPages) {
            try { await page.close(); } catch (e) {}
        }

        await this.warmUpPagePool();
    }

    /**
     * Espera por un slot disponible con delay para concurrencia.
     */
    async waitForAvailableSlot() {
        return new Promise((resolve, reject) => {
            if (this.activePages < config.puppeteer.maxConcurrentPages) {
                this.activePages++;

                const delayMs = this.activePages > 1 ? (this.activePages - 1) * 3000 : 0;
                if (delayMs > 0) {
                    logger.debug('Aplicando delay para concurrencia', {
                        activePages: this.activePages,
                        delay: delayMs + 'ms'
                    });
                    setTimeout(resolve, delayMs);
                } else {
                    resolve();
                }
            } else {
                const queueItem = { resolve, reject };
                this.pageQueue.push(queueItem);

                setTimeout(() => {
                    const index = this.pageQueue.indexOf(queueItem);
                    if (index > -1) {
                        this.pageQueue.splice(index, 1);
                        reject(new Error('Request timeout - demasiadas consultas en cola'));
                    }
                }, config.puppeteer.queueTimeout);
            }
        });
    }

    /**
     * Libera un slot.
     */
    releaseSlot() {
        if (this.pageQueue.length > 0) {
            const queueItem = this.pageQueue.shift();
            queueItem.resolve();
        } else {
            this.activePages--;
        }
    }

    /**
     * Cierra el navegador y limpia recursos.
     */
    async close() {
        logger.info('Cerrando pool de páginas', { poolSize: this.pagePool.length });
        for (const page of this.pagePool) {
            try { await page.close(); } catch (e) {}
        }
        this.pagePool = [];

        if (this.browser) {
            logger.info('Cerrando navegador');
            await this.browser.close();
        }
    }

    get isReady() {
        return !!this.browser;
    }

    get stats() {
        return {
            activePages:    this.activePages,
            queuedRequests: this.pageQueue.length,
            pagePoolSize:   this.pagePool.length,
            maxConcurrent:  config.puppeteer.maxConcurrentPages
        };
    }
}

module.exports = BrowserService;
