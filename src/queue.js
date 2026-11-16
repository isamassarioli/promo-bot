// Fila de envio com intervalo entre promoções, pausa entre grupos e horário de silêncio.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

export function inQuietHours(quiet, date = new Date()) {
  if (!quiet || quiet.start === quiet.end) return false;
  const h = date.getHours();
  return quiet.start < quiet.end ? h >= quiet.start && h < quiet.end : h >= quiet.start || h < quiet.end;
}

export class SendQueue {
  constructor({ sending = {}, getTargets, send, store, log = () => {} }) {
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
    this.items = [];
    this.running = false;
    this.lastSentAt = 0;
  }

  push(item) {
    this.items.push(item);
    this.log(`na fila (${this.items.length}): ${item.text.split('\n')[0].slice(0, 60)}`);
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
      if (Date.now() - this.lastSentAt < this.cfg.minIntervalSeconds * 1000) continue;

      const item = this.items.shift();
      if (Date.now() - item.createdAt > this.cfg.maxPromoAgeMinutes * 60_000) {
        this.log('expirada, não enviada: ' + item.key);
        continue;
      }
      const targets = this.getTargets();
      const [dMin, dMax] = this.cfg.delayBetweenGroupsSeconds;
      for (let i = 0; i < targets.length; i++) {
        try {
          await this.send(targets[i], item);
        } catch (e) {
          this.log(`falha ao enviar para ${targets[i]}: ${e.message}`);
        }
        if (i < targets.length - 1) await sleep(rand(dMin, dMax) * 1000);
      }
      this.lastSentAt = Date.now();
      this.store?.bump('sent');
    }
  }
}
