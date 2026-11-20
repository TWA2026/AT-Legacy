-- Runs on every deploy. Every statement must be safe to repeat.

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists partners (
  id serial primary key,
  company text not null,
  contact_name text not null,
  phone text not null default '',
  email text not null default '',
  trade text not null,
  tier text not null,
  years text not null default '',
  license_no text not null default '',
  insured text not null default '',
  areas text not null default '',
  website text not null default '',
  -- applied | verified | paused
  status text not null default 'applied',
  check_registration boolean not null default false,
  check_license boolean not null default false,
  check_insurance boolean not null default false,
  check_references boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists requests (
  id serial primary key,
  token text not null unique,
  service text not null,
  property text not null,
  location text not null,
  timing text not null,
  size text not null default '',
  details text not null,
  tiers text[] not null,
  answers jsonb not null default '[]',
  brief jsonb not null,
  name text not null,
  phone text not null,
  email text not null default '',
  contact_method text not null,
  -- new | collecting | chosen | closed
  status text not null default 'new',
  chosen_quote_id integer,
  created_at timestamptz not null default now()
);

create table if not exists quotes (
  id serial primary key,
  request_id integer not null references requests(id) on delete cascade,
  partner_id integer not null references partners(id),
  tier text not null,
  token text not null unique,
  -- invited | visit | submitted | declined
  status text not null default 'invited',
  amount_cents bigint,
  includes text not null default '',
  timeline text not null default '',
  warranty text not null default '',
  fee_percent numeric(5,2) not null,
  final_amount_cents bigint,
  fee_paid boolean not null default false,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (request_id, tier)
);

create index if not exists quotes_partner_idx on quotes (partner_id);
create index if not exists requests_created_idx on requests (created_at desc);

-- When each private link was sent by the owner and opened by the person it is for.
-- quote_id is empty for the customer's link.
create table if not exists link_events (
  id bigserial primary key,
  request_id integer not null references requests(id) on delete cascade,
  quote_id integer references quotes(id) on delete cascade,
  -- copied | texted | emailed | shared | opened
  event text not null,
  created_at timestamptz not null default now()
);

create index if not exists link_events_link_idx on link_events (request_id, quote_id);
