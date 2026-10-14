# Bolão do Perico

O Perico sempre chega atrasado. A galera aposta em que horário ele vai bater o ponto.

Uma página só, HTML/CSS/JS puro no front, Node + Express + SQLite no back. Todas as
regras de prazo e o cálculo do vencedor rodam **no servidor**, com o relógio do
servidor no fuso `America/Sao_Paulo`. O navegador só desenha.

## As regras

**Quem é quem.** Não tem login nem senha: o nome é a identificação. A tela inicial pede
só o nome — se ele já existe, você entra como essa pessoa; se não existe, é criado. O
mesmo nome funciona em qualquer computador. Nomes são comparados ignorando maiúsculas,
minúsculas e espaços nas pontas, então `ana` e ` Ana ` entram na mesma Ana. O navegador
lembra o nome no `localStorage` para não perguntar toda vez, e o botão **Sair** esquece.
**Não existe jeito de trocar de nome** — nenhuma tela, nenhum endpoint.

A contrapartida de não ter senha: quem souber seu nome pode apostar por você. Num bolão
entre colegas isso é aceitável; se deixar de ser, o próximo passo é uma senha por nome.

**A aposta.** Um horário `HH:MM` para uma data. Uma aposta por pessoa por dia, e ela
nunca muda nem some: o banco garante isso com `UNIQUE (user_id, bet_date)` e a API não
tem rota de edição nem de remoção.

**Os prazos.**

| Quando | Dá para apostar? |
| --- | --- |
| Dia atual, antes das 10:00 e sem chegada registrada | sim |
| Dia atual, 10:00 em diante | não |
| Dia atual, depois que o admin registra a chegada | não |
| Qualquer data futura | sim |
| Qualquer data passada | não |

**O sigilo.** As apostas de um dia só ficam visíveis depois das 10:00 daquele dia —
antes disso ninguém copia o palpite de ninguém. Até lá a tela mostra só *quantas*
apostas já entraram. Se o admin registrar a chegada antes das 10:00, as apostas do dia
fecham e tudo aparece na hora: a chegada, as apostas e o vencedor.

**O vencedor.** Ganha a aposta mais próxima do horário real que seja **igual ou
posterior** a ele. Quem apostou antes está eliminado, porque o tempo não volta para
trás.

> Perico chegou 08:56. Quem apostou 08:55 perdeu; quem apostou 08:57 ganhou.

Empate no horário vencedor: todos ganham. Se todas as apostas forem anteriores à
chegada, o dia fica sem vencedor. O bolão do dia encerra ao meio-dia — se até lá não
houver chegada registrada, o dia também fica sem vencedor.

**Os pontos.** Quem ganha o dia pontua:

| Como ganhou | Pontos | Na lista do dia |
| --- | --- | --- |
| Apostou exatamente o horário da chegada | 2 | NA MOSCA +2 |
| Aposta posterior mais próxima da chegada | 1 | GANHOU +1 |

Empate no horário vencedor: cada empatado leva a pontuação cheia, sem dividir.

**O ranking.** Ordenado por pontos; empate em pontos vai para quem tem mais vitórias e,
persistindo, para quem fez **menos** apostas. Só entra quem já fez ao menos uma aposta
— quem só escolheu o nome e nunca apostou fica de fora. Os pontos saem das apostas e
das chegadas registradas a cada consulta, então os dias que já passaram aparecem
pontuados sem nenhuma migração.

**O resultado.** O horário de chegada é registrado na área de admin, protegida pela
senha em `ADMIN_PASSWORD`. O admin pode corrigir um horário já registrado (erro de
digitação acontece) e não pode registrar a chegada de um dia que ainda não aconteceu.

## Rodando local

Precisa de Node 20.12 ou mais novo (é a versão em que o Node passou a ler
`.env` sozinho).

```bash
npm install
cp .env.example .env     # e troque a senha lá dentro
npm start
```

Abra <http://localhost:3000>. Sem `ADMIN_PASSWORD` o site funciona normalmente, mas a
área de admin recusa qualquer registro de chegada — o servidor avisa isso no arranque.

Se preferir não usar arquivo, passe pelo ambiente:

```bash
ADMIN_PASSWORD=escolha-uma-senha npm start
```

```powershell
$env:ADMIN_PASSWORD = "escolha-uma-senha"
npm start
```

### Variáveis de ambiente

O servidor carrega o `.env` da raiz no arranque, se existir. Variáveis já presentes no
ambiente vencem as do arquivo — em produção o provedor injeta a senha direto e não há
`.env` nenhum. O `.env` está no `.gitignore`; o `.env.example` serve de modelo.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `ADMIN_PASSWORD` | *(vazio)* | Senha da área de admin. Vazia desativa o registro de chegada. |
| `PORT` | `3000` | Porta HTTP. Ignorada na Vercel. |
| `TURSO_DATABASE_URL` | *(vazio)* | Banco hospedado no Turso. Definida, tem prioridade sobre `DB_FILE`. |
| `TURSO_AUTH_TOKEN` | *(vazio)* | Token do banco do Turso. |
| `DB_FILE` | `./data/bolao.db` | Arquivo local, usado só quando não há `TURSO_DATABASE_URL`. A pasta é criada sozinha. |

Sem `TURSO_DATABASE_URL` o app usa um arquivo local — é assim que se desenvolve, sem
depender da rede. Com ela, fala com o Turso. O mesmo código serve aos dois.

### Scripts

```bash
npm start              # sobe o servidor
npm run dev            # sobe com --watch, reinicia ao salvar
npm test               # roda os testes
npm run migrate        # cria as tabelas no banco apontado pelo ambiente
npm run seed           # popula um bolão de brincadeira para olhar a tela
npm run seed -- --force  # apaga o que tem e popula de novo
```

## Testes

```bash
npm test
```

São 73 testes em dois arquivos, rodando no runner nativo do Node — sem framework.

`test/rules.test.js` cobre a lógica pura: o exemplo do enunciado, aposta exatamente no
horário de chegada, empates, dia em que todas as apostas vieram antes da chegada, dia
sem apostas, independência da ordem da lista, a pontuação (acerto exato vale 2, vitória
por proximidade vale 1, empatados levam a pontuação cheia), a ordem do ranking com seus
desempates, conversões de horário, datas de calendário
e a conversão para o fuso de São Paulo (incluindo o caso em que 02:00 UTC ainda é o dia
anterior em São Paulo).

`test/api.test.js` sobe o app de verdade com banco em memória e **relógio injetado**,
e testa as regras ponta a ponta: o corte das 10:00 no segundo exato, data passada
bloqueada a qualquer hora, data futura liberada a qualquer hora, aposta única por dia
(inclusive duas requisições simultâneas), apostas escondidas antes das 10:00, chegada
registrada cedo que fecha as apostas e revela o dia, encerramento ao meio-dia sem registro, senha
de admin, e o ranking. Do lado do usuário: nome novo cria, nome existente entra (sem
caixa, sem espaço nas pontas, com acento composto ou decomposto), duas entradas
simultâneas com o mesmo nome novo, nome desconhecido que não aposta, e um banco no
formato antigo, com tokens, cujos usuários e apostas continuam valendo.

O relógio injetado é o que torna isso testável: `createApp()` recebe um `clock`, então
os testes andam para as 09:59:59 e para as 10:00:00 sem esperar o dia amanhecer.

## Como está organizado

```
public/            index.html, style.css, script.js — front sem framework e sem build
src/rules.js       regras puras: prazos, vencedor, ranking, fuso
src/db.js          schema e acesso ao banco (libSQL)
src/app.js         API HTTP e serviço dos estáticos
src/boot.js        montagem de store + app a partir do ambiente
src/server.js      ponto de entrada local (app.listen)
api/index.js       ponto de entrada na Vercel (exporta o app)
vercel.json        configuração de deploy
scripts/migrate.js cria as tabelas
scripts/seed.js    dados de brincadeira para desenvolvimento
test/              testes
```

`src/rules.js` não lê o relógio nem toca no banco — recebe o "agora" de quem chama e
devolve a decisão. É por isso que ele é testável inteiro sem subir nada.

### API

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/api/session` | Quem é você (pelo header `x-bolao-usuario`) e que horas são no servidor. |
| `POST` | `/api/users` | Entra com um nome: `200` se já existia, `201` se foi criado. Devolve o nome como está gravado. |

Quem pede se identifica pelo header `x-bolao-usuario`, com o nome passado por
`encodeURIComponent` (header HTTP não carrega qualquer letra). Nome que não existe não é
criado pelo caminho: só `POST /api/users` cria usuário.
| `GET` | `/api/day?date=AAAA-MM-DD` | O retrato do dia: sua aposta, as dos outros (se já liberadas), chegada e vencedor. |
| `POST` | `/api/bets` | Registra sua aposta do dia. |
| `GET` | `/api/ranking` | Pontos, vitórias e total de apostas por pessoa, já ordenado. |
| `POST` | `/api/admin/result` | Registra a chegada do Perico (exige a senha). |

Erros vêm como `{ "error": { "code": "...", "message": "..." } }`, com a mensagem já
em português e pronta para aparecer na tela.

## Deploy

O banco tem duas configurações, escolhidas por variável de ambiente: arquivo local
(padrão, para desenvolver) ou **Turso** quando `TURSO_DATABASE_URL` está definida. O
mesmo código serve aos dois — o Turso é um fork do SQLite, então o SQL é idêntico.

Essa dualidade existe por um motivo prático: **nenhum host grátis oferece disco
persistente hoje.** A Vercel não tem; o plano free do Render também não, e lá o
filesystem é zerado a cada redeploy, reinício ou hibernação. Tirar o banco do disco é
o preço do "grátis".

### Vercel + Turso — o caminho grátis

**1. Crie o banco no Turso.** Pelo painel em [turso.tech](https://turso.tech): crie o
banco, copie a URL (`libsql://...`) e gere um token na página dele. Pelo terminal, se
você tiver Mac, Linux ou WSL (a CLI não roda no Windows puro):

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
turso db create bolao-perico
turso db show bolao-perico --url      # -> TURSO_DATABASE_URL
turso db tokens create bolao-perico   # -> TURSO_AUTH_TOKEN
```

**2. Crie as tabelas**, uma vez só. Ponha os dois valores no seu `.env` e rode:

```bash
npm run migrate
```

O app cria o schema sozinho no primeiro acesso, mas rodar isso agora avisa na hora se
a URL ou o token estiverem errados — melhor descobrir aqui do que às 08:25.

**3. Publique:**

```bash
npm i -g vercel
vercel                                    # primeiro deploy, cria o projeto
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
vercel env add ADMIN_PASSWORD production
vercel --prod
```

Não precisa definir `PORT` nem `DB_FILE` — a Vercel cuida da porta, e o `DB_FILE` só
vale quando não há Turso.

#### O que o `vercel.json` faz

```json
{
  "framework": null,
  "outputDirectory": "public",
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

As três linhas resolvem um problema cada:

- **`framework: null`** desliga a auto-detecção de Express da Vercel. Ela procura um
  arquivo chamado `app`, `index` ou `server` na raiz ou em `src/` que exporte um app —
  e encontraria `src/app.js`, que exporta `{ createApp }`, um export *nomeado*. O build
  quebraria com um erro confuso. Desligada, só o que está configurado é construído.
- **`outputDirectory: "public"`** garante que a CDN sirva apenas `public/`. Sem isso a
  raiz do repositório seria candidata a estático, expondo `package.json` e `src/`.
- **O rewrite** manda para a função tudo que não for um arquivo de `public/`. A Vercel
  checa o filesystem antes dos rewrites, então `/` e `/style.css` saem da CDN e só as
  rotas de API chegam ao Express.

### Alternativas

**Fly.io, ~US$ 2/mês** — se pagar uns trocados não for problema, é o caminho mais
simples: uma máquina com volume, sem Turso, sem serverless. Defina `DB_FILE=/data/bolao.db`,
monte o volume em `/data` e mantenha **uma instância só** (`fly scale count 1`). Duas
instâncias com dois arquivos viram dois bolões diferentes.

```toml
[env]
  DB_FILE = "/data/bolao.db"

[mounts]
  source = "bolao_data"
  destination = "/data"
```

**Render free** — funciona, mas precisa do Turso do mesmo jeito (não tem disco no plano
grátis) **e** hiberna após 15 minutos parado, levando cerca de um minuto para acordar.
Num app cujo prazo fecha às 10:00, quem chegar primeiro às 09:55 espera esse minuto.
É estritamente pior que a Vercel aqui.

**VM com Docker** — grátis de verdade numa máquina Always Free (Oracle Cloud, por
exemplo), e sem migração nenhuma: usa o arquivo SQLite direto.

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_FILE=/data/bolao.db
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t bolao-perico .
docker run -d --name bolao -p 3000:3000 -v bolao_data:/data   -e ADMIN_PASSWORD=escolha-uma-senha bolao-perico
```

Ponha um proxy na frente (Caddy ou Nginx) para o HTTPS — a senha de admin viaja no
corpo da requisição, e em HTTP puro numa rede aberta ela vai às claras.

### Backup

No Turso, o plano grátis guarda 1 dia de point-in-time restore. Para levar uma cópia
para casa:

```bash
turso db shell bolao-perico .dump > bolao-$(date +%F).sql
```

Com arquivo local, use o backup online do SQLite em vez de copiar o arquivo (tem WAL):

```bash
sqlite3 /data/bolao.db ".backup '/data/bolao-$(date +%F).db'"
```

## Decisões que valem explicar

**Por que o relógio do servidor.** O prazo das 10:00 é a única coisa que separa um
palpite de um chute com resposta na mão. Relógio de navegador se muda em dois cliques,
então nenhuma validação depende dele. O front recebe o instante do servidor em toda
resposta, mede a diferença e usa isso só para animar a contagem regressiva.

**Por que registrar a chegada fecha as apostas.** O admin registra a chegada assim que
o Perico aparece. A partir daí todo mundo no escritório já sabe a resposta, então deixar
apostar até as 10:00 só premiaria quem apostasse por último. Registrou, fechou — e, sem
nada mais para esconder, a chegada, as apostas e o vencedor aparecem na hora.

**Por que o ranking é calculado na hora.** Não existe tabela de vitórias. O vencedor sai
das apostas e do horário de chegada toda vez que alguém pede o ranking. Assim uma
correção de horário pelo admin se reflete em tudo na mesma hora, sem recalcular nada
guardado.

**Por que o front mora em `public/`.** O Express serve essa pasta e só ela, então
`package.json`, `src/` e `node_modules/` ficam fora de alcance. Na Vercel a mesma
pasta é o `outputDirectory`, servida pela CDN — os estáticos nem chegam a invocar a
função.

**Por que tudo em `src/db.js` é assíncrono.** Com o banco em arquivo dava para ser
síncrono, e era. Com o Turso o banco está do outro lado da rede, então as consultas
viraram `async` — e `describeDay()` dispara em paralelo, com `Promise.all`, as quatro
que não dependem umas das outras. Serializá-las custaria quatro idas e voltas em vez
de uma.

**Por que a migração não encostou nas regras.** `src/rules.js` não lê o relógio nem
toca no banco, então trocar o banco inteiro não mudou uma linha dele — e os 28 testes
de `test/rules.test.js` passaram sem alteração. Foi o que tornou a troca barata.

**Por que a coluna `token` ainda existe.** O usuário já foi identificado por um token
guardado no navegador, e a tabela `users` tem a coluna `token` como `NOT NULL UNIQUE`.
Hoje ninguém lê essa coluna — quem identifica é `name_lower` —, mas o SQLite não remove
uma coluna `UNIQUE` sem reconstruir a tabela, e reconstruir `users` num banco cheio de
apostas não vale o risco. Usuários novos recebem um valor aleatório ali, só para
satisfazer o schema; bancos antigos e novos seguem idênticos, sem migração nenhuma.
