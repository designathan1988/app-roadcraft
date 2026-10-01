# Roadcraft — Estudo: pessoas, carros, construção e estradas

**Data:** 2026-10-01 · **Base:** `master` @ `df3b4d5` (o jogo rodou no servidor de desenvolvimento) · **Natureza:** estudo; nenhum código do jogo foi alterado.

Cada achado traz o que foi **visto ou medido no jogo**, a **causa no código** e **como consertar**. A seção 8 ordena a implementação em fatias visíveis no jogo.

Fotos: `docs/audit/2026-10-01/study/people/`. Medidas: feitas no navegador, na cidade do jogador (`tests/fixtures/player-city.json`), passo a passo da simulação, sobre o `PedView` publicado.

> **Atenção, sessão concorrente.** Durante este estudo outra sessão do Claude fez três commits no `master` sobre pessoas: `428e4cc`, `a1ac508` (rostos variados e roupas sem repetição) e `df3b4d5`. As fotos já incluem o trabalho dela. Duas sessões mexendo no mesmo sistema vão se atropelar: antes de começar os consertos, só uma deve ficar com "pessoas".

---

## 0. O que está LIVE no jogo hoje, e o que não existe

| Sistema | No jogo agora | Não existe |
|---|---|---|
| Aparência das pessoas | 84 corpos MakeHuman fixos (roster), 12 roupas inteiras, 10 cabelos, 6 sapatos, 2 chapéus; rosto variado (`a1ac508`); cor de pele chapada | Pele com textura, coerência de traços, dimorfismo sexual definido, expressão viva, roupa infantil, peças separadas (blusa/calça/casaco) |
| Andar | Motor People: navmesh + ORCA; ninguém trava cruzamento | Andar sem "dança": medido abaixo, grupos giram um em volta do outro e andam de costas |
| Autonomia | Destino sorteado: metade das vezes uma porta ou a borda do mapa, metade um ponto qualquer da calçada; bancos; grupos conversam parados | Casa, trabalho, rotina, necessidades, vida dentro de prédios, conversa entre estranhos, identidade persistente |
| Pessoa ↔ carro | Carro buzina na calçada: um pedestre "embarca" e **é apagado**; quem desce **é criado**. Motoristas e passageiros são desenhados por sorteio do id do carro | Pessoa que anda até o **próprio** carro, entra, dirige, estaciona e sai |
| Carros | Drive v2 (ACC + troca de faixa tática); 8 classes, 6 carrocerias "loft", 4–6 cores por classe | Gerador de carros, viagens com origem/destino reais, estacionamento, garagens |
| Construção | Volumes empilhados (polígono simples extrudado), 14 componentes de fachada, 9 padrões, 6 telhados, 17 elementos livres, materiais por face/andar | Pátios/furos, paredes curvas, sólidos livres, domos/arcos, janelas livres, interiores |
| Estradas | 6 classes, nº de faixas, mão única, elevada/ponte/túnel, reta/curva/livre, altura por ponto | Seção transversal editável (ciclovia, estacionamento, ônibus, canteiro, calçada), rotatória, rua de pedestres, trilho, acessos a lotes |

---

## 1. Pessoas — aparência

### A1 · A pele é uma cor chapada: laranja, ou branco-papel
**Visto:** `face-1-f-adult.jpg` (pele laranja uniforme, sem poros nem sombra de lábio), `face-39-f-adult.jpg` (branco-papel), `face-43-m-adult.jpg`.
**Causa:** a multidão desenha **cor por vértice**, sem textura (`personRig.ts` `dressedGeometry`: `bodyColour` = `look.skin` misturado com o cabelo). O material é `MeshStandardMaterial` com rugosidade 0.88 (`riggedCitizens.ts:501`): sem mapa de normal, sem especular de pele, sem translucidez. Sob o sol, um tom fica laranja e o mais claro estoura no branco.
**Conserto:**
1. **Textura de pele:** usar as peles CC0 do MakeHuman (jovem/meia-idade/idoso × feminino/masculino × três ascendências), com mapa de normal e especular, num atlas de pele.
2. **Tom contínuo:** aplicar o tom como multiplicador no shader, por pessoa (`melanina` + subtom), em vez de pintar os vértices.
3. **Shader de pele:** iluminação "wrap" (aproxima a translucidez), rugosidade ~0.5 com especular baixo e oclusão nos lábios e olhos.
4. **Aceite:** retratos de perto, um por faixa de tom, sem estouro nem laranja, ao sol e à sombra.

### A2 · Traços sorteados sem coerência: loira de olho azul com pele marrom, cabelo vermelho em qualquer um
**Visto:** `face-43-m-adult.jpg` (loiro, olho azul, pele marrom-alaranjada), `face-1` (cabelo vinho).
**Causa:** `spec.ts` `randomPerson` sorteia `skin`, `eyes` e `hair` cada um de uma lista **independente** da ascendência do corpo (`african/asian/caucasian`). O tom de pele também não segue a ascendência que molda o rosto.
**Conserto:** um **modelo de fenótipo**.
- A ascendência define a distribuição contínua de melanina e, condicionadas a ela, as do cabelo e dos olhos (ruivo e olho claro são raros, mas possíveis).
- A idade define os grisalhos.
- Os ajustes manuais (tingir o cabelo) continuam permitidos.
- Os mesmos parâmetros alimentam o Criador.

### A3 · Homem e mulher sem traços definidos
**Visto:** `face-1-f-adult` é uma mulher adulta com cabelo curto, mandíbula larga e sobrancelha grossa e franzida. No grupo `group-2` há figuras de sexo indistinguível de longe.
**Causa:**
- O rosto (`faceShape`) usa as mesmas distribuições para os dois sexos: mandíbula, queixo, arco das sobrancelhas, lábios e maçãs do rosto.
- As 12 sobrancelhas são sorteadas para qualquer sexo.
- 28% das mulheres saem de cabelo curto.
- `muscle` e `weight` são independentes do sexo.
- Não há barba, bigode nem sombra de barba; não há maquiagem.
**Conserto:** **perfis de dimorfismo**.
- **Mulher:** mandíbula estreita, queixo pequeno, lábio cheio, testa lisa, sobrancelha fina e arqueada, cílios marcados, quadril, cabelo médio ou longo na maioria.
- **Homem:** mandíbula e queixo largos, arco superciliar, pescoço grosso, sobrancelha reta e grossa, barba/bigode/sombra de barba (por textura e por cartões), cabelo curto na maioria.
- Uma faixa de androginia rara e opcional.
- **Teste:** um classificador simples sobre as medidas do rosto, mais revisão de 100 retratos.

### A4 · "Linha de produção": a rua inteira são 84 corpos repetidos
**Causa:**
- `roster.ts` `makeRoster` gera **84 pessoas fixas**.
- A multidão escolhe um corpo dessa lista pelo hash do id (`citizenCasting.ts`).
- A única variação por instância é a escala de ±8% (`riggedCitizens.ts:648`).
- O vestuário é pequeno: **8 roupas masculinas e 4 femininas inteiras** (terno ou conjunto, não peças), 10 cabelos, 6 sapatos e 2 chapéus.
- O commit `a1ac508` evitou repetir roupa+cor dentro dos 84, mas o teto continua 84.
**Conserto:**
1. **Cada cidadão tem o seu `PersonSpec`**, gerado na criação e salvo na cidade (ver B1).
2. A **multidão usa protótipos** (128–256 corpos cozidos por forma) e cada instância varia **no shader**: tom de pele, cor do cabelo e cor/estampa de cada peça. Isso pede canais de material por vértice e uma paleta por instância, como o desenho de agência já prevê no H4. A forma do corpo vem do protótipo mais próximo; a cor nunca se repete.
3. **Vestuário por peças**: roupa de baixo, blusa/camisa, casaco, vestido, sapato, chapéu, óculos e bolsa, combinados por regras de estilo (o "dress code" já existe).
4. **Ampliar o acervo:**
   - roupas CC0 da comunidade MakeHuman, com licença por item no manifesto;
   - peças procedurais (camiseta, regata, camisa, calça, bermuda, saia, vestido) costuradas no corpo pelo mesmo `fitProxy`;
   - estampas procedurais: listra, xadrez, liso, jeans.
5. **Aceite:** em 300 pessoas na rua, zero pares idênticos de rosto+roupa+cor; contact sheet revisada a olho.

### A5 · Criança vestida com roupa de adulta (barriga de fora)
**Visto:** `group-7-family.jpg`: a menina usa o `female_sportsuit01` (top cropped) ajustado a um corpo infantil.
**Causa:** `roster.ts` veste a faixa `child` com as mesmas roupas dos adultos.
**Conserto:** vestuário infantil próprio e uma regra no gerador: criança nunca recebe peça marcada como adulta. Um teste bloqueia o caso.

### A6 · Sem expressão: piscar, falar e sorrir são código morto
**Causa:**
- `riggedCitizens.ts` `facialExpression`/`setFacialExpression` acionam morphs com nomes do **Rocketbox** (`AU_45_Blink`, `HB_07_MouthSmile`, `AK_25_JawOpen`).
- O corpo MakeHuman não tem nenhum morph target (`personRig.ts` não cria `morphAttributes`), então ninguém pisca, ninguém mexe a boca ao conversar e ninguém sorri de verdade.
- A única "expressão" é o canto da boca moldado de forma fixa no rosto.
**Conserto:**
1. Na importação, aplicar ao corpo as **unidades de pose de expressão do MakeHuman** (CC0, do esqueleto com rosto) e gravar as diferenças como **morph targets**: piscar, sorriso, sorriso aberto, franzir, sobrancelhas para cima, e visemas A/O/E para a fala.
2. Ligar esses alvos ao `setFacialExpression` existente.
3. Fazer os olhos seguirem o que a pessoa olha (osso do olho).
4. Ligar o humor da pessoa (B2) à expressão de repouso.

### A7 · Defeitos de malha visíveis
- **Manchas brancas no tornozelo** (`solo-1`): pele ou textura da meia vazando pela barra da calça, e sapato com textura suja (`group-2`).
- **Cabelo em cartões serrilhados** (`face-1`, `face-39`): a multidão corta o cartão por alfa (`SOLID`) e perde as pontas.
- **Rosto sem lábio nem sobrancelha com volume**, por causa da cor chapada (A1).

**Conserto:**
- Recortar a pele escondida com a margem certa por peça.
- Desenhar o cabelo com alpha-to-coverage, com textura.
- No retrato próximo (LOD 0), desenhar a pessoa **texturizada** (o `personPreview.ts` já faz isso no Criador); a cor por vértice fica só para os LODs distantes.

### A8 · Memória
A animação é cozida por corpo, cerca de 11 MB cada (P1-27, ~570 MB de heap). Com protótipos e paleta por instância (A4), a animação passa a ser cozida **uma vez por esqueleto** e a GPU faz o skinning. Isso é pré-condição para ter mais variedade sem estourar a memória.

---

## 2. Pessoas — andar errático (medido)

**Medição:** cidade do jogador, 83 pessoas, 166 pessoa-minutos, cada tick comparado com o anterior:

| Medida | Resultado |
|---|---|
| Corpo andando **de costas** (contra o rosto) a 0.10–0.15 m/s | **1,8% de todos os ticks**, 62 pessoas; seis pontos concentram a maioria |
| "Dança" (mais de 0,6 m andados em 2 s com deslocamento líquido abaixo de 35%) | **18 de 83 pessoas em um minuto** (22%); 0,8% do tempo |
| Viradas de lado a lado (giro > 0,8 rad/s trocando de sentido em < 0,6 s) | 2,3 por pessoa-minuto |
| Saltos, giros bruscos | 0 |

**Visto:** `milling-pair-146-sequence.jpg`, quatro quadros com meio segundo de intervalo. Dois amigos (grupo de 2) giram um em volta do outro e trocam de lugar na calçada, em vez de seguir caminho. Os líderes de grupo (rank 0) andam de costas a exatamente 0,15 m/s por até 17 s.

**Causa:**
1. **O grupo empurra a si mesmo.**
   - Os acompanhantes miram uma vaga "ao lado do líder", recalculada várias vezes por segundo (`people.ts:592-600`).
   - O líder espera o grupo.
   - O ORCA trata os membros como estranhos que se evitam mutuamente.
   - Resultado: cada um desvia do outro, a vaga se move e os dois giram.
2. **O envelope do corpo permite andar de costas.**
   - `BACK_MAX = 0,15 m/s` e o lateral vai até 0,35 m/s (`people.ts:182-185`).
   - Abaixo de `FACE_WALK` o rosto não segue o movimento.
   - A pessoa desliza para trás com os pés andando para a frente.
3. **O teste é cego a isso.**
   - `tests/sim/support/agentDefects.ts:162` só conta "de costas" quando o corpo vai a mais de **0,25 m/s** para trás, mas o motor limita esse movimento a 0,15.
   - A "dança" de quem se move mais rápido que o limiar de "parado" também escapa.
   - Por isso o "30/30 passa" da memória não mede o que o jogador vê.

**Conserto (no motor People, sem remendo):**
1. **Grupo como formação.**
   - O grupo vira um agente composto: um ponto de referência que navega e vagas fixas (lado a lado, em fila quando a calçada estreita).
   - Os membros não se evitam entre si; seguem a vaga com uma mola amortecida.
   - O ORCA trata o grupo inteiro como um corpo só diante dos outros.
   - Os estudos de multidão (Moussaïd et al. 2010, formações em V e em fila) dão a referência.
2. **Corpo sem ré.**
   - Andar para trás só como ação explícita e curta ("dar um passo atrás", até 0,5 s).
   - Velocidade contra o rosto fica fora do envelope.
   - Se o ORCA pede ré, o corpo para e vira.
3. **Medir o que o jogador vê.**
   - Nova medida de "dança" (deslocamento líquido / caminho) e de ré a partir de 0,05 m/s.
   - Os limites do teste passam a ser os do envelope.
   - O relatório lista os pontos quentes do mapa.
   - Meta: ré = 0, dança < 0,1% do tempo, nenhuma pessoa dançando por mais de 1 s.
4. **Carros também são obstáculos.** Hoje o motor People só conhece carros pela permissão da faixa de pedestres: um carro parado sobre a calçada ou na boca da garagem não existe para ele. Ele precisa entrar no ORCA como obstáculo com velocidade (`VehicleBodyView.predict`, já previsto no desenho).

---

## 3. Pessoas — autonomia, inteligência e vida na cidade

### B1 · Ninguém tem identidade
**Causa:**
- O pedestre é um id de simulação. O corpo desenhado sai do hash do id (`citizenCasting`).
- Quem desce do carro é "outra" pessoa com o mesmo sorteio.
- Não existe registro de cidadãos.
**Conserto:** um **Registro de Cidadãos** (`src/sim/citizens/*`), salvo com a cidade:
- id permanente e `PersonSpec`;
- traços: paciência, sociabilidade, pressa, renda;
- moradia (prédio, unidade), trabalho/estudo, família;
- veículo próprio;
- agenda e humor.

A pessoa existe mesmo fora da tela: em casa, no trabalho ou num carro.

### B2 · Não há rotina nem motivo para andar
**Causa:** `people.ts` `pickGoal` sorteia o destino: 50% uma porta ou a borda do mapa, 50% um ponto qualquer da calçada. Ao chegar, sorteia de novo.
**Conserto:** **agenda por atividades**, o modelo de demanda de transporte por atividades, simplificado:
- Cada cidadão tem um dia: casa → trabalho/escola → almoço → compras → lazer → casa, gerado pelo papel (trabalhador, estudante, aposentado, criança com responsável) e pelo relógio do jogo.
- Cada atividade escolhe um lugar real: prédio por uso (`residential/commercial/industrial/mixed` já existem no prédio), banco, praça.
- Cada atividade escolhe também um modo: a pé, de carro ou de ônibus, por distância, posse de carro e pressa.
- Uma **mente utilitária** escolhe a próxima tarefa entre as necessidades (fome, descanso, social, obrigação), com persistência: só troca de intenção se a nova for pelo menos 30% melhor (já no desenho).
- Os planos se expandem em tarefas curtas: andar até, usar, esperar, seguir, embarcar.
- O jogo precisa de um **relógio do dia** e de um ciclo dia/noite (hoje não existe), senão a agenda não aparece.

### B3 · Entrar e morar nos prédios
**Causa:**
- A porta de um prédio é só um ponto onde a pessoa **some** (`sources`).
- O prédio guarda `use`, `spaces` e `cores` mas nada disso é simulado (o relatório de 30/09 já registra isso).
**Conserto:**
- **Ocupação abstrata:** cada unidade residencial vira um domicílio; cada loja/escritório, vagas de trabalho e de atendimento. O total vem da área por andar.
- Quem entra no prédio sai do mundo visível e passa a constar na ocupação do andar.
- **Visível de fora:** janelas acesas à noite pela ocupação, pessoas na porta, entrega de compras.
- **Interior visitável**, numa fase posterior: andares com cômodos gerados a partir de `spaces`, em corte, como em The Sims. Depende do modo de construção ganhar interiores (D3).

### B4 · Conversar e interagir
**Causa:** só membros do **mesmo grupo** "conversam", e só quando ficam parados juntos (`stoodTogether` → `talk`). Estranhos não interagem.
**Conserto:**
- Interações como **objetos de uso** (affordances): ponto de conversa, fila, banco compartilhado, vitrine, ponto de ônibus.
- Encontro casual: dois conhecidos que se cruzam param e conversam, conforme a sociabilidade.
- Um grafo social leve de vizinhos e colegas, criado pelo Registro.
- Animações: as de conversa, ouvir e telefone do Rocketbox já existem; acenar e cumprimentar viriam de clipes CC0 (Quaternius).

### B5 · Entrar no carro e dirigir de verdade
**Causa:**
- O carro nasce na borda do mapa com ocupantes desenhados pelo hash do id dele (`v.seats` é uma máscara de bits).
- O "motorista" é um conjunto de parâmetros (`driver.ts` `makeDriver`), não uma pessoa.
- Embarque: o pedestre anda até a porta e é **apagado** (`kerbStops.ts`, `PeopleBridge.board`). Desembarque: um pedestre é **criado**.
- Não existe estacionamento nem garagem.
**Conserto:**
1. **Carro pertence a um domicílio** e fica **estacionado**: vaga na rua (faixa de estacionamento, ver E1), estacionamento do prédio (o elemento `parking` já existe no modelo de prédios) ou garagem.
2. **Viagem de carro do cidadão:**
   1. anda até o próprio carro;
   2. abre a porta (as portas já animam);
   3. senta (as poses de sentar já existem);
   4. o carro **acorda** e entra no Drive v2 com o **cidadão como motorista**: os traços dele viram os parâmetros de direção;
   5. dirige até o destino e procura vaga;
   6. estaciona, desce e anda até a porta.

   Passageiros são cidadãos reais: a família entra junta.
3. **Ponte Pessoa↔Veículo bidirecional** (o desenho §5 já prevê `offerDoor`/`atDoor`/`boarded`/`aborted`): o id da pessoa nunca muda; ela está a pé, sentada num assento ou dirigindo.
4. **Nível de detalhe:** carros e pessoas longe da câmera rodam numa simulação abstrata (posição na rota, horário de chegada) e materializam ao entrar na vista. É assim que uma cidade grande cabe no orçamento de CPU.
5. **Tráfego de passagem:** o tráfego da borda continua existindo, com motoristas cidadãos "de fora".

---

## 4. Carros — gerador e inteligência

### C1 · Gerador de carros: é possível, e a base existe
**Hoje:**
- `render/carBody.ts` já constrói a carroceria por **loft a partir de parâmetros**: perfil lateral, estufa, colunas, portas, interior.
- São 6 estilos fixos (hatch, sedan, wagon, SUV, picape, van).
- Cada classe tem uma paleta de 4–6 cores (`archetypes.ts`).
- Ao lado do sedan, os carros parecem de brinquedo (`solo-13-f-elder.jpg`, ao fundo).

**Conserto:** um **`VehicleSpec`**, como o `PersonSpec`:
- **Proporções:** comprimento, entre-eixos, balanços, largura, altura, altura do capô e da cintura.
- **Silhueta:** inclinação do para-brisa e do vidro traseiro, queda do teto, coluna C.
- **Frente e traseira:** formas, faróis e lanternas (formato e assinatura de luz), grade.
- **Rodas:** aro e desenho.
- **Acabamento:** cromado/preto.
- **Pintura:** sólida, metálica, perolada, dois tons, envelopamento.

Em volta dele:
- famílias genéricas sem marcas registradas;
- um **gerador de frota** com distribuições realistas: popular é comum, esportivo é raro, a idade do carro dá desgaste e sujeira;
- um **Criador de Veículos** igual ao de pessoas;
- carros de cidadãos guardados com a cidade;
- desenho por protótipos instanciados.

**Aceite:** contact sheet de 200 carros sem dois iguais; renderização a ≤ 3 ms com 1200 veículos.

### C2 · Carros inteligentes: o que falta
- **Hoje, no Drive v2:** ACC com limite de jerk, troca de faixa tática, revezamento com pedestres na faixa, disjuntor de gridlock.
- **Falta:**
  1. **Viagens reais:** origem e destino em prédios e vagas, não em "qualquer rua sem saída" (P2-01). Hoje o destino é sempre uma saída da borda (`routing/destination.ts` `boundaryExit`).
  2. **Rota estratégica por tempo de viagem medido**, com escolha que muda com o congestionamento (P2-06; desenho §4 "Strategic").
  3. **Estacionar e procurar vaga**, manobra de baliza, entrada e saída de garagem.
  4. **Percepção:** ver só o que está à vista; reagir ao pedestre fora da faixa e à porta abrindo.
  5. **Semáforos corretos:** P1-42, P1-43 e P1-45 ainda abertos.
  6. **Ônibus com linha e pontos**, entregas com destino.
  7. **Motorista cidadão:** traços pessoais, pressa conforme a agenda.

---

## 5. Modo de construção — por que não dá para fazer "qualquer construção"

**Hoje (`world/buildings/types.ts`):**
- O prédio é uma pilha de **volumes**: um retângulo ou um polígono simples, extrudado por andar.
- Fachada: 14 componentes por vão e 9 padrões.
- Telhados: 6 tipos (plano, terraço, duas águas, quatro águas, uma água, dente de serra).
- 6 detalhes de telhado e 17 elementos livres (escada, rampa, pilar, marquise, muro, laje, piso, cerca, árvore, banco, ar-condicionado, floreira, guarda-corpo, toldo, flores, pedras, estacionamento).
- Materiais por prédio, volume, face e andar.
- Ferramentas Deslocar e Pintar.

| Falta | Causa | Conserto |
|---|---|---|
| Pátio interno, furo, átrio | `cutOutline` rejeita furo (`docs/design/building-editor-ux.md`) | Núcleo de **sólidos com booleanas**: Manifold. O teste isolado já mediu pátio em 5,8 ms e corte vazado em 0,5 ms, com proveniência de face. Esboços + operações (extrudar, cortar, chanfrar, deslocar) guardados no documento; a malha é derivada |
| Parede curva, arco, círculo, torre redonda | Volume só tem arestas retas | Esboço com arcos e bézier; fachada distribuída ao longo da curva |
| Domo, abóbada, mansarda, telhado cônico, telhado por aresta | 6 telhados fixos | Telhado por perfil: cada aresta com inclinação própria (straight skeleton) e primitivas de revolução |
| Janela e porta em qualquer lugar e de qualquer tamanho | Vãos são uma grade uniforme por face | Aberturas livres como furos no sólido, com moldura paramétrica |
| Pintura por vão ou região | Material só até o nível de face/andar | Regiões de material no esboço |
| Sacada, varanda, balanço e marquise livres | Parcial (elementos caixa) | Elementos paramétricos presos à face |
| Interiores (cômodos, escadas, elevador visível) | `spaces` e `cores` são guardados mas não desenhados | Plantas por andar a partir de `spaces`; vista em corte; ligação com a ocupação (B3) |
| Objetos externos (glTF) e uma biblioteca de peças | Não existe | Importar com licença por item; peças paramétricas: colunas, cornijas, frontões |

---

## 6. Modo de estradas — por que não dá para fazer "qualquer estrada"

**Hoje (`world/doc.ts` `RoadSegment`):**
- O segmento guarda classe (6 opções), sentido, nº de faixas, estrutura (chão/elevada/ponte/túnel) e curva.
- Largura da calçada, canteiro e velocidade vêm **fixos da classe** (`roadTypes.ts`).

| Falta | Conserto |
|---|---|
| **Seção transversal editável:** faixas de tipos diferentes (carro, ônibus, ciclovia, estacionamento), larguras, calçada por lado, faixa de árvores, canteiro de largura/tipo livre, assimetria (2+1) | Uma **seção transversal por segmento** (lista de faixas por lado com tipo e largura), editor visual por arrastar e transição suave entre seções. Lanelets, marcações e o navmesh das pessoas derivam dela |
| Faixa de conversão, bolsão, setas pintadas | Faixas por trecho com setas; o grafo de faixas lê as setas |
| **Rotatória** | Ferramenta dedicada: anel de mão única com entradas "dê a preferência" |
| Rua de pedestres, viela, estrada de terra, ciclovia separada | Novas classes de superfície; o navmesh e os carros leem as permissões por faixa |
| Faixa de pedestres no meio da quadra, lombada, semáforo de pedestres | Objetos de via colocáveis; a travessia usa a mesma "fonte única" (`crossings`) |
| Acesso a lotes, garagens, estacionamentos | "Acessos" no meio-fio ligam o prédio à via; necessários para B5 e C2 |
| Bonde e trilho | Faixa de trilho na seção; veículo guiado (fase posterior) |
| Velocidade e preferência por via | Atributos por segmento, editáveis no inspetor |
| Trevos e viadutos prontos | Modelos de nó, depois que as alturas por ponto (já feitas) se estabilizarem |

---

## 7. Arquitetura que liga tudo

Uma ordem de dependência, que vale para todas as seções:

1. **Registro de Cidadãos** com o `PersonSpec` (B1).
2. **Fenótipo e gerador** (A2–A5) alimentam o Registro.
3. **Mente + agenda** (B2) escolhem o que cada cidadão faz.
4. **Lugares:** prédios com ocupação (B3), vagas e acessos (E1), objetos de uso (B4).
5. **Movimento:** motor People (A pé, seção 2) e Drive v2 (C2); a **ponte** entre eles (B5).
6. **Nível de detalhe:** abstrato longe da câmera, detalhado perto.

O desenho `docs/design/agency-architecture.md` já descreve 1, 4 e 5. Faltam nele:

- o Registro e a agenda;
- o fenótipo;
- o `VehicleSpec`;
- estacionamento e acessos;
- o núcleo de sólidos dos prédios;
- a seção transversal das vias.

---

## 8. Ordem de implementação (fatias visíveis no jogo)

Cada fatia entra atrás de uma flag, é medida, fotografada (cada opção tocada, como manda o CLAUDE.md) e depois vira padrão.

| # | Fatia | O jogador vê | Aceite |
|---|---|---|---|
| 1 | **Andar sem dança:** grupo como formação, corpo sem ré, carros como obstáculos, teste com os limites do envelope | Grupos andam lado a lado, ninguém gira nem anda de costas | Ré = 0; dança < 0,1% do tempo; fotos dos seis pontos quentes |
| 2 | **Pele e fenótipo:** textura de pele, tom contínuo coerente, cabelo e olho condicionados, dimorfismo, roupa infantil | Pessoas bonitas e plausíveis, homem e mulher claros | Retratos de 40 pessoas revisados; nenhuma criança com roupa adulta |
| 3 | **Expressão viva:** morphs de expressão do MakeHuman, piscar, falar, sorrir, olhar | Rostos que piscam, falam e sorriem | Sequência de fotos de uma conversa |
| 4 | **Multidão sem repetição:** protótipos + paleta por instância, vestuário por peças, acervo ampliado, animação cozida por esqueleto | 300 pessoas, nenhuma igual; menos memória | Zero pares iguais; heap abaixo do orçamento (P1-27) |
| 5 | **Registro de Cidadãos + relógio do dia + dia/noite** | A mesma pessoa sai de casa de manhã e volta à noite | Seguir uma pessoa por um dia de jogo |
| 6 | **Prédios habitados:** ocupação por unidade, entrar/sair, janelas acesas | Prédios "vivos"; contagem de moradores no inspetor | Ocupação = soma de quem entrou |
| 7 | **Estacionamento e acessos** (vias e prédios) | Carros parados na rua e nos lotes | Fotos de vaga, garagem, lote |
| 8 | **Pessoa dirige:** anda até o carro, entra, dirige, estaciona, sai | Uma pessoa seguida do sofá ao trabalho de carro | 100% dos embarques completam ou abortam limpos |
| 9 | **Viagens reais e rota por tempo** (C2) + semáforos (P1-42/43/45) | Tráfego com origem e destino, rotas que mudam com o trânsito | Gridlock < 60 s em 20 sementes |
| 10 | **Gerador de carros + Criador de Veículos** | Frota variada, cada carro diferente | Contact sheet de 200 carros |
| 11 | **Interações:** conversa entre conhecidos, filas, ponto de ônibus, lojas | Vida na calçada | Fotos e contagem de interações |
| 12 | **Estradas:** seção transversal, rotatória, rua de pedestres, faixas especiais | Qualquer rua desenhável | Cada tipo fotografado, com carros e pessoas usando |
| 13 | **Construção:** núcleo de sólidos (Manifold), curvas, furos, telhados por aresta, aberturas livres, depois interiores | Qualquer prédio desenhável | Pátio, torre redonda, domo e janela livre fotografados |

As fatias 1–4 resolvem o que o jogador vê hoje nas pessoas; 5–9 dão vida e autonomia; 10–13 dão liberdade de criação. A fatia 1 é a mais urgente: o defeito está medido, a causa é conhecida e o teste atual não o enxerga.

## 9. Riscos

- **Sessão concorrente:** outra sessão está mudando pessoas no `master` agora (seção inicial). É preciso decidir quem fica com o quê.
- **CPU:** 335 pessoas e 385 carros já custam 8–9 ms por tick. Cidadãos com agenda só cabem com o nível de detalhe (B5.4) e sem varreduras O(N) por agente.
- **Licenças:** a base MakeHuman é CC0, mas as roupas da comunidade têm licença **por item** (registrar no manifesto; CC-BY vai para os créditos). Nenhum código do MakeHuman/MPFB pode ser usado (AGPL/GPL).
- **Escopo:** as seções 3, 5 e 6 são sistemas novos, não consertos. Cada um precisa ser entregue em fatias visíveis, nunca como preparação sem efeito no jogo.
