begin;

-- 现有 sessions/messages 行是历史测试数据。本迁移只增加 nullable 列和约束，
-- 不回填、不更新、不删除、不合并任何现有行；三列均为 NULL 的行即 legacy。
alter table public.sessions
  add column user_id uuid null,
  add column session_kind text null,
  add column conversation_id uuid null;

alter table public.sessions
  add constraint sessions_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete restrict,
  add constraint sessions_owned_main_shape_check
    check (
      (
        user_id is null
        and session_kind is null
        and conversation_id is null
      )
      or
      (
        user_id is not null
        and session_kind = 'main'
        and conversation_id is not null
      )
    );

-- 第一版每个 Supabase 用户只能有一个主聊天。
create unique index sessions_one_main_per_user_idx
  on public.sessions (user_id)
  where session_kind = 'main';

-- conversation_id 由后端生成，仅用于 Gateway session；不作为客户端授权依据。
create unique index sessions_conversation_id_key
  on public.sessions (conversation_id)
  where conversation_id is not null;

comment on column public.sessions.user_id is
  'Supabase Auth 用户 UUID；NULL 表示不可访问的 legacy session。';
comment on column public.sessions.session_kind is
  '第一版仅允许 main；NULL 表示不可访问的 legacy session。';
comment on column public.sessions.conversation_id is
  '服务端生成的稳定 Gateway conversation UUID；不返回客户端。';

commit;
