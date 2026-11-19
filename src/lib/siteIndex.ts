import { getCollection } from 'astro:content';

export const SITE = 'https://ethankong.org';

export const CONTACT = {
  email: 'ethank07@stanford.edu',
  github: 'https://github.com/DoggoOP',
  linkedin: 'https://www.linkedin.com/in/ethank07/',
  resume: `${SITE}/assets/resume.pdf`,
};

export const BIO =
  'Ethan Kong studies Aero/Astro at Stanford. He grew up in Hong Kong, sailed for the national team, ' +
  'and builds across fluids, structures, controls, electronics and code.';

export async function getProjects() {
  const all = await getCollection('projects', ({ id }) => !id.startsWith('_'));
  return all
    .sort((a, b) => a.data.order - b.data.order)
    .map(p => ({
      slug: p.slug,
      title: p.data.title,
      tagline: p.data.tagline,
      description: p.data.description,
      year: p.data.date ? Number(p.data.date.slice(0, 4)) : null,
      tags: p.data.tags,
      url: `${SITE}/projects/${p.slug}`,
    }));
}
