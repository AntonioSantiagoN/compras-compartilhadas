# Compras Compartilhadas

Site responsivo para grupos de compra pelo WhatsApp. Cada pessoa entra com a senha geral, escolhe um produto e informa nome, telefone e quantidade. **Cada produto é dividido em lotes de 4 participantes.** Assim que o quarto participa, o próximo lote do mesmo produto aparece automaticamente. As inscrições são gravadas em SQLite e não se perdem quando usuários enviam ao mesmo tempo.

## Senhas iniciais

- Acesso dos participantes: `teste123`
- Administração (criar listas, remover inscrições): `adm1234!`

**IMPORTANTE:** altere as duas senhas e defina uma chave de sessão exclusiva antes de colocar o site na internet. As senhas não aparecem no navegador; ficam na configuração do servidor. O arquivo SQLite contém telefones pessoais: proteja-o e mantenha backups.

## Executar

Requer **Node.js 22.13 ou superior**. Não precisa instalar bibliotecas.

1. Extraia o ZIP e abra um terminal dentro da pasta.
2. Execute `node server.js` ou `npm start`.
3. Abra `http://localhost:3000`.
4. Acesse com `adm1234!`, clique em **Nova lista** e informe nome, início, duração em dias e produtos (um por linha).
5. Compartilhe o link hospedado com o grupo; para acesso em aparelhos diferentes, será preciso hospedar este servidor em um local com endereço público (ou configurar acesso na mesma rede local).

### Configuração para publicação

Configure estas variáveis no serviço de hospedagem:

```
USER_PASSWORD=troque-esta-senha
ADMIN_PASSWORD=troque-esta-senha-administrativa
SESSION_SECRET=uma-chave-grande-aleatoria-com-pelo-menos-32-caracteres
DB_FILE=/caminho/para-volume-persistente/compras.sqlite
NODE_ENV=production
PORT=3000
```

**Hospedagem:** use servidor Node.js com **disco persistente** para SQLite. Plataformas sem armazenamento persistente apagarão os dados quando reiniciarem. Publique via HTTPS. Se estiver atrás de proxy HTTPS, `NODE_ENV=production` marca o cookie como Secure.

## Funcionamento

- O limite de 4 é de **participantes por lote**, não de unidades. Cada participante informa livremente sua quantidade.
- O mesmo telefone só pode se inscrever uma vez em cada produto. Caso haja erro, o administrador pode remover e a pessoa cadastra novamente.
- Produtos novos são criados ao abrir uma nova lista. Listas existentes permanecem preservadas.
- A tela consulta atualizações a cada 5 segundos; operações simultâneas são transacionadas no banco de dados.
- Apenas o administrador pode criar listas e excluir inscrições.
- A data e hora de início são ajustadas ao fuso do aparelho do administrador no momento da criação.
- Os registros ficam armazenados no arquivo `compras.sqlite` indicado em `DB_FILE`.

## Privacidade e uso responsável

Os telefones são mostrados aos membros que possuem a senha do grupo; compartilhe-a somente com participantes confiáveis. Informe a finalidade do cadastro e exclua dados quando não forem mais necessários. Para grandes grupos públicos, recomendam-se contas pessoais individuais, proteção reforçada contra abuso e políticas de privacidade específicas.
