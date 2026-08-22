begin;

-- 模型选择属于已验证账号，不属于某台浏览器或某条消息。
-- 不回填现有数据；没有偏好行时，后端继续使用服务端默认模型。
create table public.chat_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  model_alias text not null,
  updated_at timestamp with time zone not null default now(),
  constraint chat_preferences_model_alias_check
    check (model_alias ~ '^cc-home-[a-z0-9][a-z0-9._-]{0,119}$')
);

comment on table public.chat_preferences is
  'CC Home 账号级聊天偏好；只保存后端允许的公开模型别名，不保存供应商配置或凭证。';
comment on column public.chat_preferences.model_alias is
  'Haven Gateway 的安全公开别名；后端读取时仍会重新检查服务端允许列表。';

-- 浏览器不得直接读写偏好；所有访问都经过验证 Supabase JWT 的 CC Home 后端。
alter table public.chat_preferences enable row level security;
revoke all privileges on table public.chat_preferences from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_preferences to service_role;

commit;
