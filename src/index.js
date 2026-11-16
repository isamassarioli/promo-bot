import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { SendQueue } from './queue.js';
import { createPipeline } from './pipeline.js';
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

const queue = new SendQueue({
  sending: dryRun ? { ...config.sending, minIntervalSeconds: 0, quietHours: null } : config.sending,
  store,
  log,
  getTargets: () => (dryRun ? ['console'] : config.targetGroups),
  send: async (jid, item) => {
    if (dryRun) {
      console.log(`\n──────── [${item.source}] ────────\n${item.text}\n${item.image ? '(com imagem)' : ''}`);
      return;
    }
    await wa.sendPromo(jid, item);
  },
});

const handlePromo = createPipeline({ config, store, log, enqueue: (item) => queue.push(item) });

// ───── Comandos do administrador (mensagem privada para o número do bot) ─────
const digits = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');

function isAdmin(msg) {
  if (msg.key.fromMe) return true;
  const ids = [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.participant, msg.key.participantAlt].map(digits);
  return config.admins.some((a) => ids.includes(digits(a)));
}

const HELP = `*Comandos*
!grupos — lista seus grupos e IDs
!destino add|rm <id> — grupos que recebem as promoções
!fonte add|rm <id> — grupos de onde as promoções são captadas
!promo <texto> — envia uma promoção manual (pode ser legenda de foto)
!status — fila e estatísticas
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
      const [action, id] = rest;
      if (!['add', 'rm'].includes(action) || !/@g\.us$/.test(id || '')) return reply(`Uso: ${cmd} add|rm 1203...@g.us`);
      const isTarget = cmd.toLowerCase() === '!destino';
      const other = isTarget ? config.sourceGroups : config.targetGroups;
      if (action === 'add' && other.includes(id)) return reply('Esse grupo já é fonte/destino. Um grupo não pode ser os dois.');
      toggle(isTarget ? config.targetGroups : config.sourceGroups, action, id);
      return reply(`OK. Destinos: ${config.targetGroups.length} | Fontes: ${config.sourceGroups.length}`);
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
    if (text.startsWith('!') && isAdmin(msg)) await handleCommand(text, msg);
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
  watchFeed(dryRun ? { ...feed, sendBacklog: true } : feed, handlePromo, log);
}

if (dryRun) {
  log('MODO TESTE: nada será enviado ao WhatsApp; as mensagens aparecem aqui.');
  queue.start();
} else {
  wa = await connectWhatsApp({
    authDir: path.join(root, 'data', 'auth'),
    log,
    onMessage,
    onReady: () => {
      queue.start();
      if (!config.targetGroups.length) log('Nenhum grupo de destino. Envie "!grupos" no privado do bot para configurar.');
    },
  });
}
