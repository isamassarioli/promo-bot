import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseBRL, extractPrices, extractCoupon, extractTitle, extractUrls } from '../src/parser.js';
import { applyRules, rewriteLinks } from '../src/affiliate.js';
import { createPipeline } from '../src/pipeline.js';
import { inQuietHours, SendQueue } from '../src/queue.js';
import { Store } from '../src/store.js';
import { watchFeed } from '../src/sources/rss.js';

const rules = [
  { domain: 'amazon.com.br', clearParams: true, setParams: { tag: 'meu-20' } },
  { domain: 'magazineluiza.com.br', replaceHost: 'www.magazinevoce.com.br', prefixPath: '/magazineminha' },
  { domain: 'magazinevoce.com.br', replacePath: ['^/magazine[^/]+', '/magazineminha'] },
  { domain: 'kabum.com.br', template: 'https://awin.example/?id=1&ued={url}' },
];

test('parseBRL', () => {
  assert.equal(parseBRL('1.299,90'), 1299.9);
  assert.equal(parseBRL('1.299'), 1299);
  assert.equal(parseBRL('89,9'), 89.9);
  assert.equal(parseBRL('45'), 45);
});

test('preços: de/por, parcelas ignoradas, desconto', () => {
  assert.deepEqual(extractPrices('De R$ 1.999,00 por R$ 1.499,00 ou 10x de R$ 149,90'), {
    price: 1499, oldPrice: 1999, discount: 25,
  });
  assert.deepEqual(extractPrices('Fone JBL 🔥 R$ 89,90'), { price: 89.9, oldPrice: null, discount: null });
  assert.equal(extractPrices('~R$ 200~ agora R$100 no pix').discount, 50);
  assert.equal(extractPrices('sem preço').price, null);
});

test('cupom, título e urls', () => {
  assert.equal(extractCoupon('Use o cupom: TECH10 no carrinho'), 'TECH10');
  assert.equal(extractCoupon('🎟️ Cupom *VEMPRA20*'), 'VEMPRA20');
  assert.equal(extractCoupon('nada aqui'), null);
  assert.equal(extractTitle('🔥🔥\n*Air Fryer Mondial 4L*\nR$ 299'), 'Air Fryer Mondial 4L');
  assert.deepEqual(extractUrls('veja https://a.com/x?y=1. e (https://b.com/z)'), ['https://a.com/x?y=1', 'https://b.com/z']);
});

test('regras de afiliado', () => {
  assert.equal(
    applyRules('https://www.amazon.com.br/dp/B0ABC?tag=outro-20&ref=x', rules).url,
    'https://www.amazon.com.br/dp/B0ABC?tag=meu-20',
  );
  assert.equal(
    applyRules('https://www.magazineluiza.com.br/tv-lg/p/123/', rules).url,
    'https://www.magazinevoce.com.br/magazineminha/tv-lg/p/123/',
  );
  assert.equal(
    applyRules('https://www.magazinevoce.com.br/magazineoutro/tv/p/1/', rules).url,
    'https://www.magazinevoce.com.br/magazineminha/tv/p/1/',
  );
  assert.equal(
    applyRules('https://www.kabum.com.br/produto/1', rules).url,
    'https://awin.example/?id=1&ued=https%3A%2F%2Fwww.kabum.com.br%2Fproduto%2F1',
  );
  assert.equal(applyRules('https://loja.com/x', rules).matched, false);
  assert.equal(applyRules('https://fakeamazon.com.br/x', rules).matched, false);
});

test('rewriteLinks expande encurtador e remove convites', async () => {
  const fetchImpl = async () => ({ url: 'https://www.amazon.com.br/dp/B0XYZ?tag=deles-20' });
  const { text, links } = await rewriteLinks(
    'Echo Dot R$ 199\nhttps://amzn.to/abc\n\nEntre no grupo: https://chat.whatsapp.com/XXXX',
    { rules },
    { fetchImpl },
  );
  assert.equal(text, 'Echo Dot R$ 199\nhttps://www.amazon.com.br/dp/B0XYZ?tag=meu-20');
  assert.equal(links.length, 1);
});

function setup(extra = {}) {
  const sent = [];
  const store = new Store(null);
  const config = { affiliate: { rules, expandShortLinks: false }, message: { footer: 'RODAPÉ' }, filters: {}, ...extra };
  const handle = createPipeline({ config, store, enqueue: (i) => sent.push(i) });
  return { handle, sent, store };
}

test('pipeline: repost troca link, põe rodapé e deduplica', async () => {
  const { handle, sent, store } = setup();
  const text = '*Kindle 11* por R$ 399\nhttps://www.amazon.com.br/dp/B0K?tag=x';
  assert.equal((await handle({ source: 'g', format: 'repost', text })).ok, true);
  assert.equal(sent[0].text, '*Kindle 11* por R$ 399\nhttps://www.amazon.com.br/dp/B0K?tag=meu-20\n\nRODAPÉ');
  // mesma oferta vinda de outro grupo, com outro texto e outra tag
  const again = await handle({ source: 'g2', format: 'repost', text: 'KINDLE!! https://amazon.com.br/dp/B0K?tag=y' });
  assert.equal(again.reason, 'duplicada');
  assert.equal(sent.length, 1);
  assert.equal(store.data.stats.duplicates, 1);
});

test('pipeline: template (RSS) e filtros', async () => {
  const { handle, sent } = setup({ filters: { blockedKeywords: ['bet'], minDiscountPercent: 20 } });
  const r = await handle({
    source: 'rss', format: 'template', title: 'SSD 1TB Kingston',
    text: 'De R$ 500,00 por R$ 350,00. Cupom: SSD50', url: 'https://www.kabum.com.br/produto/9',
  });
  assert.equal(r.ok, true);
  assert.match(sent[0].text, /🔥 \*SSD 1TB Kingston\*/);
  assert.match(sent[0].text, /-30%/);
  assert.match(sent[0].text, /Cupom: \*SSD50\*/);
  assert.match(sent[0].text, /awin\.example/);
  assert.equal((await handle({ source: 'g', text: 'Bônus na bet https://x.com/a' })).reason, 'palavra bloqueada');
  assert.equal((await handle({ source: 'g', text: 'TV de R$ 100 por R$ 95 https://x.com/b' })).reason, 'desconto baixo');
  assert.equal((await handle({ source: 'g', text: 'bom dia grupo' })).reason, 'sem link');
  assert.equal((await handle({ source: 'g', text: 'Tablet https://x.com/tablet de R$ 100 por R$ 50' })).ok, true); // "tablet" não casa com "bet"
});

test('horário de silêncio', () => {
  const at = (h) => new Date(2026, 0, 1, h);
  assert.equal(inQuietHours({ start: 23, end: 7 }, at(2)), true);
  assert.equal(inQuietHours({ start: 23, end: 7 }, at(23)), true);
  assert.equal(inQuietHours({ start: 23, end: 7 }, at(12)), false);
  assert.equal(inQuietHours(null, at(2)), false);
});

test('fila envia para todos os destinos e respeita pausa', async () => {
  const out = [];
  const store = new Store(null);
  store.paused = true;
  const q = new SendQueue({
    sending: { minIntervalSeconds: 0, delayBetweenGroupsSeconds: [0, 0], quietHours: null },
    store, getTargets: () => ['a@g.us', 'b@g.us'], send: async (jid, item) => out.push(jid + item.text),
  });
  q.push({ key: 'k', text: 'oi', createdAt: Date.now() });
  q.start();
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(out.length, 0);
  store.paused = false;
  await new Promise((r) => setTimeout(r, 1300));
  q.stop();
  assert.deepEqual(out, ['a@g.usoi', 'b@g.usoi']);
});

test('RSS: ignora histórico e capta itens novos', async () => {
  let items = '<item><title>Antigo</title><link>https://x.com/1</link><guid>1</guid></item>';
  const server = http.createServer((_, res) => {
    res.setHeader('content-type', 'application/rss+xml');
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`);
  }).listen(0);
  const got = [];
  const feed = { name: 't', url: `http://127.0.0.1:${server.address().port}/`, intervalSeconds: 30 };
  const stop = watchFeed(feed, async (p) => got.push(p));
  await new Promise((r) => setTimeout(r, 400));
  stop();
  assert.equal(got.length, 0);
  // segunda leitura com item novo (novo watcher com sendBacklog simula o próximo ciclo)
  items += '<item><title>Novo R$ 10</title><link>https://x.com/2</link><guid>2</guid><description>&lt;img src="https://x.com/i.jpg"&gt; oferta</description></item>';
  const stop2 = watchFeed({ ...feed, sendBacklog: true }, async (p) => got.push(p));
  await new Promise((r) => setTimeout(r, 400));
  stop2();
  server.close();
  assert.equal(got.length, 2);
  const novo = got.find((p) => p.title === 'Novo R$ 10');
  assert.equal(novo.image, 'https://x.com/i.jpg');
  assert.equal(novo.format, 'template');
});
