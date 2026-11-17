import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseBRL, extractPrices, extractCoupon, extractTitle, extractUrls } from '../src/parser.js';
import { applyRules, rewriteLinks } from '../src/affiliate.js';
import { createPipeline } from '../src/pipeline.js';
import { inQuietHours, SendQueue } from '../src/queue.js';
import { Store } from '../src/store.js';
import { watchFeed } from '../src/sources/rss.js';
import { createWriter, validateMessage } from '../src/ai.js';
import { fetchProductInfo } from '../src/product.js';
import { createMonitor } from '../src/monitor.js';

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

test('rewriteLinks abre página de agregador e usa o link da loja', async () => {
  const pages = {
    'https://www.ofertaesperta.com/promocao/1/fone':
      '<img src="https://s3.amazonaws.com/x.png"><script>{\\"url\\":\\"https:\\/\\/www.amazon.com.br\\/dp\\/B0FONE?tag=deles-20\\"}</script>',
    'https://www.ofertaesperta.com/promocao/2/loja-sem-regra': '<a href="https://www.casasbahia.com.br/p/1">ver</a>',
  };
  const fetchImpl = async (url) => ({ url, text: async () => pages[url] ?? '' });
  const affiliate = { rules, dealPages: ['ofertaesperta.com'] };

  const ok = await rewriteLinks('https://www.ofertaesperta.com/promocao/1/fone', affiliate, { fetchImpl });
  assert.equal(ok.text, 'https://www.amazon.com.br/dp/B0FONE?tag=meu-20');
  assert.equal(ok.links[0].matched, true);

  const none = await rewriteLinks('https://www.ofertaesperta.com/promocao/2/loja-sem-regra', affiliate, { fetchImpl });
  assert.equal(none.text, 'https://www.ofertaesperta.com/promocao/2/loja-sem-regra');
  assert.equal(none.links[0].matched, false);
});

function setup(extra = {}) {
  const sent = [];
  const store = new Store(null);
  const config = { affiliate: { rules, expandShortLinks: false }, message: { footer: 'RODAPÉ' }, filters: {}, ...extra };
  const fetchImpl = async (url) => ({ url, text: async () => '' });
  const handle = createPipeline({ config, store, fetchImpl, writer: extra.writer, enqueue: (i) => sent.push(i) });
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

test('pipeline: unknownLinks drop descarta loja sem regra, exceto no !promo', async () => {
  const { handle, sent } = setup({ affiliate: { rules, expandShortLinks: false, unknownLinks: 'drop' } });
  const text = 'Fone R$ 49 https://vt.tiktok.com/ZSabc123/';
  assert.equal((await handle({ source: 'grupo:x', format: 'repost', text })).reason, 'loja sem regra de afiliado');
  assert.equal((await handle({ source: 'manual', format: 'repost', text })).ok, true);
  assert.equal(sent[0].text, 'Fone R$ 49 https://vt.tiktok.com/ZSabc123/\n\nRODAPÉ');
});

test('fila: prioridade passa na frente das comuns, mantendo a ordem entre prioritárias', () => {
  const q = new SendQueue({ getTargets: () => [], send: async () => {} });
  for (const [k, priority] of [['a', false], ['b', true], ['c', false], ['d', true]]) q.push({ key: k, text: k, priority });
  assert.deepEqual(q.items.map((i) => i.key), ['b', 'd', 'a', 'c']);
});

test('agregador: ignora vitrine /social/ do Mercado Livre', async () => {
  const ml = [{ domain: 'mercadolivre.com.br', clearParams: true, setParams: { matt_word: 'minha' } }];
  const html = '<a href="https://www.mercadolivre.com.br/social/deles?matt_word=deles">x</a>';
  const fetchImpl = async (url) => ({ url, text: async () => html });
  const r = await rewriteLinks('https://www.ofertaesperta.com/promocao/9/x', { rules: ml, dealPages: ['ofertaesperta.com'] }, { fetchImpl });
  assert.equal(r.links[0].matched, false);
});

test('link que já é seu (meli.la) fica intacto', async () => {
  const ml = [{ domain: 'mercadolivre.com.br', clearParams: true, setParams: { matt_word: 'minha', matt_tool: '123' } }];
  const fetchImpl = async () => ({ url: 'https://www.mercadolivre.com.br/social/minha?matt_word=minha&matt_tool=123&ref=PRODUTO' });
  const r = await rewriteLinks('Fone https://meli.la/abc', { rules: ml }, { fetchImpl });
  assert.equal(r.text, 'Fone https://meli.la/abc');
  assert.equal(r.links[0].matched, true);
});

test('IA: valida link e preços fora dos dados', () => {
  assert.equal(validateMessage('🎧 *Fone* por *R$ 179,90*', [179.9]), true);
  assert.equal(validateMessage('🎧 *Fone* ~De R$ 299~ por *R$ 179,90*', [179.9, 299]), true);
  assert.equal(validateMessage('🎧 *Fone* por *R$ 99*', [179.9]), false);
  assert.equal(validateMessage('veja https://x.com', []), false);
  assert.equal(validateMessage('', []), false);
});

test('IA: usa o texto do Claude e cai no padrão se falhar', async () => {
  const fakeClient = (reply) => ({ messages: { create: async () => reply } });
  const ok = createWriter({ client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: '🎧 *Fone JBL* por *R$ 179*' }] }) });
  assert.equal(await ok({ title: 'Fone JBL', price: 179 }), '🎧 *Fone JBL* por *R$ 179*');
  const bad = createWriter({ client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: '*Fone* por R$ 1' }] }) });
  assert.equal(await bad({ title: 'Fone', price: 179 }), null);
  const refused = createWriter({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  assert.equal(await refused({ title: 'Fone', price: 179 }), null);
  const broken = createWriter({ client: { messages: { create: async () => { throw new Error('rede'); } } } });
  assert.equal(await broken({ title: 'Fone', price: 179 }), null);
});

test('pipeline: mensagem da IA + link de afiliado + rodapé', async () => {
  const writer = async () => '🎧 *Echo Dot* por *R$ 199*';
  const { handle, sent } = setup({ writer });
  await handle({ source: 'g', format: 'repost', text: 'Echo Dot R$ 199 https://www.amazon.com.br/dp/B0E?tag=x' });
  assert.equal(sent[0].text, '🎧 *Echo Dot* por *R$ 199*\n\n🛒 https://www.amazon.com.br/dp/B0E?tag=meu-20\n\nRODAPÉ');
});

test('página do produto: lê og:image e og:title', async () => {
  const html = '<meta property="og:title" content="Fone &amp; Cia"><meta content="https://img.x/f.jpg" property="og:image">';
  const info = await fetchProductInfo('https://loja.x/p', { fetchImpl: async () => ({ text: async () => html }) });
  assert.deepEqual(info, { title: 'Fone & Cia', description: null, image: 'https://img.x/f.jpg' });
});

test('monitor: relatório diário às 8h com o que aconteceu desde o último', async () => {
  const store = new Store(null);
  const sent = [];
  let clock = new Date(2026, 10, 17, 7, 30);
  const mon = createMonitor({
    store, config: { ai: { enabled: true }, targetGroups: ['g1'] }, now: () => clock,
    notify: async (t) => sent.push(t), getQueueSize: () => 2,
    getGroups: async () => [{ id: 'g1', name: 'Radar', size: 40 }],
  });
  store.bump('captured'); store.bump('captured'); store.bump('sent');
  mon.aiUsage({ input_tokens: 1_000_000, output_tokens: 0 });
  await mon.check();
  assert.equal(sent.length, 0); // antes das 8h
  clock = new Date(2026, 10, 17, 8, 1);
  await mon.check();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Captadas: 2 \| Enviadas: 1/);
  assert.match(sent[0], /Radar: \*40\* membros/);
  assert.match(sent[0], /IA: 1 mensagens, ~US\$ 0,10/);
  await mon.check();
  assert.equal(sent.length, 1); // um por dia
  store.bump('sent');
  clock = new Date(2026, 10, 18, 9, 0);
  await mon.check();
  assert.match(sent[1], /Enviadas: 1/);
  assert.match(sent[1], /\+0 desde o último relatório/);
});

test('monitor: alertas de feed parado, IA sem crédito e grupo cheio, sem repetir', async () => {
  const store = new Store(null);
  store.data.monitor = { lastReportDay: '17/11/2026' };
  const sent = [];
  let clock = new Date(2026, 10, 17, 10, 0);
  const mon = createMonitor({
    store, config: { targetGroups: ['g1'], sending: { quietHours: { start: 23, end: 7 } } }, now: () => clock,
    notify: async (t) => sent.push(t), getGroups: async () => [{ id: 'g1', name: 'Radar', size: 1000 }],
  });
  mon.feedError('Oferta Esperta', 'timeout');
  clock = new Date(2026, 10, 17, 11, 5);
  await mon.check();
  assert.ok(sent.some((t) => /Oferta Esperta\* não responde/.test(t)));
  assert.ok(sent.some((t) => /1000 membros/.test(t)));
  const before = sent.length;
  await mon.check();
  assert.equal(sent.length, before); // não repete o mesmo alerta
  await mon.aiError('other', 'Your credit balance is too low');
  assert.match(sent.at(-1), /A IA parou/);
  mon.feedOk('Oferta Esperta');
  clock = new Date(2026, 10, 17, 11, 10);
  await mon.check();
  assert.equal(sent.filter((t) => /não responde/.test(t)).length, 1);
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
