-- ผลล่าสุดของ Edge Function "feeds" (traffy / news / cams) ให้หน้าเว็บอ่านได้ทันที
create table if not exists public.feed_cache (
  kind       text primary key,
  body       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.feed_cache enable row level security;
revoke all on public.feed_cache from anon, authenticated;
grant select on public.feed_cache to anon, authenticated;
drop policy if exists "public read" on public.feed_cache;
create policy "public read" on public.feed_cache for select to anon, authenticated using (true);

-- ให้ฐานข้อมูลเรียกฟังก์ชันเองทุก 5 นาที (กล้องใช้เวลาตรวจ ~40 วิ จึงเผื่อ timeout 2 นาที)
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('feeds-cams',   '*/5 * * * *',
  $$select net.http_get('https://lydzncyvjxxysfudwcmi.supabase.co/functions/v1/feeds?kind=cams&refresh=1',   timeout_milliseconds := 120000)$$);
select cron.schedule('feeds-traffy', '*/5 * * * *',
  $$select net.http_get('https://lydzncyvjxxysfudwcmi.supabase.co/functions/v1/feeds?kind=traffy&refresh=1', timeout_milliseconds := 60000)$$);
select cron.schedule('feeds-news',   '*/10 * * * *',
  $$select net.http_get('https://lydzncyvjxxysfudwcmi.supabase.co/functions/v1/feeds?kind=news&refresh=1',   timeout_milliseconds := 60000)$$);
