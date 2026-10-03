/** In-app help: short articles shown in «Ayuda» and used by the assistant to answer how-to questions. */
export interface HelpArticle {
  id: string;
  title: string;
  /** Extra words people use to ask about it (searched by the assistant). */
  keywords: string[];
  /** Paragraphs. */
  body: string[];
  /** Which paragraph answers a specific question: words in the question → index in `body` (the assistant replies with it). */
  answers?: { when: string[]; paragraph: number }[];
  /** Page that does what the article explains. */
  page?: string;
  section?: string;
  group: 'Empezar' | 'Tu dinero' | 'Ahorrar' | 'Invertir' | 'Cuenta y privacidad';
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'start', group: 'Empezar', title: 'Primeros pasos', page: 'import',
    keywords: ['empezar', 'comenzar', 'inicio', 'como funciona', 'primeros pasos', 'que hago'],
    body: [
      'Hormiga lee los extractos de tus bancos (PDF, Excel, CSV o Norma 43), clasifica cada movimiento y calcula cuánto gastas, ingresas y ahorras. Todo se guarda solo en tu ordenador.',
      '1. Importa uno o varios extractos en «Documentos» o conecta Gmail para que lleguen solos. 2. Indica el saldo de tu cuenta en «Cuentas». 3. Revisa «Previsión» para ver cómo acabará el mes y dónde puedes ahorrar.',
    ],
  },
  {
    id: 'gmail', group: 'Empezar', title: 'Conectar Gmail y que no se desconecte', page: 'settings', section: 'email',
    keywords: ['gmail', 'correo', 'desconecta', 'desconectado', 'conectar', 'api', 'google cloud', 'oauth', 'cliente', 'caduca', 'caducado', 'reconectar', 'sincronizar'],
    answers: [
      { when: ['desconect', 'caduc', '7 dias', 'semana', 'se pierde', 'reconect', 'otra vez', 'invalid'], paragraph: 1 },
      { when: ['cliente', 'secreto', 'client id', 'nueva api', 'crear'], paragraph: 2 },
    ],
    body: [
      'Hormiga busca en tu Gmail los correos de tus bancos con extractos y los importa. Solo lee: nunca borra ni modifica nada. Si lo permites, también te envía tus avisos importantes a tu propia dirección.',
      'Si la conexión se pierde cada 7 días es porque tu proyecto de Google Cloud está en modo «Prueba» (Google caduca la autorización a la semana). Para evitarlo: Google Cloud Console → «Google Auth Platform» → «Audiencia» → «Publicar app». Google mostrará un aviso de app no verificada al conectar: es normal para una app personal.',
      'No hace falta crear un cliente nuevo nunca: Hormiga guarda tu ID y secreto de cliente. Si Google retira la autorización, basta con pulsar «Volver a conectar».',
    ],
  },
  {
    id: 'import', group: 'Empezar', title: 'Importar extractos y PDF con contraseña', page: 'import',
    keywords: ['importar', 'extracto', 'pdf', 'excel', 'csv', 'contraseña', 'password', 'dni', 'norma 43', 'subir', 'cargar', 'duplicado'],
    body: [
      'En «Documentos» pulsa «Importar» y elige uno o varios ficheros. Si un movimiento ya existe (porque importaste el mismo periodo en otro formato) no se duplica.',
      'Muchos bancos protegen el PDF con tu DNI: Hormiga te lo pedirá y no lo guarda salvo que marques «Recordar en este equipo».',
    ],
  },
  {
    id: 'categories', group: 'Tu dinero', title: 'Cambiar la categoría de un movimiento', page: 'transactions',
    keywords: ['categoria', 'categorias', 'clasificar', 'regla', 'reglas', 'mal clasificado', 'cambiar categoria', 'sin clasificar'],
    body: [
      'Abre el movimiento en «Movimientos» y elige otra categoría. Hormiga te ofrecerá crear una regla para que los siguientes de ese comercio se clasifiquen solos.',
      'Las categorías «Entre mis cuentas» y «Patrimonio y préstamos» no cuentan como gasto: son dinero que sigue siendo tuyo.',
    ],
  },
  {
    id: 'transfers', group: 'Tu dinero', title: 'Transferencias entre tus cuentas, a tu pareja o a otras personas', page: 'accounts', section: 'transfers',
    keywords: ['transferencia', 'bizum', 'pareja', 'traspaso', 'cuenta mia', 'remunerada', 'liquidez', 'otra cuenta'],
    body: [
      'Una transferencia a otra cuenta tuya no es gasto: el dinero sigue siendo tuyo. Las transferencias y Bizum a otras personas sí cuentan como gasto (y los que recibes, como ingreso o devolución).',
      'En «Cuentas» → «Transferencias por revisar» dile a Hormiga quién es cada beneficiario: una cuenta tuya, tu pareja u otra persona. Las grandes sin revisar se tratan como tuyas hasta que decidas.',
    ],
  },
  {
    id: 'forecast', group: 'Ahorrar', title: 'Cómo funciona la previsión', page: 'forecast',
    keywords: ['prevision', 'predecir', 'prediccion', 'futuro', 'fin de mes', 'saldo previsto', 'proximos pagos', 'me quedare', 'numeros rojos', 'negativo'],
    body: [
      'La previsión parte del saldo de tu cuenta corriente y suma tus ingresos esperados en tu día de cobro habitual, resta tus pagos recurrentes en su fecha prevista y tu gasto variable medio de los últimos 3 meses, repartido por días.',
      'Si tu cuenta va a quedar por debajo del límite que elijas (100 € por defecto), Hormiga te avisa con antelación. También avisa si un mes vas a gastar bastante más de lo normal y de los meses que el año pasado fueron especialmente caros.',
    ],
  },
  {
    id: 'plan', group: 'Ahorrar', title: 'Tu plan de ahorro', page: 'forecast', section: 'plan',
    keywords: ['plan', 'ahorrar', 'ahorrar mas', 'gastar menos', 'reducir', 'recortar', 'consejos', 'optimizar', 'palancas'],
    body: [
      'En «Previsión» → «Tu plan de ahorro» verás propuestas concretas con tus números: volver al nivel de gasto de tu mejor trimestre en cada categoría, revisar suscripciones o dejar de pagar comisiones. Marca las que quieras y verás cuánto ahorrarías en un año y cuándo llegarías a tus metas.',
      'Pulsa «Convertir en presupuestos» para que Hormiga vigile cada categoría del plan y te avise al 80 % y al pasarte.',
    ],
  },
  {
    id: 'budgets', group: 'Ahorrar', title: 'Presupuestos mensuales', page: 'savings', section: 'budgets',
    keywords: ['presupuesto', 'presupuestos', 'limite', 'limites', 'tope'],
    body: ['En «Ahorro» → «Presupuestos» pon un límite mensual por categoría. Hormiga sugiere uno según tus últimos meses y te avisa al llegar al 80 % y al superarlo.'],
  },
  {
    id: 'emergency', group: 'Ahorrar', title: 'Fondo de emergencia', page: 'goals',
    keywords: ['emergencia', 'colchon', 'imprevistos', 'fondo'],
    body: ['Es el dinero para imprevistos: entre 3 y 6 meses de gasto esencial (vivienda, supermercado, suministros, seguros…). Hormiga calcula cuántos meses te recomienda según tu perfil y cuántos cubres ya con el dinero de tus cuentas.'],
  },
  {
    id: 'savings-rate', group: 'Ahorrar', title: 'Qué es la tasa de ahorro y cómo se calcula', page: 'savings',
    keywords: ['tasa de ahorro', 'ahorro', 'porcentaje', 'capacidad', 'cuanto ahorro', 'calcula'],
    body: [
      'Ahorro = ingresos − gastos. Tasa de ahorro = ahorro ÷ ingresos. Una referencia habitual es ahorrar al menos un 20 %.',
      'Si tienes una hipoteca registrada en «Patrimonio», la parte de la cuota que amortiza capital cuenta como ahorro (reduce tu deuda) y los intereses como gasto. Puedes desactivarlo en Ajustes.',
    ],
  },
  {
    id: 'recurring', group: 'Tu dinero', title: 'Gastos recurrentes y suscripciones', page: 'recurring',
    keywords: ['recurrente', 'recurrentes', 'suscripcion', 'suscripciones', 'recibo', 'recibos', 'netflix', 'spotify', 'gimnasio'],
    body: ['Hormiga detecta los pagos que se repiten (mensuales, trimestrales, anuales), calcula lo que te cuestan al año y prevé el siguiente cargo. Avisa si alguno sube de precio.'],
  },
  {
    id: 'mortgage', group: 'Invertir', title: 'Hipoteca y préstamos', page: 'wealth',
    keywords: ['hipoteca', 'prestamo', 'amortizar', 'amortizacion', 'intereses', 'cuota', 'euribor'],
    body: ['Registra tu préstamo en «Patrimonio» con capital, tipo, plazo y fecha de inicio. Hormiga calcula el cuadro de amortización, la deuda pendiente y cuánto ahorrarías amortizando antes (reduciendo plazo o cuota).'],
  },
  {
    id: 'stocks', group: 'Invertir', title: 'Bolsa: señales y tu cartera', page: 'stocks',
    keywords: ['bolsa', 'acciones', 'etf', 'invertir', 'comprar', 'vender', 'stop loss', 'cartera', 'irpf', 'fifo'],
    body: [
      'Sigue valores y recibe avisos cuando se cumplen reglas técnicas de compra; registra tus compras para recibir avisos de venta (stop-loss, objetivo de beneficio, cambio de tendencia) y ver el IRPF estimado. No es asesoramiento financiero.',
    ],
  },
  {
    id: 'notifications', group: 'Cuenta y privacidad', title: 'Avisos, notificaciones y correos', page: 'settings', section: 'alerts',
    keywords: ['aviso', 'avisos', 'notificacion', 'notificaciones', 'correo', 'email', 'resumen semanal', 'bandeja', 'segundo plano', 'inicio de windows'],
    body: [
      'Los avisos aparecen siempre en «Resumen». Puedes recibirlos también como notificación de Windows y, los importantes, por correo a tu propia dirección de Gmail. Los lunes Hormiga te resume tu semana.',
      'Si dejas Hormiga en segundo plano (icono junto al reloj) seguirá sincronizando y avisándote aunque cierres la ventana. También puede abrirse al iniciar Windows.',
    ],
  },
  {
    id: 'privacy', group: 'Cuenta y privacidad', title: 'Privacidad, copias y bloqueo', page: 'settings', section: 'privacy',
    keywords: ['privacidad', 'seguridad', 'copia', 'backup', 'restaurar', 'borrar', 'pin', 'bloqueo', 'windows hello', 'datos'],
    body: [
      'Tus datos se guardan solo en este ordenador. A internet solo sale lo imprescindible: la conexión con Gmail que tú autorizas y, si lo activas, el símbolo de los valores de bolsa que sigues.',
      'Haz copias de seguridad en Ajustes → Datos. Puedes proteger Hormiga con un PIN o Windows Hello.',
    ],
  },
  {
    id: 'assistant', group: 'Empezar', title: 'Qué puedo preguntarle a Hormiga', page: 'help',
    keywords: ['asistente', 'preguntar', 'chat', 'ayuda', 'que puedo preguntar'],
    body: [
      'Ejemplos: «¿Cuánto gasté en restaurantes el mes pasado?», «¿Cuánto me cuesta Netflix al año?», «¿Cuánto he ahorrado este año?», «¿Cómo acabaré el mes?», «¿Qué pagos tengo esta semana?», «¿Cómo puedo ahorrar más?», «¿Cuánto dinero tengo?».',
      'El asistente responde con tus datos sin enviarlos a ningún sitio: todo se calcula en tu ordenador.',
    ],
  },
];
