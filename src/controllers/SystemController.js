const { consoleLogger } = require('../utils/logger');

class SystemController {
    constructor(services) {
        this.browserService = services.browserService;
        this.authService = services.authService;
        this.familyService = services.familyService;
        this.scrapingService = services.scrapingService;
        this.keepAliveService = services.keepAliveService;
    }

    /**
     * Health check simple
     */
    ping(req, res) {
        res.json({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            service: 'datadiverservice-scraper'
        });
    }

    /**
     * Estadísticas generales del sistema
     */
    getSessions(req, res) {
        const uptime = process.uptime();
        const requestsPerHour = (this.scrapingService.stats.totalRequests / (uptime / 3600)).toFixed(2);
        const timeSinceLastRequest = Date.now() - this.scrapingService.lastRequestTime;
        const timeSinceLastActivity = Date.now() - this.keepAliveService.lastActivityTime;
        
        res.json({ 
            ...this.browserService.stats,
            tokenValid: this.authService.isTokenValid,
            tokenExpiresIn: this.authService.isTokenValid ? 
                this.authService.timeLeftMinutes + ' minutos' : 'N/A',
            isLoggingIn: this.authService.isLoggingIn,
            keepAliveActive: !!this.keepAliveService.keepAliveInterval,
            lastTokenRefresh: this.authService.tokenExpiry > 0 ? 
                new Date(this.authService.tokenExpiry - (45 * 60 * 1000)).toISOString() : 'N/A',
            activityStatus: {
                isIdle: this.keepAliveService.isIdle,
                timeSinceLastRequest: Math.floor(timeSinceLastRequest / 1000) + 's',
                timeSinceLastActivity: Math.floor(timeSinceLastActivity / 1000) + 's',
                lastRequestTime: new Date(this.scrapingService.lastRequestTime).toISOString(),
                lastActivityTime: new Date(this.keepAliveService.lastActivityTime).toISOString()
            },
            familyCache: {
                size: this.familyService.familyCache.size,
                ttl: '10 minutos'
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
            const timeLeft = this.authService.timeLeft;
            const timeSinceLastRequest = Date.now() - this.scrapingService.lastRequestTime;
            const timeSinceLastActivity = Date.now() - this.keepAliveService.lastActivityTime;
            
            // Verificar salud de sesión en tiempo real
            const sessionHealthy = this.authService.token ? 
                await this.authService.checkSessionHealth() : false;
            
            res.json({
                timestamp: new Date().toISOString(),
                browser: {
                    active: this.browserService.isReady,
                    ...this.browserService.stats
                },
                token: {
                    exists: !!this.authService.token,
                    expiresIn: timeLeft > 0 ? Math.floor(timeLeft / 60000) + ' min' : 'expirado',
                    expiryTime: this.authService.tokenExpiry > 0 ? 
                        new Date(this.authService.tokenExpiry).toISOString() : null,
                    healthy: sessionHealthy
                },
                activity: {
                    isIdle: this.keepAliveService.isIdle,
                    timeSinceLastRequest: Math.floor(timeSinceLastRequest / 1000) + 's',
                    timeSinceLastActivity: Math.floor(timeSinceLastActivity / 1000) + 's',
                    lastRequestTime: new Date(this.scrapingService.lastRequestTime).toISOString(),
                    lastActivityTime: new Date(this.keepAliveService.lastActivityTime).toISOString()
                },
                keepAlive: {
                    active: !!this.keepAliveService.keepAliveInterval,
                    isLoggingIn: this.authService.isLoggingIn
                }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Verificación de salud de sesión
     */
    async getHealthCheck(req, res) {
        try {
            const sessionHealthy = await this.authService.checkSessionHealth();
            res.json({
                success: true,
                sessionHealthy,
                tokenValid: this.authService.isTokenValid,
                browserActive: this.browserService.isReady,
                message: sessionHealthy ? 'Sesión saludable' : 'Sesión requiere renovación'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    /**
     * Renovación manual de token
     */
    async refreshToken(req, res) {
        try {
            this.authService.token = '';
            await this.authService.performLogin();
            res.json({ 
                success: true, 
                message: 'Token renovado exitosamente', 
                token: this.authService.token ? 'presente' : 'ausente' 
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
    }

    /**
     * Forzar actividad idle
     */
    async forceIdleActivity(req, res) {
        try {
            if (!this.browserService.isReady || !this.authService.token) {
                return res.status(503).json({ 
                    success: false, 
                    error: 'Browser o token no disponible' 
                });
            }
            
            consoleLogger.info('Forzando actividad idle manualmente');
            await this.keepAliveService._simulateIdleActivity();
            
            res.json({ 
                success: true, 
                message: 'Actividad idle ejecutada exitosamente',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
    }

    /**
     * Muestra estadísticas periódicas del sistema
     */
    showPeriodicStats() {
        const stats = this.scrapingService.statistics;
        const uptime = process.uptime();
        const requestsPerHour = (this.scrapingService.stats.totalRequests / (uptime / 3600)).toFixed(1);
        
        consoleLogger.stats('Resumen del sistema', {
            successRate: stats.successRate,
            avgTime: stats.averageResponseTime,
            total: stats.totalRequests + ' consultas',
            perHour: requestsPerHour + '/h'
        });
    }
    async shutdown(req, res) {
        try {
            consoleLogger.info('Iniciando proceso de shutdown');
            
            this.keepAliveService.stop();
            await this.browserService.close();
            
            consoleLogger.info('Shutdown completado');
            res.json({ message: 'Sistema cerrado exitosamente' });
            
            setTimeout(() => process.exit(0), 1000);
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
}

module.exports = SystemController;