const axios = require("axios");

// =========================
// CONFIGURAÇÃO
// =========================

const USER = "00001109854377SP";
const SENHA = "Jl041108_";

const SUBSCRIPTION_KEY =
    "d701a2043aa24d7ebb37e9adf60d043b";

// =========================
// LOGIN SED
// =========================

async function fazerLogin() {
    const { data } = await axios.post(
        "https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken",
        {
            user: USER,
            senha: SENHA
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

// =========================
// TOKEN CMSP
// =========================

async function obterAuth(token) {
    const { data } = await axios.post(
        "https://edusp-api.ip.tv/registration/edusp/token",
        {
            token
        },
        {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin":
                    "https://saladofuturo.educacao.sp.gov.br",
                "Referer":
                    "https://saladofuturo.educacao.sp.gov.br/",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
                "x-api-platform": "webclient",
                "x-api-realm": "edusp"
            }
        }
    );

    return data;
}

// =========================
// HEADERS PADRÃO
// =========================

function criarHeaders(authToken) {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin":
            "https://saladofuturo.educacao.sp.gov.br",
        "Referer":
            "https://saladofuturo.educacao.sp.gov.br/",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
        "x-api-key": authToken
    };
}

// =========================
// SALAS
// =========================

async function obterSalas(authToken) {
    const { data } = await axios.get(
        "https://edusp-api.ip.tv/room/user?list_all=true&with_cards=true",
        {
            headers: criarHeaders(authToken)
        }
    );

    return data;
}

// =========================
// URL DE TAREFAS
// =========================

function gerarUrlTarefas(
    salas,
    nickname,
    expiradas = false
) {
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
        // sala
        params.append(
            "publication_target",
            room.name
        );

        // sala:nickname
        params.append(
            "publication_target",
            `${room.name}:${nickname}`
        );

        // categorias
        for (const category of room.group_categories || []) {
            params.append(
                "publication_target",
                category.id.toString()
            );
        }
    }

    return `https://edusp-api.ip.tv/tms/task/todo?${params.toString()}`;
}

// =========================
// BUSCAR TAREFAS
// =========================

async function obterTarefas(
    salas,
    nickname,
    authToken,
    expiradas = false
) {
    const url = gerarUrlTarefas(
        salas,
        nickname,
        expiradas
    );

    const { data } = await axios.get(url, {
        headers: criarHeaders(authToken)
    });

    return data;
}

// =========================
// ERROS
// =========================

function tratarErro(err) {
    if (err.response) {
        console.error("\n=== ERRO API ===");
        console.error("Status:", err.response.status);
        console.error("Body:", err.response.data);
        return;
    }

    console.error(err);
}

// =========================
// MAIN
// =========================

async function main() {
    try {
        console.log("Fazendo login...");

        const token = await fazerLogin();

        console.log("Obtendo auth_token...");

        const auth = await obterAuth(token);

        console.log("Obtendo salas...");

        const salas = await obterSalas(
            auth.auth_token
        );

        console.log(
            `Salas encontradas: ${salas.rooms.length}`
        );

        console.log("Buscando tarefas pendentes...");

        const tarefasPendentes =
            await obterTarefas(
                salas,
                auth.nick,
                auth.auth_token,
                false
            );

        console.log("Buscando tarefas expiradas...");

        const tarefasExpiradas =
            await obterTarefas(
                salas,
                auth.nick,
                auth.auth_token,
                true
            );

        console.log("\n=== RESUMO ===");
        console.log(
            `Pendentes: ${tarefasPendentes.length}`
        );
        console.log(
            `Expiradas: ${tarefasExpiradas.length}`
        );

        // Caso queira inspecionar:
        // console.log(tarefasPendentes);
        // console.log(tarefasExpiradas);
    } catch (err) {
        tratarErro(err);
    }
}

main();