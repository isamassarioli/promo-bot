// Fonte: feeds RSS/Atom de sites de ofertas.
import Parser from 'rss-parser';

const parser = new Parser({ timeout: 15000, headers: { 'user-agent': 'Mozilla/5.0 (compatible; promo-bot)' } });

const stripHtml = (html = '') =>
  html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();

function itemImage(item) {
  if (item.enclosure?.url && /image|\.(jpe?g|png|webp)/i.test(item.enclosure.type || item.enclosure.url))
    return item.enclosure.url;
  const m = (item['content:encoded'] || item.content || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

const norm = (s = '') => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function itemToPromo(item, feedName) {
  return {
    source: `rss:${feedName}`,
    format: 'template',
    title: (item.title || '').trim(),
    text: stripHtml(item['content:encoded'] || item.content || item.contentSnippet || ''),
    url: item.link,
    image: itemImage(item),
    category: (item.categories?.[0] || '').toString().trim(),
  };
}

/** Inicia o polling de um feed. Na primeira leitura só memoriza os itens (não envia o histórico). */
export function watchFeed(feed, onPromo, log = () => {}, hooks = {}) {
  const known = new Set();
  let first = true;

  async function poll() {
    try {
      const data = await parser.parseURL(feed.url);
      for (const item of [...(data.items || [])].reverse()) {
        const id = item.guid || item.link;
        if (!id || known.has(id)) continue;
        known.add(id);
        if (first && !feed.sendBacklog) continue;
        if (!item.link) continue;
        const promo = itemToPromo(item, feed.name);
        const cat = norm(promo.category);
        if (cat && (feed.skipCategories || []).some((c) => norm(c) === cat)) continue;
        if (cat && (feed.priorityCategories || []).some((c) => norm(c) === cat)) promo.priority = true;
        await onPromo(promo);
      }
      first = false;
      hooks.ok?.(feed.name);
    } catch (e) {
      log(`RSS ${feed.name}: ${e.message}`);
      hooks.error?.(feed.name, e.message);
    }
  }

  poll();
  const timer = setInterval(poll, Math.max(30, feed.intervalSeconds || 120) * 1000);
  return () => clearInterval(timer);
}
