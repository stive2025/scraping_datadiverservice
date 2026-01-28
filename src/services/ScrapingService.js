const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');
const { delay, retry, getData } = require('../utils/helpers');

class ScrapingService {
    constructor(browserService, authService, familyService, keepAliveService = null) {
        this.browserService = browserService;
        this.authService = authService;
        this.familyService = familyService;
        this.keepAliveService = keepAliveService; // NEW: Reference to KeepAliveService
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageResponseTime: 0,
            maxQueueSize: 0
        };
        this.lastRequestTime = Date.now();
        this.lastHealthCheck = 0; // NEW: Track last health check time
        this.concurrentRequests = new Map(); // NEW: Track concurrent requests
        this.sessionValidationInProgress = false; // NEW: Prevent concurrent session validations
    }

    /**
     * Realiza scraping de datos para un DNI específico con reintentos automáticos transparentes
     */
    async scrapeData(dni, endpoint = '/title', maxRetries = 2) {
        const startTime = Date.now();
        const requestId = `${dni}-${startTime}`;
        let page = null;
        let currentAttempt = 0;
        
        while (currentAttempt <= maxRetries) {
            try {
                if (currentAttempt === 0) {
                    this.stats.totalRequests++;
                    this.lastRequestTime = Date.now();
                    
                    // Notificar al KeepAliveService sobre la nueva request
                    if (this.keepAliveService) {
                        this.keepAliveService.updateLastRequestTime();
                    }
                    
                    // Registrar request concurrente
                    this.concurrentRequests.set(requestId, { dni, startTime, endpoint });
                    
                    // Iniciar consulta estilo Chrome
                    consoleLogger.queryStart(dni);
                } else {
                    consoleLogger.loadingProgress(dni, 'Reintentando consulta automáticamente...');
                }
                
                // Verificar y renovar token si es necesario (con control de concurrencia)
                await this._ensureValidToken();
                
                // Obtener página del pool
                await this.browserService.waitForAvailableSlot();
                page = await this.browserService.getPageFromPool();
                
                // Configurar captura de datos
                const data = this._initializeDataStructure();
                const dataReceived = this._initializeDataReceivedFlags();
                
                const { dataLoadedPromise, resolveDataLoaded } = this._setupDataCapture(page, data, dataReceived, dni);
                
                // Navegar a la página de consulta
                await this._navigateToConsultation(page, dni);
                
                // Esperar a que se carguen los datos con timeout optimizado
                await Promise.race([
                    dataLoadedPromise,
                    delay(3500)
                ]);
                
                // Verificar si se capturaron datos básicos
                if (!dataReceived.general || !dataReceived.contacts) {
                    // Verificar si es problema de sesión
                    const tokenStillValid = this.authService.token && 
                        Date.now() < this.authService.tokenExpiry - (2 * 60 * 1000);
                    
                    if (!tokenStillValid) {
                        // Sesión expirada - forzar renovación y reintentar
                        logger.warn('Sesión expirada detectada, renovando automáticamente', { 
                            dni, 
                            attempt: currentAttempt + 1 
                        });
                        
                        this.authService.token = '';
                        this.authService.tokenExpiry = 0;
                        
                        // Cerrar página actual
                        if (page) {
                            await this.browserService.returnPageToPool(page);
                            page = null;
                        }
                        this.browserService.releaseSlot();
                        
                        // Esperar un momento antes del reintento
                        await delay(1000);
                        
                        // Incrementar intento y continuar el loop
                        currentAttempt++;
                        continue;
                    }
                }
                
                // Capturar datos de familia adicionales si es necesario
                await this._captureFamilyData(dni, data, dataReceived);
                
                // Si llegamos aquí, la consulta fue exitosa
                this.stats.successfulRequests++;
                const responseTime = Date.now() - startTime;
                this._updateAverageResponseTime(responseTime);
                
                // Mostrar resultado final estilo Chrome
                consoleLogger.queryComplete(dni, responseTime, true);
                
                return data;
                
            } catch (error) {
                // Cerrar página si hay error
                if (page) {
                    await this.browserService.returnPageToPool(page);
                    page = null;
                }
                this.browserService.releaseSlot();
                
                // Verificar si es un error de sesión que podemos reintentar
                const isSessionError = error.message.includes('Sesión expirada') || 
                                     error.message.includes('401') || 
                                     error.message.includes('403') ||
                                     error.message.includes('unauthorized');
                
                if (isSessionError && currentAttempt < maxRetries) {
                    logger.warn('Error de sesión detectado, reintentando automáticamente', { 
                        dni, 
                        error: error.message,
                        attempt: currentAttempt + 1,
                        maxRetries: maxRetries + 1
                    });
                    
                    // Forzar renovación de token
                    this.authService.token = '';
                    this.authService.tokenExpiry = 0;
                    
                    // Esperar antes del reintento
                    await delay(1500);
                    
                    currentAttempt++;
                    continue;
                }
                
                // Si no es error de sesión o ya agotamos reintentos, lanzar error
                this.stats.failedRequests++;
                const responseTime = Date.now() - startTime;
                consoleLogger.queryComplete(dni, responseTime, false);
                logger.error('Error en scraping tras reintentos', { 
                    dni,
                    endpoint,
                    error: error.message,
                    attempts: currentAttempt + 1,
                    stack: error.stack
                });
                throw error;
            } finally {
                // Limpiar recursos solo en el último intento
                if (currentAttempt >= maxRetries || page) {
                    this.concurrentRequests.delete(requestId);
                    
                    if (page) {
                        await this.browserService.returnPageToPool(page);
                    }
                    this.browserService.releaseSlot();
                }
            }
        }
    }

    /**
     * Asegura que el token sea válido con verificación mejorada
     */
    async _ensureValidToken() {
        const now = Date.now();
        
        // Verificación más inteligente: renovar si queda menos de 5 minutos
        const timeUntilExpiry = this.authService.tokenExpiry - now;
        const shouldRenewByTime = !this.authService.token || timeUntilExpiry < (5 * 60 * 1000);
        
        if (shouldRenewByTime) {
            const reason = !this.authService.token ? 'sin token' : 'próximo a expirar';
            const timeLeftMin = Math.floor(timeUntilExpiry / 60000);
            
            if (this.authService.isLoggingIn) {
                consoleLogger.auth('Login en progreso, esperando token fresco...');
                // Esperar hasta 15 segundos a que termine el login
                let attempts = 0;
                while (this.authService.isLoggingIn && attempts < 30) {
                    await delay(500);
                    attempts++;
                }
            } else {
                consoleLogger.auth(`Renovando token (${reason}, ${timeLeftMin} min restantes)`);
                await this.authService.performLogin();
            }
        } else {
            // Token debería ser válido según tiempo local, pero verificar salud ocasionalmente
            const timeSinceLastCheck = now - (this.lastHealthCheck || 0);
            
            // Verificar salud solo cada 2 minutos para no sobrecargar
            if (timeSinceLastCheck > (2 * 60 * 1000)) {
                this.lastHealthCheck = now;
                
                const sessionHealthy = await this.authService.checkSessionHealth();
                if (!sessionHealthy) {
                    if (this.authService.isLoggingIn) {
                        consoleLogger.auth('Renovación de sesión en progreso, esperando...');
                        let attempts = 0;
                        while (this.authService.isLoggingIn && attempts < 30) {
                            await delay(500);
                            attempts++;
                        }
                    } else {
                        consoleLogger.warn('Sesión no saludable detectada, renovando', { 
                            action: 'Renovando automáticamente' 
                        });
                        await this.authService.performLogin();
                    }
                }
            }
        }

        // Verificación final
        if (!this.authService.token) {
            throw new Error('No se pudo obtener un token válido');
        }
    }

    /**
     * Inicializa la estructura de datos
     */
    _initializeDataStructure() {
        return {
            info_general: {},
            info_contacts: {},
            info_vehicles: {},
            info_labour: {},
            info_property: {},
            info_favorities: {},
            info_family: {}
        };
    }

    /**
     * Inicializa las banderas de datos recibidos
     */
    _initializeDataReceivedFlags() {
        return {
            general: false,
            contacts: false,
            vehicles: false,
            labour: false,
            property: false,
            favorities: false,
            family: false
        };
    }

    /**
     * Configura la captura de datos de respuestas HTTP con detección rápida de expiración
     */
    _setupDataCapture(page, data, dataReceived, dni) {
        let resolveDataLoaded;
        const dataLoadedPromise = new Promise(resolve => {
            resolveDataLoaded = resolve;
        });

        page.on('response', async (response) => {
            try {
                const url = response.url();
                
                // Verificar si la respuesta indica sesión expirada - DETECCIÓN RÁPIDA
                if (response.status() === 401 || response.status() === 403) {
                    consoleLogger.warn('Sesión expirada detectada durante scraping', { 
                        dni,
                        action: 'Renovando token automáticamente'
                    });
                    this.authService.token = '';
                    this.authService.tokenExpiry = 0;
                    // Resolver inmediatamente para no esperar más datos
                    resolveDataLoaded();
                    return;
                }
                
                // Capturar datos de diferentes endpoints
                const endpoints = {
                    info_general: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/general/new'}),
                    info_contacts: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/contact'}),
                    info_vehicles: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crm/client/vehicle'}),
                    info_labour: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/labournew'}),
                    info_property: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crm/client/property'}),
                    info_favorities: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/favorites'}),
                    info_family: await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/family/new'})
                };

                // Asignar datos capturados y mostrar progreso
                Object.entries(endpoints).forEach(([key, value]) => {
                    if (value !== undefined) {
                        data[key] = value;
                        const flagKey = key.replace('info_', '');
                        dataReceived[flagKey] = true;
                        
                        // Mostrar progreso de captura estilo Chrome
                        const dataTypeNames = {
                            'general': 'general',
                            'contacts': 'contacts',
                            'vehicles': 'vehicles',
                            'labour': 'labour',
                            'property': 'property',
                            'favorities': 'favorities',
                            'family': 'family'
                        };
                        
                        consoleLogger.dataCapture(dni, dataTypeNames[flagKey], true);
                    }
                });

                // Resolver cuando se tengan datos básicos
                if (dataReceived.general && dataReceived.contacts) {
                    resolveDataLoaded();
                }
            } catch (err) {
                logger.error('Error procesando response', { 
                    dni,
                    error: err.message 
                });
            }
        });

        return { dataLoadedPromise, resolveDataLoaded };
    }

    /**
     * Navega a la página de consulta con optimizaciones de velocidad
     */
    async _navigateToConsultation(page, dni) {
        await retry(async () => {
            await page.goto(`${config.datadiverservice.baseUrl}/consultation/${dni}/client`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000 // Reducido de 25s a 20s
            });
        }, 1, 1000);
        
        // Hacer scroll optimizado para activar carga de datos adicionales
        try {
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await delay(500); // Reducido de 1000ms a 500ms
            await page.evaluate(() => {
                window.scrollTo(0, 0);
            });
        } catch (scrollError) {
            logger.debug('Error haciendo scroll', { 
                dni,
                error: scrollError.message 
            });
        }
    }

    /**
     * Captura datos de familia adicionales con estrategia optimizada
     */
    async _captureFamilyData(dni, data, dataReceived) {
        const currentFamilyCount = this._getCurrentFamilyCount(data);
        
        // Optimización: Solo intentar captura adicional si realmente no hay datos de familia
        if (!dataReceived.family && currentFamilyCount === 0) {
            logger.info('Family no capturado, intentando captura optimizada', { 
                dni,
                currentFamilyCount,
                dataReceived: dataReceived.family
            });
            
            try {
                const familyData = await this.familyService.tryMultipleFamilyEndpoints(dni);
                const totalFamilyMembers = this.familyService._getTotalMembers(familyData);
                
                if (totalFamilyMembers > 0) {
                    // Combinar con datos existentes evitando duplicados
                    const mergedFamilyData = this._mergeFamilyData(data.info_family, familyData);
                    data.info_family = mergedFamilyData;
                    
                    logger.info('Familia capturada exitosamente con estrategia optimizada', {
                        dni,
                        totalMembers: totalFamilyMembers,
                        previousCount: currentFamilyCount,
                        improvement: totalFamilyMembers - currentFamilyCount
                    });
                } else {
                    logger.debug('Estrategia optimizada no obtuvo resultados', { dni });
                }
            } catch (error) {
                logger.error('Error en captura optimizada de familia', { 
                    dni, 
                    error: error.message 
                });
            }
        } else {
            logger.debug('Datos de familia ya capturados o presentes', {
                dni,
                familyCount: currentFamilyCount,
                dataReceived: dataReceived.family
            });
        }
    }

    /**
     * Obtiene el conteo actual de miembros de familia
     */
    _getCurrentFamilyCount(data) {
        let count = 0;
        
        if (data.info_family) {
            count += (data.info_family.family?.length || 0);
            count += (data.info_family.data?.length || 0);
            count += (data.info_family.results?.length || 0);
            count += (data.info_family.relatives?.length || 0);
            count += (data.info_family.parentesco?.length || 0);
        }
        
        return count;
    }

    /**
     * Combina datos de familia evitando duplicados
     */
    _mergeFamilyData(existingData, newData) {
        if (!existingData || Object.keys(existingData).length === 0) {
            return newData;
        }
        
        const merged = { ...existingData };
        const keys = ['family', 'data', 'results', 'relatives', 'parentesco'];
        
        keys.forEach(key => {
            if (newData[key] && Array.isArray(newData[key])) {
                if (!merged[key]) merged[key] = [];
                
                // Agregar solo elementos que no estén duplicados
                const existingIds = new Set();
                merged[key].forEach(item => {
                    const id = item.dni || item.identification || item.fullname || item.name;
                    if (id) existingIds.add(id);
                });
                
                const newItems = newData[key].filter(item => {
                    const id = item.dni || item.identification || item.fullname || item.name;
                    return id && !existingIds.has(id);
                });
                
                merged[key].push(...newItems);
            }
        });
        
        return merged;
    }

    /**
     * Maneja fallos en el scraping
     */
    async _handleFailedScraping(dni, endpoint, dataReceived) {
        if (!dataReceived.general && !dataReceived.contacts) {
            consoleLogger.warn('Sesión expirada detectada, forzando re-login', { 
                dni, 
                action: 'Renovando credenciales'
            });
            
            // Forzar renovación de token inmediatamente
            this.authService.token = '';
            this.authService.tokenExpiry = 0;
            
            try {
                await this.authService.performLogin();
                return true; // Indica que se debe reintentar
            } catch (error) {
                logger.error('Error renovando sesión después de fallo', { 
                    dni, 
                    error: error.message 
                });
                return false;
            }
        }
        
        return false;
    }

    /**
     * Actualiza el tiempo promedio de respuesta
     */
    _updateAverageResponseTime(responseTime) {
        this.stats.averageResponseTime = 
            (this.stats.averageResponseTime * (this.stats.successfulRequests - 1) + responseTime) / 
            this.stats.successfulRequests;
    }

    /**
     * Getters para estadísticas
     */
    get statistics() {
        return {
            ...this.stats,
            successRate: this.stats.totalRequests > 0 ? 
                ((this.stats.successfulRequests / this.stats.totalRequests) * 100).toFixed(2) + '%' : '0%',
            averageResponseTime: this.stats.averageResponseTime.toFixed(0) + 'ms'
        };
    }
}

module.exports = ScrapingService;