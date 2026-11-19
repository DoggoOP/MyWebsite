import type { APIRoute } from 'astro';
import { SITE, BIO, CONTACT, getProjects } from '../lib/siteIndex';

export const GET: APIRoute = async () => {
  const projects = await getProjects();
  const lines = [
    '# Ethan Kong',
    '',
    `> ${BIO}`,
    '',
    'The site has a home page with a lattice-Boltzmann airflow sim around a 3D scan, an About page on sailing and ceramics, and write-ups of engineering projects.',
    '',
    '## Pages',
    '',
    `- [Home](${SITE}/): short bio and contact links`,
    `- [About](${SITE}/about): sailing for Hong Kong and ceramics`,
    `- [Projects](${SITE}/projects): every project write-up`,
    `- [Resume](${CONTACT.resume}): resume (PDF)`,
    '',
    '## Projects',
    '',
    ...projects.map(p => `- [${p.title}](${p.url})${p.year ? ` (${p.year})` : ''}: ${p.description}`),
    '',
    '## Contact',
    '',
    `- [Email](mailto:${CONTACT.email})`,
    `- [GitHub](${CONTACT.github})`,
    `- [LinkedIn](${CONTACT.linkedin})`,
    '',
  ];
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
