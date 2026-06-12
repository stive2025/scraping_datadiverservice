const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');
const { delay } = require('../utils/helpers');

// Mismo UA que BrowserService — deben ser idénticos en toda la sesión
const CHROME_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * AuthService — gestiona autenticación híbrida.
 *
 * El login usa Puppeteer (browser real) para resolver el reCAPTCHA del formulario
 * e intercepta el Bearer token JWT de la respuesta HTTP.
 * El token se almacena y se reutiliza para todas las consultas via HTTP directo.
 * Duración del token: ~5 horas. Solo se necesita 1 login cada 5 horas.
 */
class AuthService {
    constructor(browserService) {
        this.browserService = browserService;
        this._accessToken = null;
        this._tokenExpiry = null;
        this._loginMutex = null;
    }

    /**
     * Realiza login con mutex para evitar logins concurrentes.
     */
    async performLogin(maxRetries = 3) {
        if (this._loginMutex) {
            logger.info('Login en curso, esperando resultado compartido...');
            return this._loginMutex;
        }

        this._loginMutex = (async () => {
            let lastError;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    await this._doLogin();
                    return;
                } catch (err) {
                    lastError = err;
                    logger.warn(`Login fallido (intento ${attempt}/${maxRetries})`, { error: err.message });
                    if (attempt < maxRetries) {
                        await delay(3000 * attempt); // espera 3s, 6s entre reintentos
                    }
                }
            }
            throw lastError;
        })().finally(() => {
            this._loginMutex = null;
        });

        return this._loginMutex;
    }

    /**
     * Login via Puppeteer: rellena formulario (reCAPTCHA incluido) e intercepta
     * el Bearer token de la respuesta POST /login.
     */
    async _doLogin() {
        consoleLogger.auth('Iniciando autenticación via browser...');
        logger.info('Iniciando login con Puppeteer', { username: config.datadiverservice.username });

        let loginPage = null;

        try {
            loginPage = await this.browserService.browser.newPage();
            await loginPage.setDefaultNavigationTimeout(25000);

            // Interceptar la respuesta del POST /login para capturar el Bearer token
            let tokenResolve, tokenReject;
            const tokenPromise = new Promise((res, rej) => {
                tokenResolve = res;
                tokenReject  = rej;
            });

            loginPage.on('response', async (response) => {
                if (
                    response.url().includes('/login') &&
                    response.request().method() === 'POST'
                ) {
                    try {
                        const data = await response.json();
                        if (data.accessToken) {
                            tokenResolve(data.accessToken);
                        }
                    } catch (e) {
                        // respuesta no JSON, ignorar
                    }
                }
            });

            // Navegar al formulario de login
            await loginPage.goto(`${config.datadiverservice.baseUrl}/auth/login`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });

            await loginPage.waitForSelector('input#mat-input-0', { timeout: 12000 });

            // Dar tiempo a reCAPTCHA v3 para inicializarse antes de interactuar
            await delay(3000 + Math.random() * 1000);

            // Rellenar credenciales con delays humanos
            await loginPage.click('input#mat-input-0');
            await delay(200 + Math.random() * 150);
            await loginPage.type('input#mat-input-0', config.datadiverservice.username, { delay: 60 + Math.random() * 30 });

            await delay(300 + Math.random() * 200);
            await loginPage.click('input#mat-input-1');
            await delay(150 + Math.random() * 100);
            await loginPage.type('input#mat-input-1', config.datadiverservice.password, { delay: 60 + Math.random() * 30 });

            await delay(400 + Math.random() * 200);
            await loginPage.click('button#kt_login_signin_submit');

            // Esperar a que llegue el Bearer token (máx 30s — reCAPTCHA v3 necesita tiempo)
            const token = await Promise.race([
                tokenPromise,
                new Promise((_, rej) => setTimeout(() => rej(new Error('Token no capturado en 30s')), 30000))
            ]);

            this._accessToken = token;

            // Parsear expiración del JWT
            try {
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                this._tokenExpiry = payload.exp * 1000;
                const minutesLeft = Math.round((this._tokenExpiry - Date.now()) / 60000);
                logger.info(`Bearer token capturado. Expira en ${minutesLeft} minutos`);
            } catch (e) {
                this._tokenExpiry = Date.now() + (5 * 60 * 60 * 1000);
            }

            consoleLogger.auth('Autenticación completada — Bearer token capturado');

        } finally {
            if (loginPage) {
                try { await loginPage.close(); } catch (e) {}
            }
        }
    }

    /**
     * Verifica si el token está próximo a expirar (<30 min) y renueva si es necesario.
     */
    async ensureAuthenticated() {
        const thirtyMinutes = 30 * 60 * 1000;
        if (!this._accessToken || !this._tokenExpiry || Date.now() > this._tokenExpiry - thirtyMinutes) {
            await this.performLogin();
        }
    }

    /**
     * Devuelve los headers HTTP con el Bearer token para llamadas a la API.
     * Usado por FamilyService y HttpService.
     */
    getFreshAuthHeaders() {
        return {
            'Authorization':      `Bearer ${this._accessToken}`,
            'Accept':             'application/json',
            'Accept-Language':    'es-ES,es;q=0.9',
            'Content-Type':       'application/json',
            'Origin':             config.datadiverservice.baseUrl,
            'Referer':            `${config.datadiverservice.baseUrl}/`,
            'Sec-Ch-Ua':          '"Not-A.Brand";v="99", "Google Chrome";v="124", "Chromium";v="124"',
            'Sec-Ch-Ua-Mobile':   '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest':     'empty',
            'Sec-Fetch-Mode':     'cors',
            'Sec-Fetch-Site':     'same-site',
            'User-Agent':         CHROME_USER_AGENT
        };
    }

    getToken() {
        return this._accessToken;
    }

    checkSessionHealth() {
        return !!this._accessToken && !!this._tokenExpiry && Date.now() < this._tokenExpiry;
    }

    // Compatibilidad con SystemController
    get isTokenValid() {
        return this.checkSessionHealth();
    }

    get timeLeftMinutes() {
        if (!this._tokenExpiry) return 0;
        return Math.max(0, Math.round((this._tokenExpiry - Date.now()) / 60000));
    }

    get tokenExpiry() {
        return this._tokenExpiry || 0;
    }

    get isLoggingIn() {
        return !!this._loginMutex;
    }
}

module.exports = AuthService;
