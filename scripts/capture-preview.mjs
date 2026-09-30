/**
 * Gera `docs/preview.png`: o app rodando, com o phantom de exemplo carregado e
 * uma regua medida. E a primeira coisa que quem abre o repositorio ve, entao
 * ela precisa ser de verdade e nao um desenho.
 *
 *   node scripts/capture-preview.mjs
 *
 * Reusa o mesmo caminho do E2E (servidor + Chrome headless via CDP), sem
 * duplicar a logica de subir o servidor.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = 3300 + (process.pid % 200); // porta unica por execucao
const CDP_PORT = PORT + 500;
const OUT = join(ROOT, "docs", "preview.png");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome/Edge nao encontrado. Defina CHROME_PATH.");
  return found;
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        // So responder 200 nao basta: um servidor velho de outra execucao
        // pode ocupar a porta e servir outra coisa (ou um proxy de erro).
        const html = await r.text();
        if (html.includes("OdontoVision")) return true;
      }
    } catch {
      /* ainda subindo */
    }
    await sleep(400);
  }
  throw new Error(`servidor nao respondeu com o app: ${url}`);
}

/** Cliente de CDP minimo: o suficiente para navegar, clicar e capturar. */
class Cdp {
  #ws;
  #id = 0;
  #pendentes = new Map();
  #ouvintes = new Map();

  /** Evenentes do CDP (Runtime.exceptionThrown, Log.entryAdded, ...). */
  on(metodo, fn) {
    if (!this.#ouvintes.has(metodo)) this.#ouvintes.set(metodo, []);
    this.#ouvintes.get(metodo).push(fn);
  }

  static async connect(wsUrl) {
    const c = new Cdp();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      c.#ws.onopen = res;
      c.#ws.onerror = rej;
    });
    c.#ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) {
        for (const fn of c.#ouvintes.get(msg.method) ?? []) fn(msg.params);
        return;
      }
      const p = c.#pendentes.get(msg.id);
      if (!p) return;
      c.#pendentes.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    };
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      this.#pendentes.set(id, { res, rej });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.#ws.close(); }
}

// Constroi ANTES de servir. Servir `.next` enquanto ele e reescrito produz
// `ChunkLoadError`: o HTML aponta para um chunk que ainda nao existe, a pagina
// cai na tela de erro do Chrome, e o sintoma e "o botao nao responde" -- que
// parece bug do app e e corrida de build.
/**
 * Mata o servidor e o Chrome INTEIROS.
 *
 * `spawn(..., { shell: true }).kill()` mata só o `cmd.exe`: o `next start`
 * continua vivo, segura a porta, e a execução seguinte conversa com ele — que
 * serve o build antigo, enquanto o disco já tem o novo. Daí um
 * `ChunkLoadError` que parece problema de build e é um servidor zumbi.
 */
function matarArvore(pid) {
  if (!pid) return;
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* já morreu */
  }
}

function rodar(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: true, stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} -> ${code}`))));
  });
}

console.log("construindo...");
await rodar("npm.cmd", ["run", "build"]);

// `start` (build de producao) e nao `dev`: o mesmo caminho do E2E, e a captura
// mostra o que roda de verdade depois do build.
const server = spawn("npm.cmd", ["run", "start", "--", "-p", String(PORT)], {
  cwd: ROOT,
  shell: true,
  stdio: "ignore",
});
let browser;
let cdp;

try {
  await waitForHttp(`http://localhost:${PORT}/`);
  console.log("servidor no ar");

  // Flags IGUAIS as do E2E. `--window-size` junto com
  // `Emulation.setDeviceMetricsOverride` desalinha o mapeamento de coordenadas
  // do `Input.dispatchMouseEvent`: o clique e aceito e cai fora da janela, sem
  // erro. O E2E nao usa `--window-size` e o `deviceScaleFactor` e 1.
  browser = spawn(findBrowser(), [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(process.env.TEMP ?? ".", `odontovision-preview-${Date.now()}`)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ], { stdio: "ignore" });

  let wsUrl = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !wsUrl) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { /* subindo */ }
  }
  if (!wsUrl) throw new Error("Chrome nao expôs o debugger");
  void wsUrl;

  // Conecta DIRETO no target da pagina, como o E2E faz. Criar um target novo e
  // falar por `sessionId` funciona para `Runtime.evaluate`, mas o input do CDP
  // (cliques) vai para a aba em foco e nunca chega -- o sintoma e o script
  // aceitar o clique e a tela nao mudar.
  const alvos = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = alvos.find((t) => t.type === "page");
  if (!page) throw new Error("nenhum target de pagina no Chrome");
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  const send = (m, p) => cdp.send(m, p);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  // O botao de exemplo nao tinha NENHUM teste: uma captura de tela e um
  // listener de excecao foram o que acharam os dois bugs dele.
  const erros = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    erros.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "?");
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "warning") {
      erros.push(`[${p.type}] ${(p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
    }
  });
  // Mesmos numeros do E2E (1600x1000, fator 1). Mudar o tamanho do viewport
  // em relacao ao E2E ja fez o clique parar de chegar, e nao ha ganho em
  // inventar outro valor aqui.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  // Espera o evento de carga em vez de um sleep fixo: com um sleep, o clique às
  // vezes sai antes do SSR+hidratação e é aceito sem chegar em handler nenhum.
  // A corrida era a causa da flutuação entre execuções.
  const paginaCarregou = new Promise((res) => {
    const t = setTimeout(() => res(false), 30_000);
    cdp.on("Page.loadEventFired", () => { clearTimeout(t); res(true); });
  });
  await send("Page.navigate", { url: `http://localhost:${PORT}/` });
  await paginaCarregou;
  await sleep(3000); // sobra para a hidratação

  const clicar = async (seletor, texto) => {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(seletor)})];
        const el = ${texto ? `els.find(e => new RegExp(${JSON.stringify(texto)}, 'i').test(e.textContent ?? ''))` : "els[0]"};
        if (!el) return { erro: 'alvo nao encontrado' };
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
      returnByValue: true,
    });
    if (result.value?.erro) {
      const disponiveis = (await send("Runtime.evaluate", {
        expression: `JSON.stringify({
          botoes: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean),
        })`,
        returnByValue: true,
      })).result.value;
      throw new Error(
        `clique sem alvo: ${seletor}${texto ? ` / "${texto}"` : ""} | disponiveis: ${disponiveis}`,
      );
    }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type, x: result.value.x, y: result.value.y, button: "left", clickCount: 1,
      });
    }
    await sleep(700);
  };

  // Phantom de exemplo: a primeira tela de quem clonar o repositorio.
  // Espera a sidebar aparecer em vez de confiar num sleep fixo: sem isso a
  // captura corre antes da hidratacao e falha com "campo de anotacao ausente",
  // que parece bug do app e e corrida do script.
  /**
   * Espera uma condição ser verdadeira na página.
   *
   * `expressao` é um JS avaliado no browser — não só um seletor. Isso importa
   * para a hidratação, que não é um elemento da página e sim a presença da
   * fibra do React num botão.
   */
  const esperar = async (expressao, ms = 30_000) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      const { result } = await send("Runtime.evaluate", {
        expression: `(() => { try { return !!(${expressao}); } catch { return false; } })()`,
        returnByValue: true,
      });
      if (result.value === true) return true;
      await sleep(350);
    }
    return false;
  };

  const temInput = () => esperar(`document.querySelector('input[data-annotation-input]')`, 4000);

  // A pagina de erro do Chrome so tem "Reload" e "Back" nos botoes. Descobrir
  // isso e melhor do que culpar o botao de exemplo por quatro tentativas.
  const ondeEstou = async () => (await send("Runtime.evaluate", {
    expression: `({ url: location.href, titulo: document.title,
                    botoes: document.querySelectorAll('button').length })`,
    returnByValue: true,
  })).result.value;
  const onde = await ondeEstou();
  if (onde.botoes <= 2) {
    throw new Error(
      `a navegacao nao chegou no app (${onde.botoes} botoes = pagina de erro): ` +
        `${JSON.stringify(onde)} | erros: ${JSON.stringify(erros).slice(0, 300)}`,
    );
  }

  // Espera a HIDRATAÇÃO, não o carregamento. `Page.loadEventFired` e
  // `document.readyState === "complete"` chegam antes do React montar: a pagina
  // mostra o HTML do servidor, `loadDemoExam` ainda não está ligado a nenhum
  // handler, e todo clique — do CDP ou do próprio DOM — é aceito e não faz
  // nada. Sem esta espera, o sintoma é "o botão não funciona", que parece bug
  // do app e é corrida.
  const hidratou = await esperar(
    `Object.keys([...document.querySelectorAll('button')].find(b => /exemplo/i.test(b.textContent ?? '')) ?? {}).some(k => k.startsWith('__reactFiber'))`,
    90_000,
  );
  if (!hidratou) throw new Error("a pagina carregou mas nunca hidratou (90s)");
  console.log("hidratado");
  await sleep(400);

  const carregouDemo = { ok: false };
  for (let tentativa = 1; tentativa <= 4 && !carregouDemo.ok; tentativa++) {
    await clicar("button", "exemplo");
    carregouDemo.ok = await temInput();
    if (!carregouDemo.ok) await sleep(1500);
  }
  if (!carregouDemo.ok) {
    throw new Error(`Exemplo nao carregou mesmo hidratado | pagina: ${JSON.stringify(onde)}`);
  }
  await sleep(800);

  // Uma regua medida, para a captura mostrar o que o programa faz e nao so
  // tres quadrados com tons de cinza.
  await clicar('[aria-label="Regua"]');
  const clicarNoAxial = async (u, v) => {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-viewport="Axial"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`,
      returnByValue: true,
    });
    const r = result.value;
    if (!r) throw new Error("viewport Axial ausente");
    // O canvas e quadrado e centralizado; a imagem ocupa a parte maior.
    const lado = Math.min(r.w, r.h);
    const x0 = r.x + (r.w - lado) / 2;
    const y0 = r.y + (r.h - lado) / 2;
    for (const [uu, vv] of [[u, v]]) {
      const px = Math.round(x0 + ((uu + 0.5) / 64) * lado);
      const py = Math.round(y0 + ((vv + 0.5) / 64) * lado);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", clickCount: 1 });
      }
      await sleep(450);
    }
  };
  await clicarNoAxial(12, 40);
  await clicarNoAxial(48, 26);

  // Anotação, para aparecer a lista de medidas com rótulo e densidades.
  await clicar('[aria-label="Anotacao"]');
  const { result } = await send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-annotation-input]');
      if (!el) return 'sem campo';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'Nucleo pulposo');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`,
    returnByValue: true,
  });
  if (result.value !== "ok") throw new Error("campo de anotacao ausente");
  await sleep(400);
  await clicarNoAxial(30, 32);

  // Fecha a tool de anotacao para o cursor voltar a ser o de crosshair.
  await clicar('[aria-label="Janela/Contraste"]');
  await sleep(600);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`preview gravado em ${OUT}`);
} catch (erro) {
  console.error("falha ao capturar:", erro.message ?? erro);
  process.exitCode = 1;
} finally {
  cdp?.close();
  matarArvore(browser?.pid);
  matarArvore(server.pid);
  await sleep(800);
}
