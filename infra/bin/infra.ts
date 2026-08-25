#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { UbeeqStack } from '../lib/ubeeq-stack';
import { BlueskyOAuthStack, type PublicBrand, PublicLandingStack, publicLaunchStackName } from '../lib/public-launch-stack';
import { LAUNCH_REGIONS, RegionalCellStack, type ManagedProduct } from '../lib/regional-cell-stack';
import { GlobalRoutingStack } from '../lib/global-routing-stack';

const app = new cdk.App();
const environment = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ca-central-1'
  }
};
const deployTarget = app.node.tryGetContext('deployTarget') || process.env.DEPLOY_TARGET || 'full';

if (deployTarget === 'regional-matrix') {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../config/regional-cells.json'), 'utf8')) as { configurationVersion: string; globalRoutingRegion: string; cells: Array<{ product: ManagedProduct; region: typeof LAUNCH_REGIONS[number]; wave: number }> };
  const layers = JSON.parse(process.env.FFMPEG_LAYER_ARNS_JSON || '{}') as Record<string, string>;
  const policy = readFileSync(path.join(__dirname, '../config/regional-policy-v1.json'), 'utf8');
  const cellEnvironment = process.env.ENVIRONMENT?.trim() || 'production';
  for (const cell of manifest.cells) new RegionalCellStack(app, `${cell.product}-${cellEnvironment}-${cell.region}`, {
    product: cell.product, environment: cellEnvironment, dataHomeRegion: cell.region, configurationVersion: manifest.configurationVersion,
    globalUserPoolArn: process.env.GLOBAL_USER_POOL_ARN?.trim(), globalRoutingTableName: process.env.GLOBAL_ROUTING_TABLE?.trim(), globalRoutingRegion: manifest.globalRoutingRegion,
    operationsAlarmEmail: process.env.OPERATIONS_ALARM_EMAIL?.trim(), ffmpegLayerArn: layers[cell.region], regionalPolicyProfileJson: policy,
    monthlyMediaBytesLimit: Number(process.env.MONTHLY_MEDIA_BYTES_LIMIT || 0) || undefined, monthlyUploadLimit: Number(process.env.MONTHLY_UPLOAD_LIMIT || 0) || undefined,
    allowedBrowserOrigins: process.env.ALLOWED_BROWSER_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean), apiDomainName: process.env.REGIONAL_API_DOMAIN_TEMPLATE?.replace('{product}', cell.product).replace('{region}', cell.region), publicDomainName: process.env.PUBLIC_DOMAIN_TEMPLATE?.replace('{product}', cell.product).replace('{region}', cell.region), hostedZoneId: process.env.HOSTED_ZONE_ID, hostedZoneName: process.env.HOSTED_ZONE_NAME, apiCertificateArn: process.env.API_CERTIFICATE_ARNS_JSON ? JSON.parse(process.env.API_CERTIFICATE_ARNS_JSON)[cell.region] : undefined, publicCertificateArn: process.env.PUBLIC_CERTIFICATE_ARN,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: cell.region }, tags: { DeploymentWave: String(cell.wave) }
  });
} else if (deployTarget === 'global-routing') {
  const cellEnvironment = process.env.ENVIRONMENT?.trim() || 'development';
  let regionalEndpoints: Record<string, string>;
  try { regionalEndpoints = JSON.parse(process.env.REGIONAL_ENDPOINTS_JSON || '{}'); }
  catch { throw new Error('REGIONAL_ENDPOINTS_JSON must be a JSON object'); }
  new GlobalRoutingStack(app, `global-routing-${cellEnvironment}`, { environment: cellEnvironment, regionalEndpoints, env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' } });
} else if (deployTarget === 'regional-cell') {
  const product = process.env.PRODUCT as ManagedProduct | undefined;
  const cellEnvironment = process.env.ENVIRONMENT?.trim();
  const dataHomeRegion = process.env.DATA_HOME_REGION as typeof LAUNCH_REGIONS[number] | undefined;
  if (!product || !['eversally', 'nightframe'].includes(product) || !cellEnvironment || !dataHomeRegion || !LAUNCH_REGIONS.includes(dataHomeRegion)) {
    throw new Error('Regional cells require PRODUCT=eversally|nightframe, ENVIRONMENT, and an approved DATA_HOME_REGION');
  }
  new RegionalCellStack(app, `${product}-${cellEnvironment}-${dataHomeRegion}`, { product, environment: cellEnvironment, dataHomeRegion, configurationVersion: process.env.CONFIGURATION_VERSION?.trim(), operationsAlarmEmail: process.env.OPERATIONS_ALARM_EMAIL?.trim(), globalUserPoolArn: process.env.GLOBAL_USER_POOL_ARN?.trim(), globalRoutingTableName: process.env.GLOBAL_ROUTING_TABLE?.trim(), globalRoutingRegion: process.env.GLOBAL_ROUTING_REGION?.trim(), ffmpegLayerArn: process.env.FFMPEG_LAYER_ARN?.trim(), regionalPolicyProfileJson: process.env.REGIONAL_POLICY_PROFILE_JSON?.trim(), monthlyMediaBytesLimit: Number(process.env.MONTHLY_MEDIA_BYTES_LIMIT || 0) || undefined, monthlyUploadLimit: Number(process.env.MONTHLY_UPLOAD_LIMIT || 0) || undefined, allowedBrowserOrigins: process.env.ALLOWED_BROWSER_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean), apiDomainName: process.env.REGIONAL_API_DOMAIN, publicDomainName: process.env.PUBLIC_DOMAIN, hostedZoneId: process.env.HOSTED_ZONE_ID, hostedZoneName: process.env.HOSTED_ZONE_NAME, apiCertificateArn: process.env.API_CERTIFICATE_ARN, publicCertificateArn: process.env.PUBLIC_CERTIFICATE_ARN, env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: dataHomeRegion } });
} else if (deployTarget === 'public') {
  const brand: PublicBrand = process.env.PRODUCT_BRAND === 'ubeeq' ? 'ubeeq' : 'eversally';
  const rootDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  const apiDomain = process.env.API_DOMAIN?.trim().toLowerCase();
  const hostedZoneId = process.env.HOSTED_ZONE_ID?.trim();
  const webCertificateArn = process.env.WEB_CERTIFICATE_ARN?.trim();
  const apiCertificateArn = process.env.API_CERTIFICATE_ARN?.trim();
  const blueskyOAuthSecretName = process.env.BLUESKY_OAUTH_SECRET_NAME?.trim();
  const missing = [
    !rootDomain ? 'ROOT_DOMAIN' : '',
    !apiDomain ? 'API_DOMAIN' : '',
    !hostedZoneId ? 'HOSTED_ZONE_ID' : '',
    !webCertificateArn ? 'WEB_CERTIFICATE_ARN' : '',
    !apiCertificateArn ? 'API_CERTIFICATE_ARN' : '',
    !blueskyOAuthSecretName ? 'BLUESKY_OAUTH_SECRET_NAME' : ''
  ].filter(Boolean);
  if (missing.length) throw new Error(`Public launch deployment is incomplete: ${missing.join(', ')}`);
  const props = { ...environment, brand, rootDomain: rootDomain!, apiDomain: apiDomain!, hostedZoneId: hostedZoneId!, webCertificateArn: webCertificateArn!, apiCertificateArn: apiCertificateArn!, blueskyOAuthSecretName: blueskyOAuthSecretName! };
  new PublicLandingStack(app, publicLaunchStackName(brand, 'landing'), props);
  new BlueskyOAuthStack(app, publicLaunchStackName(brand, 'bluesky'), props);
} else {
  const stackName = app.node.tryGetContext('stackName') || process.env.STACK_NAME || 'UbeeqStack';
  new UbeeqStack(app, stackName, environment);
}
