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
type Cam = { title: string; lat: number; lng: number; hls: string; img: string; org: string; yt?: string; ytc?: string; status?: string };
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

// กล้อง YouTube Live ที่ตั้งประจำจุดในไทย (เอกชน/ร้านค้า เปิดสาธารณะ) พิกัดเป็นค่าประมาณจากชื่อสถานที่
// ช่อง 24/7 บางช่องเปลี่ยน video id เมื่อเริ่มสตรีมใหม่ → ตรวจ isLiveNow ทุกรอบ ตัวที่ตายจะถูกซ่อนเอง
const YT: [string, string, number, number][] = [
  ["a_bUVExv_Cg", "(กรุงเทพมหานคร) ถ.เพชรบุรี", 13.7503, 100.5400],
  ["Q71sLS8h9a4", "(กรุงเทพมหานคร) สุขุมวิท ซอย 19", 13.7385, 100.5608],
  ["UemFRPrl1hk", "(กรุงเทพมหานคร) สุขุมวิท ซอย 11", 13.7430, 100.5555],
  ["dIcFDZQDueI", "(กรุงเทพมหานคร) รวมกล้องระดับน้ำกรมทรัพยากรน้ำ 8 จุด (ปทุมฯ–สะพานพุทธ–ปากน้ำ)", 13.7393, 100.4973],
  ["rNwD42V8xDM", "(กรุงเทพมหานคร) มุมสูงดินแดง–อโศก", 13.7560, 100.5600],
  ["Vx1x_Pjcu-E", "(กรุงเทพมหานคร) มุมสูงกรุงเทพฯ (ไม่ระบุจุดแน่ชัด)", 13.7460, 100.5350],
  ["8biyA90vl1Q", "(กรุงเทพมหานคร) ท่าอากาศยานดอนเมือง", 13.9126, 100.6068],
  ["yoHisCvvrSo", "(จ.สมุทรปราการ) ท่าอากาศยานสุวรรณภูมิ", 13.6900, 100.7501],
  ["OsjwtFXkVoc", "(จ.ระยอง) ถ.จันทอุดม", 12.6810, 101.2780],
  ["cnGqGE5B8GI", "(จ.ชลบุรี) พัทยาใต้", 12.9270, 100.8720],
  ["Qa5LqU9xxtc", "(จ.ชลบุรี) ถ.เลียบหาดพัทยา", 12.9360, 100.8830],
  ["zKmXMNQ4rEs", "(จ.ชลบุรี) หาดวงศ์อมาตย์ พัทยา", 12.9690, 100.8870],
  ["_nvG0c9keWI", "(จ.ภูเก็ต) ถ.สายน้ำเย็น ป่าตอง", 7.8920, 98.2990],
  ["zsmvEf_PTpY", "(จ.ภูเก็ต) แหลมพันวา", 7.8060, 98.4070],
  ["PPJ55qdY3pw", "(จ.ประจวบคีรีขันธ์) หาดหัวหิน", 12.5690, 99.9590],
  ["3N3ZwIB_X4Y", "(จ.สุราษฎร์ธานี) คริสตัลเบย์ ละไม เกาะสมุย", 9.4870, 100.0660],
  ["Fw9hgttWzIg", "(จ.สุราษฎร์ธานี) หาดคริสตัลเบย์ ละไม เกาะสมุย", 9.4860, 100.0655],
  ["Szx0K7gZBx8", "(จ.สุราษฎร์ธานี) วิลล่าเต่า ละไม เกาะสมุย", 9.4750, 100.0600],
  ["Tpj0cmMVOd0", "(จ.สุราษฎร์ธานี) หาดละไม เกาะสมุย", 9.4700, 100.0480],
  ["xz0WEWxhHZY", "(จ.สุราษฎร์ธานี) หาดละไมใต้ เกาะสมุย", 9.4640, 100.0470],
  ["CSp55hSd_6A", "(จ.สุราษฎร์ธานี) หมู่บ้านชาวประมงบ่อผุด เกาะสมุย", 9.5580, 100.0270],
  ["bbBGNNPu0rg", "(จ.สุราษฎร์ธานี) ถนนบ่อผุด เกาะสมุย", 9.5582, 100.0290],
  ["yFgVmioYkys", "(จ.สุราษฎร์ธานี) ซอยกรีนแมงโก้ เฉวง เกาะสมุย", 9.5370, 100.0610],
  ["DwKCna1mumk", "(จ.สุราษฎร์ธานี) ซอยกรีนแมงโก้ 2 เฉวง เกาะสมุย", 9.5372, 100.0612],
  ["5ooiCHRoP18", "(จ.สุราษฎร์ธานี) ถ.เฉวง เกาะสมุย", 9.5330, 100.0620],
  ["Jv_2vPCbZUo", "(จ.สุราษฎร์ธานี) ถ.เฉวงใต้ เกาะสมุย", 9.5320, 100.0625],
  ["_TTK7VxTyCA", "(จ.สุราษฎร์ธานี) ตลาดบันยัน เกาะสมุย", 9.5350, 100.0600],
  ["z50dAep3lvA", "(จ.สุราษฎร์ธานี) พระใหญ่ เกาะสมุย", 9.5710, 100.0600],
  ["MW3fisTCXRQ", "(จ.สุราษฎร์ธานี) หาดริ้น เกาะพะงัน", 9.6780, 100.0640],
];
// เทศบาลนครรังสิต (cdp.rangsitcity.go.th): กล้องวัดระดับน้ำ ภาพนิ่งอัปเดตทุกไม่กี่วินาที
const RANGSIT: Cam[] = [
  { title: "(จ.ปทุมธานี) คลองรังสิตประยูรศักดิ์ (สะพานแดง)", lat: 13.98613, lng: 100.62596, hls: "", img: "https://cdp.rangsitcity.go.th/api/flood/snapshot/151", org: "เทศบาลนครรังสิต" },
  { title: "(จ.ปทุมธานี) แม่น้ำเจ้าพระยา เมืองปทุม", lat: 14.02283, lng: 100.53556, hls: "", img: "https://cdp.rangsitcity.go.th/api/flood/snapshot/152", org: "เทศบาลนครรังสิต" },
];

// กล้องเขื่อนใหญ่ กฟผ. (egatwater.egat.co.th) — ภาพนิ่ง https อัปเดตรายชั่วโมง
// ต้นน้ำเจ้าพระยา/แม่กลอง ช่วยดูการระบายน้ำเหนือเขื่อน ตรวจ Last-Modified ตัดภาพค้าง >24 ชม.
const EGAT: Cam[] = [
  { title: "(จ.ตาก) เขื่อนภูมิพล (ปิง)", lat: 17.24412, lng: 98.97269, hls: "", img: "https://egatwater.egat.co.th/assets/CCTV/images/BB/1.jpg", org: "กฟผ." },
  { title: "(จ.อุตรดิตถ์) เขื่อนสิริกิติ์ (น่าน)", lat: 17.76507, lng: 100.56485, hls: "", img: "https://egatwater.egat.co.th/assets/CCTV/images/SK/1.jpg", org: "กฟผ." },
  { title: "(จ.กาญจนบุรี) เขื่อนศรีนครินทร์ (แควใหญ่)", lat: 14.40790, lng: 99.12867, hls: "", img: "https://egatwater.egat.co.th/assets/CCTV/images/SNR/1.jpg", org: "กฟผ." },
  { title: "(จ.กาญจนบุรี) เขื่อนวชิราลงกรณ์ (แควน้อย)", lat: 14.79745, lng: 98.59285, hls: "", img: "https://egatwater.egat.co.th/assets/CCTV/images/VRK/1.jpg", org: "กฟผ." },
  { title: "(จ.ยะลา) เขื่อนบางลาง (ปัตตานี)", lat: 6.32028, lng: 101.27583, hls: "", img: "https://egatwater.egat.co.th/assets/CCTV/images/BLG/1.jpg", org: "กฟผ." },
];
async function egatCams(): Promise<Cam[]> {
  return await pool(EGAT, 5, async (c) => {
    let status = "offline";
    try {
      const r = await fetch(c.img, { signal: T(9000) });
      const lm = Date.parse(r.headers.get("last-modified") || "");
      if (r.ok && (!lm || Date.now() - lm < 24 * 3600e3)) status = "live";
    } catch { /* offline */ }
    return { ...c, status };
  });
}

async function ytCams(): Promise<Cam[]> {
  // ยิงทีละ 3 + ลองซ้ำ: YouTube จำกัดความถี่จาก IP ของ Supabase
  const page = async (id: string) => {
    for (let k = 0; k < 3; k++) {
      const r = await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" }, signal: T(10000) }).catch(() => null);
      const h = r?.ok ? await r.text() : "";
      if (/"isLiveNow"|"playableInEmbed"/.test(h)) return h;
      await new Promise((ok) => setTimeout(ok, 2000 * (k + 1)));
    }
    return "";
  };
  return await pool(YT, 3, async ([id, title, lat, lng]) => {
    let status = "offline";
    try {
      const h = await page(id);
      if (/"playableInEmbed":false/.test(h)) status = "suspended";  // เจ้าของปิดการฝัง เล่นในหน้าเราไม่ได้
      else if (/"isLiveNow":true/.test(h)) status = "live";
      // YouTube บล็อก IP / หน้า consent → ดูไม่ออก ใช้ oEmbed ยืนยันว่าวิดีโอยังอยู่แทน
      else if (!/"isLiveNow"/.test(h) && (await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}`, { signal: T(8000) })).ok) status = "live";
    } catch { /* offline */ }
    return { title, lat, lng, hls: "", img: "", yt: id, org: "YouTube Live", status };
  });
}

// กล้อง YouTube แบบอ้างอิงช่อง (ช่องที่ตัดไลฟ์เป็นช่วง เปลี่ยน video id ทุกไม่กี่ ชม.)
// ฝังด้วย embed/live_stream?channel= ให้ YouTube เล่นไลฟ์ปัจจุบันเอง id ตายก็ไม่พัง
const YTC: [string, string, number, number][] = [
  ["UCOQ8-W-fg0tZZTwJJDq62mA", "(จ.สุโขทัย) ปตร.แม่น้ำยม หาดสะพานจันทร์", 17.0130, 99.8210],
];
async function ytcCams(): Promise<Cam[]> {
  return await pool(YTC, 3, async ([cid, title, lat, lng]) => {
    let status = "offline";
    try {
      // cookie CONSENT/SOCS ข้ามหน้า consent; edge บางครั้งยังได้หน้า bot/consent จึงลองซ้ำ
      let h = "";
      for (let k = 0; k < 3; k++) {
        const r = await fetch(`https://www.youtube.com/channel/${cid}/live`, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en", Cookie: "CONSENT=YES+1; SOCS=CAI" }, signal: T(10000) }).catch(() => null);
        h = r?.ok ? await r.text() : "";
        if (/"isLive":(true|false)|"playabilityStatus"/.test(h)) break;
        await new Promise((ok) => setTimeout(ok, 2000 * (k + 1)));
      }
      // edge ไม่ใส่ canonical/isLiveNow แต่มี "isLive":true เมื่อกำลังไลฟ์จริง
      if (/"isLive":true/.test(h) && !/"playableInEmbed":false/.test(h)) status = "live";
    } catch { /* offline */ }
    return { title, lat, lng, hls: "", img: "", ytc: cid, org: "YouTube Live", status };
  });
}

async function cams() {
  const ytP = ytCams().catch(() => [] as Cam[]);
  const ytcP = ytcCams().catch(() => [] as Cam[]);
  const egatP = egatCams().catch(() => [] as Cam[]);
  const [j, doh] = await Promise.all([
    fetch("https://traffic.longdo.com/camera.json", { signal: T(15000) }).then((r) => r.json()),
    dohCams().catch(() => [] as Cam[]),
  ]);
  const list: Cam[] = (j.item || []).map((c: any) => ({
    title: c.title || "", lat: +c.latitude, lng: +c.longitude, hls: c.hls_url || "",
    img: /X\.X/.test(c.imgurl || "") ? "" : (c.imgurl || ""), org: c.organization || "",
  })).filter((c: Cam) => c.lat && c.lng && (c.hls || c.img)).concat(doh, RANGSIT);

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

  list.push(...await ytP, ...await ytcP, ...await egatP);  // ตรวจสถานะของตัวเองแล้ว ไม่ต้องผ่านขั้น hls/ภาพนิ่ง
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
