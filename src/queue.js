// Fila de envio: intervalo entre promoções, limite por dia, horário de silêncio e a melhor oferta primeiro.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

export function inQuietHours(quiet, date = new Date()) {
  if (!quiet || quiet.start === quiet.end) return false;
  const h = date.getHours();
  return quiet.start < quiet.end ? h >= quiet.start && h < quiet.end : h >= quiet.start || h < quiet.end;
}

export class SendQueue {
  constructor({ sending = {}, getTargets, send, store, log = () => {}, onSent = () => {} }) {
    this.cfg = {
      minIntervalSeconds: 60,
      delayBetweenGroupsSeconds: [4, 10],
      maxPromoAgeMinutes: 120,
      ...sending,
    };
    this.getTargets = getTargets;
    this.send = send;
    this.store = store;
    this.log = log;
    this.onSent = onSent;
    this.items = [];
    this.running = false;
  }

  // Guardados no store para sobreviver a reinícios (senão o bot dispara logo depois de reiniciar).
  get lastSentAt() {
    return this.store?.data.lastSentAt || 0;
  }
  set lastSentAt(v) {
    if (this.store) this.store.data.lastSentAt = v;
  }

  get sentToday() {
    const day = new Date().toLocaleDateString('pt-BR');
    const d = this.store?.data.daily;
    return d?.day === day ? d.sent : 0;
  }
  countSent() {
    if (!this.store) return;
    const day = new Date().toLocaleDateString('pt-BR');
    this.store.data.daily = { day, sent: this.sentToday + 1 };
  }

  /** Próxima a sair: as do admin (!promo) na ordem; depois a de maior comissão estimada. */
  pick() {
    const maxAge = this.cfg.maxPromoAgeMinutes * 60_000;
    this.items = this.items.filter((i) => {
      const ok = Date.now() - i.createdAt <= maxAge;
      if (!ok) this.log('expirada, não enviada: ' + i.text.split('\n')[0].slice(0, 50));
      return ok;
    });
    if (!this.items.length) return null;
    let best = this.items.findIndex((i) => i.priority);
    if (best < 0) {
      best = 0;
      this.items.forEach((i, n) => {
        if ((i.score || 0) > (this.items[best].score || 0)) best = n;
      });
    }
    return this.items.splice(best, 1)[0];
  }

  push(item) {
    const at = item.priority ? this.items.findIndex((i) => !i.priority) : -1;
    if (at >= 0) this.items.splice(at, 0, item);
    else this.items.push(item);
    const score = item.score ? ` · comissão ~R$ ${item.score.toFixed(2)}` : '';
    this.log(`na fila (${this.items.length})${score}: ${item.text.split('\n')[0].slice(0, 60)}`);
  }

  get size() {
    return this.items.length;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((e) => this.log('erro na fila: ' + e.message));
  }

  stop() {
    this.running = false;
  }

  async loop() {
    while (this.running) {
      await sleep(1000);
      if (!this.items.length || this.store?.paused) continue;
      if (inQuietHours(this.cfg.quietHours)) continue;
      if (!this.getTargets().length) continue; // sem destino: segura a fila em vez de descartar
      // !promo do admin sai na hora; o resto respeita o intervalo e o limite do dia.
      const manual = this.items.some((i) => i.priority);
      if (!manual) {
        if (Date.now() - this.lastSentAt < this.cfg.minIntervalSeconds * 1000) continue;
        if (this.cfg.maxPerDay > 0 && this.sentToday >= this.cfg.maxPerDay) continue;
      }

      const item = this.pick();
      if (!item) continue;
      const targets = this.getTargets();
      const [dMin, dMax] = this.cfg.delayBetweenGroupsSeconds;
      for (let i = 0; i < targets.length; i++) {
        try {
          await this.send(targets[i], item);
          this.log(`enviada para ${targets[i]}: ${item.text.split('\n')[0].slice(0, 50)}`);
        } catch (e) {
          this.log(`falha ao enviar para ${targets[i]}: ${e.message}`);
        }
        if (i < targets.length - 1) await sleep(rand(dMin, dMax) * 1000);
      }
      if (!item.priority) this.lastSentAt = Date.now();
      this.countSent();
      this.store?.bump('sent');
      this.onSent(item);
    }
  }
}
