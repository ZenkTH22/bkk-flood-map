// Supabase Edge Function "feeds": รวมข้อมูลภายนอกให้แผนที่น้ำท่วม
//   traffy = ร้องเรียนน้ำท่วมจาก Traffy Fondue, news = ข่าวน้ำท่วม (Google News + Bing),
//   cams = กล้องจาก Longdo พร้อมตรวจสถานะว่าภาพเดินจริง
// GET /functions/v1/feeds?kind=traffy|news|cams[&refresh=1]   (ปิด Verify JWT)
// ผลเก็บในตาราง feed_cache; pg_cron เรียก refresh=1 ทุก 5 นาที (ดู supabase/feeds.sql)

const PHOTO = "https://storage.googleapis.com/traffy_public_bucket/attachment/";
const FLOOD = /ท่วม|น้ำขัง|น้ำรอระบาย|ระบายน้ำไม่ทัน/;
const cache: Record<string, { at: number; body: string }> = {};
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

async function traffy() {
  // API ส่งเรื่องล่าสุดได้สูงสุด 1000 เรื่อง (~4 ชม.)
  const r = await fetch("https://publicapi.traffy.in.th/share/teamchadchart/search?limit=1000");
  if (!r.ok) throw new Error("traffy " + r.status);
  const j = await r.json();
  const items = (j.results || [])
    .filter((x: any) => FLOOD.test((x.description || "") + (x.problem_type_abdul || []).join(" ")))
    .map((x: any) => ({
      id: x.ticket_id,
      lat: +(+x.coords?.[1]).toFixed(5),
      lng: +(+x.coords?.[0]).toFixed(5),
      text: (x.description || "").replace(/\s+/g, " ").trim().slice(0, 120),
      photo: (x.photo_url || "").replace(PHOTO, ""),
      addr: (x.address || "").replace(/ กรุงเทพมหานคร$/, ""),
      state: x.state || "",
      ts: new Date(String(x.timestamp).replace(" ", "T").replace(/\+00$/, "Z")).toISOString(),
    }))
    .filter((x: any) => x.lat && x.lng);
  return { updated: new Date().toISOString(), items };
}

const tag = (s: string, t: string) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
const dec = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const rssItems = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => it);

async function googleNews() {
  const q = encodeURIComponent("น้ำท่วม when:1d");
  const r = await fetch(`https://news.google.com/rss/search?q=${q}&hl=th&gl=TH&ceid=TH:th`);
  if (!r.ok) throw new Error("google " + r.status);
  return rssItems(await r.text()).map((it) => {
    const source = dec(tag(it, "source"));
    let title = dec(tag(it, "title"));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: dec(tag(it, "link")), ts: new Date(tag(it, "pubDate")).toISOString() };
  });
}

async function bingNews() {
  const q = encodeURIComponent("น้ำท่วม");
  const r = await fetch(`https://www.bing.com/news/search?q=${q}&format=rss&setlang=th&cc=TH`);
  if (!r.ok) throw new Error("bing " + r.status);
  return rssItems(await r.text()).map((it) => {
    const raw = dec(tag(it, "link"));
    const link = new URL(raw).searchParams.get("url") || raw;  // ตัดตัว redirect ของ Bing
    return { title: dec(tag(it, "title")), source: dec(tag(it, "News:Source")), link, ts: new Date(tag(it, "pubDate")).toISOString() };
  });
}

// Google บล็อก IP ของ Supabase เป็นบางครั้ง จึงรวมกับ Bing
async function news() {
  const res = await Promise.allSettled([googleNews(), bingNews()]);
  const all = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!all.length) throw new Error(res.map((r) => (r.status === "rejected" ? String(r.reason) : "")).join("; "));
  const seen = new Set<string>();
  const items = all
    .filter((x) => x.title && !seen.has(x.title.slice(0, 40)) && seen.add(x.title.slice(0, 40)))
    .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 40);
  return { updated: new Date().toISOString(), items };
}

// ===== กล้อง: ตรวจสุขภาพทุกตัวก่อนส่งให้แผนที่ =====
// live = playlist เดินต่อเนื่อง, suspended = ต้นทางปิด (tempsus / ENDLIST),
// frozen = playlist ไม่ขยับใน 12 วิ, offline = โหลดไม่ได้ / ภาพว่าง / ภาพ "No signal"
type Cam = { title: string; lat: number; lng: number; hls: string; img: string; org: string; status?: string };
const T = (ms: number) => AbortSignal.timeout(ms);

async function pool<A, B>(items: A[], n: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function playlist(url: string) {
  let txt = await (await fetch(url, { signal: T(7000) })).text();
  if (!txt.startsWith("#EXTM3U")) throw new Error("not m3u8");
  const v = txt.split("\n").find((l) => l && !l.startsWith("#"));
  if (/#EXT-X-STREAM-INF/.test(txt) && v) txt = await (await fetch(new URL(v, url), { signal: T(7000) })).text();
  const segs = txt.split("\n").filter((l) => l && !l.startsWith("#"));
  return { seq: +((txt.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] ?? -1), last: segs.at(-1) || "", n: segs.length, ended: /#EXT-X-ENDLIST/.test(txt) };
}

async function imgHash(url: string) {
  const b = new Uint8Array(await (await fetch(url, { signal: T(7000) })).arrayBuffer());
  if (b.byteLength < 1500) return "";
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", b)), (x) => x.toString(16).padStart(2, "0")).join("");
}

// กรมทางหลวง (highwaytraffic.go.th): 190 จุด ~368 สตรีม HLS
// เซิร์ฟเวอร์สตรีมดับบ่อย จึงเช็กก่อน ถ้าต่อไม่ได้ข้ามทั้งชุด (ไม่ยิง API กรมฯ ~380 ครั้งเปล่าๆ)
const DOH = "https://highwaytraffic.go.th/DOHWeb/Home.aspx";
async function dohCams(): Promise<Cam[]> {
  const up = await fetch("https://streaming1.highwaytraffic.go.th/", { signal: T(6000) }).then(() => true, () => false);
  if (!up) return [];
  const H = { "User-Agent": "Mozilla/5.0" };
  const home = await fetch(DOH, { headers: H, signal: T(15000) });
  const cookie = home.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const sites = [...(await home.text()).matchAll(/CreateCustomDiv\(([\d.]+),\s*([\d.]+),\s*'[^']*',\s*'<div id="pin(\d+)"/g)]
    .map(([, lat, lng, id]) => ({ lat: +lat, lng: +lng, id }));
  const call = async (m: string, id: string) => (await (await fetch(`${DOH}/${m}`, {
    method: "POST", headers: { ...H, Cookie: cookie, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ siteID: +id }), signal: T(15000),
  })).json()).d;
  const per = await pool(sites, 10, async (s) => {
    try {
      const [info, cam] = await Promise.all([call("GetSiteInfo", s.id), call("GetCameraInfo", s.id)]);
      const name = ((String(info?.[3] || "").match(/ชื่อจุดติดตั้ง<\/b><\/td><td[^>]*>([^<]+)/) || [])[1] || "").trim();
      const prov = (name.match(/จ\.\S+/) || [""])[0];
      const place = name.replace(/\s*จ\.\S+/, "").replace(/^(\d+) - /, "ทล.$1 ");
      return [...String(cam).matchAll(/site_code="([^"]+\.m3u8)"/g)].map(([, hls]) => ({
        title: `${prov ? `(${prov}) ` : ""}${place} ${/_OUT\./.test(hls) ? "ขาออก" : "ขาเข้า"}`,
        lat: s.lat, lng: s.lng, hls, img: "", org: "กรมทางหลวง",
      }));
    } catch { return []; }
  });
  const seen = new Set<string>();  // บางจุดส่งสตรีมเดียวกันทั้งสองทิศ
  return per.flat().filter((c) => !seen.has(c.hls) && seen.add(c.hls));
}

async function cams() {
  const [j, doh] = await Promise.all([
    fetch("https://traffic.longdo.com/camera.json", { signal: T(15000) }).then((r) => r.json()),
    dohCams().catch(() => [] as Cam[]),
  ]);
  const list: Cam[] = (j.item || []).map((c: any) => ({
    title: c.title || "", lat: +c.latitude, lng: +c.longitude, hls: c.hls_url || "",
    img: /X\.X/.test(c.imgurl || "") ? "" : (c.imgurl || ""), org: c.organization || "",
  })).filter((c: Cam) => c.lat && c.lng && (c.hls || c.img)).concat(doh);

  const hls = list.filter((c) => c.hls && !/tempsus/.test(c.hls));
  list.filter((c) => /tempsus/.test(c.hls)).forEach((c) => (c.status = "suspended"));
  // ลองซ้ำ 1 ครั้งเมื่อพลาด กันกล้องที่ใช้งานได้ถูกซ่อนเพราะเน็ตสะดุดชั่วคราว
  const tryPl = (u: string) => playlist(u).catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => playlist(u))).catch(() => null);
  const first = await pool(hls, 20, (c) => tryPl(c.hls));
  await new Promise((r) => setTimeout(r, 12000));
  const second = await pool(hls, 20, (c) => tryPl(c.hls));
  hls.forEach((c, i) => {
    const a = first[i], b = second[i];
    if (!a || !b || !b.n) c.status = "offline";
    else if (b.ended) c.status = "suspended";
    else c.status = b.seq > a.seq || b.last !== a.last ? "live" : "frozen";
  });

  // ภาพนิ่ง: ภาพเดียวกันซ้ำ ≥3 กล้อง = ภาพ "No signal" ของระบบ
  const imgs = list.filter((c) => !c.hls);
  const hashes = await pool(imgs, 20, (c) => imgHash(c.img).catch(() => ""));
  const freq: Record<string, number> = {};
  hashes.forEach((h) => h && (freq[h] = (freq[h] || 0) + 1));
  imgs.forEach((c, i) => (c.status = hashes[i] && freq[hashes[i]] < 3 ? "live" : "offline"));

  const counts: Record<string, number> = {};
  list.forEach((c) => (counts[c.status!] = (counts[c.status!] || 0) + 1));
  return { updated: new Date().toISOString(), counts, items: list };
}

const KINDS: Record<string, () => Promise<unknown>> = { traffy, news, cams };

// ===== เก็บผลไว้ในตาราง feed_cache (pg_cron เรียก ?refresh=1 ทุก 5 นาที) =====
// หน้าเว็บอ่านตารางตรงผ่าน REST จึงไม่ต้องรอการตรวจกล้อง ~40 วิ
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const dbHeaders = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };
async function readDb(kind: string): Promise<{ body: string; at: number } | null> {
  const r = await fetch(`${SB_URL}/rest/v1/feed_cache?kind=eq.${kind}&select=body,updated_at`, { headers: dbHeaders });
  const rows = r.ok ? await r.json() : [];
  return rows[0] ? { body: JSON.stringify(rows[0].body), at: Date.parse(rows[0].updated_at) } : null;
}
async function writeDb(kind: string, body: string) {
  await fetch(`${SB_URL}/rest/v1/feed_cache`, {
    method: "POST", headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ kind, body: JSON.parse(body), updated_at: new Date().toISOString() }),
  });
}
const refreshing: Record<string, Promise<string> | undefined> = {};
function refresh(kind: string) {
  return (refreshing[kind] ??= KINDS[kind]()
    .then(async (d) => { const body = JSON.stringify(d); cache[kind] = { at: Date.now(), body }; await writeDb(kind, body); return body; })
    .finally(() => { refreshing[kind] = undefined; }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const kind = new URL(req.url).searchParams.get("kind") || "";
  const fn = KINDS[kind];
  if (!fn) return new Response('{"error":"kind must be traffy, news or cams"}', { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  const wantRefresh = new URL(req.url).searchParams.has("refresh");
  let hit = cache[kind] ?? await readDb(kind).catch(() => null);
  const age = hit ? Date.now() - hit.at : Infinity;
  // refresh=1 จาก pg_cron: ทำใหม่ (แต่ไม่ถี่กว่า 2 นาที กันคนยิงเล่นให้ระบบทำงานหนัก)
  // ผู้ใช้ทั่วไป: ใช้ของเดิม ถ้าไม่มีหรือเก่าเกิน 15 นาที (cron ค้าง) จึงทำใหม่
  if ((wantRefresh && age > 2 * 60e3) || age > 15 * 60e3) {
    try { hit = { body: await refresh(kind), at: Date.now() }; }
    catch (e) { if (!hit) return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }); }
  }
  return new Response(hit!.body, {
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
});
