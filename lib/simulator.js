'use strict';

// =============================================================================
// Générateur de TDR de DÉMONSTRATION — étiqueté source 'SIMULATION'.
// Alimente la MÊME chaîne réelle (modèle TDR → ISO 8583 → registre signé →
// agrégation → diffusion) que les connecteurs externes. NE PRODUIT AUCUNE
// donnée réelle. Injecte volontairement des SCHÉMAS D'ANOMALIE (fractionnement,
// vélocité, sous-déclaration de frais, déplacement impossible) pour que les
// modules antifraude / revenus / géo / ML aient des cas réels à détecter.
// =============================================================================

const ref = require('./referentiel');
const model = require('./model');
const config = require('./config');

const rint = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const wpick = (items) => {
  const total = items.reduce((s, i) => s + i.w, 0);
  let r = Math.random() * total;
  for (const i of items) { if ((r -= i.w) <= 0) return i.v; }
  return items[items.length - 1].v;
};

const TYPE_W = [
  { v: 'P2P', w: 30 }, { v: 'CASHIN', w: 22 }, { v: 'CASHOUT', w: 18 },
  { v: 'MERCHANT', w: 12 }, { v: 'AIRTIME', w: 9 }, { v: 'BILL', w: 6 }, { v: 'XBORDER', w: 3 },
];
const CHAN_W = [{ v: 'USSD', w: 58 }, { v: 'STK', w: 14 }, { v: 'APP', w: 20 }, { v: 'SMS', w: 8 }];

function amountFor(type) {
  switch (type) {
    case 'AIRTIME': return rint(200, 25_000);
    case 'P2P': return rint(1_000, 400_000);
    case 'MERCHANT': return rint(500, 250_000);
    case 'CASHIN': return rint(2_000, 600_000);
    case 'CASHOUT': return rint(2_000, 500_000);
    case 'BILL': return rint(5_000, 300_000);
    case 'XBORDER': return rint(50_000, 3_000_000);
    default: return rint(1_000, 100_000);
  }
}

// Campagnes de fractionnement en cours : { sub, op, remaining }.
const campaigns = [];

function startCampaignMaybe() {
  if (campaigns.length >= 2 || Math.random() > 0.04) return;
  const op = wpick(ref.OPERATORS.map((o) => ({ v: o, w: o.marketWeight })));
  const risky = ref.subscribersOf(op.id).filter((s) => s.riskSeed > 0.8);
  const sub = risky.length ? risky[rint(0, risky.length - 1)] : ref.subscribersOf(op.id)[0];
  campaigns.push({ sub, op, remaining: rint(3, 6) });
}

function generate() {
  const rules = config.getRules();
  startCampaignMaybe();

  // 1) Si une campagne de fractionnement est active, émettre un TDR juste sous le seuil.
  if (campaigns.length && Math.random() < 0.5) {
    const c = campaigns[0];
    c.remaining -= 1;
    if (c.remaining <= 0) campaigns.shift();
    const near = Math.round(rules.reportingThresholdXaf * (rules.structuring.nearRatio + Math.random() * 0.08));
    const receiver = ref.subscribersOf(c.op.id)[rint(0, 120)];
    return model.buildTDR({
      senderOperatorId: c.op.id, receiverOperatorId: c.op.id, type: 'P2P', channel: 'USSD',
      amount: near, senderMsisdn: c.sub.msisdn, receiverMsisdn: receiver.msisdn,
      cellOriginId: ref.cellsOf(ref.CITIES[rint(0, ref.CITIES.length - 1)].name)[0].id,
      source: 'SIMULATION',
    });
  }

  // 2) Cas nominal.
  const op = wpick(ref.OPERATORS.map((o) => ({ v: o, w: o.marketWeight })));
  const type = wpick(TYPE_W);
  const channel = wpick(CHAN_W);
  const senders = ref.subscribersOf(op.id);
  const sender = senders[rint(0, senders.length - 1)];

  // Interopérabilité : ~15 % des P2P/MERCHANT vers un autre opérateur.
  let receiverOp = op;
  if ((type === 'P2P' || type === 'MERCHANT') && Math.random() < 0.15) {
    const others = ref.OPERATORS.filter((o) => o.id !== op.id);
    receiverOp = others[rint(0, others.length - 1)];
  }
  const receiver = ref.subscribersOf(receiverOp.id)[rint(0, 120)];

  let amount = amountFor(type);
  let currency = 'XAF';
  if (type === 'XBORDER') currency = wpick([{ v: 'XOF', w: 5 }, { v: 'EUR', w: 2 }, { v: 'XAF', w: 3 }]);

  // 3) Échec aléatoire (alimente la QoS) + pic d'échecs occasionnel par opérateur.
  const failRate = model.FAIL_RATE_DEFAULT;
  const status = Math.random() < failRate ? 'FAILED' : 'SUCCESS';
  const errorCode = status === 'FAILED'
    ? ref.ERROR_CODES[rint(0, ref.ERROR_CODES.length - 1)].code : null;

  // 4) Anomalie « montant élevé » occasionnelle (compte non vérifié).
  if (Math.random() < 0.01) amount = rint(rules.highValueXaf, rules.highValueXaf * 3);

  // 5) Sous-déclaration de frais occasionnelle (assurance des revenus).
  let feeOverride;
  if (status === 'SUCCESS' && Math.random() < 0.05) {
    const expected = model.computeFee(type, ref.toXaf(amount, currency), config.getFees());
    feeOverride = Math.round(expected * (0.3 + Math.random() * 0.4)); // 30–70 % du dû
  }

  const city = ref.CITIES[rint(0, ref.CITIES.length - 1)];
  const cell = ref.cellsOf(city.name)[0];
  const agent = (type === 'CASHIN' || type === 'CASHOUT')
    ? ref.agentsOf(op.id)[rint(0, Math.max(0, ref.agentsOf(op.id).length - 1))] : null;

  return model.buildTDR({
    senderOperatorId: op.id, receiverOperatorId: receiverOp.id, type, channel,
    amount, currency, status, errorCode,
    senderMsisdn: sender.msisdn, receiverMsisdn: receiver ? receiver.msisdn : null,
    agentId: agent ? agent.id : undefined,
    cellOriginId: cell.id,
    feeGrid: config.getFees(), feeOverride,
    source: 'SIMULATION',
  });
}

module.exports = { generate };
