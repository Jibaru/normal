/**
 * The provider origin.
 *
 * One constant, imported by the six modules that used to repeat it as a literal. It is a call
 * target for `text-send`, `pdf-send`, `directory` and `control-wasender`, and a *validation*
 * boundary for `media` and `pdf-send`, which pin the hostname a download may come from and the
 * origins an upload response may name. Those two are the reason this is a single constant rather
 * than a per-module literal: a build where the call target and the validated host disagree fails
 * at a boundary, mid-operation, rather than anywhere a reader would look.
 *
 * The package, its types and its fixtures keep the Wasender name. This is a change of host, not
 * of protocol: the wire contract being spoken is still the one Wasender defined, and the adapters
 * still encode its envelopes, its error shapes and its two different pagination styles.
 */
export const providerOrigin = "https://api.wapi.crafter.run";

/** Hostname used to validate provider-issued media URLs. */
export const providerMediaHostname = new URL(providerOrigin).hostname;
