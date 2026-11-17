// Conexão com o WhatsApp (Baileys): login por QR code, reconexão, envio e leitura de mensagens.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const logger = pino({ level: 'silent' });

export function messageText(msg) {
  const m = msg.message || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    ''
  );
}

export async function connectWhatsApp({ authDir, onMessage, onReady, onClose, log = console.log }) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const api = { sock: null, ready: false };

  function start() {
    const sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    api.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        log('\nEscaneie o QR code: WhatsApp > Aparelhos conectados > Conectar um aparelho\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        api.ready = true;
        log('✅ WhatsApp conectado');
        onReady?.(api);
      }
      if (connection === 'close') {
        api.ready = false;
        onClose?.();
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log('❌ Sessão encerrada. Apague a pasta data/auth e rode de novo para escanear o QR.');
          process.exit(1);
        }
        log(`conexão caiu (${code ?? '?'}), reconectando em 5s...`);
        setTimeout(start, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
        const text = messageText(msg);
        if (text.startsWith('!') && !msg.key.remoteJid?.endsWith('@g.us'))
          log(`comando recebido (${type}, ${msg.key.fromMe ? 'enviado por você' : msg.key.remoteJid}): ${text.slice(0, 40)}`);
        if (type !== 'notify') continue;
        try {
          await onMessage?.(msg, api);
        } catch (e) {
          log('erro ao tratar mensagem: ' + e.message);
        }
      }
    });
  }

  api.sendPromo = async (jid, item) => {
    if (!api.ready) throw new Error('WhatsApp desconectado');
    if (item.image) {
      const image = Buffer.isBuffer(item.image) ? item.image : { url: item.image };
      try {
        return await api.sock.sendMessage(jid, { image, caption: item.text });
      } catch {
        /* imagem indisponível: manda só o texto */
      }
    }
    return api.sock.sendMessage(jid, { text: item.text });
  };

  api.sendText = (jid, text) => api.sock.sendMessage(jid, { text });

  /** Número de telefone por trás de um id @lid (contas novas do WhatsApp escondem o número). */
  api.phoneForLid = async (lid) => {
    try {
      return (await api.sock.signalRepository?.lidMapping?.getPNForLID(lid)) || null;
    } catch {
      return null;
    }
  };

  api.groupInfo = async (jid) => {
    const g = await api.sock.groupMetadata(jid);
    return { id: jid, name: g.subject, size: g.participants?.length || 0 };
  };

  api.listGroups = async () => {
    const groups = await api.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length || 0 }));
  };

  api.downloadImage = async (msg) => {
    const m = msg.message?.ephemeralMessage?.message || msg.message;
    if (!m?.imageMessage) return null;
    try {
      return await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: api.sock.updateMediaMessage });
    } catch {
      return null;
    }
  };

  start();
  return api;
}
