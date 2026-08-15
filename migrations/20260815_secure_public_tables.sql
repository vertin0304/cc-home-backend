begin;

-- 浏览器不直接访问这些后端数据表。重复启用 RLS 是安全的，不会修改现有数据。
alter table if exists public.sessions enable row level security;
alter table if exists public.messages enable row level security;
alter table if exists public.memories enable row level security;
alter table if exists public.settings enable row level security;

-- 不为 anon/authenticated 创建 policy，并撤销显式授权及从 PUBLIC 继承的表权限。
revoke all privileges on table public.sessions from public, anon, authenticated;
revoke all privileges on table public.messages from public, anon, authenticated;
revoke all privileges on table public.memories from public, anon, authenticated;
revoke all privileges on table public.settings from public, anon, authenticated;

-- 后端 secret key 使用 service_role；显式保留常规数据访问且不授予浏览器角色。
grant select, insert, update, delete on table public.sessions to service_role;
grant select, insert, update, delete on table public.messages to service_role;
grant select, insert, update, delete on table public.memories to service_role;
grant select, insert, update, delete on table public.settings to service_role;

commit;
