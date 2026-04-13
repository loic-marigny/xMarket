-- Minimal Supabase schema inferred from application + scripts.
-- Run this in Supabase SQL editor (or psql) for a fresh project.

create table if not exists public.stock_market_companies (
  id bigserial primary key,
  symbol text not null unique,
  name text,
  sector text,
  market_code text,
  market text,
  profile text,
  logo text,
  history text,
  industry text,
  website text,
  ir_website text,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_market_history (
  id bigserial primary key,
  symbol text not null,
  record_date date not null,
  open_value double precision,
  high_value double precision,
  low_value double precision,
  close_value double precision,
  record_value double precision,
  created_at timestamptz not null default now(),
  constraint stock_market_history_symbol_date_key unique (symbol, record_date),
  constraint stock_market_history_symbol_fk
    foreign key (symbol) references public.stock_market_companies(symbol)
    on delete cascade
);

create table if not exists public.company_fundamentals (
  symbol text primary key
    references public.stock_market_companies(symbol) on delete cascade,
  long_business_summary text,
  market_cap bigint,
  fifty_two_week_high double precision,
  fifty_two_week_low double precision,
  all_time_high double precision,
  all_time_low double precision,
  beta double precision,
  recommendation_mean double precision,
  trailing_pe double precision,
  trailing_eps double precision,
  total_revenue bigint,
  total_debt bigint,
  total_cash bigint,
  free_cashflow bigint,
  operating_cashflow bigint,
  last_updated timestamptz
);

create index if not exists stock_market_history_symbol_idx
  on public.stock_market_history(symbol);
