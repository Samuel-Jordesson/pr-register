// Páginas que o proxy mostra quando não há projeto para atender.
// Tudo embutido: a logo vira data URI e não há requisição externa.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let logoCache;
function logo() {
  if (logoCache !== undefined) return logoCache;
  try {
    const file = fs.readFileSync(path.join(ROOT, 'assets', 'logo.png'));
    logoCache = `data:image/png;base64,${file.toString('base64')}`;
  } catch {
    logoCache = null;
  }
  return logoCache;
}

const escape = (s) =>
  String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/**
 * Página inteira, no estilo do projeto: fundo escuro, logo e uma frase.
 * @param {{title:string, message:string, detail?:string}} content
 * `detail` pode conter html nosso (um <code>); `message` é sempre escapado.
 */
export function page({ title, message, detail = '' }) {
  const mark = logo();
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: #282828;
    color: #ffffff;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 77px;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    text-align: center;
  }
  .mark { width: 238px; max-width: 70vw; height: auto; display: block; }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 18px;
    align-items: center;
  }
  .message {
    font-size: 20px;
    line-height: 102.78%;
    font-weight: 400;
    max-width: 34ch;
    margin: 0;
  }
  .detail {
    font-size: 14px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.45);
    max-width: 52ch;
    margin: 0;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.72);
    background: rgba(255, 255, 255, 0.07);
    border-radius: 5px;
    padding: 3px 7px;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    body { gap: 48px; }
    .message { font-size: 18px; }
  }
</style>
</head>
<body>
  ${mark ? `<img class="mark" src="${mark}" alt="">` : ''}
  <div class="stack">
    <p class="message">${escape(message)}</p>
    ${detail ? `<p class="detail">${detail}</p>` : ''}
  </div>
</body>
</html>
`;
}

/**
 * Permite trocar a página sem mexer no código: se existir
 * ~/.pr/pages/404.html (ou 502.html), ele é usado no lugar.
 */
function override(code) {
  try {
    return fs.readFileSync(path.join(HOME, 'pages', `${code}.html`), 'utf8');
  } catch {
    return null;
  }
}

export function notFound(host) {
  return (
    override(404) ??
    page({
      title: 'Nada publicado aqui',
      message: 'Nenhum projeto está publicado neste endereço.',
      detail: host
        ? `${escape(host)} ainda não foi ligado a um projeto. No servidor: <code>pr register</code>`
        : 'Ligue um projeto a este endereço com <code>pr register</code>',
    })
  );
}

export function badGateway(processName) {
  return (
    override(502) ??
    page({
      title: 'Projeto fora do ar',
      message: 'Este projeto está fora do ar no momento.',
      detail: processName
        ? `O domínio aponta para "${escape(processName)}", que não respondeu. No servidor: <code>pr logs ${escape(processName)}</code>`
        : 'O projeto que atende este domínio não está respondendo.',
    })
  );
}

/** O cliente quer html, ou é curl/script esperando texto? */
export function wantsHtml(req) {
  return String(req.headers?.accept || '').includes('text/html');
}
