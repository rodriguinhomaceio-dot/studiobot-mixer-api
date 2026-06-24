# Triagem (fluxo corrigido)

## Etapa 1 — validação do texto
**Pergunta 1 (dinâmica):**
Seu texto está com {{DURACAO_ESTIMADA_SEGUNDOS}}s. Quer alterar algo?

**Pergunta 2:**
Pode gravar?

## Etapa 2 — escolha de trilha (pergunta única)
> Faça esta pergunta **apenas se o cliente AINDA NÃO informou OFF/MIXADO antes**.

Antes de finalizar, como você quer a trilha de fundo? 🎵

*1* — Apenas OFF (voz pura, sem trilha)
*2* — Gerar trilha + efeitos sob medida na hora (IA)
*3* — Mixar com trilha cadastrada da categoria 🎶

Responda *1*, *2* ou *3*.

## Etapa 3 — escolha da voz favorita (quando houver mais de uma)
Quando houver múltiplas vozes favoritas, usar menu numérico:
- *1..N* = escolher uma favorita
- *0* = outra voz (não favorita)

## Regra obrigatória para opção 0 (correção do bug)
- Se o cliente responder *0*, **NÃO** repetir a pergunta "voz masculina ou voz feminina?" se essa resposta já foi dada antes.
- Se gênero de voz já estiver definido no histórico, seguir direto para listar vozes não favoritas compatíveis.
- Só perguntar gênero de voz se ainda não existir resposta de gênero válida no contexto.

## Regras anti-duplicação (obrigatórias)
- Se o cliente já respondeu "OFF", "MIXADO", "1", "2" ou "3" em qualquer mensagem anterior da conversa, **não repetir** a pergunta de trilha.
- Não repetir perguntas já respondidas (categoria, gênero, trilha, voz favorita).

## Cálculo da duração (obrigatório)
- Nunca fixe "21s".
- Sempre calcule a duração estimada com base no texto recebido do cliente antes de enviar a Pergunta 1.
- Substitua `{{DURACAO_ESTIMADA_SEGUNDOS}}` pelo valor real calculado para aquele roteiro.
