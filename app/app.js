const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const MONGO_URI = process.env.MONGO_URI || "mongodb://192.168.1.96:27017/jokersRA";
const USUARIOS_COLLECTION = process.env.USUARIOS_COLLECTION || "usuarios";
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const TAREFAS_COMMAND = "/tarefas";
const STATUS_COMMAND = "/status";
const REMETENTES_LIBERADOS = new Set([
    "162247355711521@lid",
    "157058481537162@lid",
    "139109729312833@lid"
]);
const SUBSCRIPTION_KEY =
    process.env.SUBSCRIPTION_KEY || "d701a2043aa24d7ebb37e9adf60d043b";

const api = axios.create({
    timeout: 30000
});

const UsuarioSchema = new mongoose.Schema({
    nome: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    user: {
        type: String,
        required: true,
        unique: true
    },
    senha: {
        type: String,
        required: true
    }
});

const Usuario = mongoose.model("usuarios", UsuarioSchema, USUARIOS_COLLECTION);

async function fazerLogin(user, senha) {
    const { data } = await api.post(
        "https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken",
        {
            user,
            senha
        },
        {
            headers: {
                "Content-Type": "application/json",
                "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY
            }
        }
    );

    return data.token;
}

async function obterAuth(token) {
    const { data } = await api.post(
        "https://edusp-api.ip.tv/registration/edusp/token",
        {
            token
        },
        {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": "https://saladofuturo.educacao.sp.gov.br",
                "Referer": "https://saladofuturo.educacao.sp.gov.br/",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
                "x-api-platform": "webclient",
                "x-api-realm": "edusp"
            }
        }
    );

    return data;
}

function criarHeaders(authToken) {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://saladofuturo.educacao.sp.gov.br",
        "Referer": "https://saladofuturo.educacao.sp.gov.br/",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
        "x-api-key": authToken
    };
}

async function obterSalas(authToken) {
    const { data } = await api.get(
        "https://edusp-api.ip.tv/room/user?list_all=true&with_cards=true",
        {
            headers: criarHeaders(authToken)
        }
    );

    return data;
}

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

    const { data } = await api.get(url, {
        headers: criarHeaders(authToken)
    });

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

function detalhesErro(err) {
    if (err.response) {
        return {
            status: err.response.status,
            body: err.response.data
        };
    }

    return {
        message: err.message
    };
}

async function processarUsuario(usuario) {
    const identificador = usuario.nome || usuario.user;

    try {
        const token = await fazerLogin(usuario.user, usuario.senha);
        const auth = await obterAuth(token);
        const salas = await obterSalas(auth.auth_token);

        const [pendentes, expiradas] = await Promise.all([
            obterTarefas(salas, auth.nick, auth.auth_token, false),
            obterTarefas(salas, auth.nick, auth.auth_token, true)
        ]);
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
            nick: auth.nick,
            salas: salas.rooms?.length || 0,
            pendentesResumo,
            expiradasResumo,
            pendentes,
            expiradas,
            totais: {
                pendentes: pendentes.length,
                expiradas: expiradas.length
            }
        };
    } catch (err) {
        const erro = detalhesErro(err);

        console.error(
            `ERRO: ${identificador}`,
            JSON.stringify(erro)
        );
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
        {
            user: { $exists: true, $ne: "" },
            senha: { $exists: true, $ne: "" }
        },
        {
            nome: 1,
            email: 1,
            user: 1,
            senha: 1
        }
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
            if (!item.ok) {
                acc.erros += 1;
                return acc;
            }

            acc.sucesso += 1;
            acc.pendentes += item.totais.pendentes;
            acc.expiradas += item.totais.expiradas;
            return acc;
        },
        {
            sucesso: 0,
            erros: 0,
            pendentes: 0,
            expiradas: 0
        }
    );

    const filePath = await salvarResultado({
        geradoEm: new Date().toISOString(),
        resumo,
        resultados
    });

    console.log(`Arquivo salvo em: ${filePath}`);

    return {
        mensagem: montarMensagem(resultados),
        resumo,
        filePath
    };
}

function normalizarWhatsappId(id) {
    if (!id) {
        return "";
    }

    return String(id)
        .split("@")[0]
        .split(":")[0]
        .replace(/\D/g, "");
}

function idsDoParticipante(participante) {
    return [
        participante?.id?._serialized,
        participante?.id?.user,
        participante?.id?.server ? `${participante.id.user}@${participante.id.server}` : undefined
    ].filter(Boolean);
}

function remetentePodeUsarComando(chat, message, comando) {
    if (!chat.isGroup) {
        return false;
    }

    const remetente = message.author || message.from;
    const remetenteNormalizado = normalizarWhatsappId(remetente);
    const remetenteLiberado = REMETENTES_LIBERADOS.has(remetente);
    const participante = chat.participants.find((item) =>
        idsDoParticipante(item).some((id) => {
            return id === remetente || normalizarWhatsappId(id) === remetenteNormalizado;
        })
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
        remetenteLiberado ||
            participante?.isAdmin ||
            participante?.isSuperAdmin
    );
}

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
        `RELATORIO: ${gerandoRelatorio ? "gerando agora" : "livre"}`
    ].join("\n");
}

async function iniciarWhatsapp() {
    if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
        throw new Error("CONCURRENCY precisa ser um numero inteiro maior que zero.");
    }

    await mongoose.connect(MONGO_URI);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: "joker-tarefas"
        }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        }
    });

    let gerandoRelatorio = false;

    client.on("qr", async (qr) => {
        const qrTerminal = await QRCode.toString(qr, { type: "terminal", small: true });
        console.log(qrTerminal);
        console.log("Escaneie o QR Code acima com o WhatsApp.");
    });

    client.on("ready", () => {
        console.log("WhatsApp conectado. Aguardando /tarefas e /status em grupos.");
    });

    client.on("message", async (message) => {
        const comando = message.body.trim().toLowerCase();

        if (![TAREFAS_COMMAND, STATUS_COMMAND].includes(comando)) {
            return;
        }

        const chat = await message.getChat();

        if (!chat.isGroup) {
            await message.reply("Esse comando funciona apenas em grupos.");
            return;
        }

        if (!remetentePodeUsarComando(chat, message, comando)) {
            await message.reply(`Apenas admins do grupo podem usar ${comando}.`);
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
            await message.reply("Ja estou gerando um relatorio. Aguarde finalizar.");
            return;
        }

        gerandoRelatorio = true;

        try {
            await message.reply("Buscando tarefas...");
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
