import type { SystemCategoryKey } from './categories';

/**
 * Built-in, versioned knowledge used by the deterministic categorizer.
 * Everything here is public brand/keyword information, no personal data.
 */

export interface KnownMerchant {
  /** Uppercase tokens that identify the brand at the start of (or inside) a cleaned description. */
  aliases: string[];
  display: string;
  category: SystemCategoryKey;
  subscription?: boolean;
}

export const KNOWN_MERCHANTS: KnownMerchant[] = [
  // Supermercados
  { aliases: ['MERCADONA'], display: 'Mercadona', category: 'groceries' },
  { aliases: ['LIDL'], display: 'Lidl', category: 'groceries' },
  { aliases: ['CARREFOUR', 'CARREFOUR EXPRESS', 'CARREFOUR MARKET'], display: 'Carrefour', category: 'groceries' },
  { aliases: ['ALCAMPO'], display: 'Alcampo', category: 'groceries' },
  { aliases: ['DIA', 'DIA %', 'SUPERMERCADOS DIA'], display: 'Dia', category: 'groceries' },
  { aliases: ['EROSKI'], display: 'Eroski', category: 'groceries' },
  { aliases: ['CONSUM'], display: 'Consum', category: 'groceries' },
  { aliases: ['ALDI'], display: 'Aldi', category: 'groceries' },
  { aliases: ['BONPREU', 'BON PREU'], display: 'Bonpreu', category: 'groceries' },
  { aliases: ['CONDIS'], display: 'Condis', category: 'groceries' },
  { aliases: ['HIPERCOR'], display: 'Hipercor', category: 'groceries' },
  { aliases: ['AHORRAMAS'], display: 'Ahorramas', category: 'groceries' },
  { aliases: ['GADIS'], display: 'Gadis', category: 'groceries' },
  { aliases: ['CAPRABO'], display: 'Caprabo', category: 'groceries' },
  { aliases: ['SPAR'], display: 'Spar', category: 'groceries' },
  { aliases: ['SUMA'], display: 'Suma', category: 'groceries' },
  { aliases: ['SUPECO'], display: 'Supeco', category: 'groceries' },
  { aliases: ['BONAREA', 'BON AREA', 'GUISSONA'], display: 'bonÀrea', category: 'groceries' },
  { aliases: ['CASA AMETLLER'], display: 'Casa Ametller', category: 'groceries' },
  { aliases: ['SORLI'], display: 'Sorli', category: 'groceries' },
  { aliases: ['CARREF'], display: 'Carrefour', category: 'groceries' },
  { aliases: ['SEVEN ELEVEN', '7 ELEVEN'], display: '7-Eleven', category: 'groceries' },
  { aliases: ['LAWSON'], display: 'Lawson', category: 'groceries' },
  { aliases: ['FAMILYMART', 'FAMILY MART'], display: 'FamilyMart', category: 'groceries' },
  // Restauración
  { aliases: ['MCDONALDS', 'MC DONALDS', 'MCDONALD S', 'MC DONALD S'], display: "McDonald's", category: 'restaurants' },
  { aliases: ['BURGER KING'], display: 'Burger King', category: 'restaurants' },
  { aliases: ['TELEPIZZA'], display: 'Telepizza', category: 'restaurants' },
  { aliases: ['STARBUCKS'], display: 'Starbucks', category: 'restaurants' },
  { aliases: ['COSTA COFFEE'], display: 'Costa Coffee', category: 'restaurants' },
  { aliases: ['EUREST'], display: 'Eurest', category: 'restaurants' },
  { aliases: ['KFC'], display: 'KFC', category: 'restaurants' },
  { aliases: ['GLOVO'], display: 'Glovo', category: 'restaurants' },
  { aliases: ['JUST EAT', 'JUSTEAT'], display: 'Just Eat', category: 'restaurants' },
  { aliases: ['UBER EATS', 'UBEREATS'], display: 'Uber Eats', category: 'restaurants' },
  { aliases: ['DELIVEROO'], display: 'Deliveroo', category: 'restaurants' },
  { aliases: ['100 MONTADITOS'], display: '100 Montaditos', category: 'restaurants' },
  { aliases: ['FOSTERS HOLLYWOOD'], display: "Foster's Hollywood", category: 'restaurants' },
  // Suscripciones y servicios digitales
  { aliases: ['NETFLIX'], display: 'Netflix', category: 'subscriptions', subscription: true },
  { aliases: ['SPOTIFY'], display: 'Spotify', category: 'subscriptions', subscription: true },
  { aliases: ['HBO MAX', 'HBOMAX', 'MAX.COM'], display: 'Max', category: 'subscriptions', subscription: true },
  { aliases: ['DISNEY PLUS', 'DISNEYPLUS', 'DISNEY+'], display: 'Disney+', category: 'subscriptions', subscription: true },
  { aliases: ['PRIME VIDEO', 'AMAZON PRIME', 'AMZN PRIME', 'PRIMEVIDEO'], display: 'Amazon Prime', category: 'subscriptions', subscription: true },
  { aliases: ['APPLE.COM BILL', 'APPLE COM BILL', 'ITUNES'], display: 'Apple (suscripciones)', category: 'subscriptions', subscription: true },
  { aliases: ['GOOGLE STORAGE', 'GOOGLE ONE', 'GOOGLE PLAY', 'GOOGLE YOUTUBE', 'YOUTUBE PREMIUM', 'YOUTUBEPREMIUM'], display: 'Google (suscripciones)', category: 'subscriptions', subscription: true },
  { aliases: ['DAZN'], display: 'DAZN', category: 'subscriptions', subscription: true },
  // Note: aliases are normalized ("MOVISTAR+" → "MOVISTAR"), so only unambiguous forms are listed.
  { aliases: ['MOVISTAR PLUS'], display: 'Movistar Plus+', category: 'subscriptions', subscription: true },
  { aliases: ['FILMIN'], display: 'Filmin', category: 'subscriptions', subscription: true },
  { aliases: ['AUDIBLE'], display: 'Audible', category: 'subscriptions', subscription: true },
  { aliases: ['MICROSOFT', 'MSFT'], display: 'Microsoft', category: 'technology', subscription: true },
  { aliases: ['ADOBE'], display: 'Adobe', category: 'technology', subscription: true },
  { aliases: ['DROPBOX'], display: 'Dropbox', category: 'technology', subscription: true },
  { aliases: ['OPENAI', 'CHATGPT'], display: 'OpenAI', category: 'technology', subscription: true },
  { aliases: ['ANTHROPIC', 'CLAUDE.AI'], display: 'Anthropic', category: 'technology', subscription: true },
  { aliases: ['GITHUB'], display: 'GitHub', category: 'technology', subscription: true },
  // Compras
  { aliases: ['AMAZON', 'AMZN', 'AMZN MKTP', 'AMAZON MARKETPLACE'], display: 'Amazon', category: 'shopping' },
  { aliases: ['ALIEXPRESS'], display: 'AliExpress', category: 'shopping' },
  { aliases: ['ZARA'], display: 'Zara', category: 'shopping' },
  { aliases: ['PRIMARK'], display: 'Primark', category: 'shopping' },
  { aliases: ['EL CORTE INGLES', 'CORTE INGLES'], display: 'El Corte Inglés', category: 'shopping' },
  { aliases: ['IKEA'], display: 'IKEA', category: 'shopping' },
  { aliases: ['DECATHLON'], display: 'Decathlon', category: 'sport' },
  { aliases: ['MEDIA MARKT', 'MEDIAMARKT'], display: 'MediaMarkt', category: 'technology' },
  { aliases: ['PCCOMPONENTES', 'PC COMPONENTES'], display: 'PcComponentes', category: 'technology' },
  { aliases: ['FNAC'], display: 'Fnac', category: 'technology' },
  { aliases: ['LEROY MERLIN'], display: 'Leroy Merlin', category: 'housing' },
  { aliases: ['SHEIN'], display: 'Shein', category: 'shopping' },
  { aliases: ['TEMU', 'TEMU COM'], display: 'Temu', category: 'shopping' },
  { aliases: ['STRADIVARIUS'], display: 'Stradivarius', category: 'shopping' },
  { aliases: ['BERSHKA'], display: 'Bershka', category: 'shopping' },
  { aliases: ['PULL AND BEAR'], display: 'Pull&Bear', category: 'shopping' },
  { aliases: ['UNIQLO'], display: 'Uniqlo', category: 'shopping' },
  { aliases: ['NIKE', 'NIKEPOS'], display: 'Nike', category: 'shopping' },
  { aliases: ['ADIDAS'], display: 'Adidas', category: 'shopping' },
  { aliases: ['DRUNI'], display: 'Druni', category: 'shopping' },
  { aliases: ['PRIMOR'], display: 'Primor', category: 'shopping' },
  { aliases: ['HUAWEI'], display: 'Huawei', category: 'technology' },
  { aliases: ['XIAOMI'], display: 'Xiaomi', category: 'technology' },
  { aliases: ['PULL BEAR'], display: 'Pull&Bear', category: 'shopping' },
  { aliases: ['TIENDANIMAL', 'KIWOKO'], display: 'Tienda de animales', category: 'shopping' },
  { aliases: ['OBRAMAT', 'BRICOMART', 'BAUHAUS', 'BRICODEPOT', 'BRICO DEPOT'], display: 'Bricolaje', category: 'housing' },
  { aliases: ['VINTED'], display: 'Vinted', category: 'shopping' },
  // Transporte y combustible
  { aliases: ['REPSOL'], display: 'Repsol', category: 'fuel' },
  { aliases: ['CEPSA', 'MOEVE'], display: 'Cepsa / Moeve', category: 'fuel' },
  { aliases: ['GALP'], display: 'Galp', category: 'fuel' },
  { aliases: ['BP', 'BP OIL'], display: 'BP', category: 'fuel' },
  { aliases: ['SHELL'], display: 'Shell', category: 'fuel' },
  { aliases: ['PETRONOR'], display: 'Petronor', category: 'fuel' },
  { aliases: ['BALLENOIL'], display: 'Ballenoil', category: 'fuel' },
  { aliases: ['PLENOIL'], display: 'Plenoil', category: 'fuel' },
  { aliases: ['ESCLATOIL'], display: 'Esclatoil', category: 'fuel' },
  { aliases: ['MEROIL'], display: 'Meroil', category: 'fuel' },
  { aliases: ['TFL TRAVEL', 'TFL'], display: 'Transport for London', category: 'travel' },
  { aliases: ['RENFE'], display: 'Renfe', category: 'transport' },
  { aliases: ['UBER', 'UBER TRIP', 'UBER BV'], display: 'Uber', category: 'transport' },
  { aliases: ['CABIFY'], display: 'Cabify', category: 'transport' },
  { aliases: ['BOLT'], display: 'Bolt', category: 'transport' },
  { aliases: ['METRO DE MADRID', 'TMB', 'EMT', 'FGC'], display: 'Transporte público', category: 'transport' },
  { aliases: ['BLABLACAR'], display: 'BlaBlaCar', category: 'transport' },
  { aliases: ['VIA T', 'VIAT', 'AUTOPISTA', 'PEAJE'], display: 'Peajes', category: 'transport' },
  { aliases: ['IRYO', 'OUIGO'], display: 'Tren alta velocidad', category: 'travel' },
  { aliases: ['RYANAIR'], display: 'Ryanair', category: 'travel' },
  { aliases: ['AENA'], display: 'Aena (aeropuertos)', category: 'travel' },
  { aliases: ['VUELING'], display: 'Vueling', category: 'travel' },
  { aliases: ['IBERIA'], display: 'Iberia', category: 'travel' },
  { aliases: ['BOOKING.COM', 'BOOKING COM'], display: 'Booking.com', category: 'travel' },
  { aliases: ['AIRBNB'], display: 'Airbnb', category: 'travel' },
  // Suministros y telecomunicaciones
  { aliases: ['IBERDROLA'], display: 'Iberdrola', category: 'utilities' },
  { aliases: ['ENDESA'], display: 'Endesa', category: 'utilities' },
  { aliases: ['NATURGY'], display: 'Naturgy', category: 'utilities' },
  { aliases: ['TOTALENERGIES', 'TOTAL ENERGIES'], display: 'TotalEnergies', category: 'utilities' },
  { aliases: ['HOLALUZ'], display: 'Holaluz', category: 'utilities' },
  { aliases: ['OCTOPUS ENERGY'], display: 'Octopus Energy', category: 'utilities' },
  { aliases: ['CANAL DE ISABEL II', 'AIGUES DE BARCELONA', 'AGUAS DE', 'SOCIEDAD GRAL AGUAS', 'AGUAS BCN'], display: 'Agua', category: 'utilities' },
  { aliases: ['MOVISTAR', 'TELEFONICA'], display: 'Movistar', category: 'utilities' },
  { aliases: ['VODAFONE'], display: 'Vodafone', category: 'utilities' },
  { aliases: ['ORANGE'], display: 'Orange', category: 'utilities' },
  { aliases: ['DIGI', 'DIGI SPAIN'], display: 'Digi', category: 'utilities' },
  { aliases: ['JAZZTEL'], display: 'Jazztel', category: 'utilities' },
  { aliases: ['MASMOVIL', 'MAS MOVIL'], display: 'MásMóvil', category: 'utilities' },
  { aliases: ['PEPEPHONE'], display: 'Pepephone', category: 'utilities' },
  { aliases: ['O2'], display: 'O2', category: 'utilities' },
  // Seguros, salud, deporte
  { aliases: ['MAPFRE'], display: 'Mapfre', category: 'insurance' },
  { aliases: ['MUTUA MADRILENA', 'MUTUA MADRILEÑA'], display: 'Mutua Madrileña', category: 'insurance' },
  { aliases: ['LINEA DIRECTA'], display: 'Línea Directa', category: 'insurance' },
  { aliases: ['PLAN ESTARSEGURO', 'ESTARSEGURO'], display: 'BBVA Plan Estarseguro', category: 'insurance' },
  { aliases: ['SANITAS'], display: 'Sanitas', category: 'health' },
  { aliases: ['ADESLAS'], display: 'Adeslas', category: 'health' },
  { aliases: ['ASISA'], display: 'Asisa', category: 'health' },
  { aliases: ['DKV'], display: 'DKV', category: 'health' },
  { aliases: ['BASIC FIT', 'BASIC-FIT'], display: 'Basic-Fit', category: 'sport', subscription: true },
  { aliases: ['VIVAGYM', 'VIVA GYM'], display: 'VivaGym', category: 'sport', subscription: true },
  { aliases: ['ANYTIME FITNESS'], display: 'Anytime Fitness', category: 'sport', subscription: true },
  { aliases: ['MCFIT', 'MC FIT'], display: 'McFit', category: 'sport', subscription: true },
  { aliases: ['DIR '], display: 'DIR', category: 'sport', subscription: true },
  // Ocio
  { aliases: ['CINESA'], display: 'Cinesa', category: 'leisure' },
  { aliases: ['YELMO'], display: 'Yelmo Cines', category: 'leisure' },
  { aliases: ['TICKETMASTER'], display: 'Ticketmaster', category: 'leisure' },
  { aliases: ['STEAM', 'STEAMGAMES'], display: 'Steam', category: 'leisure' },
  { aliases: ['PLAYSTATION', 'SONY INTERACTIVE'], display: 'PlayStation', category: 'leisure' },
  { aliases: ['NINTENDO'], display: 'Nintendo', category: 'leisure' },
  { aliases: ['ENEBA'], display: 'Eneba', category: 'leisure' },
  { aliases: ['WEEZEVENT'], display: 'Weezevent', category: 'leisure' },
  { aliases: ['TOMORROWLAND'], display: 'Tomorrowland', category: 'leisure' },
  { aliases: ['PLAYTOMIC'], display: 'Playtomic', category: 'sport' },
];

export interface KeywordRule {
  keywords: string[];
  category: SystemCategoryKey;
  label: string;
}

/** Keyword/pattern rules (source RULE). Matched on the normalized description as whole words. */
export const KEYWORD_RULES: KeywordRule[] = [
  { keywords: ['FARMACIA', 'PARAFARMACIA', 'CLINICA', 'DENTAL', 'HOSPITAL', 'OPTICA', 'FISIOTERAPIA', 'MEDICO'], category: 'health', label: 'salud' },
  { keywords: ['GASOLINERA', 'GASOLINERAS', 'BENZINERA', 'BENZINERES', 'ESTACION DE SERVICIO', 'ESTACIO DE SERVEI', 'E.S.', 'CARBURANTES', 'CARBURANTS', 'GASOLEO'], category: 'fuel', label: 'combustible' },
  { keywords: ['RESTAURANTE', 'REST.', 'BAR', 'CAFETERIA', 'CAFE', 'RAMEN', 'COCTEL', 'COCKTEL', 'IRISH', 'CREPERIA', 'HELADERIA', 'FRANKFURT', 'TABERNA', 'PIZZERIA', 'BURGER', 'SUSHI', 'TAPAS', 'CERVECERIA', 'KEBAB', 'ASADOR', 'BRASERIA', 'MARISQUERIA'], category: 'restaurants', label: 'restauración' },
  { keywords: ['SUPERMERCADO', 'SUPERMERCAT', 'HIPERMERCADO', 'FRUTERIA', 'CARNICERIA', 'PANADERIA', 'PESCADERIA', 'ALIMENTACION', 'MERCADO'], category: 'groceries', label: 'alimentación' },
  { keywords: ['PARKING', 'APARCAMIENTO', 'ESTACIONAMENT', 'APARCAMENT', 'TAXI', 'METRO', 'AUTOBUS', 'BUS', 'TRANSPORTE', 'PEAJE', 'ITV'], category: 'transport', label: 'transporte' },
  { keywords: ['HOTEL', 'HOSTAL', 'APARTAMENTOS', 'VUELO', 'AEROPUERTO', 'AIRLINES', 'VIAJES'], category: 'travel', label: 'viajes' },
  { keywords: ['CINE', 'CINES', 'TEATRO', 'CONCIERTO', 'MUSEO', 'ENTRADAS', 'BOWLING', 'OCIO'], category: 'leisure', label: 'ocio' },
  { keywords: ['GIMNASIO', 'GYM', 'FITNESS', 'PADEL', 'PISCINA', 'DEPORTES', 'CROSSFIT', 'YOGA'], category: 'sport', label: 'deporte' },
  { keywords: ['COLEGIO', 'ACADEMIA', 'UNIVERSIDAD', 'LIBRERIA', 'CURSO', 'FORMACION', 'MATRICULA', 'ESCUELA'], category: 'education', label: 'educación' },
  { keywords: ['ALQUILER', 'COMUNIDAD DE PROPIETARIOS', 'COMUNIDAD PROP', 'MANCOMUNIDAD', 'COMUNITAT', 'HIPOTECA', 'PRESTAMO HIPOTECARIO', 'FERRETERIA', 'MUEBLES'], category: 'housing', label: 'vivienda' },
  { keywords: ['ELECTRICIDAD', 'LUZ', 'GAS NATURAL', 'AGUA', 'AGUAS', 'AIGUES', 'TELEFONO', 'FIBRA', 'INTERNET', 'TELECOMUNICACIONES'], category: 'utilities', label: 'suministros' },
  { keywords: ['SEGURO', 'SEGUROS', 'ASEGURADORA', 'POLIZA'], category: 'insurance', label: 'seguros' },
  { keywords: ['AMORTIZACION DE PRESTAMO', 'AMORTIZACION PRESTAMO', 'CUOTA PRESTAMO', 'PRESTAMO', 'CREDITO PERSONAL', 'FINANCIACION'], category: 'loans', label: 'préstamos' },
  { keywords: ['AEAT', 'AGENCIA TRIBUTARIA', 'HACIENDA', 'IBI', 'AYUNTAMIENTO', 'TASA', 'IMPUESTO', 'IVTM', 'DGT', 'MULTA', 'IMPUESTOS', 'RECAUDACION', 'TRIBUTOS'], category: 'taxes', label: 'impuestos y tasas' },
  { keywords: ['SUSCRIPCION', 'SUBSCRIPTION', 'MEMBERSHIP', 'PREMIUM'], category: 'subscriptions', label: 'suscripción' },
  { keywords: ['ELECTRONICA', 'INFORMATICA', 'SOFTWARE', 'APP STORE'], category: 'technology', label: 'tecnología' },
  { keywords: ['TIENDA', 'MODA', 'ZAPATERIA', 'BOUTIQUE', 'BAZAR', 'OUTLET', 'CENTRO COMERCIAL'], category: 'shopping', label: 'compras' },
];

/** Prefixes that banks add to card/charge descriptions and carry no merchant information. */
export const DESCRIPTION_PREFIXES = [
  'COMPRA TARJETA', 'COMPRA TARJ', 'COMPRA CON TARJETA', 'COMPRA EN', 'COMPRA', 'PAGO CON TARJETA', 'PAGO TARJETA',
  'PAGO EN', 'PAGO MOVIL EN', 'PAGO MOVIL', 'PAGO', 'CARGO POR COMPRA', 'CARGO', 'ADEUDO RECIBO', 'ADEUDO DOMICILIADO',
  'ADEUDO', 'RECIBO DOMICILIADO', 'RECIBO', 'CONTACTLESS', 'APPLE PAY', 'GOOGLE PAY', 'OPERACION TARJETA',
  'PAYPAL', 'PAYPAL EUROPE', 'SUMUP', 'SQ', 'ZETTLE', 'MOP', 'TPV',
];

/** Very common Spanish city/province names that trail merchant descriptors on card statements. */
export const TRAILING_LOCATIONS = [
  'MADRID', 'BARCELONA', 'VALENCIA', 'SEVILLA', 'ZARAGOZA', 'MALAGA', 'MURCIA', 'PALMA', 'BILBAO', 'ALICANTE',
  'CORDOBA', 'VALLADOLID', 'VIGO', 'GIJON', 'HOSPITALET', 'VITORIA', 'CORUNA', 'LA CORUNA', 'A CORUNA', 'GRANADA',
  'ELCHE', 'OVIEDO', 'BADALONA', 'TERRASSA', 'CARTAGENA', 'SABADELL', 'JEREZ', 'MOSTOLES', 'SANTANDER', 'PAMPLONA',
  'ALMERIA', 'ALCALA', 'FUENLABRADA', 'LEGANES', 'GETAFE', 'BURGOS', 'SALAMANCA', 'ALBACETE', 'LOGRONO', 'BADAJOZ',
  'HUELVA', 'LLEIDA', 'TARRAGONA', 'LEON', 'CADIZ', 'JAEN', 'OURENSE', 'GIRONA', 'LUGO', 'CACERES', 'SANTIAGO',
  'CASTELLON', 'SEGOVIA', 'TOLEDO', 'PONTEVEDRA', 'GUADALAJARA', 'HUESCA', 'CUENCA', 'SORIA', 'TERUEL', 'AVILA',
  'ZAMORA', 'PALENCIA', 'CIUDAD REAL', 'DONOSTIA', 'SAN SEBASTIAN', 'MARBELLA', 'IBIZA', 'TENERIFE', 'LAS PALMAS',
  'ESP', 'ES', 'ESPANA', 'SPAIN', 'IRL', 'IE', 'LU', 'LUX', 'NL', 'GB', 'USA', 'US',
];

export const LEGAL_SUFFIXES = ['S.L.U.', 'S.L.U', 'SLU', 'S.L.', 'S.L', 'SL', 'S.A.U.', 'S.A.U', 'SAU', 'S.A.', 'S.A', 'SA', 'S.COOP', 'SCP', 'CB', 'C.B.', 'LTD', 'LIMITED', 'INC', 'GMBH', 'BV', 'B.V.', 'SARL', 'SRL'];
