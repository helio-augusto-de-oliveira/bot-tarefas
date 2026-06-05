const axios = require('axios');

async function main() {
    try {
        // Login
        const loginResponse = await axios.post(
            'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken',
            {
                user: '00001109854377SP',
                senha: 'Jl041108_'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b'
                }
            }
        );

        const token = loginResponse.data.token;

        console.log('Token:', token);

        // Segunda requisição
        const tokenResponse = await axios.post(
            'https://edusp-api.ip.tv/registration/edusp/token',
            {
                token
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                    'Referer': 'https://saladofuturo.educacao.sp.gov.br/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
                    'x-api-platform': 'webclient',
                    'x-api-realm': 'edusp'
                }
            }
        );

        console.log("\n"+ tokenResponse.data.auth_token);

   const itens = await axios.get(
    "https://edusp-api.ip.tv/room/user?list_all=true&with_cards=true",
    {
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": "https://saladofuturo.educacao.sp.gov.br",
            "Referer": "https://saladofuturo.educacao.sp.gov.br/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
            "x-api-key": tokenResponse.data.auth_token
        }
    }
);

const data = itens.data;
const nickname = tokenResponse.data.nick;

function gerarUrlTarefas(data, nickname) {
    const params = new URLSearchParams({
        expired_only: "false",
        limit: "100",
        offset: "0",
        filter_expired: "true",
        is_exam: "false",
        with_answer: "true",
        is_essay: "false",
        answer_statuses: "draft",
        with_apply_moment: "true"
    });

    for (const room of data.rooms || []) {
        // publication_target=rxxxx
        params.append("publication_target", room.name);

        // publication_target=rxxxx:nickname
        params.append(
            "publication_target",
            `${room.name}:${nickname}`
        );

        // publication_target=1931, 1698, etc
        for (const category of room.group_categories || []) {
            params.append(
                "publication_target",
                String(category.id)
            );
        }
    }

    return `https://edusp-api.ip.tv/tms/task/todo?${params.toString()}`;
}

function gerarUrlTarefasExpiradas(data, nickname) {
    const params = new URLSearchParams({
        expired_only: "true",
        limit: "100",
        offset: "0",
        filter_expired: "false",
        is_exam: "false",
        with_answer: "true",
        is_essay: "false",
        answer_statuses: "draft",
        with_apply_moment: "true"
    });

    for (const room of data.rooms || []) {
        // rxxxx
        params.append("publication_target", room.name);

        // rxxxx:nickname
        params.append(
            "publication_target",
            `${room.name}:${nickname}`
        );

        // ids das categorias
        for (const category of room.group_categories || []) {
            params.append(
                "publication_target",
                category.id.toString()
            );
        }
    }

    return `https://edusp-api.ip.tv/tms/task/todo?${params.toString()}`;
}

// Exemplo:
const url = gerarUrlTarefas(itens.data, nickname);

//console.log(url);
    const getTarefasPendentes = await axios.get(
        url,
        {
            headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": "https://saladofuturo.educacao.sp.gov.br",
            "Referer": "https://saladofuturo.educacao.sp.gov.br/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
            "x-api-key": tokenResponse.data.auth_token
            }
        }
    )

    console.log(getTarefasPendentes.data.length)
    const urlExpiradas = gerarUrlTarefasExpiradas(itens.data, nickname);
    const getTarefasExpiradas = await axios.get(
        urlExpiradas,
        {
            headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": "https://saladofuturo.educacao.sp.gov.br",
            "Referer": "https://saladofuturo.educacao.sp.gov.br/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
            "x-api-key": tokenResponse.data.auth_token
            }
        }
    )

    console.log(getTarefasExpiradas.data.length)

    } catch (err) {
        if (err.response) {
            console.log('Status:', err.response.status);
            console.log('Headers:', err.response.headers);
            console.log('Body:', err.response.data);
        } else {
            console.error(err);
        }
    }
}



main();