# Deploy no Dokploy

Use o arquivo `docker-compose.dokploy.yml` no Dokploy.

## Variaveis

Configure estas variaveis no painel do app:

```env
MONGO_URI=mongodb://usuario:senha@host:27017/jokersRA
SUBSCRIPTION_KEY=sua_chave
USUARIOS_COLLECTION=usuarios
CONCURRENCY=5
REMETENTES_LIBERADOS=162247355711521@lid
```

Se tiver mais remetentes liberados, separe por virgula:

```env
REMETENTES_LIBERADOS=162247355711521@lid,157058481537162@lid,139109729312833@lid
```

## WhatsApp

Na primeira inicializacao, abra os logs do container no Dokploy e escaneie o QR Code exibido.

A sessao fica salva no volume `joker_whatsapp_auth`, entao o QR Code nao deve ser pedido novamente a cada redeploy normal.

## Comandos

No grupo do WhatsApp:

```text
/status
/tarefas
```

Os comandos funcionam para admins do grupo e para IDs definidos em `REMETENTES_LIBERADOS`.
