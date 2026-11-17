// Relatório diário e alertas enviados no WhatsApp para os números em config.notify.

// US$ por milhão de tokens (entrada, saída), para estimar o gasto da IA.
const PRICES = { 'claude-haiku-5-5': [0.1, 0.5] };

const MIN = 60_000;
const HOUR = 60 * MIN;

const dayKey = (d = new Date()) => d.toLocaleDateString('pt-BR');
const usd = (n) => 'US$ ' + n.toFixed(2).replace('.', ',');

export function createMonitor({
  store,
  config,
  log = () => {},
  notify, // async (texto) => envia para os números de config.notify
  getQueueSize = () => 0,
  getGroups = async () => [], // [{ id, name, size }] dos grupos de destino
  now = () => new Date(),
  reportHour = 8,
}) {
  store.data.monitor ||= {};
  const m = store.data.monitor;
  m.snapshot ||= { ...store.data.stats };
  m.ai ||= { calls: 0, input: 0, output: 0, errors: 0 };
  m.alerts ||= {};
  m.groupSizes ||= {};

  const started = now().getTime();
  const feeds = {}; // nome -> { lastOk, lastError }
  let lastSentAt = started;
  let aiErrorsHour = [];
  let disconnectedAt = null;

  async function alert(key, text, everyHours = 6) {
    const last = m.alerts[key] || 0;
    if (now().getTime() - last < everyHours * HOUR) return false;
    m.alerts[key] = now().getTime();
    store.save();
    log(`ALERTA: ${text.split('\n')[0]}`);
    try {
      await notify(`⚠️ *Alerta do Radar*\n${text}`);
    } catch (e) {
      log(`não consegui enviar o alerta: ${e.message}`);
    }
    return true;
  }

  function aiCost() {
    const [pin, pout] = PRICES[config.ai?.model || 'claude-haiku-5-5'] || PRICES['claude-haiku-5-5'];
    return (m.ai.input * pin + m.ai.output * pout) / 1e6;
  }

  async function buildReport() {
    const s = store.data.stats;
    const d = (k) => (s[k] || 0) - (m.snapshot[k] || 0);
    const lines = [`📊 *Relatório do Radar* · ${dayKey(now())}`, ''];
    lines.push(`Captadas: ${d('captured')} | Enviadas: ${d('sent')}`);
    lines.push(`Filtradas: ${d('filtered')} | Repetidas: ${d('duplicates')}`);
    lines.push(`Na fila agora: ${getQueueSize()}`);
    let groups = [];
    try {
      groups = await getGroups();
    } catch {
      /* sem conexão: segue sem grupos */
    }
    for (const g of groups) {
      const prev = m.groupSizes[g.id];
      const diff = prev === undefined ? '' : ` (${g.size - prev >= 0 ? '+' : ''}${g.size - prev} desde o último relatório)`;
      lines.push(`👥 ${g.name}: *${g.size}* membros${diff}`);
    }
    if (config.ai?.enabled) lines.push(`🤖 IA: ${m.ai.calls} mensagens, ~${usd(aiCost())}${m.ai.errors ? ` | ${m.ai.errors} falhas` : ''}`);
    lines.push(store.paused ? '⏸️ Envios pausados' : '▶️ Envios ativos');
    return { text: lines.join('\n'), groups };
  }

  /** Relatório sob demanda (!relatorio): não zera os contadores. */
  async function report() {
    return (await buildReport()).text;
  }

  async function dailyReport() {
    const { text, groups } = await buildReport();
    await notify(text);
    m.snapshot = { ...store.data.stats };
    m.ai = { calls: 0, input: 0, output: 0, errors: 0 };
    for (const g of groups) m.groupSizes[g.id] = g.size;
    m.lastReportDay = dayKey(now());
    store.save();
  }

  async function check() {
    const t = now();
    const ms = t.getTime();

    if (t.getHours() >= reportHour && m.lastReportDay !== dayKey(t)) {
      try {
        await dailyReport();
      } catch (e) {
        log(`relatório diário falhou: ${e.message}`);
      }
    }

    for (const [name, f] of Object.entries(feeds)) {
      if (ms - (f.lastOk || started) > HOUR)
        await alert(`feed:${name}`, `O feed *${name}* não responde há mais de 1 hora.${f.lastError ? `\nÚltimo erro: ${f.lastError}` : ''}`);
    }

    const quiet = config.sending?.quietHours;
    const h = t.getHours();
    const inQuiet = quiet && quiet.start !== quiet.end && (quiet.start < quiet.end ? h >= quiet.start && h < quiet.end : h >= quiet.start || h < quiet.end);
    if (!inQuiet && !store.paused && config.targetGroups?.length && ms - lastSentAt > 3 * HOUR && ms - started > 3 * HOUR)
      await alert('sem-envios', 'Nenhuma oferta foi enviada nas últimas 3 horas. Confira as fontes com !status.');

    for (const g of await getGroups().catch(() => [])) {
      if (g.size >= 950)
        await alert(`cheio:${g.id}`, `O grupo *${g.name}* tem ${g.size} membros (limite 1.024). Hora de criar o próximo grupo.`, 24);
    }
  }

  return {
    report,
    dailyReport,
    check,
    start(everyMs = 5 * MIN) {
      const timer = setInterval(() => check().catch((e) => log(`monitor: ${e.message}`)), everyMs);
      timer.unref?.();
      return timer;
    },
    feedOk(name) {
      (feeds[name] ||= {}).lastOk = now().getTime();
    },
    feedError(name, message) {
      (feeds[name] ||= {}).lastError = message;
    },
    sent() {
      lastSentAt = now().getTime();
    },
    aiUsage(usage) {
      m.ai.calls++;
      m.ai.input += usage?.input_tokens || 0;
      m.ai.output += usage?.output_tokens || 0;
    },
    async aiError(kind, message) {
      m.ai.errors++;
      if (kind === 'auth' || /credit|billing|saldo/i.test(message))
        return alert('ia-conta', `A IA parou: ${message}\nConfira a chave e os créditos em console.anthropic.com. Enquanto isso, as ofertas saem no formato padrão.`);
      const ms = now().getTime();
      aiErrorsHour = aiErrorsHour.filter((x) => ms - x < HOUR).concat(ms);
      if (aiErrorsHour.length >= 5)
        return alert('ia-erros', `A IA falhou ${aiErrorsHour.length} vezes na última hora (último erro: ${message}). As ofertas estão saindo no formato padrão.`);
    },
    disconnected() {
      disconnectedAt ??= now().getTime();
    },
    async connected() {
      if (disconnectedAt && now().getTime() - disconnectedAt > 10 * MIN) {
        const mins = Math.round((now().getTime() - disconnectedAt) / MIN);
        disconnectedAt = null;
        await notify(`ℹ️ O WhatsApp do bot ficou desconectado por ${mins} min e já voltou.`).catch(() => {});
      }
      disconnectedAt = null;
    },
  };
}
