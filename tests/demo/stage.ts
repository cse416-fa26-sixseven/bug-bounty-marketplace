import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Video,
} from "@playwright/test";
import { installWallet, type HeadlessWallet } from "./wallet";

/**
 * The film set: one browser, one context per persona (a role's wallet and
 * API session), and one video clip per scene. Waiting for the chain happens
 * on pages whose clips are thrown away, so the finished video skips the
 * challenge window and the analysis queue.
 */
export interface StageOptions {
  baseURL: string;
  outDir: string;
  /** Extra delay Playwright adds to every action, in ms. */
  slowMo: number;
  width: number;
  height: number;
}

export interface SceneTools {
  /** Shows `text` in the caption bar (bottom of the frame) until replaced. */
  caption(text: string): Promise<void>;
  /** Moves the on-screen cursor to the element, then clicks it. */
  click(target: Locator): Promise<void>;
  /** Clicks the field, clears it and types `text` one keystroke at a time. */
  type(target: Locator, text: string): Promise<void>;
  /** Keeps the frame on screen for `ms`. */
  hold(ms: number): Promise<void>;
}

type ClipSink = (video: Video, keep: boolean) => void;

export class Persona {
  private constructor(
    readonly name: string,
    readonly context: BrowserContext,
    private readonly sink: ClipSink,
  ) {}

  static async create(
    browser: Browser,
    options: StageOptions,
    name: string,
    wallet: HeadlessWallet | null,
    sink: ClipSink,
  ): Promise<Persona> {
    const context = await browser.newContext({
      baseURL: options.baseURL,
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      recordVideo: {
        dir: path.join(options.outDir, "raw"),
        size: { width: options.width, height: options.height },
      },
    });
    if (wallet) await installWallet(context, wallet);
    await context.addInitScript({ content: OVERLAY_SCRIPT });
    return new Persona(name, context, sink);
  }

  /** Records `fn` as one clip of the finished video. */
  async scene(title: string, fn: (page: Page, tools: SceneTools) => Promise<void>): Promise<void> {
    log(`▶ ${this.name}: ${title}`);
    const page = await this.newPage();
    try {
      await fn(page, tools(page));
    } finally {
      const video = page.video();
      await page.close();
      if (video) this.sink(video, true);
    }
  }

  /** Runs `fn` off camera: its clip is deleted. */
  async offCamera(title: string, fn: (page: Page) => Promise<void>): Promise<void> {
    log(`… ${this.name}: ${title}`);
    const page = await this.newPage();
    try {
      await fn(page);
    } finally {
      const video = page.video();
      await page.close();
      if (video) this.sink(video, false);
    }
  }

  private async newPage(): Promise<Page> {
    const page = await this.context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    return page;
  }
}

export class Stage {
  readonly personas: Persona[] = [];
  /** Every clip in shooting order, with whether it belongs in the cut. */
  private readonly clips: { video: Video; keep: boolean }[] = [];
  private constructor(
    readonly browser: Browser,
    readonly options: StageOptions,
  ) {}

  static async launch(options: StageOptions): Promise<Stage> {
    rmSync(path.join(options.outDir, "raw"), { recursive: true, force: true });
    mkdirSync(path.join(options.outDir, "raw"), { recursive: true });
    const browser = await chromium.launch({ slowMo: options.slowMo });
    return new Stage(browser, options);
  }

  async persona(name: string, wallet: HeadlessWallet | null): Promise<Persona> {
    const persona = await Persona.create(this.browser, this.options, name, wallet, (video, keep) =>
      this.clips.push({ video, keep }),
    );
    this.personas.push(persona);
    return persona;
  }

  /**
   * Closes everything, deletes the off-camera clips and joins the scenes, in
   * the order they were shot, into `<outDir>/demo.mp4` (H.264; falls back to
   * a stream-copied `demo.webm` when ffmpeg has no H.264 encoder). Returns
   * the file, or the raw clip directory when ffmpeg cannot join them.
   */
  async finish(): Promise<string> {
    for (const persona of this.personas) await persona.context.close();
    await this.browser.close();
    const kept: string[] = [];
    for (const { video, keep } of this.clips) {
      if (keep) kept.push(await video.path());
      else await video.delete();
    }
    if (kept.length === 0) return path.join(this.options.outDir, "raw");
    const list = path.join(this.options.outDir, "clips.txt");
    writeFileSync(
      list,
      kept.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    );
    const concat = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list];
    const attempts: [string, string[]][] = [
      [
        "demo.mp4",
        [
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "20",
          "-r",
          "25",
          "-movflags",
          "+faststart",
        ],
      ],
      ["demo.webm", ["-c", "copy"]],
    ];
    for (const [name, codec] of attempts) {
      const out = path.join(this.options.outDir, name);
      try {
        execFileSync(ffmpeg(), [...concat, ...codec, out], {
          stdio: ["ignore", "inherit", "pipe"],
        });
        return out;
      } catch (err) {
        log(`ffmpeg could not write ${name}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    log(
      `the clips are listed in ${list}; join them with a full ffmpeg build (apt/brew install ffmpeg).`,
    );
    return path.join(this.options.outDir, "raw");
  }
}

function tools(page: Page): SceneTools {
  return {
    async caption(text) {
      await page.evaluate((t) => (window as unknown as Overlay).__bbmCaption(t), text);
      await page.waitForTimeout(900);
    },
    async click(target) {
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
        await page.waitForTimeout(350);
      }
      await target.click();
      await page.waitForTimeout(500);
    },
    async type(target, text) {
      await this.click(target);
      await target.fill("");
      await target.pressSequentially(text, { delay: 45 });
      await page.waitForTimeout(300);
    },
    hold: (ms) => page.waitForTimeout(ms),
  };
}

/** ffmpeg: $FFMPEG, one on PATH, or the build Playwright installs with its browsers. */
function ffmpeg(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  } catch {
    // fall through to Playwright's copy
  }
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("ffmpeg-")) : [];
  for (const dir of dirs.sort().reverse()) {
    const binary = readdirSync(path.join(root, dir)).find((f) => f.startsWith("ffmpeg"));
    if (binary) return path.join(root, dir, binary);
  }
  throw new Error(
    "ffmpeg not found: install it, set FFMPEG, or run `playwright install chromium` (it ships one).",
  );
}

export function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${stamp}] ${message}\n`);
}

interface Overlay {
  __bbmCaption: (text: string) => void;
}

/**
 * Runs in every page before any script: a caption bar and a visible cursor,
 * both outside the app's DOM flow and ignoring pointer events. The caption
 * survives full page loads through sessionStorage. Plain source rather than
 * a function: tsx/esbuild would wrap the inner functions in a `__name`
 * helper the page does not have.
 */
const OVERLAY_SCRIPT = `
(() => {
  const KEY = "bbm-demo-caption";
  const install = () => {
    if (document.getElementById("bbm-demo-caption")) return;
    const style = document.createElement("style");
    style.textContent = \`
      #bbm-demo-caption {
        position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        max-width: 72vw; padding: 14px 26px; border-radius: 14px;
        background: rgba(2, 6, 23, 0.86); color: #f8fafc;
        border: 1px solid rgba(52, 211, 153, 0.55); border-left: 6px solid #34d399;
        font-family: inherit; font-size: 26px; font-weight: 500; line-height: 1.3;
        letter-spacing: 0.01em; box-shadow: 0 12px 40px rgba(0,0,0,0.45);
        z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity 280ms ease;
      }
      #bbm-demo-caption.show { opacity: 1; }
      #bbm-demo-cursor {
        position: fixed; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;
        border-radius: 50%; background: rgba(52, 211, 153, 0.45); border: 2px solid #f8fafc;
        box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.25); z-index: 2147483647; pointer-events: none;
        transition: transform 120ms ease, background 120ms ease; opacity: 0;
      }
      #bbm-demo-cursor.down { transform: scale(0.7); background: rgba(52, 211, 153, 0.95); }
    \`;
    document.head.appendChild(style);
    const caption = document.createElement("div");
    caption.id = "bbm-demo-caption";
    document.body.appendChild(caption);
    const cursor = document.createElement("div");
    cursor.id = "bbm-demo-cursor";
    document.body.appendChild(cursor);
    window.addEventListener("mousemove", (e) => {
      cursor.style.opacity = "1";
      cursor.style.left = e.clientX + "px";
      cursor.style.top = e.clientY + "px";
    }, true);
    window.addEventListener("mousedown", () => cursor.classList.add("down"), true);
    window.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
    const saved = sessionStorage.getItem(KEY);
    if (saved) {
      caption.textContent = saved;
      caption.classList.add("show");
    }
  };
  window.__bbmCaption = (text) => {
    install();
    const el = document.getElementById("bbm-demo-caption");
    el.classList.remove("show");
    window.setTimeout(() => {
      el.textContent = text;
      el.classList.add("show");
    }, 160);
    sessionStorage.setItem(KEY, text);
  };
  if (document.body) install();
  else document.addEventListener("DOMContentLoaded", install);
})();
`;
