# promo-bot

Capta promoções, troca os links pelos **seus links de afiliado** e envia para os **seus grupos de WhatsApp**.

```
Fontes                         Tratamento                          Envio
──────                         ──────────                          ─────
Grupos de WhatsApp (fonte) ─┐  filtros (palavras, desconto, preço) fila com intervalo
Feeds RSS de sites de oferta ┼→ expande encurtadores + afiliado  →  pausa entre grupos  → seus grupos
!promo (manual)            ─┘  remove convites de outros grupos    horário de silêncio
                               deduplicação (48h)
```

## Instalação

Requer Node.js 20+.

```bash
npm install
```

```bash
cp config.example.json config.json
```

Edite `config.json` (seu número em `admins`, regras de afiliado, feeds) e inicie:

```bash
npm start
```

Escaneie o QR code (WhatsApp > Aparelhos conectados). A sessão fica em `data/auth`.

Para testar captação/formatação sem WhatsApp (as mensagens saem no terminal):

```bash
npm run dry-run
```

## Rodando com Docker

Com o Docker Desktop instalado, dentro da pasta do projeto:

```bash
cp config.example.json config.json
```

Edite o `config.json` e suba o bot:

```bash
docker compose up -d --build
```

Veja o QR code (e depois os logs) com:

```bash
docker compose logs -f promo-bot
```

A sessão do WhatsApp fica em `data/` e sobrevive a reinícios. Outros comandos:

- testar sem WhatsApp: `docker compose run --rm teste`
- reiniciar depois de mudar o `config.json`: `docker compose restart promo-bot`
- atualizar o código: `git pull && docker compose up -d --build`
- parar: `docker compose down`

## Configurando os grupos

Mande os comandos **no privado do número do bot** (a partir de um número em `admins`, ou na conversa "você mesmo"):

| Comando | O que faz |
|---|---|
| `!grupos` | lista os grupos em que o número está, com os IDs |
| `!destino add <id>` / `rm` | grupos que **recebem** promoções |
| `!fonte add <id>` / `rm` | grupos de onde as promoções são **captadas** |
| `!promo <texto>` | envia uma promoção manual (pode ser legenda de foto) |
| `!status` | fila e estatísticas |
| `!pausar` / `!retomar` | pausa/retoma os envios |

## Regras de afiliado (`affiliate.rules`)

Cada regra vale para um domínio (e subdomínios):

| Campo | Efeito |
|---|---|
| `clearParams` | remove todos os parâmetros (tira a tag de quem postou) |
| `removeParams` | remove parâmetros específicos |
| `setParams` | define parâmetros, ex. `{ "tag": "seutag-20" }` (Amazon) |
| `replaceHost`, `prefixPath`, `replacePath` | reescrevem host/caminho (ex. Magazine Você) |
| `template` | deep link de rede de afiliados (Awin, Lomadee...); `{url}` é a URL do produto |

Links encurtados (amzn.to, bit.ly, shope.ee...) são expandidos antes. `"unknownLinks": "drop"` descarta
promoções de lojas sem regra.

`"dealPages": ["ofertaesperta.com"]`: sites agregadores cujo link leva para uma página deles, e não para a loja.
O bot abre essa página, pega o link da loja que tem regra (ex. Amazon) e troca a tag pela sua.

Shopee e Mercado Livre só geram link de afiliado pelo painel/API deles:
sem uma regra, o link original é mantido — use `"drop"` se não quiser repassar link de terceiros.

## Outros ajustes

- `filters`: `blockedKeywords`, `requiredKeywords`, `minDiscountPercent`, `maxPrice` (0 = desligado).
- `sending`: `minIntervalSeconds` entre promoções, `delayBetweenGroupsSeconds` [mín, máx], `quietHours`,
  `maxPromoAgeMinutes` (promoção velha na fila é descartada), `dedupeHours`.
- `rssFeeds`: `{ name, url, intervalSeconds }`. Na primeira leitura o histórico é ignorado.

## Avisos

- Usa a biblioteca não oficial Baileys (WhatsApp Web). O WhatsApp pode **banir** números com automação:
  use um chip dedicado, mantenha os intervalos e envie só para grupos seus, com membros que entraram por vontade própria.
- Respeite os termos dos programas de afiliados e identifique os links como de afiliado quando exigido.

## Testes

```bash
npm test
```
