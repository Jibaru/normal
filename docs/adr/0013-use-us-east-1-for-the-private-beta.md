# Use us-east-1 for the private beta

Place the private beta's Neon project and AWS KMS root key in `us-east-1`, with encrypted media in R2 and compute on global Cloudflare Workers. The product makes no strict data-residency claim because Wasender does not publish data locations and Cloudflare Queues has no documented jurisdiction control. Regulated or residency-constrained customers are out of scope until every processor and transient data path can contractually satisfy the required region.
