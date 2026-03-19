const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');

/**
 * KeepAliveService — mantiene el token activo renovándolo antes de que expire.
 *
 * Ya no necesita navegación browser. El token JWT dura ~5 horas.
 * Este servicio verifica periódicamente si el token está próximo a expirar
 * y lo renueva si ha pasado suficiente tiempo sin actividad real.
 */
class KeepAliveService {
    constructor(authService) {
        this.authService = authService;
        this.keepAliveInterval = null;
        this.lastRequestTime = Date.now();
        this._lastRequestTimeGetter = null;
    }

    start(lastRequestTimeGetter) {
        this._clearIntervals();
        this._lastRequestTimeGetter = lastRequestTimeGetter;

        consoleLogger.system('Keep-alive iniciado', {
            interval: Math.floor(config.session.tokenRefreshInterval / 60000) + ' min'
        });

        this.keepAliveInterval = setInterval(async () => {
            await this._performKeepAlive();
        }, config.session.tokenRefreshInterval);
    }

    /**
     * Verifica si el token necesita renovarse.
     * Solo actúa si ha pasado suficiente tiempo sin actividad real.
     */
    async _performKeepAlive() {
        if (this.authService.isLoggingIn) return;

        const lastReq = this._lastRequestTimeGetter ? this._lastRequestTimeGetter() : this.lastRequestTime;
        const timeSinceLastRequest = Date.now() - lastReq;
        const idleThreshold = config.session.tokenRefreshInterval * 0.8;

        if (timeSinceLastRequest < idleThreshold) {
            logger.debug('Keep-alive omitido: hay actividad reciente', {
                idleSince: Math.floor(timeSinceLastRequest / 1000) + 's'
            });
            return;
        }

        try {
            await this.authService.ensureAuthenticated();
            consoleLogger.keepAlive('Token verificado/renovado via keep-alive', {
                timeLeft: this.authService.timeLeftMinutes + ' min'
            });
        } catch (error) {
            logger.debug('Error en keep-alive (no crítico)', { error: error.message });
        }
    }

    updateLastRequestTime() {
        this.lastRequestTime = Date.now();
    }

    stop() {
        this._clearIntervals();
        logger.info('Sistema keep-alive detenido');
    }

    _clearIntervals() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    get stats() {
        return {
            isActive:      !!this.keepAliveInterval,
            lastRequest:   new Date(this.lastRequestTime).toLocaleTimeString(),
            sessionStatus: this.authService.checkSessionHealth() ? 'activa' : 'pendiente'
        };
    }
}

module.exports = KeepAliveService;
