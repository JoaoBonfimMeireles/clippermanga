// Habilidades (skills) padrão dos agentes. Valem para TODAS as obras: na primeira execução são gravadas em
// <studio>/_skills/<agente>/<id>.md, onde você pode editar, apagar ou acrescentar arquivos; o que está lá é o que vai
// para o prompt do agente. Cada habilidade é curta de propósito: custa token em toda chamada.
//
// Regra para escrever uma habilidade: só o que AQUELE agente controla.
//  - leitor:   vê a imagem e desenha a CAIXA de cada quadro (é ela que vira o recorte), descreve e dá o impacto;
//  - cortador: NÃO vê a imagem; escolhe o quadro pelo número e decide se usa o close;
//  - montador: NÃO vê a imagem; decide qual imagem vai em cada fala, quando repetir e quando juntar quadros vizinhos;
//  - diretor:  planeja os shorts.
// Tamanho na tela, altura cheia, piso de 30/40%, esticar e balão nas bordas são garantidos em código (lib/crop-enforce.ts):
// não adianta (e custa token) repetir isso para quem só escolhe o número do quadro.
export type Agent = 'leitor' | 'cortador' | 'montador' | 'diretor';

export interface SkillDef { id: string; title: string; body: string }

export const DEFAULT_SKILLS: Record<Agent, SkillDef[]> = {
  // ---------------------------------------------------------------- LEITOR (vê a imagem uma vez e descreve)
  leitor: [
    {
      id: 'caixa-da-cena',
      title: 'A caixa é o quadro inteiro',
      body: 'A caixa vai de borda a borda do quadro desenhado: toda a largura e toda a altura dele, com personagem da cabeça aos pés, arma e criatura inteiras. Tire só sarjeta e margem. Nunca devolva um pedaço (rosto, mão, faixa) de dentro de um quadro maior. Desenhos colados ou sobrepostos que mostram o MESMO momento (golpe e quem apanha, quem fala e quem ouve) são UMA caixa. Confira: caixa com menos de 60% da largura do quadro real está pequena; aumente.',
    },
    {
      id: 'quadro-alto-em-trechos',
      title: 'Só divida quadro muito alto',
      body: 'Divida um quadro apenas quando a altura dele passa de 1,9x a largura. Cada trecho cobre toda a largura do quadro e uma sub-cena completa (o personagem inteiro, o golpe inteiro), com altura entre 0,8x e 1,7x a largura. Nunca faixas baixas nem quadradinhos de detalhe. Quadro com altura até 1,9x a largura fica inteiro, numa caixa só.',
    },
    {
      id: 'descricao-fiel-e-impacto',
      title: 'Descrição fiel, balão não é quadro',
      body: '"what": quem, ação e expressão em até 10 palavras, só o que está desenhado; quem edita não vê a imagem. Quadro que é só balão, caixa de narração, placa, logo, título ou onomatopeia NÃO entra em "panels" (o texto vai em "dialogue"); a caixa nunca é desenhada em volta de um balão. Impacto: 9-10 clímax e virada, 6-8 ação e emoção, 3-5 transição, 1-2 enchimento; nem tudo é 8+.',
    },
    {
      id: 'quem-fala-e-nomes',
      title: 'Quem fala e nomes certos',
      body: 'Cada balão é de quem o rabicho aponta; caixa retangular é narração de quem está em foco. Use o nome curto da ficha, nunca "um homem" ou "uma mulher" para quem já tem ficha, e sempre o mesmo nome do começo ao fim. Na dúvida sobre quem fala, escreva "Narração". Termine toda fala e toda descrição: nada cortado no meio.',
    },
    {
      id: 'sem-anuncio-de-scan',
      title: 'Nunca propaganda ou crédito de scan',
      body: 'Rodapé, cabeçalho, mascote, "SUPPORT US", links, Discord, Ko-fi, Patreon, créditos e anúncios de outras obras nunca são quadros nem entram em "what", mesmo dividindo a tira com um quadro real. Tira só de divulgação: "panels": [] e events "página de divulgação da scan, sem história".',
    },
  ],

  // ---------------------------------------------------------------- CORTADOR (escolhe o quadro pelo número; não vê a imagem)
  cortador: [
    {
      id: 'arte-no-lugar-de-balao',
      title: 'Escolha quadro de arte, nunca de texto',
      body: 'Para cada fala escolha o quadro cuja descrição tem personagem, ação ou cenário. Quadro descrito como balão, caixa de texto, placa, logo, título ou onomatopeia nunca é escolhido, mesmo quando o texto dele é igual à fala. Página sem arte que sirva: não crie recorte; a fala fica no recorte vizinho.',
    },
    {
      id: 'cena-inteira',
      title: 'A cena, não o detalhe',
      body: 'Entre os quadros do mesmo momento, escolha o que mostra a cena completa (corpo inteiro, quem bate e quem apanha, quem fala e quem ouve) e não o de detalhe (mão, olho, pé, objeto solto). Detalhe pequeno citado na fala: use o quadro maior em que ele aparece.',
    },
    {
      id: 'close-so-com-motivo',
      title: 'Close quase nunca',
      body: '"close": false é o padrão. Só use true com impacto 9+ e quando a fala é sobre o rosto ou a expressão daquela pessoa. O dono do canal desfaz quase todo close.',
    },
    {
      id: 'formato-do-quadro',
      title: 'Evite quadro pequeno e quadro alto demais',
      body: 'Entre quadros que servem à fala, deixe por último os marcados "pequeno" (ficam muito ampliados) e "ALTO" (viram cortes rápidos). O app cuida do tamanho na tela, de cobrir a altura e de tirar balão das bordas: não tente compensar com close nem com "cover".',
    },
  ],

  // ---------------------------------------------------------------- MONTADOR (qual imagem em cada fala; não vê a imagem)
  montador: [
    {
      id: 'imagem-segue-a-fala',
      title: 'A imagem mostra o que a fala diz',
      body: 'Falou do personagem, mostre ele; do lugar, do golpe, da criatura, mostre isso. Nunca um quadro de outro momento ou de outra pessoa, nem um quadro adiante na história. Se a página da fala só tem texto ou logo, use o quadro de arte da página vizinha da mesma cena.',
    },
    {
      id: 'segurar-imagem-anterior',
      title: 'Mesmo momento, mesma imagem',
      body: 'Falas seguidas sobre o mesmo momento (reação, comentário, pensamento, explicação, resposta da mesma conversa, algo citado que não tem quadro próprio) usam a MESMA imagem: o normal é de 2 a 4 falas por imagem. Só troque quando a fala traz momento, personagem ou ação nova que tem quadro próprio. Se o quadro da fala seguinte mostra melhor o momento, use o dela nas duas.',
    },
    {
      id: 'cena-geral',
      title: 'Juntar quadros só do mesmo momento',
      body: 'Junte quadros vizinhos numa imagem só quando são o mesmo instante e se completam (encarar + reação, golpe + queda, grupo + provocação) ou quando a fala é uma explicação geral da cena. Nunca junte momentos diferentes, janela de sistema com cena, nem mais de 3 quadros. Fala com dois momentos distantes: um quadro só, o da ação principal.',
    },
    {
      id: 'sem-repeticao-proxima',
      title: 'Sem vai e volta',
      body: 'Depois de trocar de imagem, não volte a uma imagem já mostrada nas últimas 6 partes. A mesma imagem não passa de 4 falas seguidas: se a cena continua, passe para outro quadro do mesmo momento.',
    },
  ],
  // ---------------------------------------------------------------- DIRETOR DE SHORTS (planeja os shorts a partir da história)
  diretor: [
    {
      id: 'tamanho-e-gancho',
      title: 'Tamanho e gancho',
      body: 'Cada short tem de 20 a 40 segundos; passar disso só até 45, nunca mais. Os 2 primeiros segundos são o gancho: ação, revelação, pergunta ou frase de impacto. Termine num ponto de impacto ou suspense, sem encerrar a história.',
    },
    {
      id: 'comeco-meio-fim',
      title: 'Começo, meio e fim',
      body: 'Todo short faz sentido sozinho: quem nunca viu o vídeo entende quem é o personagem, o que está em jogo e o que acontece. Prefira trechos com arco completo (situação, virada, consequência) a um pedaço solto de luta.',
    },
    {
      id: 'quando-narrar',
      title: 'Quando criar narração nova',
      body: 'Padrão: só corte, mantendo a voz original. Crie narração nova (formato "narrated") apenas quando o trecho NÃO funciona sozinho: falta contexto, o gancho está no meio ou no fim, ou a história pede um resumo. Use 0 a 3 narrações novas por lote de 5 e só as necessárias; se nenhuma precisa, todas ficam como corte. A narração nova substitui a voz original por inteiro.',
    },
    {
      id: 'short-livre',
      title: 'Short livre (fora do fluxo do vídeo)',
      body: 'Você pode montar um short com imagens de pontos diferentes do vídeo, em qualquer ordem (ex.: o clímax primeiro, depois o contexto). Isso vale para corte e para narração nova. Imagem fora de ordem sem narração nova só se a fala original continuar fazendo sentido.',
    },
    {
      id: 'usar-os-exemplos',
      title: 'Aprender com os exemplos do canal',
      body: 'Os shorts de referência vêm do melhor para o pior. Imite o tipo de gancho, a duração e o estilo de título dos primeiros; fuja do padrão dos últimos. Nunca copie um título.',
    },
  ],
};
