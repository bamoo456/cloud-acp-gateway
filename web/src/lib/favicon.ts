// The tab's unread indicator: a favicon drawn at runtime plus a title prefix.
//
// The mark is painted rather than shipped as an asset because the unread badge
// has to be baked into the same bitmap — a favicon can't overlay anything on
// itself, and the browser gives it 16 CSS pixels. Drawn at 64×64 so the
// downscale stays crisp, with the badge *inside* the square (a corner overhang
// like a DOM badge would be clipped away).

const BASE_TITLE = "acp-gateway";
const SIZE = 64;
const INK = "#1f1e1d";
const BADGE = "#dc3f34";

// Two digits is all that fits legibly at 16px.
export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function titleFor(count: number): string {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${BASE_TITLE}` : BASE_TITLE;
}

// Cached across calls: one canvas, and a null context is remembered so jsdom
// (no 2d backend) doesn't log "Not implemented" on every render.
let canvas: HTMLCanvasElement | undefined;
let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
  }
  return ctx ?? null;
}

function draw(count: number): string | null {
  const c = context();
  if (!c || !canvas) return null;
  c.clearRect(0, 0, SIZE, SIZE);

  // The mark: an ink square with the prompt chevron the app is named for.
  c.fillStyle = INK;
  c.beginPath();
  c.roundRect(0, 0, SIZE, SIZE, 14);
  c.fill();
  c.strokeStyle = "#ffffff";
  c.lineWidth = 8;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(20, 19);
  c.lineTo(36, 32);
  c.lineTo(20, 45);
  c.stroke();

  if (count > 0) {
    const label = badgeText(count);
    // Punched out of the mark so the badge reads as a separate chip even where
    // it overlaps the chevron.
    c.globalCompositeOperation = "destination-out";
    c.beginPath();
    c.arc(45, 19, 23, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = "source-over";
    c.fillStyle = BADGE;
    c.beginPath();
    c.arc(45, 19, 19, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#ffffff";
    c.font = `bold ${label.length > 1 ? 22 : 26}px ui-sans-serif, system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(label, 45, 20);
  }
  return canvas.toDataURL("image/png");
}

// Idempotent: always renders the current count, so applyUnread(0) restores the
// plain mark (and the first call replaces the browser's default globe).
export function applyUnread(count: number): void {
  if (typeof document === "undefined") return;
  document.title = titleFor(count);
  const href = draw(count);
  if (!href) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}
