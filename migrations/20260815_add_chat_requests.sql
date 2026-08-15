begin;

-- 每轮聊天由后端生成 request_id。现有消息保持 NULL，不回填、不更新正文。
alter table public.messages
  add column request_id uuid null;

alter table public.messages
  add constraint messages_request_id_role_check
    check (request_id is null or role in ('ai', 'assistant'));

create unique index messages_request_id_key
  on public.messages (request_id)
  where request_id is not null;

comment on column public.messages.request_id is
  '后端生成的聊天请求 UUID；仅成功 assistant 消息使用，旧消息保持 NULL。';

create table public.chat_requests (
  request_id uuid primary key,
  session_id bigint null references public.sessions(id) on delete cascade,
  status text not null,
  error_stage text null,
  error_code text null,
  diagnostics jsonb not null default '{}'::jsonb,
  started_at timestamp with time zone not null,
  completed_at timestamp with time zone not null,
  constraint chat_requests_status_check
    check (status in ('success', 'error')),
  constraint chat_requests_error_shape_check
    check (
      (
        status = 'success'
        and error_stage is null
        and error_code is null
      )
      or
      (
        status = 'error'
        and error_stage ~ '^[a-z][a-z0-9_]{0,63}$'
        and error_code ~ '^[a-z][a-z0-9_]{0,63}$'
      )
    ),
  constraint chat_requests_diagnostics_object_check
    check (jsonb_typeof(diagnostics) = 'object'),
  constraint chat_requests_time_order_check
    check (completed_at >= started_at)
);

create index chat_requests_session_completed_idx
  on public.chat_requests (session_id, completed_at desc)
  where session_id is not null;

comment on table public.chat_requests is
  'CC Home 每轮聊天的脱敏诊断；不保存消息、提示词、记忆正文或凭证。';

-- 浏览器不能直连聊天诊断。后端 service_role 是唯一数据访问者。
alter table public.chat_requests enable row level security;
revoke all privileges on table public.chat_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_requests to service_role;

commit;
