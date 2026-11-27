import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    series: z.string().optional(), // posts sharing a series get Part n ← → navigation instead of Older / Newer
    part: z.number().int().positive().optional(),
    // reposts: where the post first appeared; shown as an "Originally published on …" note
    original: z.object({ url: z.string().url(), site: z.string() }).optional(),
    canonical: z.string().url().optional(), // override <link rel="canonical"> (defaults to this site)
  }),
});

export const collections = { blog };
