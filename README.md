# Changeling: Mil Faces

Módulo para Foundry VTT (v13–v14, feito para D&D 5e) que automatiza o traço **Metamorfo** do changeling.

## O que faz

- **Botão de máscaras no Token HUD** (coluna direita) do seu personagem: abre uma paleta de rostos no estilo do Token Variant Art. Clique num rosto para trocar; botão direito num rosto para renomear, ajustar a escala ou esquecê-lo.
- **Memorizar rostos de NPCs, aliados e inimigos:**
  - passe o mouse sobre um token e aperte **Alt+C**, ou
  - ligue o **modo de captura** (conta-gotas na paleta, ferramenta nos controles de token, ou **Alt+X**) e clique nos tokens. **Esc** sai do modo.
  - O nome sugerido é o nome do token, a não ser que o GM o tenha escondido. Aí fica como "Rosto desconhecido".
- **Enviar imagens em tempo real, sem ser o host:** arraste o arquivo para a paleta ou para o grimório, cole com **Ctrl+V** ou cole um link. A imagem é reduzida (WEBP), passa pelo navegador do GM conectado e é salva no servidor. Assim o jogador **não precisa** da permissão "Enviar arquivos".
- **Forma verdadeira:** é registrada sozinha na primeira transformação. Para voltar a ela use o primeiro rosto da paleta ou **Alt+R**. Se o personagem morrer (3 falhas em testes contra a morte ou a condição Morto), ele volta sozinho à forma verdadeira.
- **Transição animada** ao trocar de rosto (Metamorfose por padrão; dá para mudar nas configurações).
- O disfarce troca a arte, a escala, o anel dinâmico e, se você quiser, o nome do token. O token protótipo também muda, então o disfarce continua em cenas novas.
- **Grimório de rostos** (**Alt+V** ou botão direito no botão de máscaras): mostra todos os rostos, deixa reordenar arrastando e tem área para soltar arquivos.
- Se o **Token Variant Art** estiver instalado, os rostos também aparecem como variantes compartilhadas no HUD dele. Ele é opcional.

## Instalação (para o GM)

1. Na tela de Setup do Foundry, vá em **Módulos complementares → Instalar módulo** e cole este link no campo **URL do manifesto**:

   ```
   https://github.com/guij2/changeling-faces/releases/latest/download/module.json
   ```

   Funciona também no The Forge (*Install from manifest URL*). Outra opção é baixar o `changeling-faces.zip` da [página de releases](https://github.com/guij2/changeling-faces/releases) e extraí-lo em `Data/modules/changeling-faces/`.
2. Abra o mundo e ative **Changeling: Mil Faces** em *Gerenciar Módulos*.
3. **Defina quem é o changeling.** Nada aparece para nenhum jogador até você fazer isso. Há duas formas:
   - na barra lateral de **Atores**, clique com o botão direito no personagem e escolha **Definir como changeling**, ou
   - no **Token HUD** do personagem, clique no botão de **DNA** (coluna esquerda; só o GM o vê).

   O dono do personagem passa a ver a paleta, as ferramentas e os atalhos na hora, sem recarregar. Para tirar, use o mesmo lugar (**Remover changeling**): a interface some e os rostos ficam guardados, caso você devolva depois. A lista fica nas configurações do mundo, que o jogador não consegue editar. O botão de DNA pulsa de leve quando a ficha parece ser de um changeling (espécie ou traço com esse nome), mas isso é só uma dica.
4. (Opcional) Em *Configurações → Changeling: Mil Faces*:
   - **Destino dos envios**: "Pasta de dados" no Foundry próprio. No The Forge ele já vem configurado para usar a biblioteca de assets.
   - **Pasta dos envios**: o padrão é `changeling-faces/<mundo>/<personagem>`.
   - **Sussurrar trocas ao GM**: você recebe uma mensagem privada a cada troca de rosto.

Para os envios funcionarem, **um GM precisa estar conectado**. A outra opção é dar ao jogador a permissão "Enviar arquivos", e aí ele envia direto. O GM só aceita envios para personagens que ele definiu como changeling.

## Atalhos (editáveis em Configurar Controles)

| Atalho | Ação |
|---|---|
| Alt+C | Memorizar o rosto do token sob o cursor |
| Alt+X | Ligar/desligar o modo de captura |
| Alt+V | Abrir o grimório de rostos |
| Alt+R | Voltar à forma verdadeira |

## API para macros

```js
const api = game.modules.get("changeling-faces").api;
api.openLibrary();                 // grimório do seu changeling
api.captureToken(canvas.tokens.hover);
api.applyAppearance(actor, id);    // ou api.TRUE_FORM_ID
api.revert(actor);
```
