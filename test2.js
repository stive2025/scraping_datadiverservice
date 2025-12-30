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

const sessions = new Map(); // userId => { page }
let browser;
let userCount = 0;

(async () => {
    browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();    
})();

// Crear nueva sesión al acceder a /session
app.get('/title/:name', async (req, res) => {

  try {
    const page = await browser.newPage();
    const userId = `user${++userCount}`;

    let data={
    info_general:{},
    info_contacts:{},
    info_vehicles:{},
    info_labour:{},
    info_property:{},
    info_favorities:{},
    info_family:{}
};

     page.on('response', async (response) => {
        const url = response.url();
        const status = response.status();
        console.log(response)
        const login=await getData({response,url,endpoint:'api.datadiverservice.com/login'});
        const info_general=await getData({response,url,endpoint:'api.datadiverservice.com/ds/crn/client/info/general/new'});
        const info_contacts=await getData({response,url,endpoint:'api.datadiverservice.com/ds/crn/client/info/contact'});
        const info_vehicles=await getData({response,url,endpoint:'api.datadiverservice.com/ds/crm/client/vehicle'});
        const info_labour=await getData({response,url,endpoint:'api.datadiverservice.com/ds/crn/client/info/labournew'});
        const info_property=await getData({response,url,endpoint:'api.datadiverservice.com/ds/crm/client/property'});
        const info_favorities=await getData({response,url,endpoint:'api.datadiverservice.com/ds/crn/client/favorites'});

        if(login!==undefined){
            console.log(login)
            token=login.accessToken;
        }

        if(info_general!==undefined){
            data.info_general=info_general;
        }
        if(info_contacts!==undefined){
            data.info_contacts=info_contacts;
        }
        if(info_vehicles!==undefined){
            data.info_vehicles=info_vehicles;
        }
        if(info_labour!==undefined){
            data.info_labour=info_labour;
        }
        if(info_property!==undefined){
            data.info_property=info_property;
        }
        if(info_favorities!==undefined){
            data.info_favorities=info_favorities;
        }
    });

    if(token==''){
        await page.goto("https://datadiverservice.com/consultation/search",{waitUntil: 'load', timeout: 0})
        await page.goto("https://datadiverservice.com/auth/login",{waitUntil: 'load', timeout: 0});
    await page.type('input#mat-input-0','GESTOR3@SEFILSA')
    await page.type('input#mat-input-1','SEFILSA.G3')
    await page.click("button#kt_login_signin_submit");
    await delay(5000);
    }

    await page.goto(`https://datadiverservice.com/consultation/${req.params.name}/client`,{waitUntil: 'load', timeout: 0});
    await delay(2000);

    try {
        const request=await fetch(`https://api.datadiverservice.com/ds/crn/client/info/family/new?dni=${req.params.name}`,{
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
    
        const response=await request.json();
        data.info_family=response;

        console.log(response);
        console.log('FAMILY EXISTS');

    } catch (error) {
        console.log(error);
    }
 
    sessions.set(userId, { page });
    console.log(`Nueva sesión creada: ${userId}`);
    res.json(data);

  } catch (err) {
    console.error('Error creando sesión:', err);
    res.status(500).json({ success: false, error: 'Error creando sesión' });
  }

});

// Consultar estado de todas las sesiones
app.get('/sessions', (req, res) => {
  const activeSessions = Array.from(sessions.keys());
  res.json({ activeSessions });
});

// Cerrar una sesión específica
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

// Cerrar el navegador completamente
app.get('/shutdown', async (req, res) => {
  await browser.close();
  res.json({ message: 'Navegador cerrado' });
  process.exit();
});

app.listen(port, () => {
  console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
