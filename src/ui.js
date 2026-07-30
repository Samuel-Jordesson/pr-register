// Paleta e primitivas de saída no terminal.
// Estilo Claude: laranja de destaque, cinza suave para rótulos, cantos arredondados.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY !== false;

const wrap = (open, close) => (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
const rgb = (r, g, b) => wrap(`38;2;${r};${g};${b}`, 39);

export const c = {
  accent: rgb(217, 119, 87), // #D97757
  accentSoft: rgb(191, 106, 78),
  text: rgb(235, 232, 228),
  dim: rgb(138, 133, 126),
  faint: rgb(98, 94, 88),
  green: rgb(122, 176, 122),
  red: rgb(206, 92, 92),
  yellow: rgb(212, 172, 90),
  blue: rgb(122, 158, 200),
  bold: wrap(1, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
};

/** Largura visível de uma string, ignorando escapes ANSI. */
export function width(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(s, n, align = 'left') {
  const gap = Math.max(0, n - width(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  return s + ' '.repeat(gap);
}

export function truncate(s, n) {
  const plain = String(s);
  if (plain.length <= n) return plain;
  if (n <= 1) return plain.slice(0, n);
  return plain.slice(0, n - 1) + '…';
}

/**
 * Tabela sem bordas, no estilo do Claude Code: cabeçalho apagado,
 * colunas separadas por dois espaços.
 * @param {{key:string,label:string,align?:'left'|'right'}[]} columns
 * @param {Record<string,string>[]} rows
 * @param {{indent?: string}} [opts] indentação de cada linha (vazia dentro de uma caixa)
 * @returns {string[]} linhas, cabeçalho primeiro
 */
export function tableLines(columns, rows, { indent = '  ' } = {}) {
  const widths = columns.map((col) =>
    Math.max(width(col.label), ...rows.map((r) => width(r[col.key] ?? '')))
  );

  const header = columns
    .map((col, i) => c.faint(pad(col.label.toUpperCase(), widths[i], col.align)))
    .join('  ');

  const body = rows.map((row) =>
    columns.map((col, i) => pad(row[col.key] ?? '', widths[i], col.align)).join('  ')
  );

  return [header, ...body].map((line) => indent + line);
}

export function table(columns, rows, opts) {
  return tableLines(columns, rows, opts).join('\n');
}

/** Marcador de linha divisória dentro de uma caixa. */
export const RULE = Symbol('rule');

/** Caixa arredondada com título opcional. Use RULE para separar blocos. */
export function box(lines, { title = '', color = c.accent } = {}) {
  const inner = Math.max(title.length + 4, ...lines.map((l) => (l === RULE ? 0 : width(l))));
  const bar = (n) => c.faint('─'.repeat(Math.max(0, n)));
  const top = title
    ? `${c.faint('╭─')} ${color(title)} ${bar(inner - title.length - 2)}${c.faint('╮')}`
    : `${c.faint('╭')}${bar(inner + 2)}${c.faint('╮')}`;
  const mid = lines.map((l) =>
    l === RULE
      ? `${c.faint('├')}${bar(inner + 2)}${c.faint('┤')}`
      : `${c.faint('│')} ${pad(l, inner)} ${c.faint('│')}`
  );
  const bottom = `${c.faint('╰')}${bar(inner + 2)}${c.faint('╯')}`;
  return [top, ...mid, bottom].join('\n');
}

export const symbols = {
  bullet: '●',
  arrow: '→',
  check: '✔',
  cross: '✖',
  dot: '·',
};

export function statusDot(status) {
  if (status === 'online') return c.green(symbols.bullet);
  if (status === 'stopped') return c.faint(symbols.bullet);
  if (status === 'errored') return c.red(symbols.bullet);
  return c.yellow(symbols.bullet);
}

export function ok(msg) {
  console.log(`  ${c.green(symbols.check)} ${msg}`);
}

export function info(msg) {
  console.log(`  ${c.accent(symbols.arrow)} ${msg}`);
}

export function warn(msg) {
  console.log(`  ${c.yellow('!')} ${msg}`);
}

export function fail(msg) {
  console.error(`  ${c.red(symbols.cross)} ${msg}`);
}

/** Duração legível a partir de um timestamp em ms. */
export function since(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}
