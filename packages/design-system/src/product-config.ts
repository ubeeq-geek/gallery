export type ProductId = "ubeeq" | "eversally" | "nightframe";
export type ProductTheme = ProductId;

export interface ProductConfig {
  id: ProductId;
  displayName: string;
  theme: ProductTheme;
  terminology: {
    publicProfileName: string;
    creatorLabel: string;
    communityMemberLabel?: string;
  };
  capabilities: {
    hostedDiscovery: boolean;
    challenges: boolean;
    managedBilling: boolean;
    federationSource: boolean;
    federationDestination: boolean;
    imageDelivery: boolean;
    videoDelivery: boolean;
  };
  routes: { publicBaseUrl?: string; helpUrl?: string; authIssuer: string };
  policyPresentation: {
    publicContentNoticeMode: "none" | "standard" | "heightened";
    externalProfileWarningMode: "none" | "notice" | "confirm";
  };
}

export type ProductConfigDefaults = Omit<ProductConfig, "routes">;

export const productConfigDefaults = {
  ubeeq: {
    id: "ubeeq", displayName: "Ubeeq", theme: "ubeeq",
    terminology: { publicProfileName: "Creator Area", creatorLabel: "Creator", communityMemberLabel: "Ubeeqer" },
    capabilities: { hostedDiscovery: false, challenges: false, managedBilling: false, federationSource: true, federationDestination: true, imageDelivery: true, videoDelivery: true },
    policyPresentation: { publicContentNoticeMode: "none", externalProfileWarningMode: "notice" }
  },
  eversally: {
    id: "eversally", displayName: "Eversally", theme: "eversally",
    terminology: { publicProfileName: "Space", creatorLabel: "Ever Creator", communityMemberLabel: "Ever" },
    capabilities: { hostedDiscovery: true, challenges: true, managedBilling: true, federationSource: false, federationDestination: true, imageDelivery: true, videoDelivery: true },
    policyPresentation: { publicContentNoticeMode: "standard", externalProfileWarningMode: "confirm" }
  },
  nightframe: {
    id: "nightframe", displayName: "Nightframe", theme: "nightframe",
    terminology: { publicProfileName: "Profile", creatorLabel: "Creator", communityMemberLabel: "Member" },
    capabilities: { hostedDiscovery: false, challenges: false, managedBilling: true, federationSource: true, federationDestination: false, imageDelivery: true, videoDelivery: true },
    policyPresentation: { publicContentNoticeMode: "heightened", externalProfileWarningMode: "confirm" }
  }
} as const satisfies Record<ProductId, ProductConfigDefaults>;

export class ProductConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid public product configuration: ${issues.join("; ")}`);
    this.name = "ProductConfigError";
  }
}

const productIds: readonly ProductId[] = ["ubeeq", "eversally", "nightframe"];
const contentNoticeModes = ["none", "standard", "heightened"] as const;
const warningModes = ["none", "notice", "confirm"] as const;
const capabilityKeys: readonly (keyof ProductConfig["capabilities"])[] = ["hostedDiscovery", "challenges", "managedBilling", "federationSource", "federationDestination", "imageDelivery", "videoDelivery"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPublicUrl(value: unknown, required: boolean): boolean {
  if (value === undefined) return !required;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch { return false; }
}

/** Parses browser-safe deployment configuration. This validates presentation data only and never grants access. */
export function parseProductConfig(value: unknown): ProductConfig {
  const issues: string[] = [];
  if (!isRecord(value)) throw new ProductConfigError(["configuration must be an object"]);
  const id = value.id;
  const theme = value.theme;
  if (!productIds.includes(id as ProductId)) issues.push("id must identify a supported product");
  if (theme !== id) issues.push("theme must match the product id");
  if (typeof value.displayName !== "string" || !value.displayName.trim()) issues.push("displayName is required");

  const terminology = value.terminology;
  if (!isRecord(terminology) || typeof terminology.publicProfileName !== "string" || typeof terminology.creatorLabel !== "string") issues.push("terminology requires publicProfileName and creatorLabel");
  const capabilities = value.capabilities;
  if (!isRecord(capabilities) || capabilityKeys.some(key => typeof capabilities[key] !== "boolean")) issues.push("all capability flags must be boolean");
  const routes = value.routes;
  if (!isRecord(routes) || !validPublicUrl(routes.authIssuer, true) || !validPublicUrl(routes.publicBaseUrl, false) || !validPublicUrl(routes.helpUrl, false)) issues.push("routes must contain browser-safe HTTP(S) URLs and an authIssuer");
  const policy = value.policyPresentation;
  if (!isRecord(policy) || !contentNoticeModes.includes(policy.publicContentNoticeMode as typeof contentNoticeModes[number]) || !warningModes.includes(policy.externalProfileWarningMode as typeof warningModes[number])) issues.push("policy presentation modes are invalid");
  if (Object.keys(value).some(key => /secret|token|password|credential/i.test(key))) issues.push("privileged configuration keys are not permitted");
  if (issues.length) throw new ProductConfigError(issues);
  return value as unknown as ProductConfig;
}

export function createProductConfig(id: ProductId, routes: ProductConfig["routes"]): ProductConfig {
  return parseProductConfig({ ...productConfigDefaults[id], routes });
}
