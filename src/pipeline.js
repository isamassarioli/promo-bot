// Recebe promoções brutas de qualquer fonte -> filtra -> troca links -> deduplica -> formata -> fila.
import crypto from 'node:crypto';
import { rewriteLinks } from './affiliate.js';
import { parsePromoText, formatBRL } from './parser.js';
import { fetchProductInfo } from './product.js';

const norm = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function hasKeyword(text, words = []) {
  const t = ' ' + norm(text) + ' ';
  return words.some((w) => t.includes(' ' + norm(w) + ' '));
}

export function dedupeKey(promo, links) {
  const product = links.find((l) => l.matched) || links[0];
  if (product) {
    try {
      const u = new URL(product.expanded);
      return 'u:' + u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    } catch {
      /* cai no hash */
    }
  }
  const basis = norm(promo.title || promo.text || '').slice(0, 80) + '|' + (promo.price ?? '');
  return 'h:' + crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

export function formatTemplate(promo, link, footer) {
  const lines = [`🔥 *${promo.title}*`, ''];
  if (promo.oldPrice && promo.price && promo.oldPrice > promo.price) {
    lines.push(`~De ${formatBRL(promo.oldPrice)}~`);
    lines.push(`💰 *Por ${formatBRL(promo.price)}* (-${promo.discount}%)`);
  } else if (promo.price) {
    lines.push(`💰 *${formatBRL(promo.price)}*`);
  }
  if (promo.coupon) lines.push(`🎟️ Cupom: *${promo.coupon}*`);
  if (link) lines.push('', `🛒 ${link}`);
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

/**
 * promo: { source, text, title?, url?, image?: string|Buffer, format?: 'repost'|'template' }
 * - 'repost': mantém o texto original (grupos de WhatsApp), só trocando links.
 * - 'template': monta a mensagem a partir de título/preço/link (RSS).
 */
export function createPipeline({ config, store, enqueue, log = () => {}, fetchImpl, writer }) {
  const filters = config.filters || {};
  const footer = config.message?.footer || '';

  return async function handle(raw) {
    store.bump('captured');
    const fullText = [raw.title, raw.text, raw.url].filter(Boolean).join('\n');
    const parsed = parsePromoText(fullText);
    const promo = { ...parsed, ...raw, title: raw.title || parsed.title };

    const reject = (reason, stat = 'filtered') => {
      store.bump(stat);
      log(`descartada (${reason}): ${promo.title?.slice(0, 60)}`);
      return { ok: false, reason };
    };

    if (!parsed.urls.length) return reject('sem link');
    if (hasKeyword(fullText, filters.blockedKeywords)) return reject('palavra bloqueada');
    if (filters.requiredKeywords?.length && !hasKeyword(fullText, filters.requiredKeywords))
      return reject('sem palavra obrigatória');
    if (filters.minDiscountPercent > 0 && (promo.discount ?? 0) < filters.minDiscountPercent)
      return reject('desconto baixo');
    if (filters.maxPrice > 0 && promo.price && promo.price > filters.maxPrice) return reject('preço alto');

    const body = promo.format === 'template' ? (raw.url || parsed.urls[0]) : raw.text;
    const { text: rewritten, links } = await rewriteLinks(body, config.affiliate, { fetchImpl });
    if (!links.length) return reject('só tinha link de convite');
    // !promo é do próprio admin (ex.: link gerado no app do TikTok Shop): nunca descarta por falta de regra.
    if (raw.source !== 'manual' && config.affiliate?.unknownLinks === 'drop' && !links.some((l) => l.matched))
      return reject('loja sem regra de afiliado');

    const key = dedupeKey(promo, links);
    if (store.hasSeen(key)) return reject('duplicada', 'duplicates');
    store.markSeen(key);

    let message =
      promo.format === 'template'
        ? formatTemplate(promo, rewritten, footer)
        : [rewritten, footer].filter(Boolean).join('\n\n');

    // Página do produto: foto quando a oferta não trouxe uma, e contexto para a IA.
    const wantImage = config.message?.sendImages !== false;
    let image = wantImage ? raw.image || null : null;
    if (writer || (wantImage && !image)) {
      const product = links.find((l) => l.matched) || links[0];
      const page = await fetchProductInfo(product.expanded, { fetchImpl });
      if (wantImage && !image) image = page.image;
      if (writer) {
        let shop = null;
        try {
          shop = new URL(product.expanded).hostname.replace(/^www\./, '');
        } catch {
          /* sem loja */
        }
        const text = await writer({
          title: raw.title || null,
          pageTitle: page.title,
          pageDescription: page.description,
          price: promo.price,
          oldPrice: promo.oldPrice,
          discount: promo.discount,
          coupon: promo.coupon,
          store: shop,
          sourceText: raw.text,
        });
        if (text) message = [text, `🛒 ${product.final}`, footer].filter(Boolean).join('\n\n');
      }
    }

    const item = {
      key,
      source: raw.source,
      text: message,
      image,
      priority: !!raw.priority,
      createdAt: Date.now(),
    };
    enqueue(item);
    return { ok: true, item };
  };
}
