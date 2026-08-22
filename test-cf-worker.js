import { createServerClient } from '@supabase/ssr';
import { NextResponse, NextRequest } from 'next/server';

export default {
  async fetch(request, env, ctx) {
    return new Response("Hello World");
  }
};
