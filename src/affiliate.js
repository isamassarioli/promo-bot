// Troca links de produto pelos seus links de afiliado, conforme as regras do config.
import { extractUrls } from './parser.js';

const SHORTENERS = [
  'amzn.to', 'a.co', 'bit.ly', 'tinyurl.com', 'cutt.ly', 't.co', 'tidd.ly', 'is.gd',
  'shope.ee', 's.shopee.com.br', 'mercadolivre.com/sec', 'magalu.lu', 'onelink.me',
  's.click.aliexpress.com', 'divulgador.magalu.com', 'meli.la', 'tinyurl.com', 'encurtador.com.br',
];

// Links que nunca devem ser repassados (convites de outros grupos/canais).
const INVITE_RE = /(chat\.whatsapp\.com|whatsapp\.com\/channel|wa\.me|t\.me|telegram\.me)\//i;

export const isInviteLink = (url) => INVITE_RE.test(url);

function isShort(url) {
  try {
    const u = new URL(url);
    const hp = u.hostname.replace(/^www\./, '') + u.pathname;
    return SHORTENERS.some((s) => (s.includes('/') ? hp.startsWith(s) : u.hostname.endsWith(s)));
  } catch {
    return false;
  }
}

/** Segue redirecionamentos de encurtadores para chegar na URL real do produto. */
export async function expandUrl(url, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!isShort(url)) return url;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' },
    });
    res.body?.cancel?.().catch(() => {});
    return res.url || url;
  } catch {
    return url;
  }
}

const hostMatches = (url, domains = []) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
};

/**
 * Sites agregadores (ex.: ofertaesperta.com) linkam para uma página própria, que só então leva à loja.
 * Abre essa página e devolve o primeiro link de loja que tenha regra de afiliado, ou null.
 */
export async function resolveDealPage(url, rules = [], { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' },
    });
    const html = (await res.text())
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/&amp;/g, '&');
    for (const found of extractUrls(html)) {
      if (/\/social\//.test(found)) continue; // vitrine do afiliado, não é produto
      if (findRule(found, rules)) return found;
    }
  } catch {
    /* página fora do ar: fica com o link original */
  }
  return null;
}

function findRule(url, rules) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return rules.find((r) => host === r.domain || host.endsWith('.' + r.domain)) || null;
}

/** Aplica a regra do domínio. Retorna { url, matched }. */
export function applyRules(url, rules = []) {
  const rule = findRule(url, rules);
  if (!rule) return { url, matched: false };
  const u = new URL(url);
  // Link que já é seu (todos os setParams com os seus valores): não mexe, para não perder
  // parâmetros que o próprio programa colocou (ex.: "ref" dos links meli.la do Mercado Livre).
  const sets = Object.entries(rule.setParams || {});
  if (sets.length && sets.every(([k, v]) => u.searchParams.get(k) === v)) return { url, matched: true, own: true };
  if (rule.clearParams) u.search = '';
  for (const p of rule.removeParams || []) u.searchParams.delete(p);
  if (rule.replaceHost) u.hostname = rule.replaceHost;
  if (rule.replacePath) u.pathname = u.pathname.replace(new RegExp(rule.replacePath[0]), rule.replacePath[1]);
  if (rule.prefixPath && !u.pathname.startsWith(rule.prefixPath)) u.pathname = rule.prefixPath + u.pathname;
  for (const [k, v] of Object.entries(rule.setParams || {})) u.searchParams.set(k, v);
  u.hash = '';
  let out = u.toString();
  if (rule.template) out = rule.template.replace('{url}', encodeURIComponent(out));
  return { url: out, matched: true };
}

/**
 * Reescreve todos os links de um texto.
 * Retorna { text, links: [{ original, expanded, final, matched }] }.
 * Linhas com convites de outros grupos são removidas.
 */
export async function rewriteLinks(text, affiliate = {}, opts = {}) {
  const rules = affiliate.rules || [];
  const links = [];
  let out = text
    .split('\n')
    .filter((line) => !extractUrls(line).some(isInviteLink))
    .join('\n');

  for (const original of [...new Set(extractUrls(out))]) {
    let expanded = affiliate.expandShortLinks === false ? original : await expandUrl(original, opts);
    if (hostMatches(expanded, affiliate.dealPages)) {
      const store = await resolveDealPage(expanded, rules, opts);
      if (store) expanded = await expandUrl(store, opts);
    }
    const { url: applied, matched, own } = applyRules(expanded, rules);
    const final = own ? original : applied;
    links.push({ original, expanded, final, matched });
    // Sem regra, ou link que já é seu: mantém o link original (curto) em vez do expandido.
    if (matched && !own) out = out.split(original).join(final);
  }
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), links };
}
