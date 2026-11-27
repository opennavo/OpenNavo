## Novidades

- Cole texto, links, caminhos de arquivos e imagens no compositor do Hermes. Links e caminhos ficam como chips de referência, textos longos e imagens da área de transferência viram anexos, e colagens grandes demais são recusadas antes de qualquer inserção.
- O seletor de modelos do Hermes agora tem busca, e a descoberta de modelos locais roda em um processo separado, então explorar modelos não grava mais no perfil ativo nem bloqueia o chat.

## Correções

- Uma falha breve de rede ou de ativação não substitui mais a conversa por uma tela de login. O histórico em cache continua visível atrás de um aviso de reconexão, e tentar de novo verifica imediatamente.
- O seletor de sessões recarrega o histórico sempre que abre ou muda de visão, então sessões criadas por outro cliente, gateway ou tarefa agendada aparecem sem reiniciar o app.
- O compositor cresce com um rascunho de várias linhas até 110 px, inclusive durante a composição de IME, e volta à altura original quando Enviar ou Novo chat limpa o rascunho.
- Um turno parado agora mostra um selo claro de turno parado, e respostas interrompidas ficam vazias; a interface em inglês não mostra mais texto chinês de parada.
- Enviar enquanto uma resposta está em execução segue a política de entrada ocupada: a mensagem é redirecionada, guiada ou enfileirada em vez de iniciar um segundo turno, e Parar continua disponível.
- Atualizações de streaming e de raciocínio não puxam mais o histórico para o final enquanto você lê mensagens anteriores. Ele só acompanha o conteúdo mais recente quando você já está no final.
- A instalação, atualização e desinstalação do runtime do Hermes agora compartilham um único ciclo de vida: cada instalação é preparada em um diretório próprio, uma ativação com falha é revertida, apenas processos iniciados pelo OpenNavo são limpos, e um gateway que não inicia falha imediatamente em vez de deixar o chat meio iniciado.
- O histórico permanece consistente entre clientes e acompanha renomeações e exclusões de perfis; o estado de painéis e modelos fica isolado por janela, e as ações de turno ficam vinculadas ao próprio turno, para que um turno em segundo plano não possa parar ou encerrar outra conversa.
- Um provedor personalizado não recorre mais silenciosamente aos modelos integrados quando seu catálogo não está acessível.
