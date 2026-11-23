import type { APIRoute } from 'astro';
import { SITE, BIO, CONTACT, getProjects } from '../lib/siteIndex';

export const GET: APIRoute = async () => {
  const projects = await getProjects();
  const lines = [
    '# Ethan Kong',
    '',
    `> ${BIO}`,
    '',
    'The home page puts everything on one page: an interactive 3D scan of Ethan, every project, two sails and a chart of his classes, with a GPU lattice-Boltzmann wind tunnel running behind the whole page from top to bottom. An About page covers sailing and ceramics, and each project has a write-up.',
    '',
    '## Pages',
    '',
    `- [Home](${SITE}/): bio, 3D scan, projects, sails, classes and contact links`,
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
