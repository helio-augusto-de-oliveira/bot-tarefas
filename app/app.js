const { request } = require('undici');

async function main() {
    // Login
    const loginResponse = await request(
        'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b'
            },
            body: JSON.stringify({
                user: '1105904982sp',
                senha: '@Helio1970@'
            })
        }
    );

    const loginData = await loginResponse.body.json();

    const token = loginData.token;

    console.log('Token:', token);

    // Segunda requisição
    const tokenResponse = await request(
        'https://edusp-api.ip.tv/registration/edusp/token',
        {
            method: 'POST',
            headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': 'https://saladofuturo.educacao.sp.gov.br',
    'Referer': 'https://saladofuturo.educacao.sp.gov.br/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
    'x-api-platform': 'webclient',
    'x-api-realm': 'edusp'
},
            body: JSON.stringify({
                token
            })
        }
    );
    
const data = await tokenResponse.body.json();
console.log(data);
}

main().catch(console.error);