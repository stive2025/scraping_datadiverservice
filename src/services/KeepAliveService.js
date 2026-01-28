const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');
const { delay } = require('../utils/helpers');

class KeepAliveService {
    constructor(browserService, authService) {
        this.browserService = browserService;
        this.authService = authService;
        this.keepAliveInterval = null;
        this.activityInterval = null;
        this.heartbeatInterval = null;
        this.realQueryInterval = null;
        this.lastActivityTime = Date.now();
        this.lastRequestTime = Date.now();
        this.activityPage = null;
        this.isPerformingActivity = false;
        this.isIdle = false;
        this.testDNIs = [
            '0123456789', '0987654321', '0111111111', '0222222222', '0333333333',
            '0444444444', '0555555555', '0666666666', '0777777777', '0888888888'
        ];
        this.currentDNIIndex = 0;
    }

    /**
     * Inicia el sistema de keep-alive optimizado con actividad automática inteligente
     */
    start(lastRequestTimeGetter) {
        this._clearIntervals();
        
        consoleLogger.system('Keep-alive iniciado con actividad automática inteligente', {
            tokenRefresh: '8 min',
            activity: '1.5 min',
            heartbeat: '45 seg',
            realQuery: '3 min'
        });
        
        // 1. Renovación de token cada 8 minutos (más frecuente pero no excesivo)
        this.keepAliveInterval = setInterval(async () => {
            await this._performTokenMaintenance();
        }, config.session.tokenRefreshInterval);
        
        // 2. Actividad real constante cada 1.5 minutos
        this.activityInterval = setInterval(async () => {
            await this._performSmartActivity(lastRequestTimeGetter);
        }, config.session.activityInterval);
        
        // 3. Heartbeat cada 45 segundos para mantener conexión
        this.heartbeatInterval = setInterval(async () => {
            await this._performHeartbeat();
        }, config.session.heartbeatInterval);
        
        // 4. Consultas reales cada 3 minutos para verificar sesión
        this.realQueryInterval = setInterval(async () => {
            await this._performRealQuery();
        }, config.session.realQueryInterval);
        
        // Inicializar página dedicada
        this._initializeActivityPage();
    }

    /**
     * Inicializa página dedicada para actividad constante
     */
    async _initializeActivityPage() {
        try {
            if (this.activityPage) {
                await this.activityPage.close().catch(() => {});
            }
            
            this.activityPage = await this.browserService.browser.newPage();
            await this.activityPage.setDefaultNavigationTimeout(12000);
            await this.activityPage.setDefaultTimeout(12000);
            
            // Configurar interceptación para optimizar rendimiento
            await this.activityPage.setRequestInterception(true);
            this.activityPage.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media', 'websocket'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            
            // Navegar a dashboard inicialmente
            await this.activityPage.goto(`${config.datadiverservice.baseUrl}/dashboard`, {
                waitUntil: 'domcontentloaded',
                timeout: 12000
            });
            
            logger.info('Página dedicada para actividad inicializada correctamente');
        } catch (error) {
            logger.error('Error inicializando página de actividad', { error: error.message });
        }
    }

    /**
     * Mantenimiento de token - renovación inteligente mejorada
     */
    async _performTokenMaintenance() {
        if (!this.browserService.isReady || this.authService.isLoggingIn) return;
        
        try {
            const now = Date.now();
            const timeLeft = this.authService.timeLeft;
            const timeLeftMin = this.authService.timeLeftMinutes;
            
            // Verificar si el token debería estar válido según nuestro tiempo local
            const shouldBeValid = this.authService.token && timeLeft > (2 * 60 * 1000);
            
            if (!shouldBeValid) {
                const reason = !this.authService.token ? 'sin token' : 'expirado/próximo a expirar';
                
                consoleLogger.keepAlive('Renovando token automáticamente', { 
                    timeLeft: timeLeftMin + ' min',
                    reason: reason
                });
                
                await this.authService.performLogin();
                
                // Reinicializar página de actividad después del login
                await this._initializeActivityPage();
            } else {
                // Token debería ser válido, pero verificar salud real ocasionalmente
                const sessionHealthy = await this.authService.checkSessionHealth();
                
                if (sessionHealthy) {
                    consoleLogger.keepAlive('Token válido y sesión saludable', { 
                        timeLeft: timeLeftMin + ' min',
                        nextCheck: '8 min'
                    });
                } else {
                    consoleLogger.keepAlive('Token válido pero sesión no saludable, renovando', { 
                        timeLeft: timeLeftMin + ' min'
                    });
                    await this.authService.performLogin();
                    await this._initializeActivityPage();
                }
            }
        } catch (error) {
            logger.error('Error en mantenimiento de token', { error: error.message });
            // Limpiar token en caso de error para forzar renovación
            this.authService.token = '';
            this.authService.tokenExpiry = 0;
        }
    }

    /**
     * Actividad inteligente que se adapta al uso del sistema
     */
    async _performSmartActivity(lastRequestTimeGetter) {
        if (!this.browserService.isReady || 
            this.authService.isLoggingIn || 
            !this.authService.token || 
            this.isPerformingActivity) return;
        
        this.isPerformingActivity = true;
        
        try {
            // Determinar si el sistema está idle
            const timeSinceLastRequest = Date.now() - (lastRequestTimeGetter ? lastRequestTimeGetter() : this.lastRequestTime);
            this.isIdle = timeSinceLastRequest > config.session.maxIdleTime;
            
            if (this.isIdle) {
                logger.debug('🔥 Sistema idle - actividad intensiva automática', {
                    idleTime: Math.floor(timeSinceLastRequest / 1000) + 's'
                });
                await this._performIntensiveActivity();
            } else {
                logger.debug('🎯 Actividad regular automática');
                await this._performRegularActivity();
            }
            
            this.lastActivityTime = Date.now();
            
        } catch (error) {
            if (!error.message.includes('Execution context was destroyed') && 
                !error.message.includes('Target closed')) {
                logger.debug('Error en actividad inteligente (reinicializando)', { error: error.message });
                await this._initializeActivityPage();
            }
        } finally {
            this.isPerformingActivity = false;
        }
    }

    /**
     * Actividad regular para mantener sesión viva
     */
    async _performRegularActivity() {
        if (!this.activityPage) {
            await this._initializeActivityPage();
            if (!this.activityPage) return;
        }
        
        try {
            // Verificar si la página está activa
            const isPageActive = await this.activityPage.evaluate(() => {
                return typeof window !== 'undefined' && typeof document !== 'undefined';
            }).catch(() => false);
            
            if (!isPageActive) {
                await this._initializeActivityPage();
                if (!this.activityPage) return;
            }
            
            // Navegación entre páginas del sistema
            const pages = [
                `${config.datadiverservice.baseUrl}/dashboard`,
                `${config.datadiverservice.baseUrl}/consultation`,
                `${config.datadiverservice.baseUrl}/reports`
            ];
            
            const randomPage = pages[Math.floor(Math.random() * pages.length)];
            
            await this.activityPage.goto(randomPage, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            
            await delay(800);
            
            // Actividad de usuario realista
            for (let i = 0; i < 2; i++) {
                // Movimiento de mouse
                await this.activityPage.mouse.move(
                    Math.random() * 600 + 200, 
                    Math.random() * 400 + 150
                );
                await delay(400);
                
                // Scroll suave
                await this.activityPage.evaluate(() => {
                    if (typeof window !== 'undefined') {
                        window.scrollBy(0, Math.random() * 200 + 100);
                    }
                }).catch(() => {});
                await delay(300);
            }
            
            // Volver arriba
            await this.activityPage.evaluate(() => {
                if (typeof window !== 'undefined') {
                    window.scrollTo(0, 0);
                }
            }).catch(() => {});
            
            logger.debug('✅ Actividad regular completada');
            
        } catch (error) {
            if (!error.message.includes('Navigation timeout')) {
                logger.debug('Error en actividad regular', { error: error.message });
            }
        }
    }

    /**
     * Actividad intensiva cuando el sistema está idle
     */
    async _performIntensiveActivity() {
        try {
            // Realizar múltiples actividades en paralelo
            const activities = [
                this._performRegularActivity(),
                this._simulateUserInteraction(),
                this._performQuickNavigation()
            ];
            
            await Promise.allSettled(activities);
            
            logger.debug('🔥 Actividad intensiva completada');
            
        } catch (error) {
            logger.debug('Error en actividad intensiva', { error: error.message });
        }
    }

    /**
     * Simula interacción de usuario más realista
     */
    async _simulateUserInteraction() {
        if (!this.activityPage) return;
        
        try {
            // Simular clicks ocasionales en elementos seguros
            await this.activityPage.evaluate(() => {
                if (document.body) {
                    // Simular evento de mouse
                    const event = new MouseEvent('mousemove', {
                        bubbles: true,
                        cancelable: true,
                        clientX: Math.random() * window.innerWidth,
                        clientY: Math.random() * window.innerHeight
                    });
                    document.dispatchEvent(event);
                    
                    // Click ocasional en body
                    if (Math.random() < 0.3) {
                        document.body.click();
                    }
                }
            }).catch(() => {});
            
            await delay(200);
            
        } catch (error) {
            logger.debug('Error en simulación de interacción', { error: error.message });
        }
    }

    /**
     * Navegación rápida por páginas
     */
    async _performQuickNavigation() {
        let navPage = null;
        try {
            navPage = await this.browserService.browser.newPage();
            await navPage.setDefaultNavigationTimeout(8000);
            await navPage.setRequestInterception(true);
            navPage.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            
            // Navegación rápida
            await navPage.goto(`${config.datadiverservice.baseUrl}/dashboard`, {
                waitUntil: 'domcontentloaded',
                timeout: 8000
            });
            
            await delay(500);
            
            // Actividad mínima
            await navPage.evaluate(() => {
                if (typeof window !== 'undefined') {
                    window.scrollBy(0, 100);
                }
            }).catch(() => {});
            
        } catch (error) {
            logger.debug('Error en navegación rápida', { error: error.message });
        } finally {
            if (navPage) {
                try {
                    await navPage.close();
                } catch (e) {}
            }
        }
    }

    /**
     * Heartbeat para mantener conexión HTTP viva
     */
    async _performHeartbeat() {
        if (!this.browserService.isReady || !this.authService.token) return;
        
        try {
            // Heartbeat simple con request directo
            const heartbeatEndpoint = `${config.datadiverservice.apiUrl}/ds/crn/client/info/general/new?dni=0000000000`;
            
            const response = await fetch(heartbeatEndpoint, {
                headers: this.authService.authHeaders,
                signal: AbortSignal.timeout(3000)
            }).catch(() => null);
            
            if (response) {
                if (response.status === 401 || response.status === 403) {
                    logger.warn('Sesión expirada detectada en heartbeat');
                    this.authService.token = '';
                    this.authService.tokenExpiry = 0;
                } else {
                    logger.debug('💓 Heartbeat exitoso');
                }
            }
            
            // Actividad adicional en página dedicada
            if (this.activityPage) {
                await this.activityPage.evaluate(() => {
                    if (typeof document !== 'undefined') {
                        document.dispatchEvent(new Event('mousemove'));
                    }
                }).catch(() => {});
            }
            
        } catch (error) {
            logger.debug('Error en heartbeat (no crítico)', { error: error.message });
        }
    }

    /**
     * Consulta real para verificar estado de sesión
     */
    async _performRealQuery() {
        if (!this.browserService.isReady || !this.authService.token || this.isPerformingActivity) return;
        
        let queryPage = null;
        try {
            logger.debug('🔍 Realizando consulta real de verificación');
            
            queryPage = await this.browserService.browser.newPage();
            await queryPage.setDefaultNavigationTimeout(10000);
            await queryPage.setDefaultTimeout(10000);
            
            await queryPage.setRequestInterception(true);
            queryPage.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            
            let sessionValid = false;
            
            queryPage.on('response', async (response) => {
                const url = response.url();
                if (url.includes('api.datadiverservice.com')) {
                    if (response.status() === 200) {
                        sessionValid = true;
                        logger.debug('✅ Consulta real exitosa - sesión activa');
                    } else if (response.status() === 401 || response.status() === 403) {
                        logger.warn('❌ Sesión expirada detectada en consulta real');
                        this.authService.token = '';
                        this.authService.tokenExpiry = 0;
                    }
                }
            });
            
            // Usar DNI rotativo para evitar patrones
            const testDNI = this.testDNIs[this.currentDNIIndex];
            this.currentDNIIndex = (this.currentDNIIndex + 1) % this.testDNIs.length;
            
            await queryPage.goto(`${config.datadiverservice.baseUrl}/consultation/${testDNI}/client`, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            
            // Simular actividad en la consulta
            await delay(800);
            await queryPage.evaluate(() => {
                if (typeof window !== 'undefined') {
                    window.scrollBy(0, 150);
                }
            }).catch(() => {});
            
            await delay(400);
            
            // Esperar respuestas
            await Promise.race([
                new Promise(resolve => {
                    const checkResponse = setInterval(() => {
                        if (sessionValid) {
                            clearInterval(checkResponse);
                            resolve();
                        }
                    }, 100);
                }),
                delay(4000)
            ]);
            
        } catch (error) {
            if (!error.message.includes('Navigation timeout')) {
                logger.debug('Error en consulta real (no crítico)', { error: error.message });
            }
        } finally {
            if (queryPage) {
                try {
                    await queryPage.close();
                } catch (e) {}
            }
        }
    }

    /**
     * Actualiza el tiempo de última request (llamado externamente)
     */
    updateLastRequestTime() {
        this.lastRequestTime = Date.now();
    }

    /**
     * Detiene el sistema de keep-alive
     */
    stop() {
        this._clearIntervals();
        
        // Cerrar página dedicada
        if (this.activityPage) {
            this.activityPage.close().catch(() => {});
            this.activityPage = null;
        }
        
        logger.info('Sistema keep-alive con actividad automática detenido');
    }

    /**
     * Limpia intervalos
     */
    _clearIntervals() {
        const intervals = [
            'keepAliveInterval', 
            'activityInterval', 
            'heartbeatInterval',
            'realQueryInterval'
        ];
        
        intervals.forEach(interval => {
            if (this[interval]) {
                clearInterval(this[interval]);
                this[interval] = null;
            }
        });
    }

    /**
     * Obtiene estadísticas del keep-alive
     */
    get stats() {
        return {
            isActive: !!this.keepAliveInterval,
            isIdle: this.isIdle,
            lastActivity: new Date(this.lastActivityTime).toLocaleTimeString(),
            tokenTimeLeft: this.authService.timeLeftMinutes + ' min',
            activityPageReady: !!this.activityPage
        };
    }
}

module.exports = KeepAliveService;