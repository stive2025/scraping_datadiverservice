const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const port = 3030;

function delay(time) {
    return new Promise(function(resolve) { 
        setTimeout(resolve, time)
    });
}

async function getData({response,url,endpoint}){
    if (url.includes(endpoint)) {
        try {
            const data = await response.json();
            return data;
        } catch (err) {
            //return [];
        }
    }
}

async function search(data,page,name,token) {
    return JSON.stringify(data);
}

let token='';
let tokenExpiry = 0;
const sessions = new Map();
let browser;
let userCount = 0;
let keepAliveInterval;

// Función para hacer login
async function performLogin(page) {
    console.log('Iniciando login...');
    try {
        await page.goto("https://datadiverservice.com/consultation/search", {waitUntil: 'load', timeout: 60000});
        await page.goto("https://datadiverservice.com/auth/login", {waitUntil: 'load', timeout: 60000});
        await page.type('input#mat-input-0', 'GESTOR3@SEFILSA');
        await page.type('input#mat-input-1', 'SEFILSA.G3');
        await page.click("button#kt_login_signin_submit");
        await delay(5000);
        console.log('Login completado');
        tokenExpiry = Date.now() + (50 * 60 * 1000); // Token válido por 50 minutos
    } catch (error) {
        console.error('Error en login:', error);
        throw error;
    }
}

// Función para verificar y renovar el token si es necesario
async function ensureValidToken(page) {
    const now = Date.now();
    // Si el token está por expirar en los próximos 5 minutos, renovar
    if (!token || now >= tokenExpiry - (5 * 60 * 1000)) {
        console.log('Token expirado o por expirar, renovando sesión...');
        token = '';
        await performLogin(page);
        return true;
    }
    return false;
}

// Keep-alive: mantener la sesión activa cada 45 segundos (antes de 1-2 min de timeout)
let keepAlivePage = null;

async function startKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    
    // Crear una página dedicada para keep-alive
    if (!keepAlivePage) {
        keepAlivePage = await browser.newPage();
        await performLogin(keepAlivePage);
    }
    
    keepAliveInterval = setInterval(async () => {
        if (token && browser && keepAlivePage) {
            try {
                console.log('Ejecutando keep-alive (cada 45 seg)...');
                
                // Simular actividad navegando a la página de búsqueda
                await keepAlivePage.goto("https://datadiverservice.com/consultation/search", {
                    waitUntil: 'domcontentloaded', 
                    timeout: 20000
                });
                
                // Simular movimiento del mouse para parecer más humano
                await keepAlivePage.mouse.move(100, 100);
                
                console.log('Keep-alive completado - Sesión activa');
            } catch (error) {
                console.error('Error en keep-alive, recreando página:', error);
                try {
                    if (keepAlivePage) await keepAlivePage.close();
                    keepAlivePage = await browser.newPage();
                    token = '';
                    tokenExpiry = 0;
                    await performLogin(keepAlivePage);
                } catch (recreateError) {
                    console.error('Error recreando página keep-alive:', recreateError);
                }
            }
        }
    }, 45 * 1000); // Cada 45 segundos (antes del timeout de 1-2 min)
}

(async () => {
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
            '--disable-gpu'
        ]
    });
    console.log('Browser iniciado correctamente');
    
    // Iniciar el sistema de keep-alive
    startKeepAlive();
})();

app.get('/title/:name', async (req, res) => {
    try {
        const page = await browser.newPage();
        const userId = `user${++userCount}`;

        let data = {
            info_general: {},
            info_contacts: {},
            info_vehicles: {},
            info_labour: {},
            info_property: {},
            info_favorities: {},
            info_family: {}
        };

        page.on('response', async (response) => {
            const url = response.url();
            const status = response.status();
            
            const login = await getData({response, url, endpoint: 'api.datadiverservice.com/login'});
            const info_general = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/general/new'});
            const info_contacts = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/contact'});
            const info_vehicles = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crm/client/vehicle'});
            const info_labour = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/info/labournew'});
            const info_property = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crm/client/property'});
            const info_favorities = await getData({response, url, endpoint: 'api.datadiverservice.com/ds/crn/client/favorites'});

            if (login !== undefined) {
                console.log('Token actualizado');
                token = login.accessToken;
                tokenExpiry = Date.now() + (50 * 60 * 1000);
            }

            if (info_general !== undefined) data.info_general = info_general;
            if (info_contacts !== undefined) data.info_contacts = info_contacts;
            if (info_vehicles !== undefined) data.info_vehicles = info_vehicles;
            if (info_labour !== undefined) data.info_labour = info_labour;
            if (info_property !== undefined) data.info_property = info_property;
            if (info_favorities !== undefined) data.info_favorities = info_favorities;
        });

        // Verificar y renovar token antes de hacer la consulta
        await ensureValidToken(page);

        if (token === '') {
            await performLogin(page);
        }

        await page.goto(`https://datadiverservice.com/consultation/${req.params.name}/client`, {
            waitUntil: 'load', 
            timeout: 60000
        });
        await delay(2000);

        // Reintentar con nuevo token si falla
        try {
            const request = await fetch(`https://api.datadiverservice.com/ds/crn/client/info/family/new?dni=${req.params.name}`, {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`
                }
            });

            if (request.status === 401) {
                console.log('Token inválido, renovando...');
                token = '';
                await performLogin(page);
                
                // Reintentar la petición
                const retryRequest = await fetch(`https://api.datadiverservice.com/ds/crn/client/info/family/new?dni=${req.params.name}`, {
                    headers: {
                        Accept: 'application/json',
                        Authorization: `Bearer ${token}`
                    }
                });
                const response = await retryRequest.json();
                data.info_family = response;
            } else {
                const response = await request.json();
                data.info_family = response;
            }

            console.log('FAMILY EXISTS');

        } catch (error) {
            console.log('Error obteniendo info family:', error);
        }

        sessions.set(userId, { page });
        console.log(`Nueva sesión creada: ${userId}`);
        res.json(data);

    } catch (err) {
        console.error('Error creando sesión:', err);
        res.status(500).json({ success: false, error: 'Error creando sesión' });
    }
});

app.get('/sessions', (req, res) => {
    const activeSessions = Array.from(sessions.keys());
    res.json({ 
        activeSessions,
        tokenValid: token !== '',
        tokenExpiresIn: tokenExpiry > 0 ? Math.floor((tokenExpiry - Date.now()) / 1000 / 60) + ' minutos' : 'N/A'
    });
});

app.delete('/session/:userId', async (req, res) => {
    const userId = req.params.userId;
    const session = sessions.get(userId);

    if (!session) {
        return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
    }

    await session.page.close();
    sessions.delete(userId);
    console.log(`Sesión cerrada: ${userId}`);
    res.json({ success: true, message: `Sesión ${userId} cerrada` });
});

// Nuevo endpoint para forzar renovación de token
app.post('/refresh-token', async (req, res) => {
    try {
        const page = await browser.newPage();
        token = '';
        await performLogin(page);
        await page.close();
        res.json({ success: true, message: 'Token renovado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/shutdown', async (req, res) => {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    if (keepAlivePage) {
        await keepAlivePage.close();
    }
    await browser.close();
    res.json({ message: 'Navegador cerrado' });
    process.exit();
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor Express escuchando en http://0.0.0.0:${port}`);
});