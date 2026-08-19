export interface OAuthClientCacheSource {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: ReadonlyArray<string>;
}

export const oauthClientCacheRecordFor = <
  const Client extends OAuthClientCacheSource,
>(
  client: Client,
) => ({
  clientId: client.clientId,
  clientName: client.clientName,
  grantTypes: ["authorization_code", "refresh_token"] as const,
  redirectUris: [...client.redirectUris],
  responseTypes: ["code"] as const,
  tokenEndpointAuthMethod: "none" as const,
});
