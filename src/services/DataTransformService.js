const { convertDateFormat } = require('../utils/helpers');

class DataTransformService {
    /**
     * Transforma datos raw a formato estructurado
     */
    static transformToStructuredFormat(rawData) {
        const general = rawData.info_general || {};
        const contacts = rawData.info_contacts || {};
        const family = rawData.info_family || {};
        
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
            emails: []
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
        
        return structured;
    }

    /**
     * Transforma datos de contactos telefónicos
     */
    static _transformContacts(contacts, clientId, now) {
        if (!contacts.phones || !Array.isArray(contacts.phones)) {
            return [];
        }

        return contacts.phones.map(phone => ({
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

        return contacts.emails.map(email => ({
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
        return uniqueFamilyMembers.map(member => ({
            id: null,
            client_id: clientId,
            type: this._normalizeRelationship(member),
            relationship_client_id: null,
            created_at: now,
            updated_at: now,
            name: member.fullname || member.name || member.nombre || null,
            identification: member.dni || member.identification || member.cedula || null,
            birth: convertDateFormat(member.dateOfBirth || member.birthDate || member.fechaNacimiento),
            gender: member.gender || member.genero || member.sexo || null,
            state_civil: member.civilStatus || member.estadoCivil || member.maritalStatus || null,
            death: member.dateOfDeath && member.dateOfDeath.trim() !== '' ? 
                   convertDateFormat(member.dateOfDeath || member.deathDate || member.fechaMuerte) : null,
            age: member.age || member.edad || null
        }));
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
            const identifier = memberDni || memberName || JSON.stringify(member);
            
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