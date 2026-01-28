const puppeteer = require('puppeteer');
const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');
const { delay } = require('../utils/helpers');

class BrowserService {
    constructor() {
        this.browser = null;
        this.pagePool = [];
        this.activePages = 0;
        this.pageQueue = [];
    }

    /**
     * Inicializa el navegador
     */
    async initialize() {
        try {
            logger.info('Iniciando navegador Chromium', {
                executablePath: config.puppeteer.executablePath,
                headless: true
            });
            
            this.browser = await puppeteer.launch({
                headless: "new",
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
     * Pre-crea páginas para el pool
     */
    async warmUpPagePool() {
        try {
            for (let i = 0; i < config.puppeteer.pagePoolSize; i++) {
                const page = await this.createOptimizedPage();
                this.pagePool.push(page);
                logger.debug('Página pre-creada', { pageNumber: i + 1, totalPages: config.puppeteer.pagePoolSize });
            }
            consoleLogger.system('Pool de páginas listo', { poolSize: config.puppeteer.pagePoolSize });
        } catch (err) {
            logger.error('Error creando pool', { error: err.message });
        }
    }

    /**
     * Crea una página optimizada
     */
    async createOptimizedPage() {
        const page = await this.browser.newPage();
        await page.setDefaultNavigationTimeout(25000);
        await page.setDefaultTimeout(25000);
        
        await page.setCacheEnabled(true);
        await page.setRequestInterception(true);
        
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media', 'websocket'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });
        
        return page;
    }

    /**
     * Obtiene una página del pool
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
     * Devuelve una página al pool
     */
    async returnPageToPool(page) {
        try {
            if (this.pagePool.length < config.puppeteer.pagePoolSize) {
                await page.goto('about:blank');
                this.pagePool.push(page);
                logger.debug('Página devuelta al pool', { availablePages: this.pagePool.length });
            } else {
                await page.close();
                logger.debug('Pool lleno, cerrando página');
            }
        } catch (err) {
            logger.error('Error devolviendo página al pool', { error: err.message });
            try {
                await page.close();
            } catch (e) {}
        }
    }

    /**
     * Refresca el pool de páginas
     */
    async refreshPagePool() {
        logger.info('Refrescando pool de páginas para mantener sesiones activas', { 
            currentPoolSize: this.pagePool.length 
        });
        const oldPages = [...this.pagePool];
        this.pagePool = [];
        
        // Cerrar páginas antiguas
        for (const page of oldPages) {
            try {
                await page.close();
            } catch (e) {
                logger.error('Error cerrando página antigua', { error: e.message });
            }
        }
        
        // Crear nuevas páginas con sesión fresca
        await this.warmUpPagePool();
    }

    /**
     * Espera por un slot disponible con delay para concurrencia
     */
    async waitForAvailableSlot() {
        return new Promise((resolve, reject) => {
            if (this.activePages < config.puppeteer.maxConcurrentPages) {
                this.activePages++;
                
                // Agregar pequeño delay si hay múltiples requests concurrentes
                const delay = this.activePages > 1 ? (this.activePages - 1) * 500 : 0;
                if (delay > 0) {
                    logger.debug('Aplicando delay para concurrencia', { 
                        activePages: this.activePages, 
                        delay: delay + 'ms' 
                    });
                    setTimeout(resolve, delay);
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
     * Libera un slot
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
     * Cierra el navegador y limpia recursos
     */
    async close() {
        logger.info('Cerrando pool de páginas', { poolSize: this.pagePool.length });
        for (const page of this.pagePool) {
            try {
                await page.close();
            } catch (e) {
                logger.error('Error cerrando página del pool', { error: e.message });
            }
        }
        this.pagePool = [];
        
        if (this.browser) {
            logger.info('Cerrando navegador');
            await this.browser.close();
        }
    }

    /**
     * Getters para acceso a propiedades
     */
    get isReady() {
        return !!this.browser;
    }

    get stats() {
        return {
            activePages: this.activePages,
            queuedRequests: this.pageQueue.length,
            pagePoolSize: this.pagePool.length,
            maxConcurrent: config.puppeteer.maxConcurrentPages
        };
    }
}

module.exports = BrowserService;