const { convertDateFormat } = require('../utils/helpers');

class DataTransformService {
    /**
     * Transforma datos raw a formato estructurado
     */
    static transformToStructuredFormat(rawData) {
        const general = rawData.info_general || {};
        const contacts = rawData.info_contacts || {};
        const family = rawData.info_family || {};
        const labour = rawData.info_labour || {};
        
        const now = new Date().toISOString();
        
        // Construir el objeto estructurado principal
        const structured = {
            id: general.id || null,
            identification: general.dni || null,
            uses_parent_identification: 0,
            parent_identification: null,
            name: general.fullname || null,
            email: null,
            micro_activa: null,
            birth: convertDateFormat(general.dateOfBirth),
            death: general.dateOfDeath && general.dateOfDeath.trim() !== '' ? convertDateFormat(general.dateOfDeath) : null,
            gender: general.gender || null,
            state_civil: general.civilStatus || null,
            economic_activity: null,
            economic_area: null,
            nationality: general.citizenship || null,
            profession: general.profession || null,
            place_birth: general.placeOfBirth || null,
            salary: general.salary || null,
            created_at: now,
            updated_at: now,
            age: general.age || null,
            contacts: [],
            parents: [],
            address: [],
            emails: [],
            works: []
        };
        
        // Transformar teléfonos
        structured.contacts = this._transformContacts(contacts, structured.id, now);
        
        // Transformar emails
        structured.emails = this._transformEmails(contacts, structured.id, now);
        if (structured.emails.length > 0) {
            structured.email = structured.emails[0].direction;
        }
        
        // Transformar direcciones
        structured.address = this._transformAddresses(contacts, general, structured.id, now);
        
        // Transformar familia
        structured.parents = this._transformFamily(general, family, structured.id, now);

        // Transformar información laboral
        structured.works = this._transformWorks(labour, structured.id, now);

        // Completar campos económicos del nivel raíz a partir de la info laboral
        const labourSummary = this._extractLabourSummary(labour);
        if (labourSummary) {
            structured.economic_activity = structured.economic_activity || labourSummary.economic_activity || null;
            if ((structured.salary === null || structured.salary === '0' || structured.salary === 0 || structured.salary === '') && labourSummary.salary) {
                structured.salary = labourSummary.salary;
            }
        }

        return structured;
    }

    /**
     * Transforma datos de contactos telefónicos
     */
    static _transformContacts(contacts, clientId, now) {
        if (!contacts.phones || !Array.isArray(contacts.phones)) {
            return [];
        }

        const seen = new Set();
        return contacts.phones
            .filter(phone => {
                const raw = (phone.phone || '').toString();
                // Normalizar: quitar texto entre paréntesis "(NUEVO)", "(CASA)", etc.
                // y eliminar espacios para comparar solo los dígitos del número.
                const normalized = raw.replace(/\(.*?\)/g, '').replace(/\s+/g, '').trim();
                if (!normalized || seen.has(normalized)) return false;
                seen.add(normalized);
                return true;
            })
            .map(phone => ({
                id: null,
                phone_number: phone.phone || null,
                phone_type: phone.type || null,
                counter_correct_number: null,
                counter_incorrect_number: null,
                client_id: clientId,
                created_at: now,
                updated_at: now
            }));
    }

    /**
     * Transforma datos de emails
     */
    static _transformEmails(contacts, clientId, now) {
        if (!contacts.emails || !Array.isArray(contacts.emails)) {
            return [];
        }

        const seen = new Set();
        return contacts.emails
            .filter(email => {
                const addr = (email.email || '').toString().trim().toLowerCase();
                if (!addr || seen.has(addr)) return false;
                seen.add(addr);
                return true;
            })
            .map(email => ({
                id: null,
                direction: email.email || null,
                active: 1,
                client_id: clientId,
                created_at: now,
                updated_at: now
            }));
    }

    /**
     * Transforma datos de direcciones
     */
    static _transformAddresses(contacts, general, clientId, now) {
        const addresses = [];

        // Direcciones de contactos
        if (contacts.address && Array.isArray(contacts.address)) {
            addresses.push(...contacts.address.map(addr => ({
                id: null,
                address: addr.address || addr || null,
                type: addr.type || "actualizado",
                province: addr.province || "sin datos",
                city: addr.city || "sin datos",
                is_valid: addr.is_valid || "NO",
                client_id: clientId,
                created_at: now,
                updated_at: now
            })));
        }

        // Dirección general si existe
        if (general.address && typeof general.address === 'string' && general.address.trim() !== '') {
            addresses.push({
                id: null,
                address: general.address,
                type: "actualizado",
                province: "sin datos",
                city: "sin datos",
                is_valid: "NO",
                client_id: clientId,
                created_at: now,
                updated_at: now
            });
        }

        return addresses;
    }

    /**
     * Transforma la información laboral (endpoint `labournew`) al array `works`.
     *
     * El payload trae tres listas, que aquí se unifican en un solo array con un
     * campo `type` que indica el origen:
     *   - ownInfoCompany     → NEGOCIO_PROPIO   (RUC personal / persona natural, datos SRI)
     *   - jobInfoCompany     → RELACION_DEPENDENCIA (empleo con patrono, datos IESS)
     *   - societyInfoCompany → SOCIEDAD          (empresa donde es socio/representante)
     */
    static _transformWorks(labour, clientId, now) {
        if (!labour || typeof labour !== 'object' || Array.isArray(labour)) return [];

        const groups = [
            { key: 'ownInfoCompany',     type: 'NEGOCIO_PROPIO' },
            { key: 'jobInfoCompany',     type: 'RELACION_DEPENDENCIA' },
            { key: 'societyInfoCompany', type: 'SOCIEDAD' }
        ];

        const clean = v => (v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : null);
        // Actividad económica: descartar códigos de una sola letra ("C") que no son descripciones
        const cleanActivity = v => {
            const c = clean(v);
            return c && c.length > 1 ? c : null;
        };
        const toDate = v => {
            const c = clean(v);
            return c ? (convertDateFormat(c) || c) : null;
        };

        const seen = new Set();
        const works = [];

        for (const { key, type } of groups) {
            const list = Array.isArray(labour[key]) ? labour[key] : [];
            for (const rec of list) {
                if (!rec || typeof rec !== 'object') continue;

                const company = clean(rec.legalName) || clean(rec.businessName) || null;
                const ruc = clean(rec.ruc);
                const position = clean(rec.position);

                const identifier = [type, (ruc || ''), (company || '').toLowerCase(), (position || '').toLowerCase()].join('|');
                if (seen.has(identifier)) continue;
                seen.add(identifier);

                works.push({
                    id: null,
                    client_id: clientId,
                    type,
                    company,
                    ruc,
                    position,
                    salary: clean(rec.salary),
                    economic_activity: cleanActivity(rec.economicActivity),
                    address: clean(rec.address),
                    province: clean(rec.province),
                    phone: clean(rec.phone),
                    email: clean(rec.email),
                    taxpayer_status: clean(rec.taxpayerStatus),
                    branch_office: clean(rec.codeBranchOffice),
                    // Fecha de inicio: ingreso al empleo o inicio de actividades del RUC
                    start_date: toDate(rec.admissionDate) || toDate(rec.activitiesStartDate),
                    // Fecha de fin: salida del empleo o suspensión de actividades del RUC
                    end_date: toDate(rec.fireDate) || toDate(rec.suspensionRequestDate),
                    restart_date: toDate(rec.activitiesRestartDate),
                    created_at: now,
                    updated_at: now
                });
            }
        }

        return works;
    }

    /**
     * Extrae actividad económica y sueldo del payload laboral para completar
     * los campos del nivel raíz del objeto principal.
     */
    static _extractLabourSummary(labour) {
        if (!labour || typeof labour !== 'object' || Array.isArray(labour)) return null;

        const clean = v => (v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : null);
        const firstOf = (list, field) => {
            if (!Array.isArray(list)) return null;
            for (const rec of list) {
                const v = rec && clean(rec[field]);
                // Ignorar códigos de una sola letra ("C") que no son descripciones
                if (v && v.length > 1) return v;
            }
            return null;
        };

        const summary = {
            economic_activity: firstOf(labour.ownInfoCompany, 'economicActivity')
                            || firstOf(labour.societyInfoCompany, 'economicActivity'),
            salary: firstOf(labour.jobInfoCompany, 'salary')
        };

        return (summary.economic_activity || summary.salary) ? summary : null;
    }

    /**
     * Transforma datos de familia
     */
    static _transformFamily(general, family, clientId, now) {
        const allFamilyMembers = [];
        
        // Combinar todas las fuentes de datos de familia
        this._collectFamilyMembers(allFamilyMembers, general);
        this._collectFamilyMembers(allFamilyMembers, family);
        
        // Eliminar duplicados
        const uniqueFamilyMembers = this._removeFamilyDuplicates(allFamilyMembers);
        
        // Transformar a formato parents
        return uniqueFamilyMembers.map(member => {
            // El campo dateOfBirth de la tabla Genoma tiene formato "1979 (46)-09-02"
            // Extraemos la edad del patrón (número) y limpiamos la cadena de fecha.
            const rawBirth = member.dateOfBirth || member.birthDate || member.fechaNacimiento || '';
            const ageFromBirth = rawBirth.match(/\((\d+)\)/);
            const cleanBirth = rawBirth.replace(/\s*\(\d+\)\s*/g, '').replace(/\s+/g, '').trim() || null;
            const resolvedAge = member.age || member.edad || (ageFromBirth ? ageFromBirth[1] : null);

            return {
                id: null,
                client_id: clientId,
                type: this._normalizeRelationship(member),
                relationship_client_id: null,
                created_at: now,
                updated_at: now,
                name: member.fullname || member.name || member.nombre || null,
                identification: member.dni || member.identification || member.cedula || null,
                birth: convertDateFormat(cleanBirth) || cleanBirth || null,
                gender: member.gender || member.genero || member.sexo || null,
                state_civil: member.civilStatus || member.estadoCivil || member.maritalStatus || null,
                death: member.dateOfDeath && member.dateOfDeath.trim() !== '' ?
                       convertDateFormat(member.dateOfDeath || member.deathDate || member.fechaMuerte) : null,
                age: resolvedAge
            };
        });
    }

    /**
     * Recolecta miembros de familia de diferentes fuentes
     */
    static _collectFamilyMembers(allMembers, source) {
        const arrays = ['family', 'data', 'results', 'relatives', 'parentesco'];
        
        arrays.forEach(key => {
            if (Array.isArray(source[key])) {
                allMembers.push(...source[key]);
            }
        });
        
        // Buscar otras propiedades que puedan contener datos de familia
        const familyKeywords = [
            'familia', 'parientes', 'relatives', 'relations', 'members', 'miembros',
            'padres', 'parents', 'hijos', 'children', 'hermanos', 'siblings',
            'esposa', 'esposo', 'spouse', 'conyuge', 'pareja'
        ];
        
        for (const [key, value] of Object.entries(source)) {
            if (Array.isArray(value) && value.length > 0 && !arrays.includes(key)) {
                const keyLower = key.toLowerCase();
                const seemsFamilyKey = familyKeywords.some(keyword => keyLower.includes(keyword));
                
                if (seemsFamilyKey) {
                    allMembers.push(...value);
                } else {
                    // Verificar si el contenido parece datos de familia
                    const firstItem = value[0];
                    if (firstItem && this._seemsFamilyData(firstItem)) {
                        allMembers.push(...value);
                    }
                }
            }
        }
    }

    /**
     * Verifica si un objeto parece contener datos de familia
     */
    static _seemsFamilyData(item) {
        const familyFields = [
            'fullname', 'dni', 'name', 'relationship', 'parentesco', 'relation',
            'age', 'gender', 'dateOfBirth', 'civilStatus', 'nombre', 'cedula',
            'identificacion', 'edad', 'genero', 'sexo', 'fechaNacimiento'
        ];
        
        const itemKeys = Object.keys(item);
        const matchingFields = familyFields.filter(field => itemKeys.includes(field));
        
        // Si tiene al menos 2 campos que parecen de familia, probablemente lo es
        return matchingFields.length >= 2;
    }

    /**
     * Elimina duplicados de miembros de familia
     */
    static _removeFamilyDuplicates(members) {
        const seenMembers = new Set();
        return members.filter(member => {
            const memberDni = member.dni || member.identification || member.cedula;
            const memberName = member.fullname || member.name || member.nombre;
            const memberBirth = member.dateOfBirth || member.birthDate || member.fechaNacimiento || '';
            // Usar combinación DNI+nombre+nacimiento para no eliminar hijos menores
            // que comparten la cédula del padre y el mismo nombre genérico
            const identifier = `${memberDni || ''}-${memberName || ''}-${memberBirth}`;

            if (seenMembers.has(identifier)) {
                return false;
            }
            seenMembers.add(identifier);
            return true;
        });
    }

    /**
     * Normaliza el tipo de relación familiar
     */
    static _normalizeRelationship(member) {
        const relationship = member.relationship || member.parentesco || member.relation;
        return relationship ? relationship.toUpperCase() : null;
    }
}

module.exports = DataTransformService;