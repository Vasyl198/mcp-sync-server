#!/usr/bin/env node

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const args = parseArgs(process.argv.slice(2));
const lr = toNumber(args.lr, 0.02);
const layers = toNumber(args.layers, 3);
const mode = (args.mode || process.env.MODE || "default").toLowerCase();

let score;
if (mode === "conflict") {
  score =
    0.9 -
    0.4 * Math.exp(-Math.abs(lr - 0.02) * 40) -
    0.05 * layers +
    (Math.random() - 0.5) * 0.02;
} else if (mode === "anti_conflict") {
  score =
    0.15 +
    0.45 * Math.exp(-Math.abs(lr - 0.095) * 55) +
    0.08 * layers +
    (Math.random() - 0.5) * 0.03;
} else {
  score =
    0.7 +
    0.2 * Math.exp(-Math.abs(lr - 0.03) * 35) -
    0.03 * Math.abs(layers - 3) +
    (Math.random() - 0.5) * 0.02;
}

const clampedScore = Math.max(0, Math.min(1, score));
const accuracy = clampedScore;
const loss = 1 - clampedScore;

console.log(`score=${clampedScore.toFixed(4)} loss=${loss.toFixed(4)} accuracy=${accuracy.toFixed(4)}`);
console.log(`METRICS ${JSON.stringify({
  score: Number(clampedScore.toFixed(6)),
  loss: Number(loss.toFixed(6)),
  accuracy: Number(accuracy.toFixed(6)),
})}`);
