'use strict';
const readline = require('node:readline');
const pc = require('picocolors');

const MB = 1024 * 1024;

/** @param {string} msg */
function info(msg) {
  console.log(msg);
}

/** @param {string} msg */
function ok(msg) {
  console.log(pc.green(`✓ ${msg}`));
}

/** @param {string} msg */
function warn(msg) {
  console.log(pc.yellow(`⚠ ${msg}`));
}

/** @param {string} msg */
function fail(msg) {
  console.log(pc.red(`✗ ${msg}`));
}

/**
 * @param {number} n current step, 1-based
 * @param {number} total
 * @param {string} title
 */
function step(n, total, title) {
  console.log(pc.bold(`[${n}/${total}] ${title}`));
}

/**
 * Print rows of plain objects as aligned columns. Columns come from the first row.
 * @param {object[]} rows
 */
function table(rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(pc.bold(line(cols)));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ''))));
}

/**
 * A byte progress bar. On a TTY it redraws one line; otherwise it prints each 10%.
 * @param {{ label: string, total: number }} opts
 * @returns {{ update: (bytes: number) => void, done: () => void }}
 */
function progressBar({ label, total }) {
  const tty = Boolean(process.stdout.isTTY);
  const started = Date.now();
  let received = 0;
  let nextPrint = 10;

  const render = () => {
    const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
    const secs = Math.max(0.001, (Date.now() - started) / 1000);
    const speed = `${(received / MB / secs).toFixed(1)} MB/s`;
    const size = `${(received / MB).toFixed(1)}/${(total / MB).toFixed(1)} MB`;
    return `${label} ${pct}%  ${size}  ${speed}`;
  };

  return {
    update(bytes) {
      received = bytes;
      if (tty) {
        process.stdout.write(`\r${render()}`);
        return;
      }
      const pct = total > 0 ? (received / total) * 100 : 0;
      if (pct >= nextPrint) {
        console.log(render());
        nextPrint = Math.floor(pct / 10) * 10 + 10;
      }
    },
    done() {
      if (tty) process.stdout.write('\n');
      else if (nextPrint <= 100) console.log(render()); // 100% not printed yet
    },
  };
}

/**
 * Ask a yes/no question. Returns true without asking when `yes` is set or stdin
 * is not a TTY. Otherwise the default is No.
 * @param {string} question
 * @param {{ yes?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
function confirm(question, { yes = false } = {}) {
  if (yes || !process.stdin.isTTY) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Ask the user to pick one of several options by number. Returns the default
 * when stdin is not a TTY or the answer is not a valid number.
 * @param {string} question
 * @param {string[]} options labels, shown as "1) ... 2) ..."
 * @param {{ defaultIndex?: number }} [opts] 0-based
 * @returns {Promise<number>} 0-based index
 */
function choose(question, options, { defaultIndex = 0 } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultIndex);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const list = options.map((o, i) => `${i + 1}) ${o}`).join('  ');
  return new Promise((resolve) => {
    rl.question(`${question} ${list} [${defaultIndex + 1}] `, (answer) => {
      rl.close();
      const n = Number.parseInt(answer.trim(), 10);
      resolve(n >= 1 && n <= options.length ? n - 1 : defaultIndex);
    });
  });
}

module.exports = { info, ok, warn, fail, step, table, progressBar, confirm, choose };
