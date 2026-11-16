// Habilidades (skills) padrão dos três agentes. Valem para TODAS as obras: na primeira execução são gravadas em
// <studio>/_skills/<agente>/<id>.md, onde você pode editar, apagar ou acrescentar arquivos; o que está lá é o que vai
// para o prompt do agente. Cada habilidade é curta de propósito: custa token em toda chamada.
export type Agent = 'leitor' | 'cortador' | 'montador' | 'diretor';

export interface SkillDef { id: string; title: string; body: string }

export const DEFAULT_SKILLS: Record<Agent, SkillDef[]> = {
  // ---------------------------------------------------------------- LEITOR (vê a imagem uma vez e descreve)
  leitor: [
    {
      id: 'caixa-da-cena',
      title: 'Caixa justa e completa da cena',
      body: 'A caixa de cada quadro cobre a cena inteira: personagem da cabeça aos pés quando aparece assim, arma e criatura inteiras, com respiro de 3 a 5% em volta. Tire só sarjeta, margem e fundo vazio. Nunca devolva a caixa de um detalhe pequeno de dentro de uma cena maior. Confira os quatro lados: se a borda passa por cabeça, tronco ou pé, aumente a caixa até incluir a parte cortada.',
    },
    {
      id: 'quadro-alto-em-trechos',
      title: 'Quadro alto vira trechos largos',
      body: 'Quadro com altura maior que 1,7x a largura é dividido em trechos: cada elemento interessante (rosto, golpe, criatura, cenário) vira um quadro separado, de formato largo ou quase quadrado, com a descrição do que mostra. Escolha o trecho que ilustra a ação da cena e deixe o resto de fora. Cada trecho deve ter pelo menos 450 px de largura e 300 px de altura no original.',
    },
    {
      id: 'quem-fala-e-nomes',
      title: 'Quem fala e nomes certos',
      body: 'Cada balão é de quem o rabicho aponta; caixa retangular é narração de quem está em foco. Use o nome curto da ficha, nunca "um homem" ou "uma mulher" para quem já tem ficha. Numa conversa, confira se as falas alternam entre os dois lados. Na dúvida sobre quem fala, escreva "Narração" em vez de adivinhar.',
    },
    {
      id: 'sem-anuncio-de-scan',
      title: 'Nunca propaganda ou crédito de scan',
      body: 'Rodapé, cabeçalho, mascote, "SUPPORT US", links, Discord, Ko-fi, Patreon, créditos de tradução e anúncios de outras obras nunca são quadros nem entram em "what". Isso vale mesmo quando dividem a tira com um quadro real. Tira só de divulgação: "panels": [] e events "página de divulgação da scan, sem história".',
    },
    {
      id: 'descricao-fiel-e-impacto',
      title: 'Descrição fiel e impacto calibrado',
      body: '"what" diz quem, ação e expressão em até 10 palavras, só o que está desenhado. Quem edita não vê a imagem: sua descrição é o único olho dele. Impacto: 9-10 clímax e virada, 6-8 ação e emoção, 3-5 transição, 1-2 enchimento; nem tudo é 8+. Quadro só de balão não é quadro: junte à arte vizinha. Cena ambígua: diga que é ambígua.',
    },
  ],

  // ---------------------------------------------------------------- CORTADOR (define o recorte final)
  cortador: [
    {
      id: 'cena-inteira',
      title: 'Cena inteira, sem cortar personagem',
      body: 'O recorte mostra o personagem inteiro (cabeça, tronco e pés), a arma inteira e a criatura inteira. Nunca entregue só os pés, só a barriga ou só o rosto cortado ao meio. Se o quadro escolhido tem o corpo todo, use o quadro todo. Na dúvida entre apertar e abrir, abra.',
    },
    {
      id: 'trecho-largo-em-quadro-alto',
      title: 'Quadro alto: escolha um trecho largo',
      body: 'Quando o quadro é alto (a altura passa de 1,7x a largura), não mostre a tira inteira nem só o topo: escolha o trecho da cena que mostra o que a narração descreve e recorte de forma que ocupe mais a largura e menos a altura, no máximo 1,9x a largura de altura. Se houver mais de um trecho bom, use o mais forte e deixe os outros para as falas seguintes.',
    },
    {
      id: 'tamanho-na-tela',
      title: 'Tamanho mínimo e máximo na tela',
      body: 'PISO ABSOLUTO: o recorte nítido ocupa pelo menos 40% da tela (em 16:9, altura toda e 40% da largura: o retângulo azul que o usuário marcou), nunca menos, e mais sempre que der. Quadro alto: escolha o detalhe mais importante ou a cena de maior impacto (o golpe, o rosto, a criatura) como uma janela de altura até 1,6x a largura, não a tira inteira. Pode cortar perna, parte do poder disparado e balão que não está na cena; nunca corte cabeça ou tronco de forma brusca. Esticar na horizontal até 1,4x. Ampliação máxima 1,5x.',
    },
    {
      id: 'close-so-com-motivo',
      title: 'Close raro e sempre completo',
      body: 'Use "close" só em impacto 8+ quando a narração fala daquela pessoa ou golpe e o quadro inteiro é muito maior que o rosto. O close mostra a cabeça inteira, nunca corta cabelo, queixo ou arma. Se o close deixar o recorte menor que 30% da tela ou borrado, volte ao quadro inteiro.',
    },
    {
      id: 'arte-no-lugar-de-balao',
      title: 'Arte em vez de balão, nunca rodapé',
      body: 'O recorte mostra SÓ a imagem: balão de fala, caixa de texto e área branca lisa nas bordas ficam de fora (a narração já diz o texto); balão só entra se não houver mais nada para mostrar. Pode cortar parte do texto.Prefira sempre o quadro com desenho da cena ao quadro só de balão ou texto. Nunca recorte rodapé, crédito, mascote ou propaganda de scan. Nunca escolha um recorte que seja só onomatopeia ou fundo vazio. Se o único quadro disponível é de balão, mostre-o curto e volte à arte na primeira chance.',
    },
  ],

  // ---------------------------------------------------------------- MONTADOR (escolhe, ordena e cola imagem na fala)
  montador: [
    {
      id: 'imagem-segue-a-fala',
      title: 'A imagem ilustra o que está sendo dito',
      body: 'Cada frase narrada leva o quadro que mostra aquilo: falou do personagem, mostre ele; falou do lugar, do poder ou da criatura, mostre isso. Nunca ilustre uma frase com um quadro de outro momento ou de outra pessoa. Sem quadro que combine, use a regra de segurar a imagem anterior, nunca um quadro qualquer.',
    },
    {
      id: 'segurar-imagem-anterior',
      title: 'Segurar a imagem quando não há boa nova',
      body: 'Se não existe imagem decente para a próxima frase (só balão, recorte pequeno demais ou borrado), mantenha a imagem da frase anterior ou da seguinte durante essa fala. Troque de imagem somente quando aparecer um quadro bom para aquela cena, junto com o áudio dessa cena. Imagem boa repetida é melhor que imagem ruim nova.',
    },
    {
      id: 'sem-repeticao-proxima',
      title: 'Não repetir o mesmo recorte perto',
      body: 'Não use o mesmo quadro nem um recorte quase igual dentro de 6 partes, a não ser pela regra de segurar a imagem. Quando o capítulo tem poucas imagens, varie com outro trecho do mesmo quadro (mais largo ou mais próximo, dentro dos limites de tamanho). Repetir um recorte que o usuário já ajustou à mão é o erro mais notado: evite.',
    },
    {
      id: 'ritmo-e-duracao',
      title: 'Ritmo e duração das imagens',
      body: 'Cada imagem fica pelo menos 1 segundo; uma fala longa pode trocar de imagem várias vezes, com os recortes seguintes sem texto. A duração segue o impacto (1 → 1,6 s, 5 → 3 s, 10 → 4,8 s) e nunca é menor que o tempo de falar o texto. Trocas rápidas e em sequência só em ação; em conversa e emoção, deixe respirar.',
    },
    {
      id: 'ordem-e-fidelidade',
      title: 'Ordem da história e fidelidade',
      body: 'Siga a ordem de leitura das páginas; não puxe imagem de capítulo anterior nem seguinte. Mostre só o que existe nas páginas recebidas e narre só o que está nelas. No começo da obra, apresente o protagonista e o mundo com as imagens que existem, sem pular o contexto. Página sem nada relevante fica fora: "shots": [].',
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
