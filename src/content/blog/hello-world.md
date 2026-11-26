---
title: Hello, world
description: First post — how this blog is set up and how to write a new one.
date: 2026-11-26
tags: [meta, astro]
---

This blog is a folder of Markdown files built with [Astro](https://astro.build) and deployed to GitHub Pages.

## Writing a post

Create a file in `src/content/blog/` — the file name becomes the URL:

```bash
npm run new "My next post"   # creates src/content/blog/my-next-post.md
```

Every post starts with a small frontmatter block:

```yaml
---
title: My next post
description: One line shown on the home page.
date: 2026-11-26
tags: [go, databases]
draft: false
---
```

## What Markdown gets you

Regular **bold**, _italic_, `inline code`, [links](https://example.com), and lists:

1. Numbered
2. Lists
   - with nesting

> Blockquotes for asides and quotes.

| Feature        | Supported |
| -------------- | --------- |
| Code highlight | ✓         |
| Dark mode      | ✓         |
| RSS + sitemap  | ✓         |

```go
package main

import "fmt"

func main() {
	fmt.Println("hello, world")
}
```

Images go in `public/` and are referenced as `/images/name.png`, or next to the post and referenced relatively.
