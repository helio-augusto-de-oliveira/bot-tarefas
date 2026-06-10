const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const https = require("https");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MONGO_URI =
    process.env.MONGO_URI || "mongodb://192.168.1.96:27017/jokersRA";
const USUARIOS_COLLECTION =
    process.env.USUARIOS_COLLECTION || "usuarios";
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const TAREFAS_COMMAND = "/tarefas";
const STATUS_COMMAND  = "/status";
const ADMIN_COMMAND   = "/admin";
const WHATSAPP_AUTH_DIR =
    process.env.WHATSAPP_AUTH_DIR || "../.wwebjs_auth";
const SUBSCRIPTION_KEY =
    process.env.SUBSCRIPTION_KEY || "d701a2043aa24d7ebb37e9adf60d043b";

// Dono do bot — único que pode gerenciar admins
// Pode ser sobrescrito via env para não ficar hardcoded
const DONO_ID = process.env.DONO_ID || "162247355711521@lid";

// IDs liberados por env (retrocompatibilidade) — tratados como admins fixos
const LIBERADOS_ENV = new Set(
    (process.env.REMETENTES_LIBERADOS || DONO_ID)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

// Quanto tempo antes do vencimento o token é renovado proativamente (ms)
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// TTL do cache de salas: 30 min
const SALAS_CACHE_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

const api = axios.create({
    timeout: 30_000,
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
    headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Connection: "keep-alive"
    }
});

// ---------------------------------------------------------------------------
// Retry com backoff exponencial
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES  = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENETUNREACH"]);

async function comRetry(fn, { tentativas = 4, baseDelayMs = 1_000 } = {}) {
    let ultimoErro;
    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
        try {
            return await fn();
        } catch (err) {
            ultimoErro = err;
            const status = err.response?.status;
            const code   = err.code;
            const deveRetry = RETRYABLE_STATUS.has(status) || RETRYABLE_CODES.has(code);
            if (!deveRetry || tentativa === tentativas - 1) throw err;
            const retryAfter = err.response?.headers?.["retry-after"];
            const delayMs = retryAfter
                ? Number(retryAfter) * 1_000
                : baseDelayMs * 2 ** tentativa + Math.random() * 500;
            console.warn(
                `[retry] tentativa ${tentativa + 1}/${tentativas} após ${Math.round(delayMs)}ms` +
                ` (status=${status ?? code})`
            );
            await sleep(delayMs);
        }
    }
    throw ultimoErro;
}

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Mongoose / Schemas
// ---------------------------------------------------------------------------

const UsuarioSchema = new mongoose.Schema({
    nome:  { type: String, required: true },
    email: { type: String, required: true, unique: true },
    user:  { type: String, required: true, unique: true },
    senha: { type: String, required: true }
});

const Usuario = mongoose.model("usuarios", UsuarioSchema, USUARIOS_COLLECTION);

// Admin do bot — persiste no Mongo para sobreviver a restarts
const AdminBotSchema = new mongoose.Schema({
    whatsappId: { type: String, required: true, unique: true },
    adicionadoPor: { type: String, required: true },
    adicionadoEm: { type: Date, default: Date.now }
});

const AdminBot = mongoose.model("admins_bot", AdminBotSchema, "admins_bot");

// ---------------------------------------------------------------------------
// Gestão de admins
// ---------------------------------------------------------------------------

// Cache em memória dos admins (sincronizado com Mongo na inicialização)
let adminsCache = new Set();

async function carregarAdmins() {
    const admins = await AdminBot.find({}, { whatsappId: 1 }).lean();
    adminsCache = new Set(admins.map((a) => a.whatsappId));
    console.log(`Admins carregados do Mongo: ${adminsCache.size}`);
}

async function adicionarAdmin(whatsappId, adicionadoPor) {
    await AdminBot.updateOne(
        { whatsappId },
        { whatsappId, adicionadoPor, adicionadoEm: new Date() },
        { upsert: true }
    );
    adminsCache.add(whatsappId);
}

async function removerAdmin(whatsappId) {
    await AdminBot.deleteOne({ whatsappId });
    adminsCache.delete(whatsappId);
}

async function listarAdmins() {
    return AdminBot.find({}).lean();
}

/**
 * Normaliza qualquer formato de ID do WhatsApp para só os dígitos do número.
 * Ex: "5511999999999@c.us" → "5511999999999"
 *     "162247355711521@lid" → "162247355711521"
 */
function normalizarWhatsappId(id) {
    if (!id) return "";
    return String(id).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/**
 * Verifica se um ID (qualquer formato) bate com algum ID da lista de admins/liberados.
 * Compara tanto por string exata quanto por número normalizado.
 */
function idEhAdmin(id) {
    if (!id) return false;
    if (LIBERADOS_ENV.has(id) || adminsCache.has(id)) return true;

    const normalizado = normalizarWhatsappId(id);
    for (const admin of [...LIBERADOS_ENV, ...adminsCache]) {
        if (normalizarWhatsappId(admin) === normalizado) return true;
    }
    return false;
}

function idEhDono(id) {
    if (!id) return false;
    if (id === DONO_ID) return true;
    return normalizarWhatsappId(id) === normalizarWhatsappId(DONO_ID);
}

/**
 * Extrai o ID do WhatsApp de uma menção (@número) ou de um número digitado.
 * Retorna o ID no formato "número@c.us".
 */
function resolverAlvo(texto, mentionedIds) {
    // Se veio como menção (@número), usa o ID já resolvido pelo whatsapp-web.js
    if (mentionedIds && mentionedIds.length > 0) {
        return mentionedIds[0];
    }

    // Número digitado diretamente — remove tudo que não for dígito
    const numero = texto.replace(/\D/g, "");
    if (numero.length >= 10) {
        return `${numero}@c.us`;
    }

    return null;
}

// ---------------------------------------------------------------------------
// Cache em memória: tokens e salas
// ---------------------------------------------------------------------------

const tokenCache = new Map();
const salasCache = new Map();

function tokenCacheKey(usuario) {
    return String(usuario._id || usuario.user);
}

function tokenVálido(entrada) {
    return entrada && entrada.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS;
}

function salasVálidas(entrada) {
    return entrada && Date.now() < entrada.expiresAt;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function fazerLogin(user, senha) {
    const { data } = await comRetry(() =>
        api.post(
            "https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken",
            { user, senha },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY
                }
            }
        )
    );
    return data.token;
}

async function obterAuth(token) {
    const { data } = await comRetry(() =>
        api.post(
            "https://edusp-api.ip.tv/registration/edusp/token",
            { token },
            {
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Origin: "https://saladofuturo.educacao.sp.gov.br",
                    Referer: "https://saladofuturo.educacao.sp.gov.br/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
                    "x-api-platform": "webclient",
                    "x-api-realm": "edusp"
                }
            }
        )
    );
    return data;
}

function criarHeaders(authToken) {
    return {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://saladofuturo.educacao.sp.gov.br",
        Referer: "https://saladofuturo.educacao.sp.gov.br/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
        "x-api-key": authToken
    };
}

async function obterSalasRemoto(authToken) {
    const { data } = await comRetry(() =>
        api.get(
            "https://edusp-api.ip.tv/room/user?list_all=true&with_cards=true",
            { headers: criarHeaders(authToken) }
        )
    );
    return data;
}

// ---------------------------------------------------------------------------
// Camada de cache
// ---------------------------------------------------------------------------

async function obterAuthComCache(usuario) {
    const key = tokenCacheKey(usuario);
    const cached = tokenCache.get(key);

    if (tokenVálido(cached)) {
        return { authToken: cached.authToken, nick: cached.nick };
    }

    const loginToken = await fazerLogin(usuario.user, usuario.senha);
    const auth = await obterAuth(loginToken);

    let expiresAt = Date.now() + 60 * 60 * 1_000;
    try {
        const payload = JSON.parse(
            Buffer.from(auth.auth_token.split(".")[1], "base64").toString()
        );
        if (payload.exp) expiresAt = payload.exp * 1_000;
    } catch { /* JWT não decodificável */ }

    tokenCache.set(key, { authToken: auth.auth_token, nick: auth.nick, expiresAt });
    return { authToken: auth.auth_token, nick: auth.nick };
}

async function obterSalasComCache(usuario, authToken) {
    const key = tokenCacheKey(usuario);
    const cached = salasCache.get(key);

    if (salasVálidas(cached)) return cached.salas;

    const salas = await obterSalasRemoto(authToken);
    salasCache.set(key, { salas, expiresAt: Date.now() + SALAS_CACHE_TTL_MS });
    return salas;
}

function invalidarCache(usuario) {
    const key = tokenCacheKey(usuario);
    tokenCache.delete(key);
    salasCache.delete(key);
}

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

function gerarUrlTarefas(salas, nickname, expiradas = false) {
    const params = new URLSearchParams({
        expired_only: String(expiradas),
        limit: "100",
        offset: "0",
        filter_expired: String(!expiradas),
        is_exam: "false",
        with_answer: "true",
        is_essay: "false",
        answer_statuses: "draft",
        with_apply_moment: "true"
    });

    for (const room of salas.rooms || []) {
        params.append("publication_target", room.name);
        params.append("publication_target", `${room.name}:${nickname}`);
        for (const category of room.group_categories || []) {
            params.append("publication_target", category.id.toString());
        }
    }

    return `https://edusp-api.ip.tv/tms/task/todo?${params.toString()}`;
}

async function obterTarefas(salas, nickname, authToken, expiradas = false) {
    const url = gerarUrlTarefas(salas, nickname, expiradas);
    const { data } = await comRetry(() =>
        api.get(url, { headers: criarHeaders(authToken) })
    );
    return Array.isArray(data) ? data : [];
}

function obterNomeTarefa(tarefa) {
    return (
        tarefa.title || tarefa.name || tarefa.nome ||
        tarefa.task_title || tarefa.activity_title ||
        tarefa.publication_title || tarefa.statement_title ||
        tarefa.id || "Sem nome"
    );
}

function resumirTarefas(tarefas) {
    return tarefas.map((tarefa) => ({
        id: tarefa.id || tarefa.task_id || tarefa.publication_id || tarefa._id,
        nome: obterNomeTarefa(tarefa),
        prazo:
            tarefa.expire_at || tarefa.expired_at ||
            tarefa.due_date  || tarefa.deadline   ||
            tarefa.end_date  || tarefa.apply_moment?.end_at
    }));
}

// ---------------------------------------------------------------------------
// Processamento por usuário
// ---------------------------------------------------------------------------

function detalhesErro(err) {
    if (err.response) return { status: err.response.status, body: err.response.data };
    return { message: err.message };
}

async function processarUsuario(usuario) {
    const identificador = usuario.nome || usuario.user;
    try {
        const { authToken, nick } = await obterAuthComCache(usuario);
        const salas = await obterSalasComCache(usuario, authToken);
        const pendentes = await obterTarefas(salas, nick, authToken, false);
        const expiradas = await obterTarefas(salas, nick, authToken, true);
        const pendentesResumo = resumirTarefas(pendentes);
        const expiradasResumo = resumirTarefas(expiradas);

        return {
            ok: true,
            linha: `${identificador}\nPENDENTES: ${pendentes.length}\nEXPIRADAS: ${expiradas.length}`,
            usuario: { id: usuario._id, nome: usuario.nome, email: usuario.email, user: usuario.user },
            nick,
            salas: salas.rooms?.length || 0,
            pendentesResumo,
            expiradasResumo,
            pendentes,
            expiradas,
            totais: { pendentes: pendentes.length, expiradas: expiradas.length }
        };
    } catch (err) {
        if (err.response?.status === 401) invalidarCache(usuario);
        const erro = detalhesErro(err);
        console.error(`ERRO: ${identificador}`, JSON.stringify(erro));
        return {
            ok: false,
            linha: `${identificador}\nPENDENTES: -\nEXPIRADAS: -\nERRO`,
            usuario: { id: usuario._id, nome: usuario.nome, email: usuario.email, user: usuario.user },
            erro
        };
    }
}

// ---------------------------------------------------------------------------
// Fila com concorrência limitada
// ---------------------------------------------------------------------------

async function executarComConcorrencia(items, limite, mapper) {
    const results = new Array(items.length);
    let proximo = 0;
    const workers = Array.from(
        { length: Math.min(limite, items.length) },
        async () => {
            while (proximo < items.length) {
                const atual = proximo++;
                results[atual] = await mapper(items[atual], atual);
            }
        }
    );
    await Promise.all(workers);
    return results;
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

async function salvarResultado(resultados) {
    const outputDir = path.resolve(__dirname, "..", "output");
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `tarefas-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const filePath = path.join(outputDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(resultados, null, 2), "utf8");
    return filePath;
}

async function buscarUsuarios() {
    const usuarios = await Usuario.find(
        { user: { $exists: true, $ne: "" }, senha: { $exists: true, $ne: "" } },
        { nome: 1, email: 1, user: 1, senha: 1 }
    ).lean();
    return usuarios.sort((a, b) => {
        const nomeA = a.nome || a.user;
        const nomeB = b.nome || b.user;
        return nomeA.localeCompare(nomeB, "pt-BR", { sensitivity: "base" });
    });
}

function montarMensagem(resultados) {
    const linhas = resultados.map((item) => item.linha);
    return `\`\`\`\n${linhas.join("\n\n")}\n\`\`\``;
}

async function gerarRelatorioTarefas() {
    const totalNaCollection = await Usuario.collection.countDocuments();
    const usuarios = await buscarUsuarios();

    console.log(`Mongo DB: ${mongoose.connection.db.databaseName}`);
    console.log(`Collection: ${USUARIOS_COLLECTION}`);
    console.log(`Total na collection: ${totalNaCollection}`);
    console.log(`Usuarios com user e senha: ${usuarios.length}`);
    console.log(`Concorrencia: ${CONCURRENCY}`);

    const resultados = await executarComConcorrencia(
        usuarios,
        CONCURRENCY,
        (usuario) => processarUsuario(usuario)
    );

    const resumo = resultados.reduce(
        (acc, item) => {
            if (!item.ok) { acc.erros += 1; return acc; }
            acc.sucesso   += 1;
            acc.pendentes += item.totais.pendentes;
            acc.expiradas += item.totais.expiradas;
            return acc;
        },
        { sucesso: 0, erros: 0, pendentes: 0, expiradas: 0 }
    );

    const filePath = await salvarResultado({
        geradoEm: new Date().toISOString(),
        resumo,
        resultados
    });

    console.log(`Arquivo salvo em: ${filePath}`);
    return { mensagem: montarMensagem(resultados), resumo, filePath };
}

// ---------------------------------------------------------------------------
// Status do bot
// ---------------------------------------------------------------------------

async function gerarStatusBot(gerandoRelatorio) {
    const totalNaCollection = await Usuario.collection.countDocuments();
    const usuariosComCredenciais = await Usuario.countDocuments({
        user: { $exists: true, $ne: "" },
        senha: { $exists: true, $ne: "" }
    });

    return [
        "STATUS DO BOT",
        "",
        "WHATSAPP: conectado",
        `MONGO: ${mongoose.connection.readyState === 1 ? "conectado" : "desconectado"}`,
        `DB: ${mongoose.connection.db?.databaseName || "-"}`,
        `COLLECTION: ${USUARIOS_COLLECTION}`,
        `TOTAL NA COLLECTION: ${totalNaCollection}`,
        `USUARIOS COM LOGIN: ${usuariosComCredenciais}`,
        `CONCORRENCIA: ${CONCURRENCY}`,
        `TOKENS EM CACHE: ${tokenCache.size}`,
        `SALAS EM CACHE: ${salasCache.size}`,
        `ADMINS BOT: ${adminsCache.size}`,
        `RELATORIO: ${gerandoRelatorio ? "gerando agora" : "livre"}`
    ].join("\n");
}

// ---------------------------------------------------------------------------
// Handlers de mensagem
// ---------------------------------------------------------------------------

function idsDoParticipante(participante) {
    return [
        participante?.id?._serialized,
        participante?.id?.user,
        participante?.id?.server
            ? `${participante.id.user}@${participante.id.server}`
            : undefined
    ].filter(Boolean);
}

function remetentePodeUsarComandoEmGrupo(chat, message, comando) {
    const remetente = message.author || message.from;
    const remetenteNormalizado = normalizarWhatsappId(remetente);

    if (idEhAdmin(remetente)) return true;

    const participante = chat.participants.find((item) =>
        idsDoParticipante(item).some(
            (id) => id === remetente || normalizarWhatsappId(id) === remetenteNormalizado
        )
    );

    console.log(
        `Comando ${comando}:`,
        JSON.stringify({
            remetente,
            remetenteNormalizado,
            ehAdmin: idEhAdmin(remetente),
            participanteEncontrado: Boolean(participante),
            isAdmin: Boolean(participante?.isAdmin),
            isSuperAdmin: Boolean(participante?.isSuperAdmin)
        })
    );

    return Boolean(participante?.isAdmin || participante?.isSuperAdmin);
}

/**
 * Processa /admin adicionar|remover|listar
 * Só o dono pode executar.
 */
async function handleAdmin(message, chat, remetente) {
    if (!idEhDono(remetente)) {
        await message.reply("Apenas o dono do bot pode gerenciar admins.");
        return;
    }

    const partes = message.body.trim().split(/\s+/);
    // partes[0] = "/admin", partes[1] = subcomando, partes[2] = alvo opcional
    const subcomando = (partes[1] || "").toLowerCase();

    if (subcomando === "listar") {
        const admins = await listarAdmins();
        if (admins.length === 0) {
            await message.reply("Nenhum admin cadastrado alem dos fixos.");
            return;
        }
        const linhas = admins.map(
            (a) => `• ${a.whatsappId}  (adicionado por ${a.adicionadoPor} em ${new Date(a.adicionadoEm).toLocaleDateString("pt-BR")})`
        );
        await message.reply(`*Admins do bot:*\n${linhas.join("\n")}`);
        return;
    }

    if (subcomando === "adicionar" || subcomando === "remover") {
        // Tenta resolver pelo número digitado (partes[2]) ou pela menção
        const textoAlvo = partes[2] || "";
        const mentionedIds = message.mentionedIds || [];
        const alvoId = resolverAlvo(textoAlvo, mentionedIds);

        if (!alvoId) {
            await message.reply(
                `Uso:\n/admin adicionar @pessoa\n/admin adicionar 5511999999999\n/admin remover @pessoa\n/admin listar`
            );
            return;
        }

        if (subcomando === "adicionar") {
            await adicionarAdmin(alvoId, remetente);
            await message.reply(`Admin adicionado: ${alvoId}`);
        } else {
            await removerAdmin(alvoId);
            await message.reply(`Admin removido: ${alvoId}`);
        }
        return;
    }

    await message.reply(
        `Uso:\n/admin adicionar @pessoa\n/admin adicionar 5511999999999\n/admin remover @pessoa\n/admin listar`
    );
}

/**
 * Processa /tarefas e /status — funciona em grupo e no privado.
 */
async function handleRelatorio(message, chat, remetente, gerandoRelatorio, setGerandoRelatorio) {
    const comando = message.body.trim().toLowerCase();
    const emGrupo = chat.isGroup;

    // Verifica permissão
    const temPermissao = emGrupo
        ? remetentePodeUsarComandoEmGrupo(chat, message, comando)
        : idEhAdmin(remetente);

    if (!temPermissao) {
        await message.reply(
            emGrupo
                ? `Apenas admins do grupo podem usar ${comando}.`
                : `Voce nao tem permissao para usar ${comando} no privado.`
        );
        return;
    }

    if (comando === STATUS_COMMAND) {
        try {
            const status = await gerarStatusBot(gerandoRelatorio);
            await message.reply(`\`\`\`\n${status}\n\`\`\``);
        } catch (err) {
            console.error("Falha ao gerar status:", detalhesErro(err));
            await message.reply("Nao consegui buscar o status agora.");
        }
        return;
    }

    // /tarefas
    if (gerandoRelatorio) {
        await message.reply("Ja estou gerando um relatorio. Aguarde finalizar.");
        return;
    }

    setGerandoRelatorio(true);
    try {
        await message.reply("Buscando tarefas....");
        const { mensagem } = await gerarRelatorioTarefas();
        // No privado responde direto; em grupo manda no chat para todos verem
        if (emGrupo) {
            await chat.sendMessage(mensagem);
        } else {
            await message.reply(mensagem);
        }
    } catch (err) {
        console.error("Falha ao gerar relatorio:", detalhesErro(err));
        await message.reply("Nao consegui buscar as tarefas agora.");
    } finally {
        setGerandoRelatorio(false);
    }
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

async function iniciarWhatsapp() {
    if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
        throw new Error("CONCURRENCY precisa ser um numero inteiro maior que zero.");
    }

    await mongoose.connect(MONGO_URI);
    await carregarAdmins();

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: "joker-tarefas",
            dataPath: WHATSAPP_AUTH_DIR
        }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu"
            ]
        }
    });

    let _gerandoRelatorio = false;
    const getGerandoRelatorio = () => _gerandoRelatorio;
    const setGerandoRelatorio = (v) => { _gerandoRelatorio = v; };

    client.on("qr", async (qr) => {
        const qrTerminal = await QRCode.toString(qr, { type: "terminal", small: true });
        console.log(qrTerminal);
        console.log("Escaneie o QR Code acima com o WhatsApp.");
    });

    client.on("ready", () => {
        console.log("WhatsApp conectado. Aguardando comandos em grupos e no privado.");
    });

    client.on("message", async (message) => {
        const corpo = message.body.trim();
        const comandoLower = corpo.toLowerCase();
        const remetente = message.from; // no privado é o número; em grupo é o chat id

        // Em grupos o remetente real é message.author
        const autorReal = message.author || message.from;

        const chat = await message.getChat();

        // /admin — só no privado ou em grupo, mas só dono executa de qualquer lugar
        if (comandoLower.startsWith(ADMIN_COMMAND)) {
            await handleAdmin(message, chat, autorReal);
            return;
        }

        // /tarefas e /status — grupo ou privado
        if ([TAREFAS_COMMAND, STATUS_COMMAND].includes(comandoLower)) {
            await handleRelatorio(
                message,
                chat,
                autorReal,
                getGerandoRelatorio(),
                setGerandoRelatorio
            );
            return;
        }
    });

    await client.initialize();
}

iniciarWhatsapp().catch(async (err) => {
    console.error("Falha geral:", detalhesErro(err));
    await mongoose.disconnect();
    process.exitCode = 1;
});