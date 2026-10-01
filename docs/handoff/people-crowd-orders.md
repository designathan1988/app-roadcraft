# The player's orders for the pedestrian engine (verbatim, Portuguese)

These are binding. The first order set the architecture; the second corrected the implementation.
Where they differ, the second wins. Quoted exactly as the player wrote them on 2026-10-01.

---

## Order 1 — "Implemente AGORA um sistema de pedestres robusto"

> Implemente AGORA um sistema de pedestres robusto e encerre a sequência de remendos no `lanes.ts`.
> O motor atual está sendo ajustado para satisfazer censos: limites angulares, congelamento lateral, regras especiais de desvio, correções de tangente, snaps e exceções. PARE. Não crie `edit_lanes9.py` nem outra heurística equivalente.
> Preserve o que já foi corretamente construído: seção transversal das vias, calçadas, faixa livre, esquinas, travessias, mobiliário, permissões semafóricas e conectividade.
> Reconstrua apenas o MOTOR DE MOVIMENTO com arquitetura clara:
>
> 1. Walkable space
> Calçadas, esquinas e travessias devem formar superfícies/corredores navegáveis contínuos. Obstáculos como postes, bancos, prédios e bordas devem fazer parte do espaço navegável, não ser corrigidos depois por empurrões.
> 2. Route planning
> A rota define onde o pedestre pretende ir. O progresso ao longo dela é independente da orientação visual do personagem. Não permita reversões artificiais, teleportes ou saltos entre segmentos.
> 3. Crowd/local avoidance
> Use uma solução consolidada, preferencialmente Recast/Detour Crowd via `recast-navigation` compatível com Three.js. Não invente outro avoidance baseado em thresholds.
>
> O solver deve considerar simultaneamente:
>
> * agentes vizinhos;
> * suas velocidades;
> * direção desejada;
> * previsão de colisão;
> * obstáculos estáticos;
> * paredes/bordas;
> * espaço disponível;
> * velocidade máxima;
> * aceleração;
> * densidade local.
>
> Ele deve produzir uma única velocidade final contínua para cada agente.
>
> 4. Movimento
> A posição deve ser resultado exclusivamente da integração dessa velocidade usando timestep fixo. Nenhum sistema separado pode corrigir X/Z posteriormente.
> 5. Orientação e animação
> O corpo apenas acompanha suavemente a direção real de deslocamento. Orientação nunca controla posição. Agente parado não desliza. Agente esperando pode girar sem transladar.
> 6. Estados comportamentais
> Caminhar, esperar, atravessar, destino, grupo e semáforo devem alterar apenas intenção/target/restrições. Não podem implementar seu próprio sistema de movimento.
> 7. Interação entre pedestres
> O comportamento deve emergir do solver:
>
> * encontro frontal;
> * ultrapassagem;
> * fluxo bidirecional;
> * passagem em gargalos;
> * multidões;
> * grupos;
> * agentes parados;
> * entradas e saídas de cruzamentos.
>
> Não codifique regras específicas como "se encontrar alguém, vá para X". O sistema deve resolver genericamente qualquer combinação.
>
> VALIDAÇÃO OBRIGATÓRIA
> Abra o jogo real e teste visualmente, não apenas por métricas.
> Crie cenários reproduzíveis com:
>
> * 2 pedestres frente a frente;
> * 10 em fluxo bidirecional;
> * ultrapassagem de pedestre lento;
> * esquina de 90°;
> * curva fechada;
> * poste no caminho;
> * banco;
> * gargalo;
> * multidão;
> * fila esperando travessia;
> * travessia liberada simultaneamente nos dois sentidos;
> * grupos caminhando juntos;
> * destinos opostos.
>
> O sistema só está concluído quando visualmente:
>
> * não há dança/oscilação;
> * não há empurrões bruscos;
> * não há ré artificial;
> * não há deslizamento parado;
> * não há atravessamento de corpos;
> * não há atravessamento de obstáculos;
> * não há teleportes;
> * não há saltos em mudanças de segmento;
> * não há deadlocks recorrentes;
> * curvas são contínuas;
> * aceleração, desaceleração e rotação são naturais;
> * multidões continuam estáveis.
>
> O census/harness serve SOMENTE para encontrar regressões depois da implementação. É proibido alterar a mecânica apenas para reduzir um contador específico.
> Remova do motor novo todas as heurísticas antigas que ficaram redundantes.
> Não trabalhe no trânsito de veículos agora. Primeiro entregue o sistema de pedestres definitivamente funcional. Depois carros terão arquitetura própria de lane-following, car-following, lane-change e intersection control.
> Não faça nova análise extensa e não pare em diagnóstico. Leia o necessário, implemente, execute o jogo, observe os pedestres, corrija a causa estrutural dos defeitos encontrados e entregue o sistema funcionando.

---

## Order 2 — the 15 corrections

> Continue a implementação atual, mas corrija os pontos abaixo antes de considerar o sistema de pedestres concluído.
> A direção geral agora está correta: Detour/Recast como solver, cenários reproduzíveis, inspeção visual do jogo e traces numéricos. NÃO volte ao antigo modelo de remendos por threshold.
>
> PRESERVE: NavMesh/walkable space já construído; calçadas, esquinas e travessias; obstáculos e mobiliário; integração com semáforos; Detour Crowd; harness e cenários; inspeção visual real no jogo.
>
> **1. NÃO OTIMIZE PARA O TESTE.** É proibido alterar parâmetros, geometria, raio, destinos, spawn ou duração de cenário simplesmente para fazer um contador ficar verde. Se um cenário estiver objetivamente errado, corrija-o, mas: documente qual era o erro; preserve a dificuldade equivalente; não elimine a condição que deveria testar. Exemplo: spawn sobreposto artificialmente pode ser corrigido. Uma multidão densa válida não pode ser espaçada apenas para eliminar saltos.
>
> **2. RAIO DO PEDESTRE.** Verifique se esse valor representa de fato o footprint físico pretendido dos personagens e sua escala no mundo. Não diminua o corpo para permitir passagem em um local que geometricamente deveria ser estreito demais. O NavMesh e os obstáculos devem respeitar o tamanho real do agente. Teste explicitamente: dois pedestres lado a lado; passagem entre poste e borda; gargalo para uma pessoa; gargalo para duas pessoas; pessoas com modelos visuais diferentes. Não pode existir situação em que a cápsula lógica passe mas o modelo visual atravesse pessoa, poste, banco ou parede.
>
> **3. NÃO CONFUNDA PRIORIDADE COM TROCA DE DESTINO.** Mantenha separados: FINAL DESTINATION = onde a pessoa realmente quer chegar; PATH/CORRIDOR = rota global; LOCAL MANEUVER / YIELD = ação temporária para permitir passagem. Detour trabalha com avoidance local; se for necessária uma camada de yield para gargalos, implemente-a como comportamento genérico acima do solver. O destino final nunca deve ser destruído ou substituído semanticamente. Um agente pode receber temporariamente um local maneuver target, mas deve: continuar sabendo seu destino original; voltar automaticamente ao corredor; possuir timeout; não oscilar entre yield/go; não ficar preso em ciclos; não conter regras específicas para poste, esquina ou cenário de teste. Não chame isso de `avoidancePriority` se o mecanismo realmente é outro.
>
> **4. RESOLVA GARGALOS DE FORMA GENÉRICA.** O caso em que duas pessoas chegam a uma passagem para uma pessoa precisa funcionar sem empurrão, teleport ou dança. Implemente direito de passagem estável. Quando dois agentes entram em conflito incompatível: escolha deterministicamente quem continua; o outro cede espaço de maneira natural; mantenha essa decisão por tempo suficiente para a passagem ocorrer; depois libere o agente que cedeu. Evite troca de prioridade frame a frame. A solução deve funcionar com: 2 agentes; vários agentes; fluxos opostos; poste; banco; esquina estreita; porta/passagem; fila.
>
> **5. INVESTIGUE O CASO DE 0,07 m/s.** Determine objetivamente se é: A) fila legítima, com espaço bloqueado e progressão normal; ou B) starvation/microdeadlock causado pelo crowd solver ou pelo yield. Se for fila legítima, prove pelo trace que o agente progride quando o espaço à frente aparece. Se o espaço abre e ele continua a aproximadamente 0,07 m/s sem motivo, corrija a causa. Nenhum agente deve permanecer indefinidamente em velocidade residual por causa de um estado antigo.
>
> **6. DETOUR É A AUTORIDADE DO MOVIMENTO.** Não adicione correções externas de posição para "ajudar" o Detour. Nenhum: snap lateral; push manual; teleport; clamp posterior; reposicionamento frame a frame; correção angular que altere posição; afastamento artificial depois da atualização do crowd. Se Detour executar internamente resolução de colisão/posição, isso faz parte do próprio solver e deve permanecer. O que está proibido é uma segunda física externa tentando corrigir o resultado.
>
> **7. ORIENTAÇÃO VISUAL NÃO CONTROLA MOVIMENTO.** Separe definitivamente: navigation velocity → movimento físico; visual orientation → direção do corpo; animation → representação visual da velocidade. O personagem deve virar suavemente para a direção efetiva de deslocamento. Nunca altere velocidade ou posição somente porque o corpo ainda não terminou de girar. Isso deve eliminar definitivamente os antigos falsos eventos de "andar de ré".
>
> **8. PARADO SIGNIFICA PARADO.** Não classifique o agente como parado antes de o solver terminar desaceleração. Mas, quando realmente estiver parado: posição permanece estável; não desliza lateralmente; não deriva lentamente; rotação pode continuar; animação deve entrar corretamente em idle. Não crie threshold especial somente para satisfazer o census. Derive o estado da velocidade real e do estado comportamental.
>
> **9. PARÂMETROS DO DETOUR.** Pare de alternar presets tentando fazer cenários individuais passarem. Escolha um conjunto coerente de parâmetros a partir do comportamento global. Avalie em conjunto: `radius`; `maxAcceleration`; `maxSpeed`; `collisionQueryRange`; `separationWeight`; obstacle avoidance quality/type; `velBias`; `weightDesVel`; `weightCurVel`; `weightSide`; `weightToi`; `horizTime`. `collisionQueryRange` controla quão longe vizinhos/bordas entram na consulta, e `separationWeight` aumenta a tendência de separação, podendo também dificultar steering em espaços estreitos. Portanto, não maximize parâmetros isoladamente. O objetivo é um único preset coerente para uso normal, não um preset por cenário.
>
> **10. CONTINUIDADE TEMPORAL.** Evite decisões frame a frame instáveis. Estados como yield, crossing wait, route recovery e passagem por gargalo precisam possuir histerese/continuidade suficiente para impedir: esquerda/direita/esquerda/direita; go/yield/go/yield; acelera/freia repetidamente; troca constante de lado; troca constante de prioridade. A decisão pode mudar quando a situação realmente mudar, não por pequenas oscilações numéricas.
>
> **11. NÃO CONFUNDA GEOMETRIA INVÁLIDA COM AVOIDANCE.** Se uma passagem possui apenas 0,36 m úteis e o agente fisicamente necessita mais que isso, não force o solver a atravessar. Classifique corretamente: PASSÁVEL → NavMesh permite. IMPASSÁVEL → NavMesh não permite. PASSAGEM DE UMA PESSOA → permite um agente e exige negociação entre fluxos. PASSAGEM DE DUAS PESSOAS → permite cruzamento simultâneo quando houver largura física. O comportamento deve emergir da geometria verdadeira.
>
> **12. TESTES OBRIGATÓRIOS.** Mantenha uma bateria fixa e adversarial: head-on 2 agentes; fluxo bidirecional 10; fluxo bidirecional denso; ultrapassagem; agente lento na frente; esquina 90°; curva fechada; poste; banco; gargalo de uma pessoa; gargalo de duas pessoas; fila; travessia fechada; abertura da travessia; travessia simultânea nos dois sentidos; grupo; 40 pessoas; destinos cruzados; obstáculos combinados. Não remova cenários difíceis porque falharam.
>
> **13. TESTE VISUAL REAL.** Para cada cenário crítico, abra no jogo real. Use câmera FIXA nos testes temporais quando estiver analisando movimento. Não recoloque a câmera sobre o agente em cada frame porque isso mascara: deslizamento; saltos; oscilação; aceleração irregular. Capture sequência temporal suficiente para enxergar o evento inteiro: aproximação → conflito → resolução → saída.
>
> **14. MÉTRICAS.** Meça pelo menos: tempo até destino; distância mínima entre corpos; distância mínima de obstáculos; velocidade; aceleração; velocidade angular; progressão ao longo da rota; tempo parado; número de mudanças de yield; número de replans; saltos; reversões reais; agentes que não chegam; starvation. Mas NÃO codifique o movimento para satisfazer diretamente essas métricas. Elas detectam defeitos; não definem a mecânica.
>
> **15. CONDIÇÃO REAL DE CONCLUSÃO.** Não encerre porque "8 cenários passaram" ou porque o census chegou a zero. Conclua somente quando os cenários representativos e o jogo real demonstrarem: caminhada contínua; avoidance antecipado e suave; ultrapassagem natural; fluxo bidirecional; passagem por gargalos; filas funcionais; ausência de dança; ausência de jitter; ausência de ré artificial; ausência de deslizamento parado; ausência de teleport; ausência de saltos; ausência de sobreposição; ausência de atravessamento de mobiliário; ausência de starvation; ausência de deadlock recorrente; retomada natural depois de esperar; orientação corporal coerente; comportamento estável com multidões.
>
> IMPORTANTE: Não crie `crowd_fix3.py`, `crowd_fix4.py`, etc. como nova sequência de patches cegos. Edite a implementação real de forma organizada. Antes de cada alteração relevante: 1. reproduza; 2. obtenha trace; 3. determine a causa; 4. corrija a causa estrutural; 5. execute toda a bateria para verificar regressões; 6. observe visualmente quando o problema for comportamental.
>
> Continue da implementação atual. Não recomece o projeto, não remova o Detour e não volte para o antigo `lanes.ts` baseado em heurísticas. Não trabalhe no trânsito de veículos ainda. ENTREGUE PRIMEIRO O MOTOR DE PEDESTRES COMPLETO, ESTÁVEL E NATURAL.
