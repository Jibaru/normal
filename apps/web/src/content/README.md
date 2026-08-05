# Adding an SEO page

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
