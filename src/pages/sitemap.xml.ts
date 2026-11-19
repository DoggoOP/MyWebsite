import type { APIRoute } from 'astro';
import { SITE, getProjects } from '../lib/siteIndex';

export const GET: APIRoute = async () => {
  const projects = await getProjects();
  const urls = [`${SITE}/`, `${SITE}/about`, `${SITE}/projects`, ...projects.map(p => p.url)];
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') +
    '\n</urlset>\n';
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
