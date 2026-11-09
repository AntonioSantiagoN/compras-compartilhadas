# Compras Compartilhadas

Site responsivo para grupos de compra pelo WhatsApp. Cada pessoa entra com a senha geral, escolhe um produto e informa nome, telefone e quantidade. **Cada produto é dividido em lotes de 4 participantes.** Assim que o quarto participa, o próximo lote do mesmo produto aparece automaticamente. As inscrições são gravadas em PostgreSQL e não se perdem quando usuários enviam ao mesmo tempo.

## Arquitetura

- **Site e API:** Vercel. Os arquivos de `public/` são servidos pela CDN e as rotas `/api/*` rodam como função serverless (`api/index.js` → `server.js`).
- **Banco de dados:** PostgreSQL no Railway.

## Publicar

### 1. Banco no Railway

1. Em [railway.com](https://railway.com), clique em **New Project → Database → PostgreSQL**.
2. Abra o serviço **Postgres → Variables** e copie o valor de **`DATABASE_PUBLIC_URL`** (começa com `postgresql://` e contém `proxy.rlwy.net`).
   Não use a `DATABASE_URL` interna (`postgres.railway.internal`): ela só funciona dentro do Railway.

As tabelas são criadas automaticamente na primeira vez que o site acessa o banco.

### 2. Site na Vercel

1. Em [vercel.com](https://vercel.com), entre com o GitHub e clique em **Add New → Project** → importe `compras-compartilhadas`.
2. Mantenha as configurações detectadas (o `vercel.json` já define tudo) e abra **Environment Variables**:
   ```
   DATABASE_URL=<o valor de DATABASE_PUBLIC_URL copiado do Railway>
   USER_PASSWORD=senha-dos-participantes
   ADMIN_PASSWORD=senha-do-administrador
   SESSION_SECRET=texto-longo-e-aleatorio-com-pelo-menos-32-caracteres
   ```
3. Clique em **Deploy**. A cada `git push` na branch `main`, a Vercel publica a nova versão.

Na Vercel não existem senhas padrão: se faltar alguma das quatro variáveis, o site responde “Servidor sem configuração completa” e o log da função mostra qual falta. Depois de alterar variáveis, faça **Redeploy** para que elas valham.

## Executar localmente

Requer **Node.js 20.12 ou superior** e um PostgreSQL (pode ser o próprio banco do Railway).

1. `npm install`
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL` (as senhas são opcionais localmente: sem elas valem `teste123` e `adm1234!`).
3. `npm start` e abra `http://localhost:3000`.
4. Acesse com a senha de administrador, clique em **Nova lista** e informe nome, início, duração em dias e produtos (um por linha).

## Funcionamento

- O limite de 4 é de **participantes por lote**, não de unidades. Cada participante informa livremente sua quantidade.
- O mesmo telefone só pode se inscrever uma vez em cada produto. Caso haja erro, o administrador pode remover e a pessoa cadastra novamente.
- Produtos novos são criados ao abrir uma nova lista. Listas existentes permanecem preservadas.
- A tela consulta atualizações a cada 5 segundos. Inscrições simultâneas no mesmo produto são processadas uma de cada vez (trava de linha no banco), então os lotes nunca passam de 4.
- Apenas o administrador pode criar listas e excluir inscrições.
- A data e hora de início são ajustadas ao fuso do aparelho do administrador no momento da criação.

## Privacidade e uso responsável

O banco contém telefones pessoais: não compartilhe a `DATABASE_URL` e mantenha backups (o Railway oferece backups do Postgres nos planos pagos). Os telefones são mostrados aos membros que possuem a senha do grupo; compartilhe-a somente com participantes confiáveis. Informe a finalidade do cadastro e exclua dados quando não forem mais necessários. Para grandes grupos públicos, recomendam-se contas pessoais individuais, proteção reforçada contra abuso e políticas de privacidade específicas.
