// ดึงรายงานน้ำท่วมจาก Traffy Fondue + ข่าวจาก Google News แล้วเขียนเป็นไฟล์เล็กๆ ให้แผนที่อ่าน
// รันโดย GitHub Actions ทุก 15 นาที: node scripts/fetch-feeds.mjs <outDir> [prevTraffyUrl]
import { writeFileSync, mkdirSync } from "node:fs";

const out = process.argv[2] || "out";
const prevUrl = process.argv[3];
const KEEP_MS = 24 * 3600e3;
const PHOTO = "https://storage.googleapis.com/traffy_public_bucket/attachment/";
const FLOOD = /ท่วม|น้ำขัง|น้ำรอระบาย|ระบายน้ำไม่ทัน/;
mkdirSync(out, { recursive: true });

async function get(url, as = "json") {
  const r = await fetch(url, { headers: { "User-Agent": "bkk-flood-map (github.com/ZenkTH22/bkk-flood-map)" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return as === "json" ? r.json() : r.text();
}

async function traffy() {
  // API ส่งเรื่องล่าสุดได้สูงสุด 1000 เรื่อง (~4 ชม.) จึงรวมกับรอบก่อนเพื่อให้ครอบคลุม 24 ชม.
  let prev = [];
  if (prevUrl) try { prev = (await get(prevUrl)).items || []; } catch {}
  const j = await get("https://publicapi.traffy.in.th/share/teamchadchart/search?limit=1000");
  const fresh = (j.results || [])
    .filter(x => FLOOD.test((x.description || "") + (x.problem_type_abdul || []).join(" ")))
    .map(x => ({
      id: x.ticket_id,
      lat: +(+x.coords?.[1]).toFixed(5),
      lng: +(+x.coords?.[0]).toFixed(5),
      text: (x.description || "").replace(/\s+/g, " ").trim().slice(0, 120),
      photo: (x.photo_url || "").replace(PHOTO, ""),  // เก็บแค่ท้าย path ให้ไฟล์เล็ก
      addr: (x.address || "").replace(/ กรุงเทพมหานคร$/, ""),
      state: x.state || "",
      ts: new Date(x.timestamp.replace(" ", "T").replace(/\+00$/, "Z")).toISOString(),
    }))
    .filter(x => x.lat && x.lng);
  const byId = new Map(prev.map(x => [x.id, x]));
  fresh.forEach(x => byId.set(x.id, x));
  const cutoff = Date.now() - KEEP_MS;
  const items = [...byId.values()].filter(x => Date.parse(x.ts) > cutoff).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 1500);
  return { updated: new Date().toISOString(), items };
}

async function news() {
  const q = encodeURIComponent("น้ำท่วม when:1d");
  const xml = await get(`https://news.google.com/rss/search?q=${q}&hl=th&gl=TH&ceid=TH:th`, "text");
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
  const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const source = dec(tag(it, "source"));
    let title = dec(tag(it, "title"));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: dec(tag(it, "link")), ts: new Date(tag(it, "pubDate")).toISOString() };
  }).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 40);
  return { updated: new Date().toISOString(), items };
}

for (const [name, fn] of [["traffy", traffy], ["news", news]]) {
  try {
    const data = await fn();
    writeFileSync(`${out}/${name}.json`, JSON.stringify(data));
    console.log(name, data.items.length);
  } catch (e) {
    console.error(name, "failed:", e.message);
    process.exitCode = 1;
  }
}
