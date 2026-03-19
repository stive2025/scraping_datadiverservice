const axios = require('axios');
const { logger } = require('../utils/logger');
const config = require('../config');

/**
 * HttpService — realiza todas las llamadas a la API de DataDiverService.
 */
class HttpService {
    constructor(authService) {
        this.authService = authService;
        // Base para endpoints de información general (new, contact, notas, etc.)
        // Patrón: /ds/crn/client/info/{endpoint}
        this._baseUrl = `${config.datadiverservice.apiUrl}/ds/crn/client/info`;
    }

    /**
     * GET a un endpoint de la API con autenticación automática.
     * Maneja 404 (no encontrado) y 401/403 (token expirado → renueva y reintenta).
     */
    async _get(path, params = {}) {
        await this.authService.ensureAuthenticated();

        const url = `${this._baseUrl}/${path}`;
        logger.info('API call', { url, params });

        try {
            const response = await axios.get(url, {
                params,
                headers: this.authService.getFreshAuthHeaders(),
                timeout: 15000
            });
            return { data: this._fixEncoding(response.data), status: response.status };

        } catch (err) {
            if (err.response) {
                const { status } = err.response;

                if (status === 404) {
                    return { data: null, status: 404 };
                }

                if (status === 401 || status === 403) {
                    logger.warn('Token expirado detectado en API, renovando y reintentando', { path });
                    this.authService._accessToken = null;
                    await this.authService.performLogin();

                    const retry = await axios.get(`${this._baseUrl}/${path}`, {
                        params,
                        headers: this.authService.getFreshAuthHeaders(),
                        timeout: 15000
                    });
                    return { data: this._fixEncoding(retry.data), status: retry.status };
                }
            }
            throw err;
        }
    }

    /**
     * Corrige doble codificación UTF-8 que produce texto como "PIÃ'AS" en vez de "PIÑAS".
     * El servidor devuelve bytes UTF-8 interpretados como Latin-1 y re-codificados.
     * Aplica recursivamente a objetos y arrays.
     */
    _fixEncoding(obj) {
        if (typeof obj === 'string') {
            try {
                const decoded = Buffer.from(obj, 'latin1').toString('utf8');
                // Solo usar la versión decodificada si es distinta y no tiene caracteres de reemplazo
                if (decoded !== obj && !decoded.includes('\uFFFD')) return decoded;
            } catch (_) {}
            return obj;
        }
        if (Array.isArray(obj)) return obj.map(i => this._fixEncoding(i));
        if (obj && typeof obj === 'object') {
            const fixed = {};
            for (const [k, v] of Object.entries(obj)) fixed[k] = this._fixEncoding(v);
            return fixed;
        }
        return obj;
    }

    /**
     * Lanza todas las consultas de un DNI en paralelo.
     * Los endpoints 404 se devuelven como null (sin datos para ese campo).
     */
    async fetchAll(dni) {
        const [general, contact, notas, vehicle, labour, property, favorites, familyNew, family] = await Promise.allSettled([
            this._get('general/new', { dni }),
            this._get('contact', { dni }),
            this._get('notas', { dni }),
            this._get('vehicle', { dni }),
            this._get('labournew', { dni }),
            this._get('property', { dni }),
            this._get('favorites', { dni }),
            this._get('family/new', { dni }),
            this._get('family', { dni })
        ]);

        const getValue = (r, name) => {
            if (r.status === 'rejected') {
                logger.warn('Endpoint falló', { endpoint: name, error: r.reason?.message });
                return null;
            }
            if (r.value.status === 404) {
                logger.info('Endpoint 404 (sin datos)', { endpoint: name });
                return null;
            }
            return r.value.data;
        };

        // Para familia: usar el endpoint que devuelva datos (family/new tiene prioridad)
        const familyData = getValue(familyNew, 'family/new') || getValue(family, 'family');
        if (familyData) {
            logger.info('Datos de familia obtenidos', {
                endpoint: getValue(familyNew, 'family/new') ? 'family/new' : 'family',
                keys: Object.keys(familyData)
            });
        }

        return {
            general:   getValue(general,   'general/new'),
            contact:   getValue(contact,   'contact'),
            notas:     getValue(notas,     'notas'),
            vehicle:   getValue(vehicle,   'vehicle'),
            labour:    getValue(labour,    'labournew'),
            property:  getValue(property,  'property'),
            favorites: getValue(favorites, 'favorites'),
            family:    familyData
        };
    }
}

module.exports = HttpService;
