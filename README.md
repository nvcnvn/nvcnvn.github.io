# nvcnvn.github.io

Personal blog built with [Astro](https://astro.build), deployed to GitHub Pages on every push to `main`.

## Write a post

```bash
npm run new "My post title"   # creates src/content/blog/my-post-title.md (draft)
```

Or create any `.md` file in `src/content/blog/` with this frontmatter:

```yaml
---
title: My post title
description: One-line summary shown on the home page   # optional
date: 2026-11-26
tags: [go, databases]                                  # optional
draft: false                                           # drafts show only in `npm run dev`
---
```

The file name is the URL: `src/content/blog/my-post.md` → `/blog/my-post/`.
Put images in `public/images/` and link them as `/images/name.png`.

## Local preview

```bash
npm install
npm run dev      # http://localhost:4321
```

## Layout

| Path                         | What                                   |
| ---------------------------- | -------------------------------------- |
| `src/content/blog/`          | Posts (Markdown)                       |
| `src/pages/about.md`         | About page                             |
| `src/consts.ts`              | Site title, description, social links  |
| `src/styles/global.css`      | Theme tokens (colors, fonts) and styles |
| `.github/workflows/deploy.yml` | Build + deploy to GitHub Pages       |

## One-time GitHub setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
