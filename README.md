# Aprova Professor — Conceição do Almeida 2026

Arquivos:
- `aprova-professor.html` — o app (frontend, arquivo único; progresso salvo no navegador).
- `aprova-ai-server.mjs` — servidor de IA (Node 18+, sem dependências). Guarda as chaves e busca o conteúdo dos vídeos.

## Como o resumo por link funciona
1. O aluno cola o link (YouTube, Instagram ou TikTok). O app detecta a plataforma.
2. O servidor valida a URL (allowlist, https, sem credenciais, redirecionamentos revalidados, bloqueio de IPs privados).
3. Busca metadados via oEmbed (título, canal, miniatura).
4. Obtém a transcrição por provedores substituíveis (ver abaixo). Se não houver, devolve `NO_TRANSCRIPT` e o app oferece, **opcionalmente**, colar a transcrição.
5. Envia a transcrição à IA (chave só no servidor) e devolve o resumo estruturado. Nada é inventado: sem conteúdo, sem resumo.

## Rodar
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ALLOWED_ORIGINS=https://seu-dominio.com   # só se o HTML ficar em outro domínio
export ENABLE_YT_PAGE_CAPTIONS=1                 # opcional (ver nota)
node aprova-ai-server.mjs                        # http://localhost:8787
```
Coloque `aprova-professor.html` na mesma pasta e abra `http://localhost:8787`: o app detecta o servidor sozinho.
Se hospedar o HTML em outro lugar, informe o endereço do servidor em **Perfil › Ajustes** e inclua a origem em `ALLOWED_ORIGINS`.
Use **Ajustes › Testar conexão** para ver o que está ativo.

## Provedores de transcrição (o que realmente funciona hoje)
| Provedor | Ativação | Observação |
|---|---|---|
| Texto colado pelo aluno | sempre | opcional; é o plano B |
| Legendas públicas da página do YouTube | `ENABLE_YT_PAGE_CAPTIONS=1` | só vídeos públicos com legendas. Não é API oficial: confira os termos do YouTube e esteja ciente de que pode falhar ou ser bloqueado em IPs de datacenter. |
| Serviço externo seu | `TRANSCRIPT_API_URL` + `TRANSCRIPT_API_KEY` | contrato: `POST {url, platform, lang}` → `{text, title?, channel?}`. Use para Instagram/TikTok ou para transcrição de áudio (ASR) com um serviço que tenha autorização para acessar o conteúdo. |

**Limitações honestas:** Instagram e TikTok não oferecem legendas públicas por API oficial; sem um serviço externo contratado, esses links só funcionam com transcrição colada. O oEmbed do Instagram exige `META_OEMBED_TOKEN`. O servidor não contorna login, conteúdo privado, paywalls nem proteções anti-bot. A transcrição por áudio (ASR) não está embutida: é função do serviço externo.

## Segurança e privacidade
- Chaves nunca vão ao navegador. O servidor não grava links, transcrições nem resumos (a biblioteca fica no `localStorage` do aluno).
- Limite de 60 requisições/hora por IP, corpo máx. 1,5 MB, timeouts em todas as chamadas.
- Defina `ALLOWED_ORIGINS` e, em produção, coloque o servidor atrás de HTTPS e de um limitador de uso real.
- A resolução DNS é checada antes de cada requisição, mas há uma janela mínima de *DNS rebinding*; como os hosts já são allowlisted, o risco é baixo.
