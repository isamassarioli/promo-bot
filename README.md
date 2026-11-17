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
| `!fonte add <id>` / `rm` | grupos de onde as promoções são **captadas** (aceita vários IDs de uma vez, em `!destino` também) |
| `!promo <texto>` | envia uma promoção manual (pode ser legenda de foto) |
| `!status` | fila e estatísticas |
| `!relatorio` | relatório do dia até agora |
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
promoções de lojas sem regra (exceto as enviadas com `!promo`, que são sempre aceitas — use para links
gerados no app, como os do TikTok Shop).

`"dealPages": ["ofertaesperta.com"]`: sites agregadores cujo link leva para uma página deles, e não para a loja.
O bot abre essa página, pega o link da loja que tem regra (ex. Amazon) e troca a tag pela sua.

Shopee e Mercado Livre só geram link de afiliado pelo painel/API deles:
sem uma regra, o link original é mantido — use `"drop"` se não quiser repassar link de terceiros.

## Outros ajustes

- `filters`: `blockedKeywords`, `requiredKeywords`, `minDiscountPercent`, `maxPrice` (0 = desligado).
- `sending`: `minIntervalSeconds` entre promoções, `delayBetweenGroupsSeconds` [mín, máx], `quietHours`,
  `maxPromoAgeMinutes` (promoção velha na fila é descartada), `dedupeHours`.
- `rssFeeds`: `{ name, url, intervalSeconds }`. Na primeira leitura o histórico é ignorado.
  Opcional: `priorityCategories` (passam na frente da fila) e `skipCategories` (ignoradas), pelo nome da categoria do feed.

## Relatório diário e alertas

Todo dia às 8h o bot manda para os números em `"notify"` (ou, se vazio, para os `"admins"`) um resumo das
últimas 24h: ofertas captadas e enviadas, membros do grupo e gasto da IA. Também avisa quando um feed
fica 1h sem responder, quando passam 3h sem nenhum envio, quando a IA fica sem crédito ou com a chave
inválida, quando o grupo passa de 950 membros e quando o WhatsApp volta depois de cair. Cada alerta
se repete no máximo a cada 6h.

```json
"admins": ["5511999999999", "5511988888888"],
"notify": ["5511988888888"]
```

## Mensagens com IA (opcional)

Com `"ai": { "enabled": true, "model": "claude-haiku-5-5" }` no `config.json`, cada oferta ganha um texto
escrito pelo Claude a partir do título, preço e descrição da página do produto. O link de afiliado e o
rodapé continuam sendo colocados pelo bot. Se a IA falhar, citar um preço que não está nos dados ou
colocar um link, o bot usa o formato padrão.

Crie a chave em console.anthropic.com e coloque num arquivo `.env` (veja `.env.example`):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Depois: `docker compose up -d --build`. O bot também busca a foto do produto na página quando a oferta não traz uma.

## Avisos

- Usa a biblioteca não oficial Baileys (WhatsApp Web). O WhatsApp pode **banir** números com automação:
  use um chip dedicado, mantenha os intervalos e envie só para grupos seus, com membros que entraram por vontade própria.
- Respeite os termos dos programas de afiliados e identifique os links como de afiliado quando exigido.

## Testes

```bash
npm test
```
