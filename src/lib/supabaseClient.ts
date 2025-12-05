import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url) {
  // Surface a helpful console.error in production when the env var is missing
  console.error('VITE_SUPABASE_URL is not defined at build time');
  throw new Error('Supabase URL is missing');
}

if (!anonKey) {
  console.error('VITE_SUPABASE_ANON_KEY is not defined at build time');
  throw new Error('Supabase anon key is missing');
}

/** Shared Supabase client used for metadata and prices (never persists browser sessions). */
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false },
});
