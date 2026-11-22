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

-- The owner's certification. `visit` is the last site visit scored against the standard, kept with
-- the wording of each item as it was that day. Dates are stored as text, 2026-11-20, so a day never
-- shifts with a time zone. A company is approved on approved_on and due another visit on review_due.
alter table partners add column if not exists visit jsonb not null default '{}';
alter table partners add column if not exists approved_on text not null default '';
alter table partners add column if not exists review_due text not null default '';
-- Whether the company is named on the website's approved list. Off until the owner turns it on.
alter table partners add column if not exists listed boolean not null default false;

-- Pictures and files a customer adds to a request. See server/lib/files.js.
create table if not exists request_files (
  id serial primary key,
  request_id integer not null references requests(id) on delete cascade,
  -- site | idea | document
  kind text not null,
  name text not null,
  -- image/jpeg | application/pdf
  mime text not null,
  size integer not null,
  -- shared: companies quoting can see it. review: waiting for the owner to decide. private: the owner kept it back.
  sharing text not null default 'shared',
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists request_files_request on request_files (request_id);

-- Messages sent from the contact page.
create table if not exists messages (
  id serial primary key,
  name text not null,
  -- A phone number or an email address, as the sender typed it.
  reach text not null,
  body text not null,
  handled boolean not null default false,
  created_at timestamptz not null default now()
);

-- More of each quote, so a customer can compare quotes line by line.
-- The fee terms in force when the brief was sent: the smallest and largest fee, in cents (0 = none).
alter table quotes add column if not exists fee_min_cents integer not null default 0;
alter table quotes add column if not exists fee_max_cents integer not null default 0;
-- The owner can waive a fee: a job that fell through, a first job on the house.
alter table quotes add column if not exists fee_waived boolean not null default false;
-- When the customer chose. A fee's due date counts from here.
alter table requests add column if not exists chosen_at timestamptz;
alter table quotes add column if not exists start_by text not null default '';
alter table quotes add column if not exists payment_terms text not null default '';
alter table quotes add column if not exists excludes text not null default '';
alter table quotes add column if not exists permit text not null default '';

-- What a customer said about the company they hired, after the job. One per request.
create table if not exists ratings (
  id serial primary key,
  request_id integer not null unique references requests(id) on delete cascade,
  quote_id integer not null references quotes(id) on delete cascade,
  stars integer not null,
  again boolean not null,
  comment text not null default '',
  -- The customer said it may be shown on the site with their first name.
  may_publish boolean not null default false,
  -- The owner chose to show it. Only possible when may_publish is true.
  published boolean not null default false,
  seen boolean not null default false,
  created_at timestamptz not null default now()
);

-- Invoices: the ledger of finder's fees. One is issued when a customer chooses a company that owes a
-- fee. Each keeps its own copy of what it bills, so it stays in the books after its request is
-- deleted, and it holds nothing about the customer. A number is never used twice.
-- See server/lib/invoices.js for what open, paid, refunded and void mean.
create sequence if not exists invoice_number_seq start 1001;

create table if not exists invoices (
  id serial primary key,
  -- Shown as INV-1001.
  number integer not null unique,
  -- Opens the company's invoice page: /q/invoice/<token>
  token text not null unique,
  quote_id integer references quotes(id) on delete set null,
  -- Not a foreign key: the invoice outlives its request.
  request_id integer,
  partner_id integer references partners(id) on delete set null,
  -- False once the customer's choice was undone or the request was deleted while the invoice was
  -- unpaid. A quote has at most one current invoice.
  current boolean not null default true,
  company text not null,
  service text not null,
  tier text not null default '',
  -- The request's reference, such as R1004.
  job_ref text not null,
  quoted_cents bigint not null,
  fee_percent numeric(5,2) not null,
  fee_min_cents integer not null default 0,
  fee_max_cents integer not null default 0,
  amount_cents bigint not null,
  issued_at timestamptz not null default now(),
  due_at timestamptz not null,
  paid_at timestamptz,
  -- How it was paid, in words: Zelle, Check, Card through Stripe, and so on.
  paid_how text not null default '',
  -- What the payment service kept, when it is known.
  processor_fee_cents integer,
  refunded_cents bigint not null default 0,
  refunded_at timestamptz,
  voided_at timestamptz,
  void_reason text not null default '',
  -- A bank payment was started on Stripe and has not finished yet.
  pending_since timestamptz,
  -- Something the owner and the company should know about the last try, such as a failed bank payment.
  payment_note text not null default '',
  stripe_session_id text not null default '',
  stripe_session_url text not null default '',
  stripe_session_expires timestamptz,
  stripe_payment_intent text not null default '',
  stripe_charge text not null default '',
  stripe_checked_at timestamptz,
  -- How the owner last sent it, and how often the company opened it.
  sends integer not null default 0,
  last_send text not null default '',
  last_sent_at timestamptz,
  opens integer not null default 0,
  last_opened_at timestamptz
);

create unique index if not exists invoices_current_quote on invoices (quote_id) where current and quote_id is not null;
create index if not exists invoices_request_idx on invoices (request_id);
