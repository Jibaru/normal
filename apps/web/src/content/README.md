# Adding public content

## SEO pages

Add one `.mdx` file to `guides` or `use-cases`. The filename becomes the URL
slug. For example, `guides/my-guide.mdx` becomes `/guides/my-guide`.

Every file needs this frontmatter:

```mdx
---
title: A unique page title
description: A useful search description under 160 characters.
eyebrow: Short category
promise: One sentence that explains the page value.
order: 20
---

Write the page in Markdown here.
```

The collection page, static route, page metadata, Article schema, related
links, and XML sitemap entry are generated automatically. Keep every page
specific to a real search intent. Do not publish a page that only swaps a
keyword in otherwise duplicated copy.

## Changelog entries

Add one `.md` file to `changelog` for each Monday. Name it with the ISO date,
for example `2026-08-24.md`, and include this frontmatter:

```md
---
title: A short summary of the week
description: One sentence covering the most important shipped outcomes.
date: "2026-08-24"
---

Write the weekly entry in Markdown here.
```

The `/changelog` page renders entries newest first. Keep entries focused on
shipped product and platform outcomes rather than individual commits.
