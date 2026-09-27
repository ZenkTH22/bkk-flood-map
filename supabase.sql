-- จุดเสี่ยงน้ำท่วมที่ประชาชนรายงาน
-- แต่ละแถว = 1 รายงาน; อัปเดตสถานะจุดเดิม = แถวใหม่ที่มี parent_id ชี้จุดแรก

create table public.reports (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  parent_id  bigint references public.reports(id) on delete cascade,
  lat        double precision not null check (lat between 5.5 and 20.6),
  lng        double precision not null check (lng between 97.3 and 105.7),
  place      text not null check (char_length(place) between 2 and 80),
  level      text not null check (level in ('pond','high','cleared')),
  note       text check (char_length(note) <= 200),
  hidden     boolean not null default false   -- แอดมินติ๊กเพื่อซ่อนจุดมั่ว
);
create index on public.reports (created_at desc);
create index on public.reports (parent_id);

-- เก็บ hash ของ IP ไว้จำกัดความถี่ (anon อ่านไม่ได้)
create table public.report_rate (
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index on public.report_rate (ip_hash, at);
alter table public.report_rate enable row level security;

create or replace function public.reports_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ip text := coalesce(split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1), 'unknown');
  h  text := md5(ip);
  p  public.reports;
begin
  new.hidden := false;
  new.created_at := now();
  if new.parent_id is not null then
    select * into p from public.reports where id = new.parent_id and parent_id is null and not hidden;
    if not found then raise exception 'ไม่พบจุดเดิม'; end if;
    new.lat := p.lat; new.lng := p.lng; new.place := p.place;
  end if;
  if (select count(*) from public.report_rate where ip_hash = h and at > now() - interval '10 minutes') >= 5 then
    raise exception 'ส่งถี่เกินไป ลองใหม่ในอีกสักครู่';
  end if;
  insert into public.report_rate(ip_hash) values (h);
  delete from public.report_rate where at < now() - interval '1 day';
  return new;
end $$;

create trigger reports_guard before insert on public.reports
  for each row execute function public.reports_guard();

-- สิทธิ์: ทุกคนอ่านได้ (ไม่รวมที่ซ่อน/เก่ากว่า 3 วัน), เพิ่มได้, แก้/ลบไม่ได้
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant select, insert on public.reports to anon, authenticated;

create policy "read recent visible" on public.reports for select
  to anon, authenticated
  using (not hidden and created_at > now() - interval '3 days');

create policy "anyone can report" on public.reports for insert
  to anon, authenticated
  with check (true);

-- ส่งรายงานใหม่แบบ realtime ให้ทุกคนที่เปิดแผนที่
alter publication supabase_realtime add table public.reports;
