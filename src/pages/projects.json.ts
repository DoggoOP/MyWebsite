import type { APIRoute } from 'astro';
import { getProjects } from '../lib/siteIndex';

// Read by the WebMCP tools in src/scripts/webmcp.ts.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await getProjects()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
