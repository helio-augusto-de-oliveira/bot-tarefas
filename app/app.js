const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://192.168.1.96:27017/jokersRA";
const USUARIOS_COLLECTION = process.env.USUARIOS_COLLECTION || "usuarios";
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
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

async function processarUsuario(usuario, tamanhoMaiorNome) {
    const identificador = usuario.nome || usuario.user;
    const nomeAlinhado = identificador.padEnd(tamanhoMaiorNome, " ");

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

        console.log(`${nomeAlinhado} | Pendentes: ${pendentes.length} | Expiradas: ${expiradas.length}\n`);

        return {
            ok: true,
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
            `ERRO: ${nomeAlinhado}`,
            JSON.stringify(erro)
        );
        console.error("");

        return {
            ok: false,
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

async function main() {
    try {
        if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
            throw new Error("CONCURRENCY precisa ser um numero inteiro maior que zero.");
        }

        await mongoose.connect(MONGO_URI);

        const totalNaCollection = await Usuario.collection.countDocuments();
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

        console.log(`Mongo DB: ${mongoose.connection.db.databaseName}`);
        console.log(`Collection: ${USUARIOS_COLLECTION}`);
        console.log(`Total na collection: ${totalNaCollection}`);
        console.log(`Usuarios com user e senha: ${usuarios.length}`);
        console.log(`Concorrencia: ${CONCURRENCY}`);

        const tamanhoMaiorNome = usuarios.reduce((maior, usuario) => {
            const identificador = usuario.nome || usuario.user;
            return Math.max(maior, identificador.length);
        }, 0);

        const resultados = await executarComConcorrencia(
            usuarios,
            CONCURRENCY,
            (usuario) => processarUsuario(usuario, tamanhoMaiorNome)
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

        console.log("\n=== RESUMO GERAL ===");
        console.log(`Usuarios com sucesso: ${resumo.sucesso}`);
        console.log(`Usuarios com erro: ${resumo.erros}`);
        console.log(`Pendentes: ${resumo.pendentes}`);
        console.log(`Expiradas: ${resumo.expiradas}`);
        console.log(`Arquivo salvo em: ${filePath}`);
    } catch (err) {
        console.error("Falha geral:", detalhesErro(err));
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

main();
