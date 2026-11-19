import type { APIRoute } from 'astro';
import { agentManifest } from '../../lib/agentManifest';

export const GET: APIRoute = async () =>
  new Response(JSON.stringify(agentManifest(), null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
