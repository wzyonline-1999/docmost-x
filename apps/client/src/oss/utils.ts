export function getHostnameUrl(hostname: string) {
  return `${window.location.protocol}//${hostname}`;
}

export function exchangeTokenRedirectUrl(hostname: string, exchangeToken: string) {
  return `${getHostnameUrl(hostname)}/login?exchangeToken=${encodeURIComponent(exchangeToken)}`;
}
