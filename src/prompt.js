// Seleção com setas e entrada de texto, direto no TTY. Sem dependências.

import { c, symbols, width } from './ui.js';

const KEYS = {
  up: ['\u001b[A', 'k'],
  down: ['\u001b[B', 'j'],
  enter: ['\r', '\n'],
  cancel: ['\u0003', '\u001b', 'q'], // ctrl+c, esc, q
};

function raw(on) {
  if (process.stdin.isTTY) process.stdin.setRawMode(on);
}

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Lista navegável com ↑ ↓ e enter.
 * @param {{label:string, hint?:string, value:any}[]} items
 * @returns {Promise<any|null>} o valor escolhido, ou null se cancelou
 */
export function select(items, { title = 'escolha', footer = '↑ ↓ para navegar · enter para escolher · esc para sair' } = {}) {
  if (!items.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    let cursor = 0;
    let drawn = 0;

    const render = () => {
      if (drawn) process.stdout.write(`\u001b[${drawn}A\u001b[0J`);
      const largura = Math.max(...items.map((item) => width(item.label)));
      const lines = [
        `  ${c.faint(title)}`,
        '',
        ...items.map((item, i) => {
          const active = i === cursor;
          const mark = active ? c.accent(symbols.arrow) : ' ';
          const label = active ? c.accent(item.label) : c.text(item.label);
          const espaco = ' '.repeat(largura - width(item.label));
          return `  ${mark} ${label}${item.hint ? `${espaco}   ${c.faint(item.hint)}` : ''}`;
        }),
        '',
        `  ${c.faint(footer)}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };

    const done = (value) => {
      process.stdin.off('data', onData);
      raw(false);
      process.stdin.pause();
      if (drawn) process.stdout.write(`\u001b[${drawn}A\u001b[0J`);
      resolve(value);
    };

    // um chunk pode trazer várias teclas de uma vez (setas repetidas, paste)
    const onData = (buf) => {
      const keys = buf.toString().match(/\u001b\[[A-Z]|./gs) || [];
      let moved = false;

      for (const key of keys) {
        if (KEYS.cancel.includes(key)) return done(null);
        if (KEYS.enter.includes(key)) return done(items[cursor].value);
        if (KEYS.up.includes(key)) {
          cursor = (cursor - 1 + items.length) % items.length;
          moved = true;
        } else if (KEYS.down.includes(key)) {
          cursor = (cursor + 1) % items.length;
          moved = true;
        }
      }

      if (moved) render();
    };

    raw(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

/**
 * Lê uma linha de texto. Enter confirma, esc/ctrl+c cancela (null).
 * Com `defaultValue`, enter em branco devolve esse valor.
 */
export function ask(question, { placeholder = '', defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    let value = '';

    const render = () => {
      const shown = value || c.faint(placeholder || defaultValue);
      process.stdout.write(`\u001b[2K\r  ${c.accent('?')} ${c.text(question)} ${shown}`);
    };

    const done = (result) => {
      process.stdin.off('data', onData);
      raw(false);
      process.stdin.pause();
      process.stdout.write('\u001b[2K\r');
      resolve(result);
    };

    // caractere a caractere: colar um domínio chega tudo num só chunk
    const onData = (buf) => {
      const chunk = buf.toString();
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === '\u0003' || ch === '\u001b') return done(null);
        if (ch === '\r' || ch === '\n') return done(value.trim() || defaultValue);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
      render();
    };

    raw(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

/** Confirmação s/n. */
export async function confirm(question, { defaultYes = true } = {}) {
  const answer = await ask(`${question} ${defaultYes ? '(S/n)' : '(s/N)'}`, { placeholder: '' });
  if (answer === null) return null;
  if (!answer) return defaultYes;
  return /^s|^y/i.test(answer);
}
