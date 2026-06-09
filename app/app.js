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
const STATUS_COMMAND = "/status";
const WHATSAPP_AUTH_DIR =
    process.env.WHATSAPP_AUTH_DIR || "../.wwebjs_auth";
const REMETENTES_LIBERADOS = new Set(
    (
        process.env.REMETENTES_LIBERADOS ||
        "162247355711521@lid,157058481537162@lid,139109729312833@lid"
    )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);
const SUBSCRIPTION_KEY =
    process.env.SUBSCRIPTION_KEY || "d701a2043aa24d7ebb37e9adf60d043b";

// Quanto tempo antes do vencimento o token é renovado proativamente (ms)
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min
// TTL do cache de salas: 30 min (sala muda muito raramente)
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
// Trata: 429, 5xx e erros de rede (ECONNRESET, ETIMEDOUT, etc.)
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
            const deveRetry =
                RETRYABLE_STATUS.has(status) || RETRYABLE_CODES.has(code);

            if (!deveRetry || tentativa === tentativas - 1) {
                throw err;
            }

            // Respeita Retry-After se a API mandar
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
// Mongoose / Schema
// ---------------------------------------------------------------------------

const UsuarioSchema = new mongoose.Schema({
    nome:  { type: String, required: true },
    email: { type: String, required: true, unique: true },
    user:  { type: String, required: true, unique: true },
    senha: { type: String, required: true }
});

const Usuario = mongoose.model(
    "usuarios",
    UsuarioSchema,
    USUARIOS_COLLECTION
);

// ---------------------------------------------------------------------------
// Cache em memória: tokens de autenticação e salas
//
// Estrutura tokenCache:
//   Map<userId, { authToken, nick, expiresAt }>
//
// Estrutura salasCache:
//   Map<userId, { salas, expiresAt }>
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
// API calls (sem cache — cache é feito na camada acima)
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
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
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
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
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

/**
 * Retorna { authToken, nick } usando cache quando possível.
 * Renova automaticamente se o token estiver próximo de expirar.
 */
async function obterAuthComCache(usuario) {
    const key = tokenCacheKey(usuario);
    const cached = tokenCache.get(key);

    if (tokenVálido(cached)) {
        return { authToken: cached.authToken, nick: cached.nick };
    }

    // Login + troca de token
    const loginToken = await fazerLogin(usuario.user, usuario.senha);
    const auth = await obterAuth(loginToken);

    // Tenta extrair expiração do JWT (campo exp em segundos)
    let expiresAt = Date.now() + 60 * 60 * 1_000; // fallback: 1 hora
    try {
        const payload = JSON.parse(
            Buffer.from(auth.auth_token.split(".")[1], "base64").toString()
        );
        if (payload.exp) {
            expiresAt = payload.exp * 1_000;
        }
    } catch {
        // JWT não decodificável — usa fallback
    }

    tokenCache.set(key, {
        authToken: auth.auth_token,
        nick: auth.nick,
        expiresAt
    });

    return { authToken: auth.auth_token, nick: auth.nick };
}

/**
 * Retorna salas usando cache quando possível.
 */
async function obterSalasComCache(usuario, authToken) {
    const key = tokenCacheKey(usuario);
    const cached = salasCache.get(key);

    if (salasVálidas(cached)) {
        return cached.salas;
    }

    const salas = await obterSalasRemoto(authToken);
    salasCache.set(key, { salas, expiresAt: Date.now() + SALAS_CACHE_TTL_MS });
    return salas;
}

// Limpa caches de um usuário (útil em caso de 401 durante a coleta de tarefas)
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
        tarefa.title ||
        tarefa.name ||
        tarefa.nome ||
        tarefa.task_title ||
        tarefa.activity_title ||
        tarefa.publication_title ||
        tarefa.statement_title ||
        tarefa.id ||
        "Sem nome"
    );
}

function resumirTarefas(tarefas) {
    return tarefas.map((tarefa) => ({
        id: tarefa.id || tarefa.task_id || tarefa.publication_id || tarefa._id,
        nome: obterNomeTarefa(tarefa),
        prazo:
            tarefa.expire_at ||
            tarefa.expired_at ||
            tarefa.due_date ||
            tarefa.deadline ||
            tarefa.end_date ||
            tarefa.apply_moment?.end_at
    }));
}

// ---------------------------------------------------------------------------
// Processamento por usuário
// ---------------------------------------------------------------------------

function detalhesErro(err) {
    if (err.response) {
        return { status: err.response.status, body: err.response.data };
    }
    return { message: err.message };
}

async function processarUsuario(usuario) {
    const identificador = usuario.nome || usuario.user;

    try {
        // 1. Auth com cache (faz login só se necessário)
        const { authToken, nick } = await obterAuthComCache(usuario);

        // 2. Salas com cache (reusa por até 30 min)
        const salas = await obterSalasComCache(usuario, authToken);

        // 3. Tarefas sequenciais — menos pico na API
        const pendentes = await obterTarefas(salas, nick, authToken, false);
        const expiradas = await obterTarefas(salas, nick, authToken, true);

        const pendentesResumo = resumirTarefas(pendentes);
        const expiradasResumo = resumirTarefas(expiradas);

        return {
            ok: true,
            linha: `${identificador}\nPENDENTES: ${pendentes.length}\nEXPIRADAS: ${expiradas.length}`,
            usuario: {
                id: usuario._id,
                nome: usuario.nome,
                email: usuario.email,
                user: usuario.user
            },
            nick,
            salas: salas.rooms?.length || 0,
            pendentesResumo,
            expiradasResumo,
            pendentes,
            expiradas,
            totais: { pendentes: pendentes.length, expiradas: expiradas.length }
        };
    } catch (err) {
        // Se 401, invalida cache para que na próxima tentativa ele relogue
        if (err.response?.status === 401) {
            invalidarCache(usuario);
        }

        const erro = detalhesErro(err);
        console.error(`ERRO: ${identificador}`, JSON.stringify(erro));
        console.error("");

        return {
            ok: false,
            linha: `${identificador}\nPENDENTES: -\nEXPIRADAS: -\nERRO`,
            usuario: {
                id: usuario._id,
                nome: usuario.nome,
                email: usuario.email,
                user: usuario.user
            },
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

    const fileName = `tarefas-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;
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
            acc.sucesso  += 1;
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
// WhatsApp – helpers de autorização
// ---------------------------------------------------------------------------

function normalizarWhatsappId(id) {
    if (!id) return "";
    return String(id).split("@")[0].split(":")[0].replace(/\D/g, "");
}

function idsDoParticipante(participante) {
    return [
        participante?.id?._serialized,
        participante?.id?.user,
        participante?.id?.server
            ? `${participante.id.user}@${participante.id.server}`
            : undefined
    ].filter(Boolean);
}

function remetentePodeUsarComando(chat, message, comando) {
    if (!chat.isGroup) return false;

    const remetente = message.author || message.from;
    const remetenteNormalizado = normalizarWhatsappId(remetente);
    const remetenteLiberado = REMETENTES_LIBERADOS.has(remetente);

    const participante = chat.participants.find((item) =>
        idsDoParticipante(item).some(
            (id) =>
                id === remetente ||
                normalizarWhatsappId(id) === remetenteNormalizado
        )
    );

    console.log(
        `Comando ${comando}:`,
        JSON.stringify({
            remetente,
            remetenteNormalizado,
            remetenteLiberado,
            participanteEncontrado: Boolean(participante),
            isAdmin: Boolean(participante?.isAdmin),
            isSuperAdmin: Boolean(participante?.isSuperAdmin)
        })
    );

    return Boolean(
        remetenteLiberado || participante?.isAdmin || participante?.isSuperAdmin
    );
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

    const tokensCached = tokenCache.size;
    const salasCached  = salasCache.size;

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
        `TOKENS EM CACHE: ${tokensCached}`,
        `SALAS EM CACHE: ${salasCached}`,
        `RELATORIO: ${gerandoRelatorio ? "gerando agora" : "livre"}`
    ].join("\n");
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

async function iniciarWhatsapp() {
    if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
        throw new Error(
            "CONCURRENCY precisa ser um numero inteiro maior que zero."
        );
    }

    await mongoose.connect(MONGO_URI);

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

    let gerandoRelatorio = false;

    client.on("qr", async (qr) => {
        const qrTerminal = await QRCode.toString(qr, {
            type: "terminal",
            small: true
        });
        console.log(qrTerminal);
        console.log("Escaneie o QR Code acima com o WhatsApp.");
    });

    client.on("ready", () => {
        console.log(
            "WhatsApp conectado. Aguardando /tarefas e /status em grupos."
        );
    });

    client.on("message", async (message) => {
        const comando = message.body.trim().toLowerCase();

        if (![TAREFAS_COMMAND, STATUS_COMMAND].includes(comando)) return;

        const chat = await message.getChat();

        if (!chat.isGroup) {
            await message.reply("Esse comando funciona apenas em grupos.");
            return;
        }

        if (!remetentePodeUsarComando(chat, message, comando)) {
            await message.reply(
                `Apenas admins do grupo podem usar ${comando}.`
            );
            return;
        }

        if (comando === STATUS_COMMAND) {
            try {
                const status = await gerarStatusBot(gerandoRelatorio);
                await chat.sendMessage(`\`\`\`\n${status}\n\`\`\``);
            } catch (err) {
                console.error("Falha ao gerar status:", detalhesErro(err));
                await message.reply("Nao consegui buscar o status agora.");
            }
            return;
        }

        if (gerandoRelatorio) {
            await message.reply(
                "Ja estou gerando um relatorio. Aguarde finalizar."
            );
            return;
        }

        gerandoRelatorio = true;

        try {
            await message.reply("Buscando tarefas....");
            const { mensagem } = await gerarRelatorioTarefas();
            await chat.sendMessage(mensagem);
        } catch (err) {
            console.error("Falha ao gerar relatorio:", detalhesErro(err));
            await message.reply("Nao consegui buscar as tarefas agora.");
        } finally {
            gerandoRelatorio = false;
        }
    });

    await client.initialize();
}

iniciarWhatsapp().catch(async (err) => {
    console.error("Falha geral:", detalhesErro(err));
    await mongoose.disconnect();
    process.exitCode = 1;
});