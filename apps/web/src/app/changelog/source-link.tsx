import { ArrowUpRight } from "lucide-react";
import type { ComponentProps } from "react";

export function sourceReference(href: string | undefined) {
  const pullRequest = href?.match(
    /^https:\/\/github\.com\/cuevaio\/normal\/pull\/(\d+)\/?$/u,
  )?.[1];
  if (pullRequest) return `PR #${pullRequest}`;

  const commit = href?.match(
    /^https:\/\/github\.com\/cuevaio\/normal\/commit\/([0-9a-f]{7,40})\/?$/u,
  )?.[1];
  if (commit) return `commit ${commit.slice(0, 7)}`;

  return null;
}

export function ChangelogSourceLink({
  children,
  className,
  href,
  ...props
}: ComponentProps<"a">) {
  const reference = sourceReference(href);
  if (!reference)
    return (
      <a {...props} className={className} href={href}>
        {children}
      </a>
    );

  return (
    <a
      {...props}
      className={["changelog-source-link", className].filter(Boolean).join(" ")}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <span className="changelog-source-label">{children}</span>{" "}
      <span className="changelog-source-reference">{reference}</span>
      <ArrowUpRight aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
