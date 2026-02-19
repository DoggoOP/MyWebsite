import { defineCollection, z } from 'astro:content';

const projects = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    tagline: z.string(),
    coverImage: z.string().optional(),
    animation: z.enum([
      'tempo', 'ion-thruster', 'sailing-rl', 'solar-car',
      '3d-plane', 'skrunners', 'light-switch', 'rocketry', 'polymarket'
    ]),
    date: z.string(),
    tags: z.array(z.string()),
    order: z.number(),
    links: z.object({
      github: z.string().optional(),
      paper: z.string().optional(),
      demo: z.string().optional(),
    }).optional(),
  }),
});

export const collections = { projects };
