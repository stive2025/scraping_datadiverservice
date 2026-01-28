const express = require('express');
const config = require('./config');
const { logger, consoleLogger } = require('./utils/logger');
const createRoutes = require('./routes');

// Servicios
const BrowserService = require('./services/BrowserService');
const AuthService = require('./services/AuthService');
const FamilyService = require('./services/FamilyService');
const ScrapingService = require('./services/ScrapingService');
const KeepAliveService = require('./services/KeepAliveService');

class Application {
    constructor() {
        this.app = express();
        this.services = {};
    }

    /**
     * Inicializa todos los servicios
     */
    async initializeServices() {
        try {
            // Inicializar servicios en orden de dependencia
            this.services.browserService = new BrowserService();
            await this.services.browserService.initialize();

            this.services.authService = new AuthService(this.services.browserService);
            await this.services.authService.performLogin();

            this.services.familyService = new FamilyService(this.services.authService);
            
            // Inicializar KeepAliveService primero
            this.services.keepAliveService = new KeepAliveService(
                this.services.browserService,
                this.services.authService
            );

            // Inicializar ScrapingService con referencia al KeepAliveService
            this.services.scrapingService = new ScrapingService(
                this.services.browserService,
                this.services.authService,
                this.services.familyService,
                this.services.keepAliveService // Pasar referencia para notificaciones
            );

            // Iniciar keep-alive con función para obtener tiempo de última request
            this.services.keepAliveService.start(() => this.services.scrapingService.lastRequestTime);

            // Mostrar estadísticas cada 10 minutos
            setInterval(() => {
                if (this.services.scrapingService.stats.totalRequests > 0) {
                    const stats = this.services.scrapingService.statistics;
                    const uptime = process.uptime();
                    const requestsPerHour = (this.services.scrapingService.stats.totalRequests / (uptime / 3600)).toFixed(1);
                    
                    consoleLogger.stats('Resumen del sistema', {
                        successRate: stats.successRate,
                        avgTime: stats.averageResponseTime,
                        total: stats.totalRequests + ' consultas',
                        perHour: requestsPerHour + '/h'
                    });
                }
            }, 600000); // 10 minutos

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
        // Middleware para logging de requests
        this.app.use((req, res, next) => {
            const start = Date.now();
            
            res.on('finish', () => {
                const duration = Date.now() - start;
                logger.info('HTTP Request', {
                    method: req.method,
                    url: req.url,
                    status: res.statusCode,
                    duration: duration + 'ms',
                    userAgent: req.get('User-Agent')
                });
            });
            
            next();
        });

        // Middleware para manejo de errores
        this.app.use((err, req, res, next) => {
            logger.error('Unhandled error', {
                error: err.message,
                stack: err.stack,
                url: req.url,
                method: req.method
            });

            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
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
            });

            // Manejo de señales para cierre graceful
            this.setupGracefulShutdown();

        } catch (error) {
            logger.error('Error iniciando aplicación', { error: error.message, stack: error.stack });
            process.exit(1);
        }
    }

    /**
     * Configura el cierre graceful de la aplicación
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            logger.info(`Recibida señal ${signal}, iniciando cierre graceful`);
            
            try {
                // Cerrar servidor HTTP
                if (this.server) {
                    await new Promise((resolve) => {
                        this.server.close(resolve);
                    });
                }

                // Detener servicios
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
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
}

module.exports = Application;