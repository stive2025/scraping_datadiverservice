const express = require('express');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const { logger, consoleLogger } = require('./utils/logger');
const createRoutes = require('./routes');

// Servicios
const BrowserService = require('./services/BrowserService');
const AuthService = require('./services/AuthService');
const HttpService = require('./services/HttpService');
const FamilyService = require('./services/FamilyService');
const ScrapingService = require('./services/ScrapingService');
const KeepAliveService = require('./services/KeepAliveService');

class Application {
    constructor() {
        this.app = express();
        this.services = {};
    }

    /**
     * Inicializa todos los servicios en orden de dependencia.
     * Ya no se necesita BrowserService ni Puppeteer.
     */
    async initializeServices() {
        try {
            // 1. Browser: solo para login (resuelve reCAPTCHA) — no se usa para consultas
            this.services.browserService = new BrowserService();
            await this.services.browserService.initialize();

            // 2. Auth: login via Puppeteer → captura Bearer token JWT
            this.services.authService = new AuthService(this.services.browserService);
            await this.services.authService.performLogin();

            // 3. HTTP: realiza las llamadas a la API con el token
            this.services.httpService = new HttpService(this.services.authService);

            // 4. Family: consultas adicionales de familia via API
            this.services.familyService = new FamilyService(this.services.authService);

            // 5. KeepAlive: renueva el token antes de que expire
            this.services.keepAliveService = new KeepAliveService(this.services.authService);

            // 6. Scraping: orquesta las consultas de datos via HTTP
            this.services.scrapingService = new ScrapingService(
                this.services.authService,
                this.services.httpService,
                this.services.keepAliveService,
                this.services.familyService
            );

            // Iniciar keep-alive con referencia al tiempo de última request
            this.services.keepAliveService.start(() => this.services.scrapingService.lastRequestTime);

            // Mostrar estadísticas cada 10 minutos
            setInterval(() => {
                const stats = this.services.scrapingService.statistics;
                const uptime = process.uptime();
                const requestsPerHour = (this.services.scrapingService.stats.totalRequests / (uptime / 3600)).toFixed(1);
                const mem = process.memoryUsage();

                consoleLogger.stats('Resumen del sistema', {
                    successRate: stats.successRate,
                    avgTime:     stats.averageResponseTime,
                    total:       stats.totalRequests + ' consultas',
                    perHour:     requestsPerHour,
                    cacheHits:   stats.cacheHits,
                    cacheSize:   stats.cacheSize,
                    memRss:      Math.round(mem.rss / 1024 / 1024),
                    memHeap:     Math.round(mem.heapUsed / 1024 / 1024),
                    tokenLeft:   this.services.authService.timeLeftMinutes + ' min'
                });
            }, 600000);

            logger.info('Todos los servicios inicializados correctamente');

        } catch (error) {
            logger.error('Error inicializando servicios', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Configura las rutas de la aplicación
     */
    setupRoutes() {
        const routes = createRoutes(this.services);
        this.app.use('/', routes);
    }

    /**
     * Configura middleware global
     */
    setupMiddleware() {
        // Máximo 60 peticiones por minuto por IP — protege contra abuso y sobrecarga
        const limiter = rateLimit({
            windowMs: 60 * 1000,
            max: 60,
            standardHeaders: true,
            legacyHeaders: false,
            message: { success: false, error: 'Demasiadas solicitudes, intenta en un minuto.' }
        });
        this.app.use(limiter);

        this.app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                logger.info('HTTP Request', {
                    method:    req.method,
                    url:       req.url,
                    status:    res.statusCode,
                    duration:  duration + 'ms',
                    userAgent: req.get('User-Agent')
                });
            });
            next();
        });

        this.app.use((err, req, res, next) => {
            logger.error('Unhandled error', {
                error:  err.message,
                stack:  err.stack,
                url:    req.url,
                method: req.method
            });
            res.status(500).json({ success: false, error: 'Internal server error' });
        });
    }

    /**
     * Inicia el servidor
     */
    async start() {
        try {
            await this.initializeServices();
            this.setupMiddleware();
            this.setupRoutes();

            this.server = this.app.listen(config.server.port, config.server.host, () => {
                consoleLogger.separator('DATADIVERSERVICE SCRAPER');
                consoleLogger.system(`Servidor iniciado en puerto ${config.server.port}`);
                if (!process.env.API_KEY) {
                    logger.warn('ADVERTENCIA: API_KEY no definida en .env — el servidor está abierto sin autenticación');
                }
            });

            this.setupGracefulShutdown();

        } catch (error) {
            logger.error('Error iniciando aplicación', { error: error.message, stack: error.stack });
            process.exit(1);
        }
    }

    /**
     * Cierre graceful — detiene el keep-alive y cierra el servidor HTTP.
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            logger.info(`Recibida señal ${signal}, iniciando cierre graceful`);
            try {
                if (this.server) {
                    await new Promise((resolve) => this.server.close(resolve));
                }
                if (this.services.keepAliveService) {
                    this.services.keepAliveService.stop();
                }
                if (this.services.browserService) {
                    await this.services.browserService.close();
                }
                logger.info('Cierre graceful completado');
                process.exit(0);
            } catch (error) {
                logger.error('Error durante cierre graceful', { error: error.message });
                process.exit(1);
            }
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT',  () => shutdown('SIGINT'));
    }
}

module.exports = Application;
