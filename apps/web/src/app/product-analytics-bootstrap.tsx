"use client";

import { useEffect } from "react";
import {
  configureProductAnalytics,
  type ProductAnalyticsConfiguration,
} from "../effect/product-analytics";

export function ProductAnalyticsBootstrap({
  configuration,
}: {
  readonly configuration: ProductAnalyticsConfiguration | null;
}) {
  useEffect(() => {
    configureProductAnalytics(configuration);
    return () => {
      configureProductAnalytics(null);
    };
  }, [configuration]);

  return null;
}
