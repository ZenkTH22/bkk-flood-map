// Supabase Edge Function "feeds": ดึงร้องเรียนน้ำท่วมจาก Traffy Fondue + ข่าวน้ำท่วมจาก Google News
// แล้วส่งกลับเป็น JSON ขนาดเล็กพร้อม CORS ให้แผนที่อ่าน; เก็บผลไว้ในหน่วยความจำ 5 นาที
// เรียก: GET /functions/v1/feeds?kind=traffy | news   (ปิด Verify JWT)

const TTL = 5 * 60e3;
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

const KINDS: Record<string, () => Promise<unknown>> = { traffy, news };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const kind = new URL(req.url).searchParams.get("kind") || "";
  const fn = KINDS[kind];
  if (!fn) return new Response('{"error":"kind must be traffy or news"}', { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  const hit = cache[kind];
  if (!hit || Date.now() - hit.at > TTL) {
    try {
      cache[kind] = { at: Date.now(), body: JSON.stringify(await fn()) };
    } catch (e) {
      if (!hit) return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }
  return new Response(cache[kind].body, {
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
});
