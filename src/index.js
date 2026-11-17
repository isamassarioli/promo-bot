import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { SendQueue } from './queue.js';
import { createPipeline } from './pipeline.js';
import { createWriter } from './ai.js';
import { createMonitor } from './monitor.js';
import { watchFeed } from './sources/rss.js';
import { connectWhatsApp, messageText } from './whatsapp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const log = (m) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${m}`);

const configPath = path.join(root, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json não encontrado. Copie config.example.json para config.json e edite.');
  process.exit(1);
}
const loadConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const saveConfig = () => fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
const config = loadConfig();
config.targetGroups ||= [];
config.sourceGroups ||= [];
config.admins ||= [];

const store = new Store(path.join(root, 'data', 'state.json'));
store.prune(config.sending?.dedupeHours || 48);
setInterval(() => store.prune(config.sending?.dedupeHours || 48), 3600_000).unref();

let wa = null;

// Avisos vão para config.notify (ou, se vazio, para os admins).
const notifyJids = () => (config.notify?.length ? config.notify : config.admins).map((n) => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`);
let groupCache = { at: 0, groups: [] };
const monitor = createMonitor({
  store,
  config,
  log,
  getQueueSize: () => queue.size,
  notify: async (text) => {
    if (dryRun || !wa?.ready) return log(`(aviso não enviado) ${text.split('\n')[0]}`);
    for (const jid of notifyJids()) await wa.sendText(jid, text);
  },
  getGroups: async () => {
    if (dryRun || !wa?.ready) return [];
    if (Date.now() - groupCache.at > 3600_000) {
      const groups = [];
      for (const id of config.targetGroups) groups.push(await wa.groupInfo(id).catch(() => ({ id, name: id, size: 0 })));
      groupCache = { at: Date.now(), groups };
    }
    return groupCache.groups;
  },
});

const queue = new SendQueue({
  sending: dryRun ? { ...config.sending, minIntervalSeconds: 0, quietHours: null } : config.sending,
  store,
  log,
  getTargets: () => (dryRun ? ['console'] : config.targetGroups),
  onSent: () => monitor.sent(),
  send: async (jid, item) => {
    if (dryRun) {
      console.log(`\n──────── [${item.source}] ────────\n${item.text}\n${item.image ? '(com imagem)' : ''}`);
      return;
    }
    await wa.sendPromo(jid, item);
  },
});

let writer = null;
if (config.ai?.enabled) {
  if (process.env.ANTHROPIC_API_KEY) {
    writer = createWriter({
      model: config.ai.model || 'claude-haiku-5-5',
      log,
      onUsage: (u) => monitor.aiUsage(u),
      onError: (kind, message) => monitor.aiError(kind, message),
    });
    log(`IA ligada (${config.ai.model || 'claude-haiku-5-5'}): mensagens personalizadas`);
  } else {
    log('IA desligada: falta ANTHROPIC_API_KEY no arquivo .env');
  }
}

const handlePromo = createPipeline({ config, store, log, writer, enqueue: (item) => queue.push(item) });

// ───── Comandos do administrador (mensagem privada para o número do bot) ─────
const digits = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');

async function isAdmin(msg) {
  if (msg.key.fromMe) return true;
  const raw = [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.participant, msg.key.participantAlt].filter(Boolean);
  const ids = raw.map(digits);
  // Contas novas chegam como "@lid", sem o número: pergunta ao WhatsApp qual é o telefone.
  for (const jid of raw.filter((j) => j.endsWith('@lid'))) ids.push(digits(await wa?.phoneForLid(jid)));
  return config.admins.some((a) => ids.includes(digits(a)));
}

const HELP = `*Comandos*
!grupos — lista seus grupos e IDs
!destino add|rm <id> — grupos que recebem as promoções
!fonte add|rm <id> [id...] — grupos de onde as promoções são captadas (vários de uma vez)
!promo <texto> — envia uma promoção manual (pode ser legenda de foto)
!status — fila e estatísticas
!relatorio — relatório do dia até agora
!pausar / !retomar`;

function toggle(list, action, id) {
  const i = list.indexOf(id);
  if (action === 'add' && i < 0) list.push(id);
  if (action === 'rm' && i >= 0) list.splice(i, 1);
  saveConfig();
}

async function handleCommand(text, msg) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const reply = (t) => wa.sendText(msg.key.remoteJid, t);
  switch (cmd.toLowerCase()) {
    case '!grupos': {
      const groups = await wa.listGroups();
      const tag = (id) => (config.targetGroups.includes(id) ? ' 📤destino' : config.sourceGroups.includes(id) ? ' 📥fonte' : '');
      return reply(groups.map((g) => `*${g.name}* (${g.size})${tag(g.id)}\n${g.id}`).join('\n\n') || 'Nenhum grupo.');
    }
    case '!destino':
    case '!fonte': {
      // Aceita vários IDs de uma vez, separados por espaço ou linha.
      const [action, ...ids] = rest;
      if (!['add', 'rm'].includes(action) || !ids.length || !ids.every((id) => /@g\.us$/.test(id)))
        return reply(`Uso: ${cmd} add|rm 1203...@g.us [outro@g.us ...]`);
      const isTarget = cmd.toLowerCase() === '!destino';
      const other = isTarget ? config.sourceGroups : config.targetGroups;
      const conflicts = action === 'add' ? ids.filter((id) => other.includes(id)) : [];
      for (const id of ids) if (!conflicts.includes(id)) toggle(isTarget ? config.targetGroups : config.sourceGroups, action, id);
      const warn = conflicts.length ? `\n⚠️ Ignorados (já são ${isTarget ? 'fonte' : 'destino'}): ${conflicts.length}` : '';
      return reply(`OK. Destinos: ${config.targetGroups.length} | Fontes: ${config.sourceGroups.length}${warn}`);
    }
    case '!promo': {
      const body = text.trim().slice(cmd.length).trim();
      if (!body) return reply('Uso: !promo <texto com o link>');
      const r = await handlePromo({ source: 'manual', format: 'repost', text: body, image: await wa.downloadImage(msg) });
      return reply(r.ok ? '✅ Na fila.' : `❌ Não enviada: ${r.reason}`);
    }
    case '!status': {
      const s = store.data.stats;
      return reply(
        `${store.paused ? '⏸️ Pausado' : '▶️ Ativo'}\nFila: ${queue.size}\nCaptadas: ${s.captured} | Enviadas: ${s.sent}\n` +
          `Duplicadas: ${s.duplicates} | Filtradas: ${s.filtered}\nDestinos: ${config.targetGroups.length} | Fontes: ${config.sourceGroups.length}`,
      );
    }
    case '!relatorio':
    case '!relatório':
      return reply(await monitor.report());
    case '!pausar':
      store.paused = true;
      return reply('⏸️ Envios pausados (a captação continua).');
    case '!retomar':
      store.paused = false;
      return reply('▶️ Envios retomados.');
    default:
      return reply(HELP);
  }
}

async function onMessage(msg, api) {
  const jid = msg.key.remoteJid;
  const text = messageText(msg);
  const isGroup = jid.endsWith('@g.us');

  if (!isGroup) {
    if (!text.startsWith('!')) return;
    if (await isAdmin(msg)) await handleCommand(text, msg);
    else log(`comando ignorado: ${jid} não está em "admins"`);
    return;
  }
  // Captação: mensagens de outros participantes nos grupos-fonte.
  if (msg.key.fromMe || !config.sourceGroups.includes(jid) || !text) return;
  await handlePromo({ source: `grupo:${jid}`, format: 'repost', text, image: await api.downloadImage(msg) });
}

// ───── Inicialização ─────
for (const feed of config.rssFeeds || []) {
  if (!feed.url || feed.url.includes('exemplo.com')) continue;
  log(`monitorando RSS: ${feed.name}`);
  watchFeed(dryRun ? { ...feed, sendBacklog: true } : feed, handlePromo, log, {
    ok: (name) => monitor.feedOk(name),
    error: (name, message) => monitor.feedError(name, message),
  });
}

if (dryRun) {
  log('MODO TESTE: nada será enviado ao WhatsApp; as mensagens aparecem aqui.');
  queue.start();
} else {
  wa = await connectWhatsApp({
    authDir: path.join(root, 'data', 'auth'),
    log,
    onMessage,
    onClose: () => monitor.disconnected(),
    onReady: () => {
      queue.start();
      monitor.connected();
      if (!config.targetGroups.length) log('Nenhum grupo de destino. Envie "!grupos" no privado do bot para configurar.');
    },
  });
}

if (!dryRun) monitor.start();
