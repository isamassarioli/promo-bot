// Lê título, descrição, foto e preços da página do produto, para enriquecer a mensagem.
import { parseBRL } from './parser.js';

const decode = (s = '') =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`,
      'i',
    );
    const m = html.match(re);
    if (m) return decode(m[1] || m[2]);
  }
  return null;
}

/** Retorna { title, description, image } (campos podem vir null). Nunca lança erro. */
export async function fetchProductInfo(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const empty = { title: null, description: null, image: null, price: null, oldPrice: null };
  if (!url) return empty;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'accept-language': 'pt-BR,pt;q=0.9',
      },
    });
    const html = (await res.text()).slice(0, 3_000_000);
    // Amazon não usa Open Graph: pega a foto principal (data-old-hires) e o <title>.
    const image =
      meta(html, ['og:image', 'twitter:image']) ||
      decode(html.match(/data-old-hires="(https:[^"]+)"/)?.[1] || '') ||
      null;
    const pageTitle = decode(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').split(/ : Amazon| \| Mercado Livre/)[0] || null;
    return {
      ...amazonPrices(html),
      title: meta(html, ['og:title', 'twitter:title']) || pageTitle,
      description: meta(html, ['og:description', 'description'])?.slice(0, 600) || null,
      // WhatsApp não aceita .webp como foto; o Mercado Livre serve a mesma imagem em .jpg.
      image: image && /^https?:\/\//.test(image) ? image.replace(/(mlstatic\.com\/.+)\.webp$/, '$1.jpg') : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Amazon: preço atual (o que o cliente paga) e o preço "De" riscado que a própria página mostra.
 * Só lê dentro do bloco de preço principal, para não pegar o preço de outro produto da página.
 */
export function amazonPrices(html = '') {
  const at = html.indexOf('corePriceDisplay_desktop_feature_div');
  if (at < 0) return { price: null, oldPrice: null };
  const block = html.slice(at, at + 25_000);
  const money = (re) => {
    const m = block.match(re);
    const txt = m ? m[1].replace(/R\$|&nbsp;|\s/g, '') : '';
    return /\d/.test(txt) ? parseBRL(txt) : null;
  };
  // O preço atual vem em partes (inteiro + centavos); o texto "offscreen" às vezes vem vazio.
  const whole = block.match(
    /apex-pricetopay-value[\s\S]{0,600}?a-price-whole">([\d.]+)<span class="a-price-decimal">,<\/span><\/span><span class="a-price-fraction">(\d+)</,
  );
  const price =
    (whole ? parseBRL(`${whole[1]},${whole[2]}`) : null) ||
    money(/apex-pricetopay-value[\s\S]{0,400}?<span class="a-offscreen">([^<]+)</);
  const oldPrice = money(/data-a-strike="true"[^>]*><span class="a-offscreen">([^<]+)</);
  return { price, oldPrice: oldPrice && price && oldPrice > price ? oldPrice : null };
}
