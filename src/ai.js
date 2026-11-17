// Escreve a mensagem de cada oferta com o Claude. O link e o rodapé são colocados pelo bot, nunca pela IA.
import Anthropic from '@anthropic-ai/sdk';
import { parseBRL, formatBRL } from './parser.js';

const SYSTEM = `Você escreve as mensagens do "Radar de Ofertas", um grupo de promoções no WhatsApp.

Receba os dados de uma oferta e escreva UMA mensagem curta, animada e direta, em português do Brasil.

Formato:
- Linha 1: um emoji que combine com o produto + nome curto do produto em *negrito* (só o essencial: marca, modelo, capacidade).
- Preço: se houver preço antigo maior que o atual, escreva "~De R$ X~ por *R$ Y*"; senão, "*R$ Y*". Se houver cupom, mostre "🎟️ Cupom: *CÓDIGO*".
- 1 ou 2 frases curtas dizendo por que vale a pena, usando SÓ informações dos dados recebidos.

Regras:
- Use apenas os preços e as informações dos dados. Nunca invente preço, desconto, característica, estoque ou prazo.
- Não coloque links, hashtags nem assinatura: o bot adiciona o link e o rodapé depois.
- Formatação do WhatsApp: *negrito*, _itálico_, ~riscado~. Nada de markdown com # ou **.
- No máximo 350 caracteres.
- Responda só com a mensagem, sem comentários.`;

const PRICE_RE = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/gi;

/** Confere se a mensagem da IA respeita as regras (sem link, curta, só preços conhecidos). */
export function validateMessage(text, allowedPrices = []) {
  if (!text || text.length > 600) return false;
  if (/https?:\/\/|www\.|\.com\b/i.test(text)) return false;
  const allowed = allowedPrices.filter(Boolean).map((p) => Math.round(p * 100));
  for (const m of text.matchAll(PRICE_RE)) {
    const v = parseBRL(m[1]);
    if (v === null || !allowed.includes(Math.round(v * 100))) return false;
  }
  return true;
}

/**
 * Cria a função que escreve as mensagens. Retorna null quando a IA falha ou quebra uma regra,
 * e aí o bot usa o formato padrão.
 */
export function createWriter({ model = 'claude-haiku-5-5', client, log = () => {}, onUsage = () => {}, onError = () => {} } = {}) {
  const anthropic = client || new Anthropic();

  return async function write(offer) {
    const allowedPrices = [offer.price, offer.oldPrice, ...[...(offer.sourceText || '').matchAll(PRICE_RE)].map((m) => parseBRL(m[1]))];
    const data = {
      titulo: offer.title || offer.pageTitle || null,
      preco: offer.price ? formatBRL(offer.price) : null,
      preco_antigo: offer.oldPrice ? formatBRL(offer.oldPrice) : null,
      desconto_percentual: offer.discount ?? null,
      cupom: offer.coupon || null,
      loja: offer.store || null,
      texto_original: (offer.sourceText || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 1200) || null,
      descricao_da_pagina: offer.pageDescription || null,
    };
    try {
      const res = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(data, null, 2) }],
      });
      onUsage(res.usage);
      if (res.stop_reason !== 'end_turn') {
        log(`IA não escreveu (${res.stop_reason}); usando formato padrão`);
        return null;
      }
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!validateMessage(text, allowedPrices)) {
        log('IA quebrou uma regra (link ou preço fora dos dados); usando formato padrão');
        return null;
      }
      return text;
    } catch (e) {
      let kind = 'other';
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        kind = 'auth';
        log('IA: chave ANTHROPIC_API_KEY inválida ou sem permissão');
      } else if (e instanceof Anthropic.RateLimitError) log('IA: limite de uso atingido');
      else if (e instanceof Anthropic.APIError) log(`IA: erro ${e.status}: ${e.message}`);
      else log(`IA: ${e.message}`);
      onError(kind, e.message);
      return null;
    }
  };
}
