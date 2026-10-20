export interface DeploymentUrls {
  siteUrl: string;
  cloudUrl: string;
}

export function buildEnvironment(urls: DeploymentUrls) {
  return {
    cloudUrl: urls.cloudUrl,
    siteUrl: urls.siteUrl,
    basePath: new URL(urls.siteUrl).pathname || "/",
  };
}

export function buildEnvironmentChanged(
  before: DeploymentUrls,
  after: DeploymentUrls,
): boolean {
  const previous = buildEnvironment(before);
  const next = buildEnvironment(after);
  return (
    previous.cloudUrl !== next.cloudUrl ||
    previous.siteUrl !== next.siteUrl ||
    previous.basePath !== next.basePath
  );
}
