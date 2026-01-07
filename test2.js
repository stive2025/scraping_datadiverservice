const express = require('express');
const puppeteer = require('puppeteer');

process.on('uncaughtException', (err) => {
    console.error('Excepción no capturada:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Rechazo no manejado en promesa:', reason);
});

const app = express();
const port = 3030;

function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function getData({response, url, endpoint}) {
    if (url.includes(endpoint)) {
        try {
            const data = await response.json();
            return data;
        } catch (err) {
            return undefined;
        }
    }
}

let token = '';
let tokenExpiry = 0;
let browser;
let keepAliveInterval;
let isLoggingIn = false;


const MAX_CONCURRENT_PAGES = 10;
const PAGE_POOL_SIZE = 3;
let activePages = 0;
let pageQueue = [];
let pagePool = [];
const QUEUE_TIMEOUT = 45000;


let stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    maxQueueSize: 0
};

async function retry(fn, retries = 2, delayMs = 1000) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < retries) {
                await delay(delayMs);
            }
        }
    }
    throw lastErr;
}


async function performLogin() {
    if (isLoggingIn) {
        console.log('Login en curso, esperando...');
        let attempts = 0;
        while (isLoggingIn && attempts < 30) {
            await delay(500);
            attempts++;
        }
        if (token) {
            console.log('Token obtenido por otro proceso');
            return;
        }
    }
    
    isLoggingIn = true;
    console.log('Iniciando login...');
    let loginPage = null;
    
    try {
        await retry(async () => {
            loginPage = await browser.newPage();
            await loginPage.setDefaultNavigationTimeout(20000);
            
            let tokenCaptured = false;
            
            loginPage.on('response', async (response) => {
                const url = response.url();
                if (url.includes('api.datadiverservice.com/login')) {
                    try {
                        const data = await response.json();
                        if (data.accessToken) {
                            token = data.accessToken;
                            tokenExpiry = Date.now() + (50 * 60 * 1000);
                            tokenCaptured = true;
                            console.log('✓ Token capturado exitosamente');
                        }
                    } catch (err) {
                        console.error('Error capturando token:', err.message);
                    }
                }
            });
            
            await loginPage.goto("https://datadiverservice.com/auth/login", {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            
            await loginPage.waitForSelector('input#mat-input-0', { timeout: 8000 });
            await loginPage.type('input#mat-input-0', 'GESTOR3@SEFILSA');
            await loginPage.type('input#mat-input-1', 'SEFILSA.G3');
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
            
            console.log('Login completado exitosamente');
        }, 2, 2000);
    } finally {
        if (loginPage) {
            try {
                await loginPage.close();
            } catch (e) {
                console.error('Error cerrando página de login:', e.message);
            }
        }
        isLoggingIn = false;
    }
}


async function startKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    
    keepAliveInterval = setInterval(async () => {
        if (browser && !isLoggingIn) {
            try {
                const timeLeft = tokenExpiry - Date.now();
                
                
                if (!token || timeLeft < 5 * 60 * 1000) {
                    console.log('Keep-alive: renovando token...');
                    await performLogin();
                } else {
                    console.log(`Keep-alive: token válido (${Math.floor(timeLeft / 60000)} min restantes)`);
                }
            } catch (error) {
                console.error('Error en keep-alive:', error.message);
                token = '';
                tokenExpiry = 0;
            }
        }
    }, 10 * 60 * 1000); 
}

async function launchBrowser() {
    try {
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: '/usr/bin/chromium',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection', 
                '--disable-renderer-backgrounding', 
                '--disable-backgrounding-occluded-windows', 
                '--disable-breakpad', 
                '--disable-component-extensions-with-background-pages', 
                '--disable-features=Translate,BackForwardCache,AcceptCHFrame', 
                '--disable-hang-monitor', 
                '--disable-prompt-on-repost', 
                '--metrics-recording-only', 
                '--mute-audio', 
                '--no-default-browser-check',
                '--no-pings', 
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        });
        
        console.log('Browser iniciado correctamente');
        
        browser.on('disconnected', async () => {
            console.error('El navegador se cerró inesperadamente. Reiniciando...');
            pagePool = []; // Limpiar pool
            await launchBrowser();
            startKeepAlive();
        });
        
        // Hacer login inicial
        await performLogin();
        
        // Crear pool de páginas listas
        console.log('Pre-calentando pool de páginas...');
        await warmUpPagePool();
        
        startKeepAlive();
        
    } catch (err) {
        console.error('Error lanzando el navegador:', err);
        setTimeout(launchBrowser, 5000);
    }
}

// Función para pre-crear páginas
async function warmUpPagePool() {
    try {
        for (let i = 0; i < PAGE_POOL_SIZE; i++) {
            const page = await createOptimizedPage();
            pagePool.push(page);
            console.log(`✓ Página ${i + 1}/${PAGE_POOL_SIZE} pre-creada`);
        }
        console.log(`✓ Pool de ${PAGE_POOL_SIZE} páginas listo`);
    } catch (err) {
        console.error('Error creando pool:', err);
    }
}

// Función para crear página optimizada
async function createOptimizedPage() {
    const page = await browser.newPage();
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


async function getPageFromPool() {
    if (pagePool.length > 0) {
        console.log(`Usando página del pool (${pagePool.length} disponibles)`);
        return pagePool.pop();
    }
    console.log('Pool vacío, creando página nueva...');
    return await createOptimizedPage();
}

// Devolver página al pool
async function returnPageToPool(page) {
    try {
        if (pagePool.length < PAGE_POOL_SIZE) {
            
            await page.goto('about:blank');
            pagePool.push(page);
            console.log(`Página devuelta al pool (${pagePool.length} disponibles)`);
        } else {
            
            await page.close();
        }
    } catch (err) {
        console.error('Error devolviendo página al pool:', err.message);
        try {
            await page.close();
        } catch (e) {}
    }
}

launchBrowser();

async function waitForAvailableSlot() {
    return new Promise((resolve, reject) => {
        if (activePages < MAX_CONCURRENT_PAGES) {
            activePages++;
            resolve();
        } else {
            const queueItem = { resolve, reject };
            pageQueue.push(queueItem);
            
            setTimeout(() => {
                const index = pageQueue.indexOf(queueItem);
                if (index > -1) {
                    pageQueue.splice(index, 1);
                    reject(new Error('Request timeout - demasiadas consultas en cola'));
                }
            }, QUEUE_TIMEOUT);
        }
    });
}

function releaseSlot() {
    if (pageQueue.length > 0) {
        const queueItem = pageQueue.shift();
        queueItem.resolve();
    } else {
        activePages--;
    }
}

app.get('/title/:name', async (req, res) => {
    let page = null;
    const startTime = Date.now();
    
    try {
        stats.totalRequests++;
        
        console.log(`Request para ${req.params.name} - Esperando slot... (Cola: ${pageQueue.length})`);
        
        if (pageQueue.length > stats.maxQueueSize) {
            stats.maxQueueSize = pageQueue.length;
        }
        
        await waitForAvailableSlot();
        const waitTime = Date.now() - startTime;
        console.log(`Request para ${req.params.name} - Slot obtenido después de ${waitTime}ms`);

        // Verificación de token más laxa
        const now = Date.now();
        if (!token || now >= tokenExpiry - (2 * 60 * 1000)) { 
            console.log('Renovando token antes de la consulta...');
            await performLogin();
        }

        if (!token) {
            throw new Error('No se pudo obtener un token válido');
        }

        // Usar página del pool en lugar de crear nueva
        page = await getPageFromPool();

        let data = {
            info_general: {},
            info_contacts: {},
            info_vehicles: {},
            info_labour: {},
            info_property: {},
            info_favorities: {},
            info_family: {}
        };

        let dataReceived = {
            general: false,
            contacts: false,
            vehicles: false,
            labour: false,
            property: false,
            favorities: false,
            family: false 
        };

        // Capturar datos con Promise para detectar cuando estén completos
        const dataPromises = [];
        let resolveDataLoaded;
        const dataLoadedPromise = new Promise(resolve => {
            resolveDataLoaded = resolve;
        });

        page.on('response', async (response) => {
            try {
                const url = response.url();
                
                const info_general = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/general/new'});
                const info_contacts = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/contact'});
                const info_vehicles = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crm/client/vehicle'});
                const info_labour = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/labournew'});
                const info_property = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crm/client/property'});
                const info_favorities = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/favorites'});
                const info_family = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/family/new'}); // AGREGADO

                if (info_general !== undefined) {
                    data.info_general = info_general;
                    dataReceived.general = true;
                }
                if (info_contacts !== undefined) {
                    data.info_contacts = info_contacts;
                    dataReceived.contacts = true;
                }
                if (info_vehicles !== undefined) {
                    data.info_vehicles = info_vehicles;
                    dataReceived.vehicles = true;
                }
                if (info_labour !== undefined) {
                    data.info_labour = info_labour;
                    dataReceived.labour = true;
                }
                if (info_property !== undefined) {
                    data.info_property = info_property;
                    dataReceived.property = true;
                }
                if (info_favorities !== undefined) {
                    data.info_favorities = info_favorities;
                    dataReceived.favorities = true;
                }
                if (info_family !== undefined) {
                    data.info_family = info_family;
                    dataReceived.family = true;
                    console.log('✓ Info family capturada desde response listener');
                }

                // Verificar si ya tenemos todos los datos críticos
                if (dataReceived.general && dataReceived.contacts) {
                    resolveDataLoaded();
                }
            } catch (err) {
                console.error('Error procesando response:', err.message);
            }
        });

        // navegación más rápida
        await retry(async () => {
            await page.goto(`https://datadiverservice.com/consultation/${req.params.name}/client`, {
                waitUntil: 'domcontentloaded', 
                timeout: 25000
            });
        }, 1, 1000);
        
        
        await Promise.race([
            dataLoadedPromise,
            delay(6000) // Aumentado a 6 segundos para datos más lentos
        ]);

        console.log('Datos recibidos:', dataReceived);
        
        // Esperar un poco más si faltan datos no críticos
        if (!dataReceived.vehicles || !dataReceived.property || !dataReceived.favorities || !dataReceived.family) {
            console.log('Esperando datos adicionales...');
            await delay(2000);
            console.log('Datos finales recibidos:', dataReceived);
        }

        // OPTIMIZACIÓN 8: Solo hacer fetch de family si NO se capturó desde el listener
        if (!dataReceived.family) {
            console.log('Family no capturado desde listener, intentando fetch directo...');
            let familySuccess = false;
            let familyAttempts = 0;
            
            while (!familySuccess && familyAttempts < 3) {
                try {
                    familyAttempts++;
                    console.log(`Intento ${familyAttempts} - Obteniendo info_family con token...`);
                    
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 15000);
                    
                    const familyRequest = await fetch(
                        `https://api.datadiverservice.com/ds/crn/client/info/family/new?dni=${req.params.name}`, 
                        {
                            headers: {
                                Accept: 'application/json',
                                Authorization: `Bearer ${token}`
                            },
                            signal: controller.signal
                        }
                    );
                    
                    clearTimeout(timeoutId);

                    if (familyRequest.ok) {
                        const response = await familyRequest.json();
                        data.info_family = response;
                        familySuccess = true;
                        console.log('✓ Info family obtenida exitosamente via fetch');
                    } else if (familyRequest.status === 401) {
                        console.log('Token inválido (401) para family, renovando...');
                        await performLogin();
                    } else {
                        console.log(`Error en family request: ${familyRequest.status}`);
                        data.info_family = { message: "No disponible", status: familyRequest.status };
                        break;
                    }
                } catch (error) {
                    console.log(`Error obteniendo info family (intento ${familyAttempts}):`, error.message);
                    if (familyAttempts < 3) {
                        await delay(2000);
                    } else {
                        data.info_family = { message: "No se pudo obtener información familiar", error: error.message };
                    }
                }
            }
        } else {
            console.log('✓ Family ya capturado desde listener, omitiendo fetch');
        }

        res.json(data);
        
        stats.successfulRequests++;
        const responseTime = Date.now() - startTime;
        stats.averageResponseTime = 
            (stats.averageResponseTime * (stats.successfulRequests - 1) + responseTime) / 
            stats.successfulRequests;
        
        console.log(`✓ Consulta completada en ${responseTime}ms para ${req.params.name}`);

    } catch (err) {
        stats.failedRequests++;
        console.error('Error en consulta:', err.message);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (e) {
                console.error('Error cerrando página:', e.message);
            }
        }
        releaseSlot();
    }
});

app.get('/sessions', (req, res) => {
    const uptime = process.uptime();
    const requestsPerHour = (stats.totalRequests / (uptime / 3600)).toFixed(2);
    
    res.json({ 
        activePages,
        queuedRequests: pageQueue.length,
        pagePoolSize: pagePool.length, // NUEVO
        maxConcurrent: MAX_CONCURRENT_PAGES,
        tokenValid: token !== '',
        tokenExpiresIn: tokenExpiry > 0 ? Math.floor((tokenExpiry - Date.now()) / 1000 / 60) + ' minutos' : 'N/A',
        isLoggingIn,
        statistics: {
            totalRequests: stats.totalRequests,
            successfulRequests: stats.successfulRequests,
            failedRequests: stats.failedRequests,
            successRate: stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2) + '%' : '0%',
            averageResponseTime: stats.averageResponseTime.toFixed(0) + 'ms',
            maxQueueSize: stats.maxQueueSize,
            requestsPerHour,
            uptimeHours: (uptime / 3600).toFixed(2)
        }
    });
});

app.post('/refresh-token', async (req, res) => {
    try {
        token = '';
        await performLogin();
        res.json({ success: true, message: 'Token renovado exitosamente', token: token ? 'presente' : 'ausente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/shutdown', async (req, res) => {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    
    // Cerrar páginas del pool
    for (const page of pagePool) {
        try {
            await page.close();
        } catch (e) {}
    }
    pagePool = [];
    
    if (browser) {
        await browser.close();
    }
    res.json({ message: 'Navegador cerrado' });
    process.exit();
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor Express escuchando en http://0.0.0.0:${port}`);
});