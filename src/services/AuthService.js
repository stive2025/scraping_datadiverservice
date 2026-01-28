const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');
const { delay, retry } = require('../utils/helpers');

class AuthService {
    constructor(browserService) {
        this.browserService = browserService;
        this.token = '';
        this.tokenExpiry = 0;
        this.isLoggingIn = false;
        this.isValidating = false; // NEW: Prevent concurrent session validations
        this.validationPromise = null; // NEW: Share validation results
        this.lastValidation = 0; // NEW: Cache validation results
        this.tokenVersion = 0; // NEW: Track token changes
        this.waitingForToken = []; // NEW: Queue requests waiting for token
    }

    /**
     * Realiza el login - BASADO EN CÓDIGO QUE FUNCIONA
     */
    async performLogin() {
        if (this.isLoggingIn) {
            logger.info('Login en curso, esperando...');
            let attempts = 0;
            while (this.isLoggingIn && attempts < 30) { // Como el código que funciona
                await delay(500);
                attempts++;
            }
            if (this.token) {
                logger.info('Token obtenido por otro proceso');
                return;
            }
        }
        
        this.isLoggingIn = true;
        consoleLogger.auth('Iniciando proceso de autenticación...');
        logger.info('Iniciando proceso de login', { username: config.datadiverservice.username });
        let loginPage = null;
        
        try {
            await retry(async () => {
                loginPage = await this.browserService.browser.newPage();
                await loginPage.setDefaultNavigationTimeout(20000); // Como el código que funciona
                
                let tokenCaptured = false;
                
                loginPage.on('response', async (response) => {
                    const url = response.url();
                    if (url.includes('api.datadiverservice.com/login')) {
                        try {
                            const data = await response.json();
                            if (data.accessToken) {
                                this.token = data.accessToken;
                                this.tokenExpiry = Date.now() + config.session.tokenExpiryTime; // 50 minutos
                                this.tokenVersion++;
                                tokenCaptured = true;
                                consoleLogger.auth('Token capturado exitosamente', {
                                    timeLeft: `${Math.floor((config.session.tokenExpiryTime) / 60000)} min`
                                });
                            }
                        } catch (err) {
                            logger.error('Error capturando token', { error: err.message });
                        }
                    }
                });
                
                await loginPage.goto(`${config.datadiverservice.baseUrl}/auth/login`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                });
                
                await loginPage.waitForSelector('input#mat-input-0', { timeout: 8000 });
                await loginPage.type('input#mat-input-0', config.datadiverservice.username);
                await loginPage.type('input#mat-input-1', config.datadiverservice.password);
                await loginPage.click("button#kt_login_signin_submit");
                
                await Promise.race([
                    new Promise(resolve => {
                        const checkToken = setInterval(() => {
                            if (tokenCaptured) {
                                clearInterval(checkToken);
                                resolve();
                            }
                        }, 100);
                    }),
                    delay(8000)
                ]);
                
                if (!tokenCaptured) {
                    throw new Error('No se pudo capturar el token del login');
                }
                
                logger.info('Login completado exitosamente');
                
            }, 2, 2000); // Como el código que funciona
        } finally {
            if (loginPage) {
                try {
                    await loginPage.close();
                } catch (e) {
                    logger.error('Error cerrando página de login', { error: e.message });
                }
            }
            this.isLoggingIn = false;
        }
    }

    /**
     * Verifica la salud de la sesión - MEJORADO CON VERIFICACIÓN REAL
     */
    async checkSessionHealth() {
        if (!this.token || this.isLoggingIn) return false;
        
        // Verificación local primero - si el token debería estar expirado según nuestro tiempo
        const now = Date.now();
        const timeUntilExpiry = this.tokenExpiry - now;
        
        // Si queda menos de 2 minutos según nuestro tiempo local, considerar expirado
        if (timeUntilExpiry < (2 * 60 * 1000)) {
            logger.warn('Token próximo a expirar según tiempo local', { 
                timeLeft: Math.floor(timeUntilExpiry / 60000) + ' min' 
            });
            this.token = '';
            this.tokenExpiry = 0;
            return false;
        }
        
        // Verificación real con la API
        try {
            const healthEndpoint = `${config.datadiverservice.apiUrl}/ds/crn/client/info/general/new?dni=0123456789`;
            
            const healthCheck = await fetch(healthEndpoint, {
                headers: this.authHeaders,
                signal: AbortSignal.timeout(8000) // Timeout más largo para verificación real
            });
            
            // Verificar respuesta de autenticación
            if (healthCheck.status === 401 || healthCheck.status === 403) {
                logger.warn('Sesión expirada detectada por API', { status: healthCheck.status });
                this.token = '';
                this.tokenExpiry = 0;
                return false;
            }
            
            // Si la respuesta es exitosa, la sesión está saludable
            if (healthCheck.ok) {
                logger.debug('Sesión confirmada como saludable por API');
                return true;
            }
            
            // Para otros códigos de estado (4xx, 5xx), verificar el contenido
            const responseText = await healthCheck.text().catch(() => '');
            
            // Buscar indicadores de sesión expirada en la respuesta
            if (responseText.includes('unauthorized') || 
                responseText.includes('expired') || 
                responseText.includes('invalid token') ||
                responseText.includes('authentication required')) {
                logger.warn('Sesión expirada detectada en contenido de respuesta');
                this.token = '';
                this.tokenExpiry = 0;
                return false;
            }
            
            // Si llegamos aquí, asumir que la sesión está bien
            logger.debug('Health check inconcluso, asumiendo sesión válida', { 
                status: healthCheck.status,
                timeLeft: Math.floor(timeUntilExpiry / 60000) + ' min'
            });
            return true;
            
        } catch (error) {
            // En caso de error de red, verificar tiempo local
            if (timeUntilExpiry > (10 * 60 * 1000)) {
                logger.debug('Error en health check, pero token debería ser válido según tiempo local', { 
                    error: error.message,
                    timeLeft: Math.floor(timeUntilExpiry / 60000) + ' min'
                });
                return true;
            } else {
                logger.warn('Error en health check y token próximo a expirar, renovando por seguridad', { 
                    error: error.message,
                    timeLeft: Math.floor(timeUntilExpiry / 60000) + ' min'
                });
                this.token = '';
                this.tokenExpiry = 0;
                return false;
            }
        }
    }

    /**
     * Realiza la validación real de la sesión con múltiples endpoints y manejo inteligente de errores
     */
    async _performSessionValidation() {
        try {
            logger.debug('Verificando salud de la sesión con estrategia multi-endpoint');
            
            // Múltiples endpoints de prueba con DNIs más realistas para Ecuador
            const healthEndpoints = [
                `${config.datadiverservice.apiUrl}/ds/crn/client/info/general/new?dni=0123456789`,
                `${config.datadiverservice.apiUrl}/ds/crn/client/info/contact?dni=0123456789`,
                `${config.datadiverservice.apiUrl}/ds/crm/client/vehicle?dni=0123456789`
            ];
            
            let lastError = null;
            let authenticationErrors = 0;
            let serverErrors = 0;
            let successfulChecks = 0;
            let clientErrors = 0;
            let networkErrors = 0;
            
            // Probar múltiples endpoints para obtener una imagen más clara del estado
            for (const endpoint of healthEndpoints) {
                try {
                    const healthCheck = await fetch(endpoint, {
                        headers: {
                            Accept: 'application/json',
                            Authorization: `Bearer ${this.token}`,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        signal: AbortSignal.timeout(4000) // Timeout más corto por endpoint
                    });
                    
                    // Errores de autenticación - sesión definitivamente expirada
                    if (healthCheck.status === 401 || healthCheck.status === 403) {
                        authenticationErrors++;
                        logger.debug('Error de autenticación en health check', { 
                            endpoint,
                            status: healthCheck.status 
                        });
                        continue;
                    }
                    
                    // Respuesta exitosa - sesión definitivamente válida
                    if (healthCheck.ok) {
                        successfulChecks++;
                        logger.debug('Health check exitoso', { endpoint, status: healthCheck.status });
                        // Si al menos un endpoint responde bien, la sesión está saludable
                        return true;
                    }
                    
                    // Errores del servidor (5xx) - no indican problema de sesión
                    if (healthCheck.status >= 500) {
                        serverErrors++;
                        logger.debug('Error temporal del servidor en health check', { 
                            endpoint,
                            status: healthCheck.status 
                        });
                        continue;
                    }
                    
                    // Errores 4xx (excepto 401/403) - pueden ser DNI inválido, rate limiting, etc.
                    if (healthCheck.status >= 400 && healthCheck.status < 500) {
                        clientErrors++;
                        logger.debug('Error de cliente en health check (posible DNI inválido)', { 
                            endpoint,
                            status: healthCheck.status 
                        });
                        // Para errores 4xx, asumir que la sesión está bien pero el DNI es inválido
                        continue;
                    }
                    
                } catch (endpointError) {
                    lastError = endpointError;
                    networkErrors++;
                    if (endpointError.name === 'AbortError') {
                        logger.debug('Timeout en endpoint de health check', { endpoint });
                    } else {
                        logger.debug('Error de red en health check', { 
                            endpoint,
                            error: endpointError.message 
                        });
                    }
                    continue;
                }
            }
            
            // Análisis de resultados con lógica más conservadora
            const totalEndpoints = healthEndpoints.length;
            
            // Solo marcar como expirada si TODOS los endpoints que respondieron reportan error de auth
            if (authenticationErrors > 0 && (authenticationErrors + networkErrors) === totalEndpoints) {
                // Todos los endpoints que respondieron reportan error de autenticación
                logger.warn('Sesión expirada confirmada por múltiples endpoints', { 
                    authErrors: authenticationErrors,
                    networkErrors: networkErrors,
                    totalEndpoints: totalEndpoints
                });
                this.token = '';
                this.tokenExpiry = 0;
                return false;
            }
            
            // Si hay al menos un endpoint exitoso, la sesión está saludable
            if (successfulChecks > 0) {
                logger.debug('Sesión confirmada como saludable', { 
                    successfulChecks,
                    authErrors: authenticationErrors,
                    serverErrors,
                    clientErrors,
                    networkErrors,
                    totalEndpoints
                });
                return true;
            }
            
            // Si hay errores mixtos (algunos auth, algunos no), ser más conservador
            if (authenticationErrors > 0 && authenticationErrors < totalEndpoints) {
                logger.debug('Errores de autenticación parciales detectados, verificando token local', {
                    authErrors: authenticationErrors,
                    totalEndpoints,
                    tokenTimeLeft: this.timeLeftMinutes + ' min'
                });
                
                // Verificar si el token debería estar válido según nuestro tiempo local
                const tokenShouldBeValid = this.token && Date.now() < this.tokenExpiry - (5 * 60 * 1000);
                
                if (tokenShouldBeValid) {
                    logger.debug('Token debería estar válido según tiempo local, asumiendo problemas temporales');
                    return true;
                } else {
                    logger.debug('Token cerca de expirar según tiempo local, confirmando expiración');
                    this.token = '';
                    this.tokenExpiry = 0;
                    return false;
                }
            }
            
            // Si solo hay errores de servidor, cliente o red, asumir que la sesión está bien
            if (serverErrors > 0 || clientErrors > 0 || networkErrors > 0) {
                logger.debug('Solo errores temporales detectados, asumiendo sesión válida', { 
                    serverErrors,
                    clientErrors,
                    networkErrors,
                    totalEndpoints
                });
                return true;
            }
            
            // Caso edge: ningún endpoint respondió de manera concluyente
            logger.debug('Health check inconcluso, verificando tiempo local del token');
            const tokenShouldBeValid = this.token && Date.now() < this.tokenExpiry - (5 * 60 * 1000);
            return tokenShouldBeValid;
            
        } catch (error) {
            logger.error('Error crítico verificando sesión', { error: error.message });
            // En caso de error crítico, verificar tiempo local del token
            const tokenShouldBeValid = this.token && Date.now() < this.tokenExpiry - (5 * 60 * 1000);
            return tokenShouldBeValid;
        }
    }

    /**
     * Getters para acceso a propiedades
     */
    get isTokenValid() {
        return !!this.token && Date.now() < this.tokenExpiry;
    }

    get timeLeft() {
        return this.tokenExpiry - Date.now();
    }

    get timeLeftMinutes() {
        return Math.floor(this.timeLeft / 60000);
    }

    get authHeaders() {
        return {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': config.datadiverservice.baseUrl,
            'X-Token-Version': this.tokenVersion.toString() // Agregar versión del token
        };
    }

    /**
     * Obtiene headers con token fresco garantizado
     */
    async getFreshAuthHeaders() {
        // Si el token está próximo a expirar, renovarlo
        const now = Date.now();
        if (!this.token || now >= this.tokenExpiry - (2 * 60 * 1000)) {
            await this.performLogin();
        }
        
        return this.authHeaders;
    }
}

module.exports = AuthService;