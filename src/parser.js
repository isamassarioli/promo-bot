// Extrai dados de uma promoção a partir de texto livre (mensagem de grupo, item de RSS...).

const URL_RE = /https?:\/\/[^\s<>"'`*]+/gi;

export function extractUrls(text = '') {
  return (text.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?)\]]+$/, ''));
}

/** "1.299,90" -> 1299.9 | "1299" -> 1299 | "1.299" -> 1299 */
export function parseBRL(str) {
  let s = String(str).trim();
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const PRICE_RE = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/gi;

/** Retorna { price, oldPrice, discount } ignorando valores de parcela ("10x de R$ 29,90"). */
export function extractPrices(text = '') {
  const values = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/\d+\s*x\s*(de\s*)?$/i.test(before)) continue; // parcela
    const v = parseBRL(m[1]);
    if (v !== null && v > 0) values.push(v);
  }
  if (!values.length) return { price: null, oldPrice: null, discount: null };

  let price;
  let oldPrice = null;
  const dePor = text.match(
    /\bde:?\s*~?R\$\s*([\d.,]+)~?[\s\S]{0,40}?\bpor:?\s*\*?R\$\s*([\d.,]+)/i,
  );
  if (dePor) {
    oldPrice = parseBRL(dePor[1].replace(/[.,]$/, ''));
    price = parseBRL(dePor[2].replace(/[.,]$/, ''));
  } else {
    price = Math.min(...values);
    const max = Math.max(...values);
    if (max > price) oldPrice = max;
  }
  const discount =
    oldPrice && price && oldPrice > price ? Math.round((1 - price / oldPrice) * 100) : null;
  return { price, oldPrice, discount };
}

export function extractCoupon(text = '') {
  const m = text.match(/[Cc][Uu][Pp][Oo][Mm]\b[^\n A-Z0-9]*\s*(?:de desconto\s*)?[:\-]?\s*[`*_]*([A-Z0-9][A-Z0-9_-]{2,})/);
  if (m) return m[1];
  const m2 = text.match(/cupom\b[^\n]*?[`*]([A-Za-z0-9_-]{3,})[`*]/i);
  return m2 ? m2[1] : null;
}

export function extractTitle(text = '') {
  for (const line of text.split('\n')) {
    const clean = line
      .replace(URL_RE, '')
      .replace(/[*_~`]/g, '')
      .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
      .trim();
    if (clean.length >= 4) return clean;
  }
  return '';
}

export function parsePromoText(text = '') {
  return {
    title: extractTitle(text),
    urls: extractUrls(text),
    coupon: extractCoupon(text),
    ...extractPrices(text),
  };
}

export function formatBRL(n) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
