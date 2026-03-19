const { consoleLogger } = require('../utils/logger');

class SystemController {
    constructor(services) {
        this.authService     = services.authService;
        this.familyService   = services.familyService;
        this.scrapingService = services.scrapingService;
        this.keepAliveService= services.keepAliveService;
    }

    /**
     * Health check simple
     */
    ping(req, res) {
        res.json({
            status:    'ok',
            timestamp: new Date().toISOString(),
            uptime:    process.uptime(),
            service:   'datadiverservice-scraper'
        });
    }

    /**
     * Estadísticas generales del sistema
     */
    getSessions(req, res) {
        const uptime = process.uptime();
        const requestsPerHour = (this.scrapingService.stats.totalRequests / (uptime / 3600)).toFixed(2);
        const timeSinceLastRequest = Date.now() - this.scrapingService.lastRequestTime;

        res.json({
            tokenValid:      this.authService.isTokenValid,
            tokenExpiresIn:  this.authService.isTokenValid ? this.authService.timeLeftMinutes + ' minutos' : 'N/A',
            isLoggingIn:     this.authService.isLoggingIn,
            keepAliveActive: this.keepAliveService.stats.isActive,
            lastTokenRefresh: this.authService.tokenExpiry > 0
                ? new Date(this.authService.tokenExpiry - (5 * 60 * 60 * 1000)).toISOString()
                : 'N/A',
            activityStatus: {
                timeSinceLastRequest: Math.floor(timeSinceLastRequest / 1000) + 's',
                lastRequestTime:      new Date(this.scrapingService.lastRequestTime).toISOString()
            },
            familyCache: {
                size: this.familyService ? this.familyService.familyCache.size : 0,
                ttl:  '10 minutos'
            },
            statistics: {
                ...this.scrapingService.statistics,
                requestsPerHour,
                uptimeHours: (uptime / 3600).toFixed(2)
            }
        });
    }

    /**
     * Estado detallado del sistema
     */
    async getSystemStatus(req, res) {
        try {
            const timeSinceLastRequest = Date.now() - this.scrapingService.lastRequestTime;

            res.json({
                timestamp: new Date().toISOString(),
                token: {
                    valid:      this.authService.isTokenValid,
                    expiresIn:  this.authService.timeLeftMinutes + ' min',
                    expiryTime: this.authService.tokenExpiry > 0
                        ? new Date(this.authService.tokenExpiry).toISOString()
                        : null
                },
                activity: {
                    timeSinceLastRequest: Math.floor(timeSinceLastRequest / 1000) + 's',
                    lastRequestTime:      new Date(this.scrapingService.lastRequestTime).toISOString()
                },
                keepAlive: {
                    active:     this.keepAliveService.stats.isActive,
                    isLoggingIn:this.authService.isLoggingIn
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
        }
    }

    /**
     * Verificación de salud de sesión
     */
    async getHealthCheck(req, res) {
        try {
            const sessionHealthy = this.authService.checkSessionHealth();
            res.json({
                success:        true,
                sessionHealthy,
                tokenValid:     this.authService.isTokenValid,
                tokenExpiresIn: this.authService.timeLeftMinutes + ' min',
                message:        sessionHealthy ? 'Sesión saludable' : 'Sesión requiere renovación'
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    /**
     * Renovación manual de token
     */
    async refreshToken(req, res) {
        try {
            this.authService._accessToken = null;
            await this.authService.performLogin();
            res.json({
                success:        true,
                message:        'Token renovado exitosamente',
                tokenExpiresIn: this.authService.timeLeftMinutes + ' min'
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    /**
     * Endpoint legacy — ya no aplica (se usa HTTP directo)
     */
    async forceIdleActivity(req, res) {
        res.status(410).json({
            success: false,
            message: 'La actividad idle por browser fue eliminada. El keep-alive ahora usa solo HTTP.',
            keepAlive: this.keepAliveService.stats
        });
    }

    showPeriodicStats() {
        const stats = this.scrapingService.statistics;
        const uptime = process.uptime();
        const requestsPerHour = (this.scrapingService.stats.totalRequests / (uptime / 3600)).toFixed(1);
        consoleLogger.stats('Resumen del sistema', {
            successRate: stats.successRate,
            avgTime:     stats.averageResponseTime,
            total:       stats.totalRequests + ' consultas',
            perHour:     requestsPerHour + '/h'
        });
    }

    /**
     * Consumo de recursos en tiempo real
     */
    getResources(req, res) {
        const mem    = process.memoryUsage();
        const uptime = process.uptime();

        res.json({
            timestamp: new Date().toISOString(),
            uptime: {
                seconds: Math.floor(uptime),
                human:   uptime < 3600 ? Math.floor(uptime / 60) + ' min' : (uptime / 3600).toFixed(1) + ' h'
            },
            memory: {
                rss_mb:        Math.round(mem.rss       / 1024 / 1024),
                heap_used_mb:  Math.round(mem.heapUsed  / 1024 / 1024),
                heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
                external_mb:   Math.round(mem.external  / 1024 / 1024)
            },
            cache: {
                result_cache_size:  this.scrapingService._resultCache.size,
                result_cache_ttl:   '15 min',
                family_cache_size:  this.familyService ? this.familyService.familyCache.size : 0,
                family_cache_ttl:   '10 min',
                in_flight_requests: this.scrapingService._inFlight.size
            },
            session: {
                token_valid:      this.authService.isTokenValid,
                token_expires_in: this.authService.timeLeftMinutes + ' min',
                logging_in:       this.authService.isLoggingIn
            }
        });
    }

    async shutdown(req, res) {
        try {
            consoleLogger.info('Iniciando proceso de shutdown');
            this.keepAliveService.stop();
            consoleLogger.info('Shutdown completado');
            res.json({ message: 'Sistema cerrado exitosamente' });
            setTimeout(() => process.exit(0), 1000);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

module.exports = SystemController;
